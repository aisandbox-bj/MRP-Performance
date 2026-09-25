/* ═══════════════════════════════════════════════════════════════════════════
   Intake engine — wires the six-section workflow together.
   Depends on (loaded earlier in HTML): SheetJS (XLSX), PapaParse (Papa),
   AppParsers, AppStorage, AppConfig, CanonicalSchema.

   MRP Performance v0.1.0-dev — BORROWED from Calibre Tune
   (aisandbox-bj/Inventory_Optimization @ 2896842, intake/intake.js). Same
   parse → map → DQ gate → scope → review flow; local changes are tagged
   PERF-* so a diff against the Tune original shows exactly what differs:
     PERF-INT-TYPE  — "Supply-chain performance" assessment type (the only
                      type offered); scope = every material in the files
     PERF-INT-DQ    — PR-History + receipt-path checks in the DQ gate
     PERF-INT-TRIM  — trim keeps MB51 ∪ PR-History materials
     PERF-INT-NAV   — hands off to the Workbench, not Tune's Trend page
     PERF-INT-FAST  — JSON preview no longer deep-copies the whole dataset
   Analyst marks (Tune's For-Action sidecar) are NOT loaded here: this app
   never writes Tune's tune.analyst.* keys (same browser origin).
═══════════════════════════════════════════════════════════════════════════ */

(function () {
  'use strict';

  /* ─── Sources required and conditional ──────────────────────────────────── */
  const REQUIRED_SOURCES   = ['mb51', 'iw39', 'fleetMaster', 'inventoryMaster'];
  /* APP-T-02 — prHistory added as conditional (optional for Tune, required for Trace). */
  const CONDITIONAL_SOURCES= ['userList', 'materialVendor', 'leadTimes', 'prHistory'];

  const SOURCE_LABEL = {
    mb51:            'MB51 — Material Movements',
    iw39:            'IW39 — Work Orders',
    fleetMaster:     'Fleet Master',
    inventoryMaster: 'Inventory Master',
    userList:        'User list (materials or work orders)',
    materialVendor:  'Material — Vendor mapping',
    leadTimes:       'Lead Times',
    prHistory:       'PR History'
  };

  /* ─── Per-field notes — what each canonical field is used for ───────────── */
  const FIELD_NOTES = {
    mb51: {
      postingDate:  'When the movement happened. <b>Drives P1/P2 windowing</b> and the 12-month history check.',
      order:        'Work order number. <b>Joined to IW39</b> for fleet scope mode (filters MB51 to fleet WOs only).',
      material:     'SAP material number. <b>The unit of analysis</b> — every recommendation is per-material.',
      description:  'Material description. Display only — appears alongside the material number in dashboards and Excel.',
      quantity:     'Movement quantity. <b>Combined with movement type</b> to compute net consumption (issues − returns).',
      movementType: '261 / 262 / 201 / 202. <b>261+201 = goods issue, 262+202 = return.</b> Determines the sign of quantity.',
      /* PERF-INT-TYPE — notes for the fields the performance run leans on */
      plant:           'Plant code on the movement. Cross-checked against Inventory Master plants.',
      purchaseOrder:   '<b>Joins receipts to PR History.</b> 107 = arrived at the 3PL, 109 = received at site — per PO.',
      amountLC:        'Movement value in local currency (Amt.in Loc.Cur.). Used for $ views.',
      entryDate:       'When the posting was keyed into SAP. Compared with Posting Date to spot back-dated postings.',
      storageLocation: 'Storage location. 107 rows usually post with no SLoc (3PL side); 109 rows into the site SLoc.'
    },
    iw39: {
      order:          'Work order key. <b>Joins to MB51</b> via Order — links each transaction to a piece of equipment.',
      sortField:      'Equipment unit (e.g. TD402). <b>Bridge field</b> — joined to Fleet Master to roll WOs up to model.',
      basicStartDate: 'When the WO started. <b>Future-dated orders are filtered out</b> so we count realised demand only.',
      description:    "WO description (e.g. 'Undercarriage rebuild'). <b>Annotated on charts</b> to explain consumption spikes."
    },
    fleetMaster: {
      model:               'Fleet model code (e.g. 775G, D9T). <b>Defines the buckets</b> in fleet scope mode.',
      sortField:           'Equipment unit. <b>Bridge field</b>: model → sort fields → IW39 orders → MB51 transactions.',
      unitType:            "e.g. 'CAT Dump Truck'. Display only — used in the fleet asset tree.",
      manufacturer:        'OEM name. Display only — useful when multiple OEMs are in scope.',
      functLocDescription: 'SAP functional location label. Display only — operational context per unit.'
    },
    inventoryMaster: {
      material:         'Material number — <b>the join key</b> against MB51 materials.',
      description:      'Material description. Display only; cross-checked against MB51 when present.',
      plant:            'Plant code (e.g. 1130 site stock, 1120 3PL hub). Captured for every row; <b>multi-plant scope picker queued for APP-T-01b</b>.',
      uom:              'Base unit of measure (EA, KG, …). Used downstream by Compose for PR drafting.',
      totQtyOh:         'Stock on hand. <b>Used for runway calculation</b> (months of cover at current rate).',
      mrpInd:           'MRP type (PD, V1, …). <b>Drives the traffic-light rules</b> in the analysis engine.',
      mrpMin:           'Current MRP minimum. <b>Compared to recommended Min</b> to set the action (raise / lower / leave).',
      mrpMax:           'Current MRP maximum. <b>Compared to recommended Max</b> the same way.',
      inventoryType:    'Inventory category (NORM, INSP, …). <b>Filter dimension</b> in byClassification scope mode.',
      primaryVendor:    'Vendor for this material. Optional fallback if no separate Material-Vendor file is uploaded.',
      inTransit:        'Quantity in transit (between sites or from 3PL). Compose uses this so PRs aren\'t drafted while stock is already inbound.',
      openPO:           'Open purchase-order qty. Picks <code>GM PO Qty</code> (plant 1130) first, <code>MLA PO Qty</code> (plant 1120) as fallback. Plant-conditional logic queued for APP-T-01b.',
      totalReservation: 'Total reservation qty across all reservations for this material. Authoritative (carries reservations beyond the 3 display rows).',
      unitPrice:        'PO-confirmed unit price. Currently sourced from Material Master if present; primary source (Supplier PO Reference) joins land in a follow-up chunk.',
      movingAvgPrice:   'Moving average price from SAP (the <code>Moving price</code> field). Used downstream by Compose for value-weighted analysis.'
    },
    materialVendor: {
      material:            'Join key to MB51 / Inventory Master.',
      vendor:              'Vendor number. <b>Defines the buckets</b> in byVendor scope mode.',
      vendorName:          'Display label for the vendor.',
      sourceListIndicator: 'Primary / approved / single-source flag. Display in v1; reserved for sole-source-risk flags later.'
    },
    leadTimes: {
      material:     'Join key to the rest of the dataset.',
      leadTimeDays: 'Time from re-order trigger to goods receipt. <b>Replaces minMonths</b> in the leadTimeBased Min/Max formula.',
      safetyStock:  'Buffer added on top of lead-time consumption to size the recommended Min.',
      source:       "How this lead-time was derived (e.g. 'SAP MARC', 'supplier-confirmed', 'measured')."
    },
    /* APP-T-02 — PR History hints. Tune doesn't read these fields today;
       they're for Trace (T-03 onward). Hints frame the operator value. */
    prHistory: {
      material:           'Material number — <b>the join key</b> against MB51 + Inventory Master.',
      plant:              'Plant code on the PR. Cross-checked against MB51 and Inventory Master plants.',
      uom:                'Unit of measure on the PR line. Trace uses this for qty normalisation when pack sizes differ from base UoM.',
      purchaseOrder:      'The PO this PR became (if it ever did). <b>Joins to Supplier PO Reference</b> for Phase C lead-time stats (T-05).',
      poDate:             'When the PO was raised. Defines Phase B end-point.',
      pr:                 'Purchase Requisition number. <b>Primary key</b> for PR-side rows.',
      prItem:             'PR line item number. Multiple lines per PR possible.',
      prDate:             'When the PR was raised. <b>Defines Phase A start-point</b> of the procurement chain.',
      releaseDate:        'When the PR was released for sourcing. Phase A end-point.',
      changedOn:          'Last-touched date. <b>Not reliable as a cancelled-on date</b> per CDHDR audit; use deletionIndicator + processingStatus for cancellation detection.',
      processingStatus:   'PR processing state. <b>Status N + deletionIndicator true = cancelled.</b>',
      deletionIndicator:  'Logical-delete flag. true/false (stored as string per SAP export).',
      creationIndicator:  '<b>B = MRP-generated · R = manually created.</b> Critical for V2 Check F — manual PRs bypass MRP logic.',
      releaseIndicator:   'Released vs pending release.',
      qtyRequested:       'Quantity requested on the PR line. <b>Trace volume-tab input.</b>',
      shortText:          'PR line description. Display only.',
      requisitioner:      'Free-text requester name / group. Feeds F12 mapping for Compose.',
      acctAssignmentCat:  'Account-assignment category: K = cost centre · A = asset · P = project · N = network · blank = stock.',
      purchasingGroup:    'Buyer routing group code.',
      itemCategory:       'Item category at PR line level. Material-level derivation (MODE across recent PRs) is deferred to T-05.',
      desiredVendor:      'Vendor the requester wanted.',
      fixedVendor:        'PR-intent vendor. <b>Cross-checked against Supplier PO Reference</b> (T-05) — flags VENDOR_DRIFT when they disagree (D24).',
      /* PERF-INT-TYPE */
      deliveryDate:       '<b>Need-by date on the PR.</b> For MRP-created PRs SAP sets it = PR date + planned lead time — the plan the actuals are measured against.',
      grProcessingTime:   'Planned goods-receipt processing days (part of SAP\'s planned lead time).'
    }
  };

  function sourceTagline(source){
    const map = {
      mb51:            'consumption history',
      iw39:            'fleet WO link',
      fleetMaster:     'equipment → model rollup',
      inventoryMaster: 'stock + MRP settings',
      materialVendor:  'material → vendor mapping',
      leadTimes:       'per-material lead time + safety stock',
      prHistory:       'procurement chains — PR → release → PO'  /* PERF-INT-TYPE */
    };
    return map[source] || '';
  }

  /* ─── Mutable module state ──────────────────────────────────────────────── */
  const state = {
    files:    {},                                    // source → File
    parsed:   {},                                    // source → parseAndMap result
    dq:       null,                                  // { passed, issues, warnings, tiles }
    scope:    CanonicalSchema.emptyScope('fleet'),
    paramsSaved: { ...CanonicalSchema.FACTORY_DEFAULTS },
    paramsRun:   { ...CanonicalSchema.FACTORY_DEFAULTS },
    aliases:  {},
    runDate:  (typeof AppLocale !== 'undefined' ? AppLocale.localDateISO() : new Date().toISOString().slice(0, 10)),
    name:     '',
    assessmentType: null,                            // 'unitFloc' | 'userList' | 'paramSearch'
    mrpTemplate: false,                              // APP-MRP-REQ Part A — opt-in: this run will produce the MRP Request Template, so Fleet Master + IW39 become required (they resolve each part to fleet make/model/site)
    psFilters: [],                                   // Parameter-Search filter cards
    alignmentAck: null,                              // APP-E6 · { acknowledgedAt, dimensions } once operator confirms scope alignment
    inventoryMasterDate: null                        // APP-FIX-SNAPSHOT-ALIGN · SAP extract date of the Inventory Master (yyyy-mm-dd)
  };

  /* APP-FIX-SNAPSHOT-ALIGN — pull a yyyy-mm-dd (or yyyymmdd / yyyy_mm_dd) date out
     of an uploaded filename so the extract-date field can pre-fill. Returns ISO or null. */
  function detectDateInFilename(name){
    const m = String(name || '').match(/(20\d{2})[-_]?(0[1-9]|1[0-2])[-_]?(0[1-9]|[12]\d|3[01])/);
    return m ? `${m[1]}-${m[2]}-${m[3]}` : null;
  }

  /* ─── Parameter-Search dimension catalogue ──────────────────────────────── */
  /* Each dimension declares its data source, value type, and pickers. */
  const PS_DIMENSIONS = [
    { key:'mb51Movement',   label:'MB51 movement',   type:'number', from:'mb51_net',  unit:'units' },
    { key:'materialGroup',  label:'Material group',  type:'string', from:'master',    field:'materialGroup' },
    { key:'manufacturer',   label:'Manufacturer',    type:'string', from:'master',    field:'manufacturer' },
    { key:'totValueOh',     label:'Value on hand',   type:'number', from:'master',    field:'totValueOh',  unit:'currency' },
    { key:'totQtyOh',       label:'Qty on hand',     type:'number', from:'master',    field:'totQtyOh',    unit:'units' },
    { key:'inventoryType',  label:'Inventory type',  type:'string', from:'master',    field:'inventoryType' },
    { key:'mrpInd',         label:'MRP indicator',   type:'string', from:'master',    field:'mrpInd' }
  ];

  /* ─── DOM refs ──────────────────────────────────────────────────────────── */
  const $  = (s) => document.querySelector(s);
  const $$ = (s) => Array.from(document.querySelectorAll(s));

  /* ═════════════════════════════════════════════════════════════════════════
     STEP 0 — Assessment type
  ═════════════════════════════════════════════════════════════════════════ */

  function setupAssessmentType(){
    $$('.atype-card').forEach(card => {
      card.addEventListener('click', (e) => {
        // Avoid double-fire from inner radio click
        if (e.target.tagName === 'INPUT') return;
        const radio = card.querySelector('input[type=radio]');
        radio.checked = true;
        applyAssessmentType(card.dataset.atype);
      });
      const radio = card.querySelector('input[type=radio]');
      radio.addEventListener('change', () => applyAssessmentType(card.dataset.atype));
    });
    // APP-MRP-REQ Part A — the MRP Request Template opt-in: makes Fleet Master + IW39
    // required (both the ★ upload flags and the DQ gate), then re-evaluates the gate.
    const optin = $('#mrpReqOptinChk');
    if (optin) optin.addEventListener('change', () => {
      state.mrpTemplate = optin.checked;
      const card = $('#mrpReqOptin'); if (card) card.classList.toggle('on', optin.checked);
      refreshUploadFlags();
      if (state.dq) runDqGate();        // re-run the gate with the new required set (only if data already loaded)
      renderJsonPreview();
    });
  }

  function applyAssessmentType(type){
    state.assessmentType = type;
    $$('.atype-card').forEach(c => c.classList.toggle('selected', c.dataset.atype === type));

    // APP-INT-NEEDS-01 — flag (don't blank) each upload for this assessment
    // type. Nothing is disabled: every source stays loadable so an operator can
    // feed the optional inputs (IW39 / Fleet Master → "Where used", PR History
    // → Calibre Trace) on ANY run. The DQ gate still keys off the REQUIRED set
    // only (currentRequiredSources → ASSESSMENT_TYPE_REQUIRES) — unchanged, so
    // a User-list run still passes on MB51 + Inventory Master + (file or paste)
    // without IW39/Fleet, while those now read "optional" instead of greyed.
    refreshUploadFlags();

    // Scope tab visibility — restrict to scope modes valid for this assessment type
    const allowedScopes = new Set(CanonicalSchema.ASSESSMENT_TYPE_SCOPE[type] || []);
    $$('.scope-tabs .tab').forEach(tab => {
      const valid = allowedScopes.has(tab.dataset.mode);
      tab.style.display = valid ? '' : 'none';
    });
    // Auto-pick the first valid scope mode for this type
    const firstValid = CanonicalSchema.ASSESSMENT_TYPE_SCOPE[type][0];
    if (firstValid && state.scope.mode !== firstValid) {
      switchScopeMode(firstValid);
    }

    // Show/hide Parameter-Search panel
    const psStep = $('#stepParamSearch');
    if (psStep) psStep.classList.toggle('hidden', type !== 'paramSearch');

    // Step 4 (scope) collapsed for paramSearch — its scope is the filter panel itself
    const scopeStep = $('#step4');
    if (scopeStep) scopeStep.classList.toggle('hidden', type === 'paramSearch');

    /* PERF-INT-TYPE — Tune's Min/Max parameters (Step 05) mean nothing to a
       performance run; its settings live on the Workbench. The MRP Request
       Template opt-in is a Tune export — hidden too. */
    const paramStep = $('#step5');
    if (paramStep) paramStep.classList.toggle('hidden', type === 'scPerformance');
    const optinCard = $('#mrpReqOptin');
    if (optinCard) optinCard.classList.toggle('hidden', type === 'scPerformance');

    $('#step0Status').textContent = `${labelForType(type)} selected`;
    $('#step0Status').className = 'step-status done';
    // APP-FIX-T-03a (2026-05-17) — pre-existing latent bug surfaced by the
    // JSON-upload path firing applyAssessmentType(). 'needed' was referenced
    // without ever being defined → ReferenceError, which cascaded into a
    // mid-flow abort on load (DQ gate skipped, dashboard registration
    // missed). Compute the list from the locked assessment-type → required-
    // sources map.
    const needed = CanonicalSchema.ASSESSMENT_TYPE_REQUIRES[type] || [];
    $('#step1Status').textContent = `awaiting ${needed.join(' · ')}`;

    if (type === 'paramSearch') renderParamSearch();
    renderJsonPreview();
  }

  function labelForType(t){
    return { scPerformance:'Supply-chain performance', unitFloc:'UNIT/FLOC', userList:'User list', paramSearch:'Parameter search' }[t] || t;   /* PERF-INT-TYPE */
  }

  /* APP-INT-NEEDS-01 — what each upload "means" for the selected assessment
     type + scope: required (drives the DQ gate), optional (loadable, unlocks a
     feature), or not-used. Purely informational — it never blocks a drop and
     never changes the DQ required set (that stays ASSESSMENT_TYPE_REQUIRES). */
  function uploadFlagFor(source, type, scopeMode){
    /* PERF-INT-TYPE — the performance run needs exactly three files. */
    if (type === 'scPerformance') {
      switch (source){
        case 'mb51':            return { level:'req', reason:'receipts (107 / 109) + consumption for the stock rebuild' };
        case 'inventoryMaster': return { level:'req', reason:'stock anchor · Min / Max / SS · MRP type · manufacturer' };
        case 'prHistory':       return { level:'req', reason:'procurement chains · PR → release → PO' };
        case 'iw39':
        case 'fleetMaster':     return { level:'na',  reason:'not used in v0.1' };
        default:                return { level:'na' };
      }
    }
    // MB51 + Inventory Master are required for every assessment type.
    if (source === 'mb51' || source === 'inventoryMaster') return { level:'req' };
    switch (source){
      case 'iw39':
        if (state.mrpTemplate) return { level:'req', reason:'required for the MRP Request Template' };
        return type === 'unitFloc'
          ? { level:'req' }
          : { level:'opt', reason:'enables "Where used"' };
      case 'fleetMaster':
        if (state.mrpTemplate) return { level:'req', reason:'required for the MRP Request Template' };
        return type === 'unitFloc'
          ? { level:'req' }
          : { level:'opt', reason:'adds the model rollup to "Where used"' };
      case 'userList':
        // Not in the DQ required set — operator can paste the list in Step 4
        // instead — so it's an optional-but-expected input for a User-list run.
        return type === 'userList'
          ? { level:'opt', reason:'provide here, or paste in Step 4' }
          : { level:'na' };
      case 'prHistory':
        return { level:'opt', reason:'enables Calibre Trace + the open-procurement lamps' };
      case 'materialVendor':
        return scopeMode === 'byVendor'
          ? { level:'req', reason:'required for By-Vendor scope' }
          : { level:'na' };
      case 'leadTimes':
        return { level:'opt', reason:'enables lead-time-based Min/Max' };
      default:
        return { level:'na' };
    }
  }

  function refreshUploadFlags(){
    const type  = state.assessmentType;
    const scope = state.scope && state.scope.mode;
    const MARK = { req:'★', opt:'☆', na:'—' };
    const LAB  = { req:'Required', opt:'Optional', na:'Not used' };
    $$('.drop[data-source]').forEach(drop => {
      const flagEl = drop.querySelector('.drop-flag');
      if (!flagEl) return;
      if (!type){ flagEl.textContent = ''; flagEl.className = 'drop-flag'; return; }
      const f = uploadFlagFor(drop.dataset.source, type, scope);
      flagEl.className = 'drop-flag ' + f.level;
      flagEl.innerHTML = `<span class="df-mark">${MARK[f.level]}</span><span class="df-lab">${LAB[f.level]}</span>`
        + (f.reason ? `<span class="df-reason">${f.reason}</span>` : '');
    });
  }

  /* Helper to swap the active scope tab + pane programmatically */
  function switchScopeMode(mode){
    state.scope.mode = mode;
    $$('.scope-tabs .tab').forEach(t => t.classList.toggle('active', t.dataset.mode === mode));
    $$('.scope-pane').forEach(p => p.classList.toggle('hidden', p.dataset.mode !== mode));
    const mv = document.querySelector('.drop[data-source="materialVendor"]');
    if (mv) mv.parentElement.classList.toggle('hidden', mode !== 'byVendor');
    refreshUploadFlags();   // APP-INT-NEEDS-01 — Material→Vendor flips to required under By-Vendor scope
  }

  /* ═════════════════════════════════════════════════════════════════════════
     STEP 1 — Upload
  ═════════════════════════════════════════════════════════════════════════ */

  function setupDropZones(){
    REQUIRED_SOURCES.concat(CONDITIONAL_SOURCES).forEach(source => {
      const drop = document.querySelector(`.drop[data-source="${source}"]`);
      if (!drop) return;
      const input = drop.querySelector('input[type="file"]');
      // APP-INT-NEEDS-01 — drops are never disabled now; any source is loadable
      // on any assessment type (the type only changes its required/optional flag).
      drop.addEventListener('dragover',  (e) => { e.preventDefault(); drop.classList.add('dragover'); });
      drop.addEventListener('dragleave', ()  => drop.classList.remove('dragover'));
      drop.addEventListener('drop',      (e) => {
        e.preventDefault();
        drop.classList.remove('dragover');
        if (e.dataTransfer.files.length) handleFile(source, e.dataTransfer.files[0]);
      });
      input.addEventListener('change', (e) => {
        if (e.target.files.length) handleFile(source, e.target.files[0]);
      });
    });
    // APP-FIX-SNAPSHOT-ALIGN — Inventory Master extract-date field.
    const imDate = document.querySelector('#imDateInput');
    if (imDate) {
      imDate.addEventListener('change', () => {
        state.inventoryMasterDate = imDate.value || null;
        syncInventoryMasterDateInput();
        onParseUpdated();   // re-run the DQ gate so the alignment warning refreshes live
      });
    }
    syncInventoryMasterDateInput();
  }

  // APP-FIX-SNAPSHOT-ALIGN — reflect state.inventoryMasterDate into the field + a
  // small inline note showing whether it matches the last MB51 posting date.
  function syncInventoryMasterDateInput(){
    const inp  = document.querySelector('#imDateInput');
    const note = document.querySelector('#imDateNote');
    if (!inp) return;
    if (state.inventoryMasterDate && inp.value !== state.inventoryMasterDate) inp.value = state.inventoryMasterDate;
    if (!state.inventoryMasterDate && inp.value) inp.value = '';
    if (!note) return;
    const mb51 = state.parsed.mb51?.canonical || [];
    const lastMb51 = mb51.length ? (mb51.map(r => r.postingDate).filter(Boolean).sort().pop() || null) : null;
    if (!state.inventoryMasterDate) {
      note.textContent = 'SAP run date of the stock snapshot — set it so the Stock-on-Hand line lines up with MB51.';
      note.className = 'im-date-note';
    } else if (lastMb51 && lastMb51 !== state.inventoryMasterDate) {
      const gap = Math.abs(Math.round((Date.parse(lastMb51) - Date.parse(state.inventoryMasterDate)) / 86400000));
      note.textContent = `⚠ Differs from the last MB51 movement (${lastMb51}) by ${gap} day${gap === 1 ? '' : 's'} — the Stock-on-Hand line will be offset.`;
      note.className = 'im-date-note warn';
    } else if (lastMb51) {
      note.textContent = `✓ Matches the MB51 cut-off (${lastMb51}).`;
      note.className = 'im-date-note ok';
    } else {
      note.textContent = 'SAP run date of the stock snapshot.';
      note.className = 'im-date-note';
    }
  }

  async function handleFile(source, file){
    state.files[source] = file;
    const drop = document.querySelector(`.drop[data-source="${source}"]`);
    drop.classList.add('loaded');
    drop.querySelector('.file').textContent = `${file.name} · parsing…`;

    try {
      const result = await AppParsers.parseAndMap(file, source, state.aliases);
      state.parsed[source] = result;
      const sheetTxt = result.sheet ? ` · sheet: "${result.sheet}"` : '';
      drop.querySelector('.file').textContent = `${file.name} · ${result.rowCount.toLocaleString()} rows${sheetTxt}`;
      // APP-FIX-SNAPSHOT-ALIGN — when the Inventory Master lands, pre-fill its
      // extract date from the filename if detectable + the field is still empty.
      if (source === 'inventoryMaster' && !state.inventoryMasterDate) {
        const guess = detectDateInFilename(file.name);
        if (guess) state.inventoryMasterDate = guess;
      }
      if (source === 'inventoryMaster') syncInventoryMasterDateInput();
      // Re-render every drop so cross-file reconciliation chips refresh too
      renderAllDropStats();
      onParseUpdated();
    } catch (e) {
      console.error(e);
      drop.classList.remove('loaded');
      drop.querySelector('.file').textContent = `${file.name} · ERROR: ${e.message || e}`;
      toast('Parse failed: ' + (e.message || e), 'crit');
    }
  }

  /* ─── Per-drop key-parameter stats ──────────────────────────────────────── */
  /* APP-T-01b — per-file plant breakdown chip. Returns null if no rows
     carry a non-blank plant value (parser-side alias didn't match, or the
     file simply doesn't carry plant). Single plant → neutral chip; >1 plant
     → 'warn' tinted chip so it surfaces before the operator runs analysis.
     This is read-only display in this chunk — no scope filtering yet. */
  function computePlantBreakdown(rows){
    if (!rows || !rows.length) return null;
    const counts = new Map();
    for (const r of rows) {
      const p = String(r.plant || '').trim();
      if (!p) continue;
      counts.set(p, (counts.get(p) || 0) + 1);
    }
    if (counts.size === 0) return null;
    const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1]);
    const label  = sorted.length === 1 ? 'Plant' : 'Plants';
    const v      = sorted.map(([p, n]) => `${p} ✕ ${n.toLocaleString()}`).join(' · ');
    const cls    = sorted.length > 1 ? 'warn' : '';
    return { lab: label, v, cls };
  }

  function computeSourceStats(source, rows){
    if (!rows || !rows.length) return [];
    const uniqOf = (key) => new Set(rows.map(r => String(r[key] || '').trim()).filter(Boolean)).size;
    const plantChip = computePlantBreakdown(rows);
    const append = (arr) => plantChip ? arr.concat([plantChip]) : arr;
    switch (source) {
      case 'mb51':
        return append([
          { lab:'Transactions', v:rows.length.toLocaleString() },
          { lab:'Materials',    v:uniqOf('material').toLocaleString() },
          { lab:'Orders',       v:uniqOf('order').toLocaleString() }
        ]);
      case 'iw39':
        return [
          { lab:'Work orders', v:rows.length.toLocaleString() },
          { lab:'Units',       v:uniqOf('sortField').toLocaleString() }
        ];
      case 'fleetMaster':
        return [
          { lab:'Units',  v:rows.length.toLocaleString() },
          { lab:'Models', v:uniqOf('model').toLocaleString() }
        ];
      case 'inventoryMaster':
        return append([
          { lab:'Materials',     v:uniqOf('material').toLocaleString() },
          { lab:'MRP types',     v:uniqOf('mrpInd').toLocaleString() },
          { lab:'Inv. types',    v:uniqOf('inventoryType').toLocaleString() }
        ]);
      case 'userList':
        return [{ lab:'Materials', v:uniqOf('material').toLocaleString() }];
      case 'materialVendor':
        return [
          { lab:'Mat→vendor rows', v:rows.length.toLocaleString() },
          { lab:'Materials',       v:uniqOf('material').toLocaleString() },
          { lab:'Vendors',         v:uniqOf('vendor').toLocaleString() }
        ];
      case 'leadTimes':
        return [{ lab:'Materials', v:uniqOf('material').toLocaleString() }];
      /* APP-T-02 — PR History chips. Cancellation breakdown deferred to T-04
         when the cancellation-diagnostic view is built; for now the
         foundation chunk just shows count of lines + PRs + materials. */
      case 'prHistory':
        return append([
          { lab:'Lines',     v:rows.length.toLocaleString() },
          { lab:'PRs',       v:uniqOf('pr').toLocaleString() },
          { lab:'Materials', v:uniqOf('material').toLocaleString() }
        ]);
      default:
        return [];
    }
  }

  function renderDropStats(source){
    const drop = document.querySelector(`.drop[data-source="${source}"]`);
    if (!drop) return;
    let wrap = drop.querySelector('.drop-stats');
    if (!wrap) {
      wrap = document.createElement('div');
      wrap.className = 'drop-stats';
      drop.appendChild(wrap);
    }
    const parsed = state.parsed[source];
    if (!parsed) { wrap.innerHTML = ''; return; }
    const stats = computeSourceStats(source, parsed.canonical)
                    .concat(computeCrossFileChips(source));
    wrap.innerHTML = stats.map(s => `
      <span class="drop-stat${s.cls ? ' ' + s.cls : ''}">
        <span class="lab">${escapeHtml(s.lab)}</span>
        <span class="v">${s.v}</span>
      </span>`).join('');
  }

  function renderAllDropStats(){
    Object.keys(state.parsed).forEach(s => renderDropStats(s));
  }

  /* ─── Cross-file reconciliation chips ─── shows up only if the relevant
     second file is also parsed; flags amber/red when below thresholds. */
  function computeCrossFileChips(source){
    const out = [];
    const p = state.parsed;

    const setOfKey = (rows, key) => new Set((rows || []).map(r => String(r[key] || '').trim()).filter(Boolean));

    if (source === 'mb51') {
      const mb51Mats = setOfKey(p.mb51?.canonical, 'material');
      if (p.inventoryMaster) {
        const mMats = setOfKey(p.inventoryMaster.canonical, 'material');
        const overlap = [...mb51Mats].filter(m => mMats.has(m)).length;
        out.push(reconChip('in Inv Master', overlap, mb51Mats.size));
      }
      if (p.iw39) {
        const mb51Ords = setOfKey(p.mb51.canonical, 'order');
        const iwOrds   = setOfKey(p.iw39.canonical, 'order');
        const overlap  = [...mb51Ords].filter(o => iwOrds.has(o)).length;
        out.push(reconChip('orders in IW39', overlap, mb51Ords.size));
      }
    }
    if (source === 'iw39') {
      if (p.mb51) {
        const iwOrds  = setOfKey(p.iw39.canonical, 'order');
        const mbOrds  = setOfKey(p.mb51.canonical, 'order');
        const overlap = [...iwOrds].filter(o => mbOrds.has(o)).length;
        out.push(reconChip('orders in MB51', overlap, iwOrds.size));
      }
      if (p.fleetMaster) {
        const iwSf  = setOfKey(p.iw39.canonical, 'sortField');
        const flSf  = setOfKey(p.fleetMaster.canonical, 'sortField');
        const overlap = [...iwSf].filter(s => flSf.has(s)).length;
        out.push(reconChip('units in Fleet', overlap, iwSf.size));
      }
    }
    if (source === 'fleetMaster') {
      if (p.iw39) {
        const flSf  = setOfKey(p.fleetMaster.canonical, 'sortField');
        const iwSf  = setOfKey(p.iw39.canonical, 'sortField');
        const overlap = [...flSf].filter(s => iwSf.has(s)).length;
        out.push(reconChip('units with WOs', overlap, flSf.size));
      }
    }
    if (source === 'inventoryMaster') {
      if (p.mb51) {
        const mMats = setOfKey(p.inventoryMaster.canonical, 'material');
        const mb51M = setOfKey(p.mb51.canonical, 'material');
        const overlap = [...mb51M].filter(m => mMats.has(m)).length;
        out.push(reconChip('MB51 mats covered', overlap, mb51M.size));
      }
    }
    if (source === 'userList') {
      if (p.mb51) {
        const ul = setOfKey(p.userList.canonical, 'material');
        const mb = setOfKey(p.mb51.canonical, 'material');
        const overlap = [...ul].filter(m => mb.has(m)).length;
        out.push(reconChip('in MB51', overlap, ul.size));
      }
      if (p.inventoryMaster) {
        const ul = setOfKey(p.userList.canonical, 'material');
        const im = setOfKey(p.inventoryMaster.canonical, 'material');
        const overlap = [...ul].filter(m => im.has(m)).length;
        out.push(reconChip('in Inv Master', overlap, ul.size));
      }
    }
    if (source === 'materialVendor') {
      if (p.inventoryMaster) {
        const mv = setOfKey(p.materialVendor.canonical, 'material');
        const im = setOfKey(p.inventoryMaster.canonical, 'material');
        const overlap = [...mv].filter(m => im.has(m)).length;
        out.push(reconChip('in Inv Master', overlap, mv.size));
      }
    }
    /* APP-T-02 — PR History recon chips. Tells the operator how much of
       the PR History data will actually pair with consumption (MB51) and
       MRP settings (Inventory Master). Low overlap is a flag — likely
       a scope-of-export mismatch the operator should fix before Trace
       runs. */
    if (source === 'prHistory') {
      const prMats = setOfKey(p.prHistory.canonical, 'material');
      if (p.mb51) {
        const mb51M = setOfKey(p.mb51.canonical, 'material');
        const overlap = [...prMats].filter(m => mb51M.has(m)).length;
        out.push(reconChip('in MB51', overlap, prMats.size));
      }
      if (p.inventoryMaster) {
        const imM = setOfKey(p.inventoryMaster.canonical, 'material');
        const overlap = [...prMats].filter(m => imM.has(m)).length;
        out.push(reconChip('in Inv Master', overlap, prMats.size));
      }
    }
    return out;
  }

  function reconChip(label, overlap, total){
    if (!total) return { lab: label, v: '—' };
    const pct = overlap / total * 100;
    const cls = pct < 50 ? 'crit' : (pct < 90 ? 'warn' : '');
    return {
      lab: label,
      v:   `${overlap.toLocaleString()} / ${total.toLocaleString()} (${pct.toFixed(0)}%)`,
      cls
    };
  }

  function onParseUpdated(){
    renderSchema();
    const required = currentRequiredSources();
    if (required.length && required.every(s => state.parsed[s])) {
      runDqGate();
    }
    // Auto-populate manual list textarea when user-list type + file uploaded.
    // APP-E22: file can have a Material column OR an Order column. Whichever
    // is populated drives the listType + chooser UI state.
    if (state.assessmentType === 'userList' && state.parsed.userList && !state.scope.manual.userEdited) {
      const rows = state.parsed.userList.canonical;
      const mats = uniq(rows.map(r => String(r.material || '').trim()).filter(Boolean));
      const ords = uniq(rows.map(r => String(r.order    || '').trim()).filter(Boolean));
      const ta = $('#manualPaste');
      if (mats.length && ords.length) {
        /* Both columns populated — error condition per APP-E22 spec. Keep
           materials and ignore orders; flag in detection. */
        state.scope.manual.materials  = mats;
        state.scope.manual.workOrders = [];
        state.scope.manual.listType   = 'materials';
        if (ta) ta.value = mats.join('\n');
        setManualUiMode('materials');
        state.scope.manual.detection = {
          confidence: 'override', materialHits: mats.length, workOrderHits: ords.length,
          ambiguous: 0, unknown: 0, total: mats.length,
          source: 'userListFile-bothColumns', userOverride: true,
          warning: 'File had both Material and Order columns — used Material; ignored Order.'
        };
      } else if (ords.length) {
        state.scope.manual.workOrders = ords;
        state.scope.manual.materials  = [];
        state.scope.manual.listType   = 'workOrders';
        if (ta) ta.value = ords.join('\n');
        setManualUiMode('workOrders');
        state.scope.manual.detection = {
          confidence: 'high', materialHits: 0, workOrderHits: ords.length,
          ambiguous: 0, unknown: 0, total: ords.length,
          source: 'userListFile-orderColumn', userOverride: false
        };
      } else {
        state.scope.manual.materials  = mats;
        state.scope.manual.workOrders = [];
        state.scope.manual.listType   = 'materials';
        if (ta) ta.value = mats.join('\n');
        setManualUiMode('materials');
        state.scope.manual.detection = {
          confidence: 'high', materialHits: mats.length, workOrderHits: 0,
          ambiguous: 0, unknown: 0, total: mats.length,
          source: 'userListFile-materialColumn', userOverride: false
        };
      }
      renderManualDetectChip();
      renderScopePreview();
    }
    if (state.assessmentType === 'paramSearch') renderParamSearch();
    renderJsonPreview();
  }

  function currentRequiredSources(){
    if (!state.assessmentType) return [];
    const base = (CanonicalSchema.ASSESSMENT_TYPE_REQUIRES[state.assessmentType] || []).slice();
    // APP-MRP-REQ Part A — the MRP Request Template can't resolve parts to fleet
    // make/model/site without Fleet Master + IW39, so the opt-in makes them required.
    if (state.mrpTemplate) for (const s of ['iw39', 'fleetMaster']) if (!base.includes(s)) base.push(s);
    return base;
  }

  /* ═════════════════════════════════════════════════════════════════════════
     STEP 2 — Schema mapping
  ═════════════════════════════════════════════════════════════════════════ */

  function renderSchema(){
    const host = $('#schemaRows');
    host.innerHTML = '';
    const order = REQUIRED_SOURCES.concat(CONDITIONAL_SOURCES);
    let totalMissing = 0, totalMatched = 0;

    for (const source of order) {
      const parsed = state.parsed[source];
      if (!parsed) continue;
      const fields  = Object.keys(AppParsers.ALIASES[source] || {});
      const isReq   = REQUIRED_SOURCES.includes(source);
      let groupMatched = 0;

      const group = document.createElement('div');
      group.className = 'schema-group ' + (isReq ? 'required' : 'optional');

      const labelLeft = SOURCE_LABEL[source].split('—')[0].trim();
      const sheetTxt  = parsed.sheet ? `sheet "${parsed.sheet}" · ` : '';
      const head = document.createElement('div');
      head.className = 'schema-group-head';
      head.innerHTML = `
        <div class="chev">▸</div>
        <div class="name">${escapeHtml(labelLeft)}</div>
        <div class="desc">${escapeHtml(sourceTagline(source))} · ${sheetTxt}${parsed.rowCount.toLocaleString()} rows</div>
        <div class="count" data-count></div>
      `;
      group.appendChild(head);

      for (const field of fields) {
        const header  = parsed.fieldMap[field];
        const matched = !!header;
        if (matched) { totalMatched++; groupMatched++; } else { totalMissing++; }

        const row = document.createElement('div');
        row.className = 'schema-row ' + (matched ? 'matched' : 'missing');

        const opts = ['<option value="">— choose header —</option>']
          .concat(parsed.headers.map(h => `<option value="${escapeAttr(h)}" ${h === header ? 'selected' : ''}>${escapeHtml(h)}</option>`))
          .join('');

        const note = (FIELD_NOTES[source] && FIELD_NOTES[source][field]) || '—';

        row.innerHTML = `
          <div class="field">${escapeHtml(field)}</div>
          <div class="notes">${note}</div>
          <div class="header">${matched ? '' : '<em>not matched · </em>'}<select data-source="${source}" data-field="${field}">${opts}</select></div>
          <div class="ok">${matched ? '✓' : '!'}</div>
        `;
        group.appendChild(row);
      }

      const countEl = head.querySelector('[data-count]');
      const unmatched = fields.length - groupMatched;
      countEl.innerHTML = `${groupMatched}/${fields.length} mapped${unmatched ? ` · <b>${unmatched} unmapped</b>` : ''}`;
      countEl.classList.add(unmatched === 0 ? 'ok' : 'warn');
      // APP-INT-UITIDY — each file's mapping is a collapsible tile: fully-mapped
      // files start collapsed (short by default), any file with unmapped columns
      // auto-expands so a broken mapping is never hidden. Click the tile to toggle.
      group.classList.toggle('collapsed', unmatched === 0);
      head.addEventListener('click', () => group.classList.toggle('collapsed'));

      host.appendChild(group);
    }

    $('#schemaSummary').textContent =
      totalMatched + totalMissing === 0
        ? 'no files parsed yet'
        : `${totalMatched} matched · ${totalMissing} unmatched`;
    $('#schemaSummary').className = 'step-status ' + (totalMissing === 0 ? 'done' : 'warn');

    // Wire override dropdowns — user picks a header → save as session alias → re-parse
    $$('#schemaRows select').forEach(sel => {
      sel.addEventListener('change', async (e) => {
        const source    = e.target.dataset.source;
        const field     = e.target.dataset.field;
        const newHeader = e.target.value;
        if (!state.files[source]) return;

        state.aliases[source] = state.aliases[source] || {};
        if (newHeader) state.aliases[source][field] = [newHeader];
        else           delete state.aliases[source][field];

        try {
          const result = await AppParsers.parseAndMap(state.files[source], source, state.aliases);
          state.parsed[source] = result;
          _matNetCacheKey = null;                  // invalidate net-consumption cache
          if (state.dq) runDqGate();
          renderSchema();
          renderAllDropStats();                    // refresh per-drop counts + cross-file recon
          populateScopeOptions();
          // If user re-mapped the userList file, re-derive scope.manual.{materials|workOrders}
          // APP-E22: branch on which column (material vs order) is now populated.
          if (state.assessmentType === 'userList' && source === 'userList' && state.parsed.userList) {
            const rows = state.parsed.userList.canonical;
            const mats = uniq(rows.map(r => String(r.material || '').trim()).filter(Boolean));
            const ords = uniq(rows.map(r => String(r.order    || '').trim()).filter(Boolean));
            const ta = $('#manualPaste');
            if (ords.length && !mats.length) {
              state.scope.manual.workOrders = ords;
              state.scope.manual.materials  = [];
              state.scope.manual.listType   = 'workOrders';
              if (ta) ta.value = ords.join('\n');
              setManualUiMode('workOrders');
            } else {
              state.scope.manual.materials  = mats;
              state.scope.manual.workOrders = [];
              state.scope.manual.listType   = 'materials';
              if (ta) ta.value = mats.join('\n');
              setManualUiMode('materials');
            }
            renderManualDetectChip();
            renderScopePreview();
          }
          renderJsonPreview();
          renderScopeSummary();
        } catch (err) {
          toast('Re-parse failed: ' + (err.message || err), 'crit');
        }
      });
    });
  }

  /* ═════════════════════════════════════════════════════════════════════════
     STEP 3 — Data Quality Gate (port of 01_data_quality.py)
  ═════════════════════════════════════════════════════════════════════════ */

  function runDqGate(){
    const issues = [];
    const warnings = [];
    const tiles = [];

    const mb51 = state.parsed.mb51?.canonical || [];
    const iw39 = state.parsed.iw39?.canonical || [];
    const fleet = state.parsed.fleetMaster?.canonical || [];
    const master = state.parsed.inventoryMaster?.canonical || [];

    // ── MB51 ─────────────────────────────────────────────────────────
    if (mb51.length === 0) {
      issues.push({ code:'mb51_empty', sev:'crit', msg:'MB51 has no rows' });
    } else {
      const dates = mb51.map(r => r.postingDate).filter(Boolean).sort();
      const minD = dates[0], maxD = dates[dates.length-1];
      const months = monthsBetween(minD, maxD);
      tiles.push({ lab:'MB51 rows',           v:mb51.length.toLocaleString(),  desc:`${minD || '?'} → ${maxD || '?'}` });
      tiles.push({ lab:'MB51 span (months)',  v:months.toString(),             desc:'≥ 12 required',
                   cls: months < 12 ? 'crit' : 'ok' });
      if (months < 12) issues.push({ code:'mb51_span', sev:'crit', msg:`MB51 spans only ${months} months — minimum 12 required` });

      const movs = uniq(mb51.map(r => String(r.movementType || '').trim())).filter(Boolean).sort();
      /* PERF-INT-DQ — a performance run uses far more movement types than
         Tune's rate engine: 107/108 (3PL side), 109/110 (site receipt) and
         everything the stock rebuild signs. Only types NEITHER uses are
         reported, and as information — they don't change any number. */
      if (state.assessmentType === 'scPerformance') {
        const bc = (typeof InventoryBackCalc !== 'undefined') ? InventoryBackCalc : null;
        const used = new Set(['107','108','109','110']);
        if (bc) { Object.keys(bc.MVT_SIGN).forEach(k => used.add(k)); bc.DIRECTIONAL_MVTS.forEach(k => used.add(k)); }
        const unusedT = movs.filter(m => !used.has(m));
        if (unusedT.length) warnings.push({ code:'mb51_movts_unused', sev:'warn', msg:`MB51 movement types not used by the stock rebuild or the receipt chain: ${unusedT.join(', ')} — they don't move site stock in this model and are left out.` });
      } else {
      const expected = ['109','261','262','201','202'];
      const unexpected = movs.filter(m => !expected.includes(m));
      if (unexpected.length) warnings.push({ code:'mb51_movts', sev:'warn', msg:`MB51 has unexpected movement types: ${unexpected.join(', ')} — will be ignored downstream` });
      }

      const has261 = movs.includes('261');
      const has262 = movs.includes('262');
      const has109 = movs.includes('109');
      if (!has261) issues.push({ code:'mb51_no_261', sev:'crit', msg:'MB51 has no 261 (goods issue) movements' });
      if (!has262) warnings.push({ code:'mb51_no_262', sev:'warn', msg:'MB51 has no 262 (return) movements — net = gross' });
      if (!has109) warnings.push({ code:'mb51_no_109', sev:'warn', msg:'MB51 has no 109 (goods receipt) movements — the stock-on-hand line on the analysis chart will show drawdowns only. Re-export with movement type 109 included to see replenishment.' });

      const uniqMats = new Set(mb51.map(r => String(r.material || '').trim()).filter(Boolean));
      tiles.push({ lab:'MB51 unique materials', v:uniqMats.size.toLocaleString(), desc:'distinct material numbers' });
    }

    // ── PERF-INT-DQ — PR History (the procurement chains) ────────────
    if (state.assessmentType === 'scPerformance') perfDqPrHistory(mb51, issues, warnings, tiles);

    // ── IW39 ─────────────────────────────────────────────────────────
    if (iw39.length === 0 && state.assessmentType === 'scPerformance') {
      /* PERF-INT-DQ — IW39 isn't used by a performance run; no warning. */
    } else if (iw39.length === 0) {
      warnings.push({ code:'iw39_empty', sev:'warn', msg:'IW39 has no rows — fleet scope will be empty' });
    } else {
      const histRows = iw39.filter(r => r.basicStartDate && r.basicStartDate <= state.runDate);
      const futRows  = iw39.filter(r => r.basicStartDate && r.basicStartDate >  state.runDate);
      tiles.push({ lab:'IW39 historical', v:histRows.length.toLocaleString(), desc:`vs ${futRows.length} future (excluded)` });
      if (histRows.length === 0) issues.push({ code:'iw39_no_hist', sev:'crit', msg:'IW39 has no historical orders after future-date filter' });

      // Coverage: % of MB51 orders found in IW39
      if (mb51.length) {
        const iw39Orders = new Set(iw39.map(r => String(r.order || '').trim()).filter(Boolean));
        const mb51Orders = new Set(mb51.map(r => String(r.order || '').trim()).filter(Boolean));
        const overlap    = [...mb51Orders].filter(o => iw39Orders.has(o)).length;
        const pct        = mb51Orders.size ? (overlap / mb51Orders.size * 100).toFixed(1) : '0';
        tiles.push({ lab:'IW39 ⊃ MB51 orders', v:`${pct}%`, desc:`${overlap.toLocaleString()} / ${mb51Orders.size.toLocaleString()}`,
                     cls: parseFloat(pct) < 50 ? 'warn' : 'ok' });
        if (parseFloat(pct) < 50) warnings.push({ code:'iw39_coverage', sev:'warn', msg:`Only ${pct}% of MB51 orders found in IW39 — fleet WO filter will exclude many MB51 rows` });
      }
    }

    // ── Fleet Master ─────────────────────────────────────────────────
    if (fleet.length === 0 && state.assessmentType === 'scPerformance') {
      /* PERF-INT-DQ — Fleet Master isn't used by a performance run. */
    } else if (fleet.length === 0) {
      warnings.push({ code:'fleet_empty', sev:'warn', msg:'Fleet Master has no rows — fleet scope mode unavailable' });
    } else {
      const models = uniq(fleet.map(r => String(r.model || '').trim()).filter(Boolean));
      tiles.push({ lab:'Fleet models',    v:models.length.toString(), desc:`${fleet.length} units total` });
      // Case-dupe check
      const lowerMap = {};
      models.forEach(m => {
        const k = m.toLowerCase();
        (lowerMap[k] = lowerMap[k] || []).push(m);
      });
      const caseDupes = Object.values(lowerMap).filter(arr => arr.length > 1);
      caseDupes.forEach(arr => {
        issues.push({ code:'fleet_case_dupe', sev:'crit', msg:`Fleet model case conflict: ${JSON.stringify(arr)} — confirm merge before proceeding` });
      });
    }

    // ── Inventory Master ──────────────────────────────────────────────
    if (master.length === 0) {
      issues.push({ code:'master_empty', sev:'crit', msg:'Inventory Master has no rows' });
    } else {
      const mats = new Set(master.map(r => String(r.material || '').trim()).filter(Boolean));
      tiles.push({ lab:'Inv Master materials', v:mats.size.toLocaleString(), desc:'with MRP settings' });
      // Reconciliation against MB51
      if (mb51.length) {
        const mb51Mats = new Set(mb51.map(r => String(r.material || '').trim()).filter(Boolean));
        const matched  = [...mb51Mats].filter(m => mats.has(m)).length;
        const unmatch  = mb51Mats.size - matched;
        const pct      = mb51Mats.size ? (matched / mb51Mats.size * 100).toFixed(1) : '0';
        tiles.push({ lab:'Reconciliation', v:`${pct}%`, desc:`${unmatch.toLocaleString()} not in Master`,
                     cls: parseFloat(pct) < 80 ? 'warn' : 'ok' });
        if (unmatch > 0) {
          warnings.push({ code:'master_recon', sev:'warn', msg:`${unmatch} MB51 materials not in Inventory Master — will be excluded from MRP analysis` });
        }
      }
      // Case-dupe check on materials
      const lower = {};
      master.forEach(r => {
        const m = String(r.material || '').trim();
        if (!m) return;
        const k = m.toLowerCase();
        (lower[k] = lower[k] || []).push(m);
      });
      const dupes = Object.values(lower).filter(a => uniq(a).length > 1);
      if (dupes.length) issues.push({ code:'master_case_dupe', sev:'crit', msg:`${dupes.length} material case-conflict(s) in Inventory Master` });
    }

    // ── APP-FIX-SNAPSHOT-ALIGN — Inventory Master extract date vs MB51 cut-off ──
    // The SOH back-calc anchors today's Inventory Master stock and walks MB51
    // backward; it assumes the snapshot is AS AT the MB51 cut-off. If they differ,
    // every reconstructed SOH line + stockout flag is offset by the net of the gap
    // movements. Strict same-day; warn-and-proceed (does not block the run).
    if (master.length) {
      if (state.inventoryMasterDate && mb51.length) {
        const lastMb51 = mb51.map(r => r.postingDate).filter(Boolean).sort().pop() || null;
        if (lastMb51 && lastMb51 !== state.inventoryMasterDate) {
          const gap = Math.round((Date.parse(lastMb51) - Date.parse(state.inventoryMasterDate)) / 86400000);
          const n = Math.abs(gap), d = n === 1 ? 'day' : 'days';
          const dir = gap > 0
            ? `${n} ${d} of movements occurred after the stock snapshot`
            : `the stock snapshot is ${n} ${d} after the last MB51 movement`;
          warnings.push({ code:'snapshot_align', sev:'warn',
            msg:`Inventory Master dated ${state.inventoryMasterDate}, MB51 runs to ${lastMb51} — ${dir}. The reconstructed Stock-on-Hand line and stockout flags will be offset by the net of those movements. Re-extract both on the same SAP run date.` });
        }
      } else if (!state.inventoryMasterDate) {
        warnings.push({ code:'snapshot_nodate', sev:'warn',
          msg:`No Inventory Master extract date set — can't confirm the stock snapshot lines up with the MB51 cut-off, so the Stock-on-Hand line may be offset. Set the extract date (Step 1, under the Inventory Master upload).` });
      }
    }

    state.dq = {
      issues, warnings, tiles,
      passed: issues.length === 0
    };
    renderDq();
    renderJsonPreview();
    populateScopeOptions();
  }

  /* PERF-INT-DQ — PR History checks for a performance run. Everything the
     chain metrics depend on is counted here so a thin or mis-mapped extract
     shows up BEFORE the Workbench draws a histogram from it. */
  function perfDqPrHistory(mb51, issues, warnings, tiles){
    const raw = state.parsed.prHistory?.canonical || [];
    const pr  = raw.filter(r => String(r.material || '').trim());
    const blank = raw.length - pr.length;
    if (!pr.length) { issues.push({ code:'pr_empty', sev:'crit', msg:'PR History has no rows with a material number' }); return; }
    const dates = pr.map(r => r.prDate).filter(Boolean).sort();
    tiles.push({ lab:'PR lines', v: pr.length.toLocaleString(), desc: `${dates[0] || '?'} → ${dates[dates.length - 1] || '?'}` });
    if (blank) warnings.push({ code:'pr_blank_rows', sev:'warn', msg:`${blank.toLocaleString()} PR History row${blank === 1 ? ' carries' : 's carry'} no material (SAP sub-header / totals rows) — left out.` });
    const noDate = pr.filter(r => !r.prDate).length;
    if (noDate) warnings.push({ code:'pr_no_date', sev:'warn', msg:`${noDate.toLocaleString()} PR line${noDate === 1 ? '' : 's'} have no requisition date — they can't be placed on a timeline and are counted as data gaps.` });
    const withPo = pr.filter(r => String(r.purchaseOrder || '').trim());
    const pctN = (a, b) => b ? Math.round(a / b * 100) : 0;
    tiles.push({ lab:'PR → PO', v: pctN(withPo.length, pr.length) + '%', desc: `${withPo.length.toLocaleString()} lines carry a PO` });
    const ci = pr.filter(r => String(r.creationIndicator || '').trim()).length;
    if (!ci) warnings.push({ code:'pr_no_ci', sev:'warn', msg:'PR History has no Creation indicator — MRP-created vs manual PRs can\'t be told apart (MRP cadence views will treat every PR as unknown).' });
    const nb = pr.filter(r => r.deliveryDate).length;
    tiles.push({ lab:'Need-by dates', v: pctN(nb, pr.length) + '%', desc: 'PR Delivery Date — the plan', cls: nb ? 'ok' : 'warn' });
    if (!nb) warnings.push({ code:'pr_no_needby', sev:'warn', msg:'PR History has no Delivery Date (need-by) — the plan-vs-actual views will be empty. Include the "Delivery Date" column in the extract.' });
    // Receipt join: POs in PR History that show a 107 / 109 in MB51
    const mbPo = new Map();
    for (const r of mb51) {
      const po = String(r.purchaseOrder || '').trim(); if (!po) continue;
      const mt = String(r.movementType || '').trim();
      if (mt !== '107' && mt !== '109') continue;
      const k = po + '|' + String(r.material || '').trim();
      mbPo.set(k, true);
    }
    let joined = 0;
    for (const r of withPo) if (mbPo.has(String(r.purchaseOrder).trim() + '|' + String(r.material).trim())) joined++;
    tiles.push({ lab:'PO receipts found', v: pctN(joined, withPo.length) + '%', desc: `${joined.toLocaleString()} of ${withPo.length.toLocaleString()} PR→PO lines have a 107/109 in MB51`,
                 cls: withPo.length && joined / withPo.length < 0.5 ? 'warn' : 'ok' });
    if (withPo.length && joined / withPo.length < 0.5) warnings.push({ code:'pr_po_join', sev:'warn', msg:`Only ${pctN(joined, withPo.length)}% of PR lines with a PO find a 107 / 109 receipt in MB51 — check MB51 carries the "Purchase order" column and covers the same period. Unmatched POs show as still in flight.` });
  }

  function renderDq(){
    const dq = state.dq;
    if (!dq) return;
    const tilesHost = $('#dqTiles'); tilesHost.innerHTML = '';
    dq.tiles.forEach(t => {
      const el = document.createElement('div');
      el.className = 'dq-tile';
      el.innerHTML = `<span class="lab">${t.lab}</span><div class="v ${t.cls || ''}">${t.v}</div><div class="desc">${t.desc || ''}</div>`;
      tilesHost.appendChild(el);
    });
    const listHost = $('#dqList'); listHost.innerHTML = '';
    dq.issues.concat(dq.warnings).forEach(i => {
      const li = document.createElement('li');
      li.className = i.sev;
      li.innerHTML = `<span class="sev">${i.sev}</span><span>${escapeHtml(i.msg)}</span>`;
      listHost.appendChild(li);
    });
    if (dq.issues.length === 0 && dq.warnings.length === 0) {
      listHost.innerHTML = '<li class="ok"><span class="sev">ok</span><span>All checks passed.</span></li>';
    }
    const status = $('#step3Status');
    if (dq.issues.length)        { status.textContent = `${dq.issues.length} critical · halt`; status.className = 'step-status crit'; }
    else if (dq.warnings.length) { status.textContent = `${dq.warnings.length} warning${dq.warnings.length>1?'s':''} · review`; status.className = 'step-status warn'; }
    else                          { status.textContent = 'green'; status.className = 'step-status done'; }

    // enable / disable scope step
    const scopeStep = $('#step4');
    if (dq.passed) scopeStep.classList.remove('disabled');
    else           scopeStep.classList.add('disabled');
  }

  /* ═════════════════════════════════════════════════════════════════════════
     STEP 4 — Scope selector
  ═════════════════════════════════════════════════════════════════════════ */

  function setupScopeTabs(){
    $$('.scope-tabs .tab').forEach(t => {
      t.addEventListener('click', () => {
        const mode = t.dataset.mode;
        state.scope.mode = mode;
        $$('.scope-tabs .tab').forEach(x => x.classList.toggle('active', x === t));
        $$('.scope-pane').forEach(p => p.classList.toggle('hidden', p.dataset.mode !== mode));
        // show/hide conditional drops
        document.querySelector('.drop[data-source="materialVendor"]').parentElement.classList.toggle('hidden', mode !== 'byVendor');
        refreshUploadFlags();   // APP-INT-NEEDS-01 — Material→Vendor flips to required under By-Vendor scope
        renderScopePreview();
        renderJsonPreview();
      });
    });
  }

  function populateScopeOptions(){
    // Fleet — chips for each model
    const fleet = state.parsed.fleetMaster?.canonical || [];
    const models = uniq(fleet.map(r => String(r.model || '').trim()).filter(Boolean)).sort();
    const fleetHost = $('#fleetModels'); fleetHost.innerHTML = '';
    models.forEach(m => {
      const c = chip(m, () => {
        const arr = state.scope.fleet.models;
        const i = arr.indexOf(m);
        if (i >= 0) arr.splice(i, 1); else arr.push(m);
        c.classList.toggle('selected');
        renderScopePreview();
        renderJsonPreview();
      });
      if (state.scope.fleet.models.includes(m)) c.classList.add('selected');
      fleetHost.appendChild(c);
    });

    // Classification — populate inventory types & MRP classifiers
    const master = state.parsed.inventoryMaster?.canonical || [];
    const invTypes = uniq(master.map(r => String(r.inventoryType || '').trim()).filter(Boolean)).sort();
    const mrpInds  = uniq(master.map(r => String(r.mrpInd || '').trim()).filter(Boolean)).sort();

    const invHost = $('#classifInvTypes'); invHost.innerHTML = '';
    invTypes.forEach(t => {
      const c = chip(t, () => {
        const arr = state.scope.byClassification.inventoryTypes;
        const i = arr.indexOf(t);
        if (i >= 0) arr.splice(i, 1); else arr.push(t);
        c.classList.toggle('selected');
        renderScopePreview();
        renderJsonPreview();
      });
      if (state.scope.byClassification.inventoryTypes.includes(t)) c.classList.add('selected');
      invHost.appendChild(c);
    });

    const mrpHost = $('#classifMrp'); mrpHost.innerHTML = '';
    mrpInds.forEach(t => {
      const c = chip(t, () => {
        const arr = state.scope.byClassification.mrpClassifiers;
        const i = arr.indexOf(t);
        if (i >= 0) arr.splice(i, 1); else arr.push(t);
        c.classList.toggle('selected');
        renderScopePreview();
        renderJsonPreview();
      });
      if (state.scope.byClassification.mrpClassifiers.includes(t)) c.classList.add('selected');
      mrpHost.appendChild(c);
    });

    // Vendor — populated only if materialVendor parsed
    const vmap = state.parsed.materialVendor?.canonical || [];
    const vendors = uniq(vmap.map(r => String(r.vendor || '').trim()).filter(Boolean)).sort();
    const vendorHost = $('#vendorList'); vendorHost.innerHTML = '';
    if (vendors.length === 0) {
      vendorHost.innerHTML = '<div class="hint">Upload a Material-Vendor mapping file (Step 1, conditional zone) to populate this list.</div>';
    } else {
      vendors.forEach(v => {
        const c = chip(v, () => {
          const arr = state.scope.byVendor.vendors;
          const i = arr.indexOf(v);
          if (i >= 0) arr.splice(i, 1); else arr.push(v);
          c.classList.toggle('selected');
          renderScopePreview();
          renderJsonPreview();
        });
        if (state.scope.byVendor.vendors.includes(v)) c.classList.add('selected');
        vendorHost.appendChild(c);
      });
    }

    renderScopePreview();
  }

  function chip(label, onclick){
    const el = document.createElement('span');
    el.className = 'chip';
    el.textContent = label;
    el.addEventListener('click', onclick);
    return el;
  }

  function renderScopePreview(){
    const mode = state.scope.mode;
    const host = document.querySelector(`.scope-pane[data-mode="${mode}"] .scope-preview`);
    if (!host) return;

    const fleet  = state.parsed.fleetMaster?.canonical || [];
    const iw39   = state.parsed.iw39?.canonical || [];
    const master = state.parsed.inventoryMaster?.canonical || [];
    const mb51   = state.parsed.mb51?.canonical || [];
    const vmap   = state.parsed.materialVendor?.canonical || [];

    /* PERF-INT-TYPE — every material in the files: MB51 ∪ PR History. */
    if (mode === 'allMaterials') {
      const pr = state.parsed.prHistory?.canonical || [];
      const mbM = new Set(mb51.map(r => String(r.material || '').trim()).filter(Boolean));
      const prM = new Set(pr.map(r => String(r.material || '').trim()).filter(Boolean));
      const all = new Set([...mbM, ...prM]);
      host.innerHTML = `<span class="v">${all.size.toLocaleString()}</span> materials in the files &middot; `
        + `<span class="v">${mbM.size.toLocaleString()}</span> with MB51 movements &middot; `
        + `<span class="v">${prM.size.toLocaleString()}</span> with PR history`;
      return;
    }

    if (mode === 'fleet') {
      const sel = state.scope.fleet.models;
      const units = fleet.filter(r => sel.includes(String(r.model || '').trim()));
      const sortFields = new Set(units.map(u => String(u.sortField || '').trim()).filter(Boolean));
      const fleetOrders = iw39.filter(o => sortFields.has(String(o.sortField || '').trim()) && o.basicStartDate <= state.runDate);
      host.innerHTML = sel.length === 0
        ? `<span class="v warn">no models selected</span> &middot; pick one or more from the chips above`
        : `selected <span class="v">${sel.length}</span> model${sel.length>1?'s':''} &middot; <span class="v">${units.length}</span> equipment unit${units.length===1?'':'s'} &middot; <span class="v">${fleetOrders.length.toLocaleString()}</span> qualifying historical work order${fleetOrders.length===1?'':'s'}`;
    }

    if (mode === 'manual') {
      /* APP-E22 — branch on listType. WO list previews IW39 coverage + the
         number of materials the WO set will resolve to in MB51. */
      const lt = state.scope.manual.listType || 'materials';
      if (lt === 'workOrders') {
        const list = state.scope.manual.workOrders || [];
        const ordMb51 = new Set(mb51.map(r => String(r.order || '').trim()));
        const ordIw39 = new Set((state.parsed.iw39?.canonical || []).map(r => String(r.order || '').trim()));
        const inMb51  = list.filter(o => ordMb51.has(o)).length;
        const inIw39  = list.filter(o => ordIw39.has(o)).length;
        /* Materials touched by these orders in MB51 = the derived material bucket */
        const woSet = new Set(list);
        const derivedMats = new Set();
        for (const r of mb51) {
          if (woSet.has(String(r.order || '').trim())) {
            const m = String(r.material || '').trim();
            if (m) derivedMats.add(m);
          }
        }
        const iw39Chip = state.parsed.iw39
          ? `in IW39: <span class="v">${inIw39}</span>`
          : `<span class="v warn">IW39 not loaded</span>`;
        host.innerHTML = list.length === 0
          ? `<span class="v warn">no work orders provided</span> &middot; paste or upload below`
          : `<span class="v">${list.length}</span> work order${list.length===1?'':'s'} &middot; in MB51: <span class="v">${inMb51}</span> &middot; ${iw39Chip} &middot; resolves to <span class="v">${derivedMats.size}</span> material${derivedMats.size===1?'':'s'}`;
      } else {
        const list = state.scope.manual.materials || [];
        const masterMats = new Set(master.map(r => String(r.material || '').trim()));
        const mb51Mats   = new Set(mb51.map(r => String(r.material || '').trim()));
        const inMaster   = list.filter(m => masterMats.has(m)).length;
        const inMb51     = list.filter(m => mb51Mats.has(m)).length;
        host.innerHTML = list.length === 0
          ? `<span class="v warn">no materials provided</span> &middot; paste or upload below`
          : `<span class="v">${list.length}</span> material${list.length===1?'':'s'} &middot; in MB51: <span class="v">${inMb51}</span> &middot; in Inventory Master: <span class="v">${inMaster}</span>`;
      }
    }

    if (mode === 'byClassification') {
      const f = state.scope.byClassification;
      const matching = master.filter(r => {
        if (f.inventoryTypes.length && !f.inventoryTypes.includes(String(r.inventoryType || '').trim())) return false;
        if (f.mrpClassifiers.length && !f.mrpClassifiers.includes(String(r.mrpInd || '').trim())) return false;
        return true;
      });
      // Movement amount filter is applied per-material against MB51 net consumption
      let withinMvmt = matching;
      if (f.movementAmount.min != null || f.movementAmount.max != null) {
        const matNet = computeNetConsumption(mb51);
        withinMvmt = matching.filter(r => {
          const m = String(r.material || '').trim();
          const net = matNet[m] || 0;
          if (f.movementAmount.min != null && net < f.movementAmount.min) return false;
          if (f.movementAmount.max != null && net > f.movementAmount.max) return false;
          return true;
        });
      }
      const byMrp = {};
      withinMvmt.forEach(r => {
        const k = String(r.mrpInd || '—').trim();
        byMrp[k] = (byMrp[k] || 0) + 1;
      });
      const mrpBreakdown = Object.entries(byMrp).map(([k,v]) => `<span class="v">${k}</span>:${v}`).join(' &middot; ') || '—';
      host.innerHTML = `<span class="v">${withinMvmt.length}</span> material${withinMvmt.length===1?'':'s'} match &middot; ${mrpBreakdown}`;
    }

    if (mode === 'byVendor') {
      const sel = state.scope.byVendor.vendors;
      const matsByVendor = {};
      vmap.forEach(r => {
        const v = String(r.vendor || '').trim();
        if (!sel.includes(v)) return;
        (matsByVendor[v] = matsByVendor[v] || new Set()).add(String(r.material || '').trim());
      });
      const total = Object.values(matsByVendor).reduce((a, s) => a + s.size, 0);
      // total consumption
      const matNet = computeNetConsumption(mb51);
      let consumption = 0;
      Object.values(matsByVendor).forEach(s => s.forEach(m => { consumption += matNet[m] || 0; }));
      host.innerHTML = sel.length === 0
        ? `<span class="v warn">no vendors selected</span>`
        : `<span class="v">${sel.length}</span> vendor${sel.length===1?'':'s'} &middot; <span class="v">${total}</span> material${total===1?'':'s'} &middot; net consumption (12mo): <span class="v">${Math.round(consumption).toLocaleString()}</span>`;
    }
  }

  // Net consumption per material (cached)
  let _matNetCache = null;
  let _matNetCacheKey = null;
  function computeNetConsumption(mb51){
    const key = mb51.length;
    if (_matNetCacheKey === key && _matNetCache) return _matNetCache;
    const out = {};
    for (const r of mb51) {
      const m = String(r.material || '').trim();
      if (!m) continue;
      const mt = String(r.movementType || '').trim();
      const q  = parseFloat(r.quantity);
      if (isNaN(q)) continue;
      out[m] = out[m] || 0;
      if (mt === '261' || mt === '201') out[m] += Math.abs(q);
      if (mt === '262' || mt === '202') out[m] -= Math.abs(q);
    }
    _matNetCache = out; _matNetCacheKey = key;
    return out;
  }

  /* ─── Manual paste handling ─────────────────────────────────────────────────
     APP-E22 — list can be materials OR work orders. Auto-detect with override:
       · Three buttons above the textarea: [Auto] [Materials] [Work Orders]
       · Auto runs detectListTypeFromTokens against parsed inventoryMaster /
         MB51 / IW39 and chooses materials vs workOrders.
       · Operator can flip with one click; flip persists until they re-pick Auto.
       · Detection chip below textarea reports counts + IW39 cross-check. */

  function parseManualTokens(){
    const ta = $('#manualPaste');
    if (!ta) return [];
    return ta.value
      .split(/[\s,;\t]+/)
      .map(s => s.trim())
      .filter(Boolean);
  }

  function detectListTypeFromTokens(tokens){
    const matMaster = new Set((state.parsed.inventoryMaster?.canonical || [])
      .map(r => String(r.material || '').trim()).filter(Boolean));
    const matMb51   = new Set((state.parsed.mb51?.canonical || [])
      .map(r => String(r.material || '').trim()).filter(Boolean));
    const ordMb51   = new Set((state.parsed.mb51?.canonical || [])
      .map(r => String(r.order || '').trim()).filter(Boolean));
    const ordIw39   = new Set((state.parsed.iw39?.canonical || [])
      .map(r => String(r.order || '').trim()).filter(Boolean));

    const materialSet = new Set([...matMaster, ...matMb51]);
    const orderSet    = new Set([...ordMb51, ...ordIw39]);

    let mHits = 0, wHits = 0, both = 0, none = 0;
    for (const t of tokens) {
      const isMat = materialSet.has(t);
      const isOrd = orderSet.has(t);
      if (isMat && isOrd) both++;
      else if (isMat) mHits++;
      else if (isOrd) wHits++;
      else none++;
    }

    const n = tokens.length;
    if (n === 0) {
      return { listType: null, confidence: 'none', materialHits: 0, workOrderHits: 0, ambiguous: 0, unknown: 0, total: 0 };
    }
    const matVotes = mHits + both;
    const woVotes  = wHits + both;

    let listType = null;
    let confidence = 'low';
    if (mHits === n && wHits === 0) { listType = 'materials';  confidence = 'high'; }
    else if (wHits === n && mHits === 0) { listType = 'workOrders'; confidence = 'high'; }
    else if (matVotes >= 0.8 * n && wHits === 0) { listType = 'materials';  confidence = 'medium'; }
    else if (woVotes  >= 0.8 * n && mHits === 0) { listType = 'workOrders'; confidence = 'medium'; }
    /* else: mixed / ambiguous → listType stays null, operator must pick */

    return {
      listType, confidence,
      materialHits: mHits, workOrderHits: wHits,
      ambiguous: both, unknown: none, total: n
    };
  }

  function getManualUiMode(){
    /* Which chooser button is active. DOM is the source of truth; not persisted. */
    const active = document.querySelector('#manualTypeBar .ml-type.active');
    return active ? active.dataset.type : 'auto';
  }

  function setManualUiMode(mode){
    document.querySelectorAll('#manualTypeBar .ml-type').forEach(b => {
      b.classList.toggle('active', b.dataset.type === mode);
    });
  }

  function applyManualSelection(tokens, det){
    /* Apply detection result + chooser mode to state.scope.manual. */
    const uiMode = getManualUiMode();
    let listType;
    if (uiMode === 'materials' || uiMode === 'workOrders') {
      listType = uiMode;
    } else {
      /* auto */
      listType = det.listType || 'materials';   /* fall back to materials when ambiguous */
    }
    state.scope.manual.listType = listType;
    if (listType === 'workOrders') {
      state.scope.manual.workOrders = tokens.slice();
      state.scope.manual.materials  = [];
    } else {
      state.scope.manual.materials  = tokens.slice();
      state.scope.manual.workOrders = [];
    }
    state.scope.manual.detection = {
      confidence:   det.confidence,
      materialHits: det.materialHits,
      workOrderHits: det.workOrderHits,
      ambiguous:    det.ambiguous,
      unknown:      det.unknown,
      total:        det.total,
      source:       'paste',
      userOverride: (uiMode !== 'auto'),
      pickedAt:     (typeof AppLocale !== 'undefined' ? AppLocale.localStampCompact() : new Date().toISOString())
    };
  }

  function renderManualDetectChip(){
    const chip = $('#manualDetectChip');
    if (!chip) return;
    const tokens = parseManualTokens();
    if (tokens.length === 0) {
      chip.className = 'ml-detect-chip hidden';
      chip.innerHTML = '';
      return;
    }
    const det = detectListTypeFromTokens(tokens);
    const uiMode = getManualUiMode();
    const lt = state.scope.manual.listType;
    const iw39Loaded = !!(state.parsed.iw39);
    const ordIw39 = new Set((state.parsed.iw39?.canonical || [])
      .map(r => String(r.order || '').trim()));
    const woConfirmed = tokens.filter(t => ordIw39.has(t)).length;
    const woMissing   = tokens.length - woConfirmed;

    let cls = 'info', txt = '';
    if (uiMode === 'auto') {
      if (det.listType === null) {
        cls = 'warn';
        txt = `Could not auto-detect &middot; <span class="v">${det.materialHits}</span> look like materials, <span class="v">${det.workOrderHits}</span> look like work orders, <span class="v">${det.unknown}</span> matched neither. Pick <b>Materials</b> or <b>Work Orders</b> above.`;
      } else if (det.listType === 'materials') {
        cls = det.confidence === 'high' ? 'ok' : 'info';
        const note = det.unknown ? ` &middot; ${det.unknown} unmatched` : '';
        txt = `Auto-detected &middot; <span class="v">${tokens.length}</span> items look like materials${note} &middot; scope = <b>Materials</b>`;
      } else {
        cls = det.confidence === 'high' ? 'ok' : 'info';
        const iw = iw39Loaded
          ? ` &middot; IW39 confirms <span class="v">${woConfirmed} / ${tokens.length}</span>`
          : ' &middot; IW39 not loaded — coverage cannot be verified';
        const warn = (iw39Loaded && woMissing > 0)
          ? ` &middot; <span class="v">${woMissing}</span> not in IW39 (still filter MB51)`
          : '';
        txt = `Auto-detected &middot; <span class="v">${tokens.length}</span> items look like work orders${iw}${warn} &middot; scope = <b>Work Orders</b>`;
      }
    } else {
      if (lt === 'workOrders') {
        const iw = iw39Loaded
          ? ` &middot; IW39 confirms <span class="v">${woConfirmed} / ${tokens.length}</span>`
          : ' &middot; IW39 not loaded — coverage cannot be verified';
        const warn = (iw39Loaded && woMissing > 0)
          ? ` &middot; <span class="v">${woMissing}</span> not in IW39 (still filter MB51)`
          : '';
        txt = `Set manually to <b>Work Orders</b> &middot; <span class="v">${tokens.length}</span> items${iw}${warn}`;
        cls = (iw39Loaded && woMissing > tokens.length * 0.2) ? 'warn' : 'info';
      } else {
        const masterMats = new Set((state.parsed.inventoryMaster?.canonical || [])
          .map(r => String(r.material || '').trim()));
        const inMaster = tokens.filter(t => masterMats.has(t)).length;
        txt = `Set manually to <b>Materials</b> &middot; <span class="v">${tokens.length}</span> items &middot; in Inventory Master: <span class="v">${inMaster}</span>`;
        cls = 'info';
      }
    }
    chip.className = `ml-detect-chip ${cls}`;
    chip.innerHTML = txt;
  }

  function refreshManualScope(){
    const tokens = parseManualTokens();
    const det = detectListTypeFromTokens(tokens);
    applyManualSelection(tokens, det);
    renderManualDetectChip();
    renderScopePreview();
    renderJsonPreview();
  }

  // APP-INT-XREF (2026-06-27) — cross-check the pasted material list against the
  // loaded MB51 / Inventory Master / PR History, on demand. Counts + the missing
  // material numbers per source, so the operator can confirm the list has data
  // before running. Material lists only (work-order lists are flagged as N/A).
  function renderManualXref(){
    const host = $('#manualXrefResult');
    if (!host) return;
    host.classList.remove('hidden');
    const tokens = uniq(parseManualTokens());
    if (!tokens.length) {
      host.innerHTML = '<div class="ml-xref-empty">Paste a material list above, then check.</div>';
      return;
    }
    const lt = state.scope.manual.listType || getManualUiMode();
    if (lt === 'workOrders') {
      host.innerHTML = '<div class="ml-xref-empty">Cross-reference checks <b>material</b> lists against MB51 / Inventory Master / PR History. This list is currently set to Work Orders.</div>';
      return;
    }
    const sources = [
      { key: 'mb51',            label: 'MB51' },
      { key: 'inventoryMaster', label: 'Inventory Master' },
      { key: 'prHistory',       label: 'PR History' }
    ];
    const rows = sources.map(s => {
      const parsed = state.parsed[s.key];
      if (!parsed) return Object.assign({ loaded: false }, s);
      const set = new Set((parsed.canonical || []).map(r => String(r.material || '').trim()).filter(Boolean));
      const missing = tokens.filter(t => !set.has(t));
      return Object.assign({ loaded: true, found: tokens.length - missing.length, total: tokens.length, missing }, s);
    });
    const pill = r => {
      if (!r.loaded) return `<span class="ml-xref-pill na">${r.label}: not loaded</span>`;
      const pct = r.total ? r.found / r.total * 100 : 0;
      const cls = pct >= 90 ? 'ok' : (pct >= 50 ? 'warn' : 'crit');
      return `<span class="ml-xref-pill ${cls}">${r.label}: ${r.found}/${r.total}${r.missing.length ? ` &middot; ${r.missing.length} missing` : ''}</span>`;
    };
    const missingBlocks = rows.filter(r => r.loaded && r.missing.length).map(r =>
      `<details class="ml-xref-missing"><summary>${r.missing.length} not found in ${r.label}</summary><div class="ml-xref-missing-list">${r.missing.map(escapeHtml).join(', ')}</div></details>`
    ).join('');
    host.innerHTML = `<div class="ml-xref-pills">${rows.map(pill).join('')}</div>${missingBlocks}`;
  }

  function setupManualPaste(){
    const ta = $('#manualPaste');
    if (ta) {
      ta.addEventListener('input', () => {
        // APP-FIX-REUSE — typing/pasting marks the box as user-owned, so the
        // auto-fill from a (re)loaded user-list file never overwrites it.
        state.scope.manual.userEdited = true;
        refreshManualScope();
      });
    }
    // APP-INT-XREF — on-demand cross-check of the pasted list vs MB51 / Inv Master / PR.
    const xrefBtn = $('#manualXref');
    if (xrefBtn) xrefBtn.addEventListener('click', renderManualXref);
    /* Wire the three list-type chooser buttons. */
    document.querySelectorAll('#manualTypeBar .ml-type').forEach(btn => {
      btn.addEventListener('click', () => {
        setManualUiMode(btn.dataset.type);
        refreshManualScope();
      });
    });
    /* Initial chip state. */
    renderManualDetectChip();
  }

  function setupClassifInputs(){
    const minI = $('#mvmtMin'), maxI = $('#mvmtMax');
    minI.addEventListener('input', () => {
      const v = parseFloat(minI.value);
      state.scope.byClassification.movementAmount.min = isNaN(v) ? null : v;
      renderScopePreview(); renderJsonPreview();
    });
    maxI.addEventListener('input', () => {
      const v = parseFloat(maxI.value);
      state.scope.byClassification.movementAmount.max = isNaN(v) ? null : v;
      renderScopePreview(); renderJsonPreview();
    });
  }

  /* ═════════════════════════════════════════════════════════════════════════
     STEP 4b — Parameter Search filter panel
     PBI-style: drag a dimension from the bar onto the canvas. Each card
     supports Simple (chips / range) and Advanced (custom min-max, regex,
     comma-separated list) modes. Filters AND together.
  ═════════════════════════════════════════════════════════════════════════ */

  function setupParamSearch(){
    const bar = $('#psDimBar');
    if (!bar) return;
    bar.innerHTML = '';
    PS_DIMENSIONS.forEach(dim => {
      const pill = document.createElement('div');
      pill.className = 'ps-dim';
      pill.draggable = true;
      pill.dataset.dim = dim.key;
      pill.textContent = dim.label;
      pill.addEventListener('dragstart', (e) => {
        e.dataTransfer.setData('text/plain', dim.key);
        e.dataTransfer.effectAllowed = 'copy';
      });
      pill.addEventListener('click', () => addPsFilter(dim.key));   // click = quick-add
      bar.appendChild(pill);
    });
    const canvas = $('#psCanvas');
    canvas.addEventListener('dragover', (e) => {
      e.preventDefault();
      canvas.classList.add('drag-over');
      e.dataTransfer.dropEffect = 'copy';
    });
    canvas.addEventListener('dragleave', () => canvas.classList.remove('drag-over'));
    canvas.addEventListener('drop', (e) => {
      e.preventDefault();
      canvas.classList.remove('drag-over');
      const key = e.dataTransfer.getData('text/plain');
      if (key) addPsFilter(key);
    });
  }

  function addPsFilter(dimKey){
    if (state.psFilters.find(f => f.dim === dimKey)) return;   // already added
    const dim = PS_DIMENSIONS.find(d => d.key === dimKey);
    if (!dim) return;
    const filter = {
      dim:    dimKey,
      mode:   'simple',
      values: [],
      min:    null,
      max:    null,
      regex:  ''
    };
    state.psFilters.push(filter);
    renderParamSearch();
  }

  function removePsFilter(dimKey){
    state.psFilters = state.psFilters.filter(f => f.dim !== dimKey);
    renderParamSearch();
  }

  function renderParamSearch(){
    const canvas = $('#psCanvas');
    const bar    = $('#psDimBar');
    if (!canvas) return;

    // Mark in-use dimensions in the bar
    if (bar) {
      $$('#psDimBar .ps-dim').forEach(p => p.classList.toggle('in-use', !!state.psFilters.find(f => f.dim === p.dataset.dim)));
    }

    canvas.innerHTML = '';
    if (state.psFilters.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'ps-canvas-empty';
      empty.textContent = 'Drag a dimension here to start filtering.';
      canvas.appendChild(empty);
      $('#paramSearchStatus').textContent = 'no filters set';
      updatePsPreview();
      return;
    }

    state.psFilters.forEach(f => canvas.appendChild(renderPsFilterCard(f)));
    $('#paramSearchStatus').textContent = `${state.psFilters.length} filter${state.psFilters.length === 1 ? '' : 's'} active`;
    updatePsPreview();
  }

  function renderPsFilterCard(filter){
    const dim = PS_DIMENSIONS.find(d => d.key === filter.dim);
    const card = document.createElement('div');
    card.className = 'ps-filter';
    card.dataset.dim = filter.dim;

    card.innerHTML = `
      <div class="ps-filter-head">
        <span class="ps-filter-name">${escapeHtml(dim.label)}</span>
        <div class="ps-filter-mode">
          <button data-mode="simple" class="${filter.mode === 'simple' ? 'active' : ''}">Simple</button>
          <button data-mode="advanced" class="${filter.mode === 'advanced' ? 'active' : ''}">Advanced</button>
        </div>
        <span class="ps-filter-count" data-count></span>
        <button class="ps-filter-remove">✕ Remove</button>
      </div>
      <div class="ps-filter-body"></div>
    `;
    const body = card.querySelector('.ps-filter-body');

    if (dim.type === 'string') {
      if (filter.mode === 'simple') {
        const values = uniqueValuesFor(dim).sort();
        const chips = document.createElement('div');
        chips.className = 'ps-chip-row';
        values.forEach(v => {
          const chip = document.createElement('span');
          chip.className = 'ps-chip' + (filter.values.includes(v) ? ' on' : '');
          chip.textContent = v || '(blank)';
          chip.addEventListener('click', () => {
            const idx = filter.values.indexOf(v);
            if (idx >= 0) filter.values.splice(idx, 1); else filter.values.push(v);
            renderParamSearch();
          });
          chips.appendChild(chip);
        });
        if (values.length === 0) {
          chips.innerHTML = '<span class="ps-chip-summary">no values available — Inventory Master may not include this field</span>';
        }
        body.appendChild(chips);
      } else {
        // Advanced: comma-separated values OR regex
        body.innerHTML = `
          <div class="row-input">
            <label>Values</label>
            <input type="text" data-pskey="values"
              placeholder="comma-separated, e.g. VOLVO, KOMATSU"
              value="${escapeAttr(filter.values.join(', '))}">
          </div>
          <div class="row-input">
            <label>Regex</label>
            <input type="text" data-pskey="regex"
              placeholder="optional — overrides values, e.g. ^CAT-"
              value="${escapeAttr(filter.regex)}">
          </div>
        `;
      }
    } else {
      // numeric — both Simple and Advanced share min/max; Advanced just lets user enter precise decimals
      const stepAttr = (dim.unit === 'currency') ? 'step="100"' : 'step="1"';
      body.innerHTML = `
        <div class="row-input">
          <label>min</label>
          <input type="number" data-pskey="min" ${stepAttr}
            placeholder="—" value="${filter.min == null ? '' : filter.min}">
        </div>
        <div class="row-input">
          <label>max</label>
          <input type="number" data-pskey="max" ${stepAttr}
            placeholder="—" value="${filter.max == null ? '' : filter.max}">
        </div>
        <div class="ps-chip-summary">${dim.unit === 'currency' ? 'Currency units as stored on inventory master (currency unaware).' : 'Net consumption (issues − returns) over the analysis window.'}</div>
      `;
    }

    // Mode toggle
    card.querySelectorAll('.ps-filter-mode button').forEach(b => {
      b.addEventListener('click', () => {
        filter.mode = b.dataset.mode;
        renderParamSearch();
      });
    });
    // Remove
    card.querySelector('.ps-filter-remove').addEventListener('click', () => removePsFilter(filter.dim));
    // Input wiring
    body.querySelectorAll('input').forEach(inp => {
      inp.addEventListener('input', () => {
        const k = inp.dataset.pskey;
        if (k === 'min' || k === 'max') {
          const n = parseFloat(inp.value);
          filter[k] = isNaN(n) ? null : n;
        } else if (k === 'values') {
          filter.values = inp.value.split(',').map(s => s.trim()).filter(Boolean);
        } else if (k === 'regex') {
          filter.regex = inp.value;
        }
        updatePsPreview();
      });
    });

    // Per-card match count
    setTimeout(() => {
      const match = countMatchingMaterials([filter]);
      const c = card.querySelector('[data-count]');
      if (c) c.textContent = `${match.size} match${match.size === 1 ? '' : 'es'}`;
    }, 0);

    return card;
  }

  function uniqueValuesFor(dim){
    if (dim.from === 'master') {
      const master = state.parsed.inventoryMaster?.canonical || [];
      return uniq(master.map(r => String(r[dim.field] || '').trim()).filter(Boolean));
    }
    return [];
  }

  /* ─── Apply filters → resolved material set ─────────────────────────────── */
  function countMatchingMaterials(filters){
    const master = state.parsed.inventoryMaster?.canonical || [];
    if (master.length === 0) return new Set();

    // Per-material net consumption (cached)
    const matNet = computeNetConsumption(state.parsed.mb51?.canonical || []);

    const matched = new Set();
    for (const r of master) {
      const mat = String(r.material || '').trim();
      if (!mat) continue;
      if (passesAllFilters(r, mat, matNet, filters)) matched.add(mat);
    }
    return matched;
  }

  function passesAllFilters(masterRow, mat, matNet, filters){
    for (const f of filters) {
      const dim = PS_DIMENSIONS.find(d => d.key === f.dim);
      if (!dim) continue;

      if (dim.from === 'mb51_net') {
        const net = matNet[mat] || 0;
        if (f.min != null && net < f.min) return false;
        if (f.max != null && net > f.max) return false;
        continue;
      }

      if (dim.type === 'string') {
        const v = String(masterRow[dim.field] || '').trim();
        if (f.mode === 'advanced' && f.regex) {
          let re;
          try { re = new RegExp(f.regex); } catch { return false; }
          if (!re.test(v)) return false;
        } else {
          if (f.values.length === 0) continue;            // no constraint set
          if (!f.values.includes(v)) return false;
        }
      } else {
        const n = parseFloat(masterRow[dim.field]);
        if (isNaN(n)) {
          // If filter is set, NaN doesn't satisfy
          if (f.min != null || f.max != null) return false;
          continue;
        }
        if (f.min != null && n < f.min) return false;
        if (f.max != null && n > f.max) return false;
      }
    }
    return true;
  }

  function updatePsPreview(){
    const matched = countMatchingMaterials(state.psFilters);
    const master  = state.parsed.inventoryMaster?.canonical || [];
    const matNet  = computeNetConsumption(state.parsed.mb51?.canonical || []);

    let netSum = 0, valSum = 0;
    for (const r of master) {
      const m = String(r.material || '').trim();
      if (!matched.has(m)) continue;
      netSum += matNet[m] || 0;
      const v = parseFloat(r.totValueOh);
      if (!isNaN(v)) valSum += v;
    }
    const fmt = (n) => Math.round(n).toLocaleString('en-CA');

    if ($('#psMatCount'))      $('#psMatCount').textContent      = matched.size.toLocaleString('en-CA');
    if ($('#psNetConsumption'))$('#psNetConsumption').textContent= fmt(netSum);
    if ($('#psOnHandValue'))   $('#psOnHandValue').textContent   = AppLocale.fmtCAD(valSum);

    // Update resolvedMaterials on scope object for JSON serialization
    state.scope.parameterSearch = {
      filters: JSON.parse(JSON.stringify(state.psFilters)),
      resolvedMaterials: [...matched]
    };
    renderJsonPreview();
  }

  /* ═════════════════════════════════════════════════════════════════════════
     STEP 5 — Parameters
  ═════════════════════════════════════════════════════════════════════════ */

  async function loadDefaults(){
    state.aliases = await AppConfig.getAliases();
    state.paramsSaved = await AppConfig.getDefaults();
    state.paramsRun   = { ...state.paramsSaved };
    renderParams();
  }

  // APP-FIX-P1-RATE — snap a 'YYYY-MM-DD' to the 1st / last day of its (UTC) month.
  function snapMonthStartIso(iso){
    const d = new Date(iso); if (isNaN(d.getTime())) return iso;
    return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-01`;
  }
  function snapMonthEndIso(iso){
    const d = new Date(iso); if (isNaN(d.getTime())) return iso;
    const last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0));
    return `${last.getUTCFullYear()}-${String(last.getUTCMonth() + 1).padStart(2, '0')}-${String(last.getUTCDate()).padStart(2, '0')}`;
  }

  function renderParams(){
    const factory = CanonicalSchema.FACTORY_DEFAULTS;
    const saved   = state.paramsSaved;
    const run     = state.paramsRun;

    const fields = [
      { key:'minMaxMethod',        label:'Min/Max method',  type:'select', opts:['monthsBased','leadTimeBased'] },
      { key:'p1Start',             label:'P1 start',        type:'date' },
      { key:'p1End',               label:'P1 end',          type:'date' },
      { key:'p2Months',            label:'P2 months',       type:'number', step:1 },
      { key:'minMonths',           label:'Min months',      type:'number', step:1 },
      { key:'maxMonths',           label:'Max months',      type:'number', step:1 },
      { key:'batchedMinFactor',    label:'Batched Min factor', type:'number', step:0.05 },
      { key:'batchedMinGoverns',   label:'Batched Min governs', type:'select', opts:['off','on'] },
      { key:'threshold',           label:'Threshold',       type:'number', step:1 },
      { key:'minEventsThreshold',  label:'Min consumption events', type:'number', step:1 },
      { key:'hcePctThreshold',     label:'HCE % threshold', type:'number', step:0.05 },
      { key:'hceMultThreshold',    label:'HCE multiplier',  type:'number', step:0.5 },
      { key:'lumpyCvThreshold',    label:'Lumpy CV',        type:'number', step:0.1 },
      { key:'lumpyTopWoThreshold', label:'Lumpy top-WO',    type:'number', step:0.05 },
      { key:'invAdjSigmaThreshold',label:'Inv Adj σ threshold', type:'number', step:0.5 },
      { key:'wrSoftMonths',        label:'WR soft months',  type:'number', step:1 },
      { key:'wrHardMonths',        label:'WR hard months',  type:'number', step:1 },
      { key:'wrMrpTypes',          label:'WR MRP types',    type:'list',   placeholder:'PD, ZE' },
      { key:'socBackCalcMonths',   label:'Stock history window (months)', type:'number', step:1 }
    ];

    const descs = CanonicalSchema.PARAMETER_DESCRIPTIONS || {};
    const byKey = {}; for (const f of fields) byKey[f.key] = f;

    // Build one param cell (shared by the primary grid + the advanced roll-up).
    function buildCell(f){
      const cell = document.createElement('div');
      cell.className = 'param-cell' + (JSON.stringify(run[f.key]) !== JSON.stringify(saved[f.key]) ? ' dirty' : '');
      let input;
      if (f.type === 'select') {
        input = `<select data-pkey="${f.key}">${f.opts.map(o => `<option value="${o}" ${run[f.key]===o?'selected':''}>${o}</option>`).join('')}</select>`;
      } else if (f.type === 'date') {
        input = `<input type="date" data-pkey="${f.key}" value="${run[f.key] || ''}">`;
      } else if (f.type === 'list') {
        const v = Array.isArray(run[f.key]) ? run[f.key].join(', ') : '';
        input = `<input type="text" data-pkey="${f.key}" value="${escapeAttr(v)}" placeholder="${escapeAttr(f.placeholder || '')}">`;
      } else {
        input = `<input type="number" data-pkey="${f.key}" value="${run[f.key]}" step="${f.step || 1}">`;
      }
      const desc = descs[f.key] || '';
      const factoryDiff = JSON.stringify(factory[f.key]) !== JSON.stringify(saved[f.key]);
      const factoryDisplay = Array.isArray(factory[f.key]) ? factory[f.key].join(', ') : factory[f.key];
      const savedDisplay   = Array.isArray(saved[f.key])   ? saved[f.key].join(', ')   : saved[f.key];
      const factoryNote = factoryDiff ? `<div class="factory-note">factory: ${escapeHtml(String(factoryDisplay))} · saved: ${escapeHtml(String(savedDisplay))}</div>` : '';
      cell.innerHTML = `<label>${f.label}</label><div class="param-desc">${desc}</div>${input}${factoryNote}`;
      return cell;
    }

    // APP-INT-UITIDY — the params the operator actually tweaks per run are shown
    // up front; the rest live in a collapsed, sub-grouped "Advanced parameters"
    // roll-up so the step is short. Editing keeps the roll-up open (state flag).
    const PRIMARY = ['threshold','minEventsThreshold','minMonths','maxMonths','socBackCalcMonths'];
    const ADV_GROUPS = [
      { label:'Analysis windows',     keys:['minMaxMethod','p1Start','p1End','p2Months'] },
      { label:'Consumption pattern',  keys:['hcePctThreshold','hceMultThreshold','lumpyCvThreshold','lumpyTopWoThreshold'] },
      { label:'Batched Min',          keys:['batchedMinFactor','batchedMinGoverns'] },
      { label:'Working-redundant',    keys:['wrSoftMonths','wrHardMonths','wrMrpTypes'] },
      { label:'Inventory-adjustment', keys:['invAdjSigmaThreshold'] }
    ];

    const host = $('#paramsGrid');
    host.innerHTML = '';
    for (const k of PRIMARY) if (byKey[k]) host.appendChild(buildCell(byKey[k]));

    const adv = $('#paramsAdvanced');
    if (adv){
      const advKeys = ADV_GROUPS.flatMap(g => g.keys);
      const dirtyCount = advKeys.filter(k => JSON.stringify(run[k]) !== JSON.stringify(saved[k])).length;
      const open = !!state._paramsAdvOpen;
      adv.innerHTML = '';
      const toggle = document.createElement('button');
      toggle.type = 'button';
      toggle.className = 'params-adv-toggle' + (open ? ' open' : '');
      toggle.innerHTML = `<span class="chev">▸</span> Advanced parameters <span class="adv-meta">${advKeys.length} settings${dirtyCount ? ` · <b>${dirtyCount} overridden</b>` : ''}</span>`;
      adv.appendChild(toggle);
      const body = document.createElement('div');
      body.className = 'params-adv-body' + (open ? '' : ' collapsed');
      for (const g of ADV_GROUPS){
        const grp = document.createElement('div'); grp.className = 'params-adv-group';
        const gl = document.createElement('div'); gl.className = 'params-adv-label'; gl.textContent = g.label;
        grp.appendChild(gl);
        const grid = document.createElement('div'); grid.className = 'param-grid';
        for (const k of g.keys) if (byKey[k]) grid.appendChild(buildCell(byKey[k]));
        grp.appendChild(grid);
        body.appendChild(grp);
      }
      adv.appendChild(body);
      toggle.addEventListener('click', () => {
        state._paramsAdvOpen = !state._paramsAdvOpen;
        toggle.classList.toggle('open', state._paramsAdvOpen);
        body.classList.toggle('collapsed', !state._paramsAdvOpen);
      });
    }

    // Wire every param input (primary grid + advanced roll-up live in #step5).
    $$('#step5 [data-pkey]').forEach(el => {
      el.addEventListener('change', (e) => {
        const k = el.dataset.pkey;
        const f = fields.find(x => x.key === k);
        let v;
        if (el.type === 'number') v = parseFloat(el.value);
        else if (f && f.type === 'list') {
          v = String(el.value || '')
            .split(',')
            .map(s => s.trim().toUpperCase())
            .filter(Boolean);
        }
        else                       v = el.value;
        // APP-FIX-P1-RATE — snap the P1 window to whole calendar months (mirrors
        // the pipeline) so its month-count divisor equals the true window length.
        if (k === 'p1Start' && v) { v = snapMonthStartIso(v); el.value = v; }
        if (k === 'p1End'   && v) { v = snapMonthEndIso(v);   el.value = v; }
        state.paramsRun[k] = v;
        if (k === 'minMaxMethod') toggleLeadTimesDrop();
        renderParams();
        renderJsonPreview();
      });
    });
    toggleLeadTimesDrop();
  }

  function toggleLeadTimesDrop(){
    const drop = document.querySelector('.drop[data-source="leadTimes"]');
    if (!drop) return;
    const wrap = drop.parentElement;
    wrap.classList.toggle('hidden', state.paramsRun.minMaxMethod !== 'leadTimeBased');
  }

  function setupParamButtons(){
    $('#paramsReset').addEventListener('click', () => {
      state.paramsRun = { ...state.paramsSaved };
      renderParams(); renderJsonPreview();
      toast('Reverted to saved defaults', 'ok');
    });
  }

  /* ═════════════════════════════════════════════════════════════════════════
     STEP 6 — Final scope summary (what will actually be analyzed)
     Runs the pipeline's bucket builder against the current JSON and reports
     materials per bucket + total. Cross-file mismatch flags surfaced.
  ═════════════════════════════════════════════════════════════════════════ */

  function renderScopeSummary(){
    const host   = $('#scopeSummaryBody');
    const status = $('#scopeSummaryStatus');
    if (!host) return;

    const required = currentRequiredSources();
    if (!required.length || !required.every(s => state.parsed[s])) {
      const missing = required.filter(s => !state.parsed[s]);
      host.innerHTML = `<div class="scope-summary-empty">awaiting upload: ${missing.length ? missing.join(' · ') : 'all required files'}</div>`;
      status.textContent = 'awaiting data';
      status.className = 'step-status';
      return;
    }

    let json;
    try {
      json = buildJson();
    } catch (e) {
      host.innerHTML = `<div class="scope-summary-empty">error building scope: ${escapeHtml(e.message)}</div>`;
      status.textContent = 'error';
      status.className = 'step-status crit';
      return;
    }

    /* PERF-INT-TYPE — the performance run has no buckets or consumption
       screens: it looks at every material in the files. Summarise what the
       Workbench will see instead. */
    if (json.scope && json.scope.mode === 'allMaterials') {
      renderPerfScopeSummary(json, host, status);
      return;
    }

    if (typeof AppPipeline === 'undefined') {
      host.innerHTML = '<div class="scope-summary-empty">pipeline module not loaded</div>';
      return;
    }

    let buckets = [];
    try {
      buckets = AppPipeline.buildBuckets(json);
    } catch (e) {
      console.error(e);
      host.innerHTML = `<div class="scope-summary-empty">error computing buckets: ${escapeHtml(e.message)}</div>`;
      status.textContent = 'error';
      status.className = 'step-status crit';
      return;
    }

    // Per-bucket: count materials that PASS the threshold filter
    // (i.e. would actually be analyzed by the pipeline)
    const threshold = json.parameters.threshold || 0;
    // APP-E9 — second screen (min consumption events) mirrored here so the
    // Step-6 count matches what the pipeline will actually analyse.
    const minEvents = (typeof json.parameters.minEventsThreshold === 'number' && json.parameters.minEventsThreshold > 0)
                        ? json.parameters.minEventsThreshold : 0;
    let totalQualifying = 0, totalRaw = 0;
    const bucketRows = buckets.map(b => {
      const raw = (b.materials instanceof Set) ? b.materials.size : (Array.isArray(b.materials) ? b.materials.length : 0);
      // Compute net consumption per material in this bucket → count past both screens
      const netByMat = AppPipeline.netConsumptionByMaterial(b.transactions, new Map());
      let qualifying = 0;
      for (const [, agg] of netByMat) {
        if (agg.net >= threshold && agg.eventCount >= minEvents) qualifying++;
      }
      totalRaw         += raw;
      totalQualifying  += qualifying;
      const rowCls = b.kind === 'multi' ? 'multi' : '';
      return `
        <tr class="${rowCls}">
          <td class="bname">${escapeHtml(b.name)}</td>
          <td class="bkind">${escapeHtml(b.kind)}</td>
          <td class="num">${raw.toLocaleString()}</td>
          <td class="num">${qualifying.toLocaleString()}</td>
          <td class="num">${b.transactions.length.toLocaleString()}</td>
        </tr>`;
    }).join('');

    // Mismatch advisories
    const mismatch = computeMismatch(json);
    const mismatchHtml = mismatch.length ? `
      <div class="scope-mismatch">
        <b>⚠ Cross-file consistency notes:</b>
        ${mismatch.map(m => `<div>· ${m}</div>`).join('')}
      </div>` : '';

    const scopeDescr = describeScope(json);

    host.innerHTML = `
      <div class="scope-summary-head">
        <div class="key">
          <span class="lab">Materials to be analyzed</span>
          <span class="v big">${totalQualifying.toLocaleString()}</span>
        </div>
        <div class="key">
          <span class="lab">Buckets</span>
          <span class="v">${buckets.length}</span>
        </div>
        <div class="key">
          <span class="lab">Pre-threshold materials</span>
          <span class="v">${totalRaw.toLocaleString()}</span>
        </div>
        <div class="sub">
          Scope: <b style="color:var(--text-pri)">${escapeHtml(scopeDescr)}</b><br>
          Screens: <b style="color:var(--text-pri)">net consumption ≥ ${threshold}</b>${minEvents > 0 ? ` <b style="color:var(--text-pri)">AND ≥ ${minEvents} consumption event${minEvents === 1 ? '' : 's'}</b> (a WO 261 or cost-centre 201 issue)` : ''} over the analysis window.<br>
          Materials below ${minEvents > 0 ? 'either screen' : 'the threshold'} are excluded automatically.
        </div>
      </div>
      ${mismatchHtml}
      <table class="scope-summary-table">
        <thead>
          <tr>
            <th>Bucket</th>
            <th>Kind</th>
            <th class="num">Materials (raw)</th>
            <th class="num">≥ threshold</th>
            <th class="num">Transactions</th>
          </tr>
        </thead>
        <tbody>
          ${bucketRows || '<tr><td colspan="5" style="text-align:center;color:var(--text-muted);font-family:var(--font-mono);padding:14px;">no buckets — check scope selections</td></tr>'}
          ${buckets.length > 1 ? `
            <tr class="totals">
              <td class="bname">TOTAL</td>
              <td class="bkind">—</td>
              <td class="num">${totalRaw.toLocaleString()}</td>
              <td class="num">${totalQualifying.toLocaleString()}</td>
              <td class="num">—</td>
            </tr>` : ''}
        </tbody>
      </table>
    `;

    if (totalQualifying === 0) {
      status.textContent = '0 materials qualify · review scope or threshold';
      status.className = 'step-status warn';
    } else {
      status.textContent = `${totalQualifying.toLocaleString()} material${totalQualifying === 1 ? '' : 's'} ready for analysis`;
      status.className = 'step-status done';
    }
  }

  /* PERF-INT-TYPE — Step 06 summary for a supply-chain performance run. */
  function renderPerfScopeSummary(json, host, status){
    const mb51 = json.data.mb51 || [];
    const pr   = (json.data.prHistory || []).filter(r => String(r.material || '').trim());
    const im   = json.data.inventoryMaster || [];
    const mbM  = new Set(mb51.map(r => String(r.material || '').trim()).filter(Boolean));
    const prM  = new Set(pr.map(r => String(r.material || '').trim()));
    const all  = new Set([...mbM, ...prM]);
    const imBy = new Map();
    for (const r of im) { const m = String(r.material || '').trim(); if (m && !imBy.has(m)) imBy.set(m, r); }
    const types = {};
    let noIm = 0;
    for (const m of all) {
      const r = imBy.get(m);
      if (!r) { noIm++; continue; }
      const t = String(r.mrpInd || '').trim() || '(blank)';
      types[t] = (types[t] || 0) + 1;
    }
    const typeTxt = Object.entries(types).sort((a, b) => b[1] - a[1])
      .map(([t, n]) => `${escapeHtml(t)} <b style="color:var(--text-pri)">${n.toLocaleString()}</b>`).join(' · ');
    const withPo  = pr.filter(r => String(r.purchaseOrder || '').trim()).length;
    const mrpMade = pr.filter(r => String(r.creationIndicator || '').trim().toUpperCase() === 'B').length;
    const needBy  = pr.filter(r => r.deliveryDate).length;
    const pct = (a, b) => b ? Math.round(a / b * 100) + '%' : '—';
    const mismatch = computeMismatch(json);
    const mismatchHtml = mismatch.length ? `
      <div class="scope-mismatch">
        <b>⚠ Cross-file consistency notes:</b>
        ${mismatch.map(m => `<div>· ${m}</div>`).join('')}
      </div>` : '';
    host.innerHTML = `
      <div class="scope-summary-head">
        <div class="key">
          <span class="lab">Materials in the files</span>
          <span class="v big">${all.size.toLocaleString()}</span>
        </div>
        <div class="key">
          <span class="lab">PR lines</span>
          <span class="v">${pr.length.toLocaleString()}</span>
        </div>
        <div class="key">
          <span class="lab">MB51 movements</span>
          <span class="v">${mb51.length.toLocaleString()}</span>
        </div>
        <div class="sub">
          Scope: <b style="color:var(--text-pri)">every material in MB51 or PR History</b> — the files decide.<br>
          MRP type (Inventory Master): ${typeTxt || '—'}${noIm ? ` · <b style="color:var(--status-warn)">${noIm.toLocaleString()} not in Inventory Master</b> (no stock rebuild or Min/Max for those)` : ''}.<br>
          PR lines with a PO <b style="color:var(--text-pri)">${pct(withPo, pr.length)}</b> · MRP-created <b style="color:var(--text-pri)">${pct(mrpMade, pr.length)}</b> · carrying a need-by date <b style="color:var(--text-pri)">${pct(needBy, pr.length)}</b>.
        </div>
      </div>
      ${mismatchHtml}`;
    status.textContent = `${all.size.toLocaleString()} material${all.size === 1 ? '' : 's'} ready for the Workbench`;
    status.className = all.size ? 'step-status done' : 'step-status warn';
  }

  /* ─── Describe the current scope in plain English ───────────────────────── */
  function describeScope(json){
    const m = json.scope.mode;
    if (m === 'allMaterials')       return 'All materials in the files';   /* PERF-INT-TYPE */
    if (m === 'fleet')              return `Fleet · ${(json.scope.fleet?.models || []).join(' / ') || '—'}`;
    if (m === 'manual') {
      const n = (json.scope.manual?.materials || []).length;
      return `Manual list · ${n} material${n === 1 ? '' : 's'}`;
    }
    if (m === 'byClassification') {
      const f = json.scope.byClassification || {};
      const bits = [];
      if (f.inventoryTypes?.length) bits.push(`type: ${f.inventoryTypes.join('/')}`);
      if (f.mrpClassifiers?.length) bits.push(`MRP: ${f.mrpClassifiers.join('/')}`);
      if (f.movementAmount?.min != null || f.movementAmount?.max != null)
        bits.push(`mvmt: ${f.movementAmount.min ?? '—'} … ${f.movementAmount.max ?? '—'}`);
      return `By classification · ${bits.join(' · ') || 'no filters'}`;
    }
    if (m === 'byVendor') {
      const n = (json.scope.byVendor?.vendors || []).length;
      return `By vendor · ${n} vendor${n === 1 ? '' : 's'}`;
    }
    if (m === 'parameterSearch') {
      const f = (json.scope.parameterSearch?.filters || []).length;
      return `Parameter search · ${f} filter${f === 1 ? '' : 's'}`;
    }
    return m;
  }

  /* ─── Cross-file mismatch advisories ────────────────────────────────────── */
  function computeMismatch(json){
    const out  = [];
    const mb51 = json.data.mb51 || [];
    const iw39 = json.data.iw39 || [];
    const fleet = json.data.fleetMaster || [];
    const master = json.data.inventoryMaster || [];

    const mb51Mats   = new Set(mb51.map(r => String(r.material || '').trim()).filter(Boolean));
    const masterMats = new Set(master.map(r => String(r.material || '').trim()).filter(Boolean));

    if (mb51Mats.size && masterMats.size) {
      const missing = [...mb51Mats].filter(m => !masterMats.has(m));
      if (missing.length) {
        const pct = (missing.length / mb51Mats.size * 100).toFixed(1);
        out.push(`<b>${missing.length.toLocaleString()}</b> of ${mb51Mats.size.toLocaleString()} MB51 materials (${pct}%) are NOT in Inventory Master — they'll be excluded from MRP-driven assessments.`);
      }
    }

    if (mb51.length && iw39.length && json.metadata.assessmentType === 'unitFloc') {
      const mb51Orders = new Set(mb51.map(r => String(r.order || '').trim()).filter(Boolean));
      const iw39Orders = new Set(iw39.map(r => String(r.order || '').trim()).filter(Boolean));
      const missing = [...mb51Orders].filter(o => !iw39Orders.has(o));
      if (missing.length && mb51Orders.size > 0) {
        const pct = (missing.length / mb51Orders.size * 100).toFixed(1);
        if (parseFloat(pct) > 5) {
          out.push(`<b>${missing.length.toLocaleString()}</b> of ${mb51Orders.size.toLocaleString()} MB51 orders (${pct}%) are NOT in IW39 — those transactions can't be attributed to a fleet unit.`);
        }
      }
    }

    if (iw39.length && fleet.length && json.metadata.assessmentType === 'unitFloc') {
      const iw39Sf  = new Set(iw39.map(r => String(r.sortField || '').trim()).filter(Boolean));
      const fleetSf = new Set(fleet.map(r => String(r.sortField || '').trim()).filter(Boolean));
      const missing = [...iw39Sf].filter(s => !fleetSf.has(s));
      if (missing.length && iw39Sf.size > 0) {
        const pct = (missing.length / iw39Sf.size * 100).toFixed(1);
        if (parseFloat(pct) > 5) {
          out.push(`<b>${missing.length.toLocaleString()}</b> of ${iw39Sf.size.toLocaleString()} IW39 sort-field units (${pct}%) are NOT in Fleet Master — those WOs won't roll up to a fleet model bucket.`);
        }
      }
    }

    /* APP-T-01c — cross-file plant consistency. Plant alias was added to
       MB51 (T-01b) and inventoryMaster (T-01). Compare the plant sets:
       skip silently if either file has no plant data (T-01b chip already
       surfaces that absence). Asymmetric difference reported both ways so
       operator knows whether the gap is "consumption with no master" or
       "master with no consumption". */
    const mb51Plants   = new Set(mb51  .map(r => String(r.plant || '').trim()).filter(Boolean));
    const masterPlants = new Set(master.map(r => String(r.plant || '').trim()).filter(Boolean));
    if (mb51Plants.size && masterPlants.size) {
      const mb51Only   = [...mb51Plants  ].filter(p => !masterPlants.has(p));
      const masterOnly = [...masterPlants].filter(p => !mb51Plants  .has(p));
      const fmt = (arr) => arr.map(p => `<b>${escapeHtml(p)}</b>`).join(', ');
      if (mb51Only.length) {
        const plural = mb51Only.length > 1;
        out.push(`MB51 contains plant${plural ? 's' : ''} ${fmt(mb51Only)} that ${plural ? 'are' : 'is'} not present in Inventory Master — consumption from ${plural ? 'those plants' : 'that plant'} can't be matched to MRP settings or stock-on-hand.`);
      }
      if (masterOnly.length) {
        const plural = masterOnly.length > 1;
        out.push(`Inventory Master contains plant${plural ? 's' : ''} ${fmt(masterOnly)} not present in MB51 — those materials have no consumption to analyze in this window.`);
      }
    }

    return out;
  }

  /* ═════════════════════════════════════════════════════════════════════════
     STEP 7 — Review & Export
  ═════════════════════════════════════════════════════════════════════════ */

  function buildJson(){
    const json = CanonicalSchema.emptyJson();
    const now = AppLocale.localStampCompact();
    json.metadata.assessmentName = state.name || $('#assessmentName').value || '';
    json.metadata.createdBy      = $('#createdBy').value || '';
    // APP-E15 — createdAt is REWRITTEN every save (acts as "last analysis").
    // uploadedAt is the FIRST-SAVE timestamp; preserved when an intake is
    // re-used from storage or a JSON upload (state.uploadedAt is set in
    // hydrateFromSavedIntake / the upload-JSON handler). For genuinely
    // fresh intakes, state.uploadedAt is null and we stamp `now` so the
    // field is always present going forward.
    json.metadata.createdAt      = now;
    json.metadata.uploadedAt     = state.uploadedAt || now;
    // APP-FIX-SNAPSHOT-ALIGN — the SAP run date the Inventory Master was extracted
    // (the stock snapshot the SOH back-calc anchors to). Additive; null if unset.
    json.metadata.inventoryMasterDate = state.inventoryMasterDate || null;
    json.metadata.assessmentType = state.assessmentType;
    json.scope                   = JSON.parse(JSON.stringify(state.scope));
    // For userList type: scope.manual.{materials|workOrders} is already maintained
    // by either the file-upload handler (onParseUpdated) OR the textarea paste
    // handler (setupManualPaste). Whichever was most recent is the source of
    // truth. We just lock scope.mode = 'manual'.
    // APP-E22: defensive fallback recognises either column on the userList file.
    if (state.assessmentType === 'userList') {
      json.scope.mode = 'manual';
      const m = json.scope.manual || {};
      const hasMaterials  = !!(m.materials  && m.materials.length);
      const hasWorkOrders = !!(m.workOrders && m.workOrders.length);
      if (!hasMaterials && !hasWorkOrders && state.parsed.userList) {
        const rows = state.parsed.userList.canonical;
        const mats = uniq(rows.map(r => String(r.material || '').trim()).filter(Boolean));
        const ords = uniq(rows.map(r => String(r.order    || '').trim()).filter(Boolean));
        if (ords.length && !mats.length) {
          json.scope.manual = { materials: [], workOrders: ords, listType: 'workOrders', detection: m.detection || null };
        } else {
          json.scope.manual = { materials: mats, workOrders: [], listType: 'materials',  detection: m.detection || null };
        }
      }
      /* Ensure new fields are always present on the canonical (legacy support). */
      if (!json.scope.manual.listType) json.scope.manual.listType = 'materials';
      if (!Array.isArray(json.scope.manual.workOrders)) json.scope.manual.workOrders = [];
      if (!Array.isArray(json.scope.manual.materials))  json.scope.manual.materials  = [];
    }
    if (state.assessmentType === 'scPerformance') json.scope.mode = 'allMaterials';   /* PERF-INT-TYPE */
    json.parameters              = { ...state.paramsRun };
    for (const s of REQUIRED_SOURCES.concat(CONDITIONAL_SOURCES)) {
      if (state.parsed[s]) json.data[s] = state.parsed[s].canonical;
    }
    json.validation = state.dq ? {
      passed: state.dq.passed,
      issues: state.dq.issues.concat(state.dq.warnings).map(i => ({
        severity: i.sev, code: i.code, message: i.msg
      }))
    } : { passed:false, issues:[{ severity:'crit', code:'no_dq', message:'DQ gate not run' }] };
    return json;
  }

  /* PERF-INT-FAST — Tune deep-copied the WHOLE dataset (JSON.parse(stringify))
     to build this preview and then stringified it again for the size — on
     every keystroke in the name box. At 150k–500k MB51 rows that is two
     ~100 MB string round-trips per render. Now: the preview swaps the data
     arrays for row counts without copying them, and the byte size is only
     recomputed when the data itself changes (cached on the row counts). */
  let _sizeCache = { sig: null, bytes: 0 };
  function renderJsonPreview(){
    const json = buildJson();
    const host = $('#jsonPreview');
    const counts = {};
    for (const key of Object.keys(json.data)) {
      const arr = json.data[key] || [];
      counts[key] = arr.length > 0 ? `[ … ${arr.length} rows … ]` : `[ ]`;
    }
    host.textContent = JSON.stringify({ ...json, data: counts }, null, 2);

    const sig = Object.keys(json.data).map(k => k + ':' + ((json.data[k] || []).length)).join('|');
    if (_sizeCache.sig !== sig) {
      _sizeCache = { sig, bytes: new Blob([JSON.stringify(json)]).size };
    }
    $('#jsonSize').textContent = '≈ ' + humanBytes(_sizeCache.bytes);

    // Scope summary updates with the JSON preview — same upstream triggers
    renderScopeSummary();
  }

  /* ─── Mandatory Assessment-Name validation (v2.1) ─────────────────────── */
  function requireAssessmentName(){
    const input = $('#assessmentName');
    const errEl = $('#assessmentNameError');
    const name = (state.name || '').trim();
    if (!name) {
      if (input) {
        input.setAttribute('aria-invalid', 'true');
        input.focus();
        input.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }
      if (errEl) errEl.style.display = '';
      toast('Assessment name is required — name it before saving / running analysis.', 'crit');
      return false;
    }
    if (input) input.removeAttribute('aria-invalid');
    if (errEl) errEl.style.display = 'none';
    return true;
  }

  function setupReviewActions(){
    $('#assessmentName').addEventListener('input', () => {
      state.name = $('#assessmentName').value;
      // Clear the error styling as soon as the user starts typing
      if (state.name.trim()) {
        const input = $('#assessmentName');
        const errEl = $('#assessmentNameError');
        if (input) input.removeAttribute('aria-invalid');
        if (errEl) errEl.style.display = 'none';
      }
      renderJsonPreview();
    });
    $('#createdBy').addEventListener('input', renderJsonPreview);
    $('#runDate').addEventListener('change', () => { state.runDate = $('#runDate').value; if (state.parsed.mb51) runDqGate(); });
    $('#runDate').value = state.runDate;

    $('#btnSaveLocal').addEventListener('click', async () => {
      if (!requireAssessmentName()) return;
      const json = buildJson();
      const name = state.name.trim();
      // APP-E3-TRIM — opt-in: shrink the saved JSON to the materials in use.
      let trimNote = '';
      const trimChk = $('#chkTrimScope');
      if (trimChk && trimChk.checked) {
        const t = trimToScope(json);
        if (t.ok && t.dropped > 0) trimNote = ` · trimmed ${t.dropped.toLocaleString()} unused rows, kept ${t.materials.toLocaleString()} materials`;
        else if (!t.ok) toast(`Trim skipped (${t.error}) — saved full`, 'warn');
      }
      const result = await AppStorage.set('intake.' + name, json);
      // also update an "intakes" index list
      const idx = (await AppStorage.get('intakes.index')) || [];
      const idxClean = idx.filter(e => e.name !== name);
      // APP-E15 — index entry now carries both uploadedAt and createdAt so the
      // Dashboard and Reuse modal can show "Uploaded · Last analysis" without
      // having to load the full intake JSON to read its metadata.
      idxClean.unshift({
        name,
        uploadedAt: json.metadata.uploadedAt,
        createdAt:  json.metadata.createdAt,
        mode:       json.scope.mode
      });
      await AppStorage.set('intakes.index', idxClean.slice(0, 50));
      // also save as "current" for analysis engine handoff
      await AppStorage.set('intake.current', json);
      toast(`Saved as "${name}" to ${result.store === 'idb' ? 'IndexedDB' : 'localStorage'} (${humanBytes(result.size)})${trimNote}`, 'ok');
    });

    $('#btnDownload').addEventListener('click', () => {
      if (!requireAssessmentName()) return;
      const json = buildJson();
      // APP-E3-TRIM — honour the same opt-in for the downloaded file.
      const trimChk = $('#chkTrimScope');
      if (trimChk && trimChk.checked) trimToScope(json);
      // APP-FIX-ANALYST-DL (2026-08-16) — carry the analyst layer (For-Action
      // flags, recs, notes) into the downloaded combined file, exactly as the Trend
      // export does. Without this, a JSON combined here (e.g. + IW39) drops the
      // operator's analyst work, so re-loading it shows nothing. Top-level
      // `_analystData` block; the Upload handler strips it before it becomes the
      // canonical, so the stored dataset stays pure.
      try {
        if (typeof AnalystMarks !== 'undefined' && AnalystMarks.load) {
          const raw = AnalystMarks.load(json.metadata.assessmentName || '');
          if (raw && Object.keys(raw).length) json._analystData = raw;
        }
      } catch (err) { console.warn('APP-FIX-ANALYST-DL embed (download):', err); }
      // APP-E3-MINIFY — compact (no pretty-print whitespace) — ~28% smaller file,
      // zero data loss. The localStorage save (storage.js) was already compact;
      // only this download was pretty-printed. Still valid JSON; the Upload .json
      // handler re-parses it unchanged.
      const blob = new Blob([JSON.stringify(json)], { type: 'application/json' });
      const url  = URL.createObjectURL(blob);
      const a    = document.createElement('a');
      const name = state.name.trim().replace(/[^A-Za-z0-9_-]+/g, '_');
      a.href = url; a.download = `${name}.json`;
      a.click();
      URL.revokeObjectURL(url);
    });

    $('#btnUpload').addEventListener('click', () => $('#uploadJsonInput').click());
    $('#uploadJsonInput').addEventListener('change', async (e) => {
      const file = e.target.files[0];
      if (!file) return;
      try {
        const text = await file.text();
        const json = JSON.parse(text);
        // APP-ACT-PERSIST (Phase 1) — restore co-packaged analyst data (For-Action
        // flags + Analyst Rec + notes) to the sidecar, then strip it so the
        // canonical stays clean for validateShape + save. Keyed by assessmentName
        // (must match the analysis-page binding).
        if (json._analystData && typeof json._analystData === 'object') {
          try {
            const nm = (json.metadata && json.metadata.assessmentName) || '';
            if (typeof AnalystMarks !== 'undefined' && AnalystMarks.restore) {
              AnalystMarks.restore(nm, json._analystData);
            }
          } catch (err) { console.warn('APP-ACT-PERSIST restore:', err); }
          delete json._analystData;
        }
        const v = CanonicalSchema.validateShape(json);
        if (!v.ok) { toast('Invalid JSON: ' + v.errors.join('; '), 'crit'); return; }
        /* PERF-INT-TYPE — a Tune download (fleet / user-list / parameter-search)
           becomes a performance run over every material its data carries.
           Tune trims its downloads to the assessment's materials, so the run
           covers only those — said out loud, not silently. */
        let perfConverted = null;
        if (json.metadata && json.metadata.assessmentType !== 'scPerformance') {
          perfConverted = json.metadata.assessmentType || 'unknown';
          json.metadata.assessmentType = 'scPerformance';
          json.scope = CanonicalSchema.emptyScope('allMaterials');
        }
        // Repopulate state from the JSON
        state.scope = json.scope;
        state.paramsRun = { ...json.parameters };
        state.name = json.metadata.assessmentName || '';
        // APP-E15 — preserve the original upload date through this load so
        // the next save keeps it. Pre-APP-E15 JSONs have no uploadedAt; fall
        // back to createdAt as the closest honest proxy.
        state.uploadedAt = json.metadata.uploadedAt || json.metadata.createdAt || null;
        state.inventoryMasterDate = (json.metadata && json.metadata.inventoryMasterDate) || null;  // APP-FIX-SNAPSHOT-ALIGN
        // Stuff data into parsed slots so downstream UI works
        for (const s of REQUIRED_SOURCES.concat(CONDITIONAL_SOURCES)) {
          if (json.data[s] && json.data[s].length) {
            state.parsed[s] = {
              canonical: json.data[s],
              headers:   Object.keys(json.data[s][0] || {}),
              fieldMap:  Object.fromEntries(Object.keys(json.data[s][0] || {}).map(k => [k,k])),
              rowCount:  json.data[s].length,
              unmatched: [],
              missingFields: []
            };
            const drop = document.querySelector(`.drop[data-source="${s}"]`);
            if (drop) {
              drop.classList.add('loaded');
              drop.querySelector('.file').textContent = `${json.data[s].length.toLocaleString()} rows · loaded from JSON`;
            }
          }
        }
        // Render all drop-stats so cross-file recon chips populate
        renderAllDropStats();
        // Re-apply assessment type if it was set on the JSON
        if (json.metadata && json.metadata.assessmentType) {
          applyAssessmentType(json.metadata.assessmentType);
        }
        $('#assessmentName').value = state.name;
        $('#createdBy').value = json.metadata.createdBy || '';
        runDqGate();
        renderParams(); renderScopePreview(); renderJsonPreview();
        toast(perfConverted
          ? `JSON loaded — a Tune "${labelForType(perfConverted)}" dataset, now read as a performance run over every material it contains`
          : 'JSON loaded', perfConverted ? 'warn' : 'ok');
      } catch (e) {
        toast('Failed to load JSON: ' + e.message, 'crit');
      }
    });

    $('#btnOpenAnalysis').addEventListener('click', async () => {
      if (!requireAssessmentName()) return;
      const json = buildJson();
      await AppStorage.set('intake.current', json);
      window.location.href = '../workbench/workbench.html';   // PERF-INT-NAV
    });
  }

  /* ═════════════════════════════════════════════════════════════════════════
     Helpers
  ═════════════════════════════════════════════════════════════════════════ */

  function uniq(arr){ return [...new Set(arr)]; }
  function monthsBetween(a, b){
    if (!a || !b) return 0;
    const da = new Date(a), db = new Date(b);
    return (db.getFullYear() - da.getFullYear()) * 12 + (db.getMonth() - da.getMonth());
  }
  /* APP-E3-TRIM — keep only the materials this assessment uses, dropping the
     full material catalog + any out-of-scope rows from the material-keyed
     tables. Keep-set = (scope-resolved materials, via the pipeline's own bucket
     logic so every scope mode is handled) ∪ (PR-History materials, so Trace's
     chains survive). SAFE/lossless: the pipeline already restricts to scope at
     the bucket level, every per-material consumer looks up by in-scope material,
     and the Inv-Adj rate exclusion uses the STORED confirmed dates (not the σ
     candidate scan). Full reasoning: "_Hand-over docs/APP-E3 - JSON trim safety
     audit". Reassigns json.data.* (never mutates the shared state.parsed arrays).
     Returns a summary for the toast; on any failure it trims nothing. */
  function trimToScope(json){
    /* PERF-INT-TRIM — a performance run keeps every material that moved or was
       requisitioned (MB51 ∪ PR History). What gets dropped is the rest of the
       Inventory Master catalogue — materials with no movement and no PR in the
       window can't show a procurement or trigger event. */
    if (json.scope && json.scope.mode === 'allMaterials') {
      const keepP = new Set();
      for (const r of (json.data.mb51 || []))      { const m = String(r.material || '').trim(); if (m) keepP.add(m); }
      for (const r of (json.data.prHistory || [])) { const m = String(r.material || '').trim(); if (m) keepP.add(m); }
      if (keepP.size === 0) return { ok:false, error:'no materials in MB51 or PR History' };
      let droppedP = 0;
      for (const tbl of ['inventoryMaster', 'materialVendor', 'leadTimes']) {
        const rows = json.data[tbl];
        if (!Array.isArray(rows) || rows.length === 0) continue;
        const kept = rows.filter(r => keepP.has(String(r.material || '').trim()));
        droppedP += rows.length - kept.length;
        json.data[tbl] = kept;
      }
      /* PR History's blank sub-header / totals rows carry no material — drop them. */
      if (Array.isArray(json.data.prHistory)) {
        const kept = json.data.prHistory.filter(r => String(r.material || '').trim());
        droppedP += json.data.prHistory.length - kept.length;
        json.data.prHistory = kept;
      }
      return { ok:true, materials: keepP.size, dropped: droppedP };
    }
    const keep = new Set();
    // APP-FIX-TRIM-BLOAT (2026-09-25) — keep-set = the ACTUAL in-scope materials only.
    // For a user-list assessment, keep every listed material explicitly (even ones
    // with no consumption in the window, so the full list survives). Fleet/consumption
    // scope is resolved from the pipeline's own buckets.
    const man = (json.scope && json.scope.manual) || {};
    for (const m of (man.materials || [])){ const mm = String(m||'').trim(); if (mm) keep.add(mm); }
    try {
      const buckets = (window.AppPipeline && AppPipeline.buildBuckets(json)) || [];
      for (const b of buckets){
        if (b.materials instanceof Set) for (const m of b.materials){ const mm = String(m||'').trim(); if (mm) keep.add(mm); }
        for (const t of (b.transactions||[])){ const m = String(t.material||'').trim(); if (m) keep.add(m); }
      }
    } catch(e){ return { ok:false, error: e.message }; }
    if (keep.size === 0) return { ok:false, error:'no in-scope materials resolved' };
    // APP-FIX-TRIM-BLOAT — trim EVERY material-keyed table to the in-scope set,
    // INCLUDING prHistory. Previously prHistory was kept whole AND every prHistory
    // material was added to the keep-set, so a full-plant PR extract defeated the
    // trim entirely (a 250-material list stayed ~20 MB, a 2,500 list ~232 MB). Trace
    // only ever shows in-scope materials + computeChains filters prHistory by
    // material, so out-of-scope procurement history is safe to drop.
    const TABLES = ['inventoryMaster','mb51','materialVendor','leadTimes','prHistory'];
    let dropped = 0;
    for (const tbl of TABLES){
      const rows = json.data[tbl];
      if (!Array.isArray(rows) || rows.length === 0) continue;
      const kept = rows.filter(r => keep.has(String(r.material||'').trim()));
      dropped += (rows.length - kept.length);
      json.data[tbl] = kept;
    }
    return { ok:true, materials: keep.size, dropped };
  }

  function humanBytes(n){
    if (n < 1024) return n + ' B';
    if (n < 1024*1024) return (n/1024).toFixed(1) + ' KB';
    return (n/1024/1024).toFixed(1) + ' MB';
  }
  function escapeHtml(s){ return String(s||'').replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'})[c]); }
  function escapeAttr(s){ return escapeHtml(s).replace(/'/g, '&#39;'); }
  function toast(msg, kind){
    const el = document.createElement('div');
    el.className = 'toast ' + (kind || '');
    el.textContent = msg;
    document.body.appendChild(el);
    setTimeout(() => el.remove(), 4500);
  }

  /* ═════════════════════════════════════════════════════════════════════════
     Boot
  ═════════════════════════════════════════════════════════════════════════ */

  /* ═════════════════════════════════════════════════════════════════════════
     REUSE COMMON DATA FROM SAVED INTAKE (batch mode, v2.1)
     Lets the operator skip re-uploading MB51 / IW39 / Fleet / Inv Master
     when running multiple batches against the same SAP extracts.
  ═════════════════════════════════════════════════════════════════════════ */

  /* Tile-level panel — visible when saved intakes exist. Click opens modal. */
  async function setupReusePanel(){
    const panel    = $('#reusePanel');
    const btnOpen  = $('#reuseOpen');
    const summary  = $('#reuseSummary');
    if (!panel || !btnOpen) return;

    const idx = (await AppStorage.get('intakes.index')) || [];
    if (idx.length === 0) {
      panel.hidden = true;
      return;
    }
    panel.hidden  = false;
    btnOpen.disabled = false;
    if (summary) summary.textContent = `${idx.length} saved intake${idx.length === 1 ? '' : 's'} available`;

    btnOpen.addEventListener('click', () => openReuseModal(idx));

    // Modal close handlers (idempotent)
    const closeBtn = $('#reuseModalClose');
    if (closeBtn && !closeBtn._bound) {
      closeBtn.addEventListener('click', closeReuseModal);
      closeBtn._bound = true;
    }
    const backdrop = $('#reuseModal').querySelector('.mass-backdrop');
    if (backdrop && !backdrop._bound) {
      backdrop.addEventListener('click', closeReuseModal);
      backdrop._bound = true;
    }
  }

  function closeReuseModal(){
    const m = $('#reuseModal');
    if (!m) return;
    m.classList.add('hidden'); m.setAttribute('aria-hidden', 'true');
  }

  /* ─── Reuse modal — pick source + which datasets to hydrate ─────────────── */
  // Friendly labels per source key
  const REUSE_LABELS = {
    mb51:            { label:'MB51',               desc:'Material movements — the consumption transactional file' },
    iw39:            { label:'IW39',               desc:'Work orders — bridges MB51 to fleet equipment' },
    fleetMaster:     { label:'Fleet Master',       desc:'Equipment / unit master — fleet model definitions' },
    inventoryMaster: { label:'Inventory Master',   desc:'Stock + MRP settings + classification + value' },
    materialVendor:  { label:'Material → Vendor',  desc:'Vendor mapping — only used for by-vendor scope' },
    leadTimes:       { label:'Lead Times',         desc:'Per-material lead-time + safety stock (rare)' },
    userList:        { label:'User list',          desc:'Pre-loaded material list — usually you want to set a fresh one' },
    /* APP-T-02 */
    prHistory:       { label:'PR History',         desc:'Procurement requisition history — Trace input (Tune ignores)' }
  };
  // Datasets in the order we present them, separated into "heavy common" + "specifier"
  const REUSE_GROUPS = [
    { groupLabel: 'Common heavy files (typically reused across batches)',
      sources: ['mb51', 'iw39', 'fleetMaster', 'inventoryMaster'],
      defaultChecked: true },
    { groupLabel: 'Specifier / optional files (usually new per batch — leave unchecked)',
      /* APP-T-02 — prHistory in this group: optional, typically refreshed per
         batch since PR data ages fast and Trace wants current. */
      sources: ['userList', 'materialVendor', 'leadTimes', 'prHistory'],
      defaultChecked: false }
  ];

  async function openReuseModal(idx){
    const modal = $('#reuseModal');
    const body  = $('#reuseModalBody');
    const foot  = $('#reuseModalFoot');
    modal.classList.remove('hidden');
    modal.setAttribute('aria-hidden', 'false');

    let selectedName = idx[0] ? idx[0].name : '';

    function render(){
      // Pull the current source intake to see what datasets it actually has
      let sourceJson = null;
      if (selectedName) sourceJson = window._reuseCache && window._reuseCache.name === selectedName ? window._reuseCache.json : null;
      // We'll fetch lazily on render and cache on the modal scope
      body.innerHTML = `
        <div class="reuse-step">
          <span class="step-lab">Step 1</span>
          <h4>Pick the source intake to copy data from</h4>
          <select id="reuseModalSelect" class="reuse-select">
            ${idx.map(e => {
              // APP-E15 — show BOTH dates so the operator can tell at a glance
              // whether the underlying dataset is fresh or stale. Pre-APP-E15
              // index entries have only createdAt; show it as the upload date
              // with a "(approx)" note since we can't distinguish for them.
              const upRaw = e.uploadedAt || e.createdAt || '';
              const laRaw = e.createdAt || '';
              const up = escapeHtml(upRaw.replace('T', ' ').slice(0, 16));
              const la = escapeHtml(laRaw.replace('T', ' ').slice(0, 16));
              const sameDay = upRaw.slice(0, 10) === laRaw.slice(0, 10);
              const dates = e.uploadedAt
                ? (sameDay ? `uploaded ${up}` : `uploaded ${up} · last analysis ${la}`)
                : `${la} (approx — pre-APP-E15)`;
              return `
              <option value="${escapeAttr(e.name)}" ${e.name === selectedName ? 'selected' : ''}>
                ${escapeHtml(e.name)} · ${escapeHtml(e.mode || '—')} · ${dates}
              </option>`;
            }).join('')}
          </select>
        </div>

        <div class="reuse-step">
          <span class="step-lab">Step 2</span>
          <h4>Pick which datasets to hydrate</h4>
          <div id="reuseSourcesHost"></div>
        </div>

        <div class="reuse-notes">
          <b>What happens on load:</b>
          <ul>
            <li>Selected datasets are copied into the current intake state (no re-upload).</li>
            <li>Parameter defaults carry over as a starting point (you can override per-run).</li>
            <li><b>Assessment type is NOT inherited</b> — pick fresh in Step 0 below.</li>
            <li><b>Scope is reset</b> — that's the whole point of a new batch.</li>
            <li>Assessment name auto-suggests <code>{source} — batch HHMM</code>; rename freely.</li>
          </ul>
        </div>
      `;
      // Lazy-fetch the source JSON to count rows + filter available sources
      AppStorage.get('intake.' + selectedName).then(json => {
        window._reuseCache = { name: selectedName, json };
        renderSourcesList(json);
      });
      // Bind dropdown
      $('#reuseModalSelect').addEventListener('change', e => {
        selectedName = e.target.value;
        render();
      });
    }

    function renderSourcesList(json){
      const host = $('#reuseSourcesHost');
      if (!host || !json) return;
      const data = json.data || {};
      // APP-INT-DATE — surface the dataset's date + a staleness flag right at the
      // checkbox list so reusing stale data is obvious.
      const meta = json.metadata || {};
      const dRaw = meta.uploadedAt || meta.createdAt || '';
      let html = '';
      if (dRaw) {
        const ageDays = Math.floor((Date.now() - new Date(dRaw).getTime()) / 86400000);
        const ageTxt = ageDays <= 0 ? 'today' : (ageDays === 1 ? '1 day ago' : ageDays + ' days ago');
        const stale = ageDays > 90;
        html += `<div class="reuse-date ${stale ? 'stale' : ''}">Dataset date: <b>${escapeHtml(dRaw.replace('T', ' ').slice(0, 16))}</b> &middot; ${ageTxt}${stale ? ' &middot; ⚠ stale (&gt;90 days) — confirm this data is still current' : ''}</div>`;
      }
      for (const group of REUSE_GROUPS) {
        html += `<div style="margin-top:10px;font-family:var(--font-mono);font-size:10.5px;letter-spacing:.6px;color:var(--text-muted);text-transform:uppercase;margin-bottom:6px;">${group.groupLabel}</div>`;
        html += '<div class="reuse-sources">';
        for (const src of group.sources) {
          const rows = (Array.isArray(data[src]) ? data[src].length : 0);
          const avail = rows > 0;
          const checked = avail && group.defaultChecked;
          html += `
            <label class="reuse-source-row ${avail ? '' : 'unavailable'}">
              <input type="checkbox" data-src="${src}" ${avail ? '' : 'disabled'} ${checked ? 'checked' : ''} />
              <span class="name">${REUSE_LABELS[src].label}</span>
              <span class="desc">${REUSE_LABELS[src].desc}</span>
              <span class="rows">${avail ? rows.toLocaleString('en-CA') + ' rows' : '— not in source —'}</span>
            </label>
          `;
        }
        html += '</div>';
      }
      host.innerHTML = html;
    }

    foot.innerHTML = `
      <button id="reuseCancel" class="ghost">Cancel</button>
      <span class="spacer"></span>
      <button id="reuseLoadDo" class="primary">↻ Load selected datasets</button>
    `;
    $('#reuseCancel').addEventListener('click', closeReuseModal);
    $('#reuseLoadDo').addEventListener('click', async () => {
      const cbs = body.querySelectorAll('input[type=checkbox][data-src]:checked');
      const sources = [...cbs].map(c => c.dataset.src);
      if (sources.length === 0) { toast('Pick at least one dataset to load.', 'warn'); return; }
      const json = (window._reuseCache && window._reuseCache.json) || await AppStorage.get('intake.' + selectedName);
      if (!json) { toast('Saved intake not found: ' + selectedName, 'crit'); return; }
      closeReuseModal();
      await hydrateFromSavedIntake(json, selectedName, sources);
    });

    render();
  }

  /**
   * Hydrate state.parsed.* + state.paramsRun from a saved canonical JSON,
   * limited to the explicitly-selected sources. Does NOT inherit the source's
   * assessment type or scope (operator picks fresh).
   */
  async function hydrateFromSavedIntake(json, sourceName, selectedSources){
    const sources = Array.isArray(selectedSources) ? selectedSources : REQUIRED_SOURCES.concat(CONDITIONAL_SOURCES);
    const reusedSources = [];
    // APP-E15 — preserve the ORIGINAL upload date through this reuse so the
    // next save keeps it. For pre-APP-E15 intakes that have no uploadedAt
    // field, fall back to createdAt (their last-save date is the closest
    // honest proxy we have for "when this dataset entered the system").
    state.uploadedAt = (json.metadata && (json.metadata.uploadedAt || json.metadata.createdAt)) || null;
    state.inventoryMasterDate = (json.metadata && json.metadata.inventoryMasterDate) || state.inventoryMasterDate || null;  // APP-FIX-SNAPSHOT-ALIGN
    for (const s of sources) {
      const arr = json.data && json.data[s];
      if (Array.isArray(arr) && arr.length > 0) {
        state.parsed[s] = {
          canonical: arr,
          headers:   Object.keys(arr[0] || {}),
          fieldMap:  Object.fromEntries(Object.keys(arr[0] || {}).map(k => [k, k])),
          rowCount:  arr.length,
          unmatched: [],
          missingFields: []
        };
        reusedSources.push(s);
        const drop = document.querySelector(`.drop[data-source="${s}"]`);
        if (drop) {
          drop.classList.add('loaded');
          const fileEl = drop.querySelector('.file');
          if (fileEl) fileEl.textContent = `↻ reused from "${sourceName}" · ${arr.length.toLocaleString('en-CA')} rows`;
        }
      }
    }
    // Carry parameters as starting point
    if (json.parameters) {
      state.paramsRun = Object.assign({}, state.paramsSaved, json.parameters);
    }

    // Do NOT inherit assessmentType — operator picks fresh per the batch-mode design.
    // (Removed automatic applyAssessmentType call from prior behaviour.)

    // Auto-suggest name only if blank (don't overwrite a name the user typed)
    const nameInput = $('#assessmentName');
    if (nameInput && !nameInput.value) {
      const base = (json.metadata && json.metadata.assessmentName) || sourceName;
      const now = new Date();
      const hhmm = String(now.getHours()).padStart(2, '0') + String(now.getMinutes()).padStart(2, '0');
      nameInput.value = `${base} — batch ${hhmm}`;
      state.name = nameInput.value;
      nameInput.removeAttribute('aria-invalid');
      const errEl = $('#assessmentNameError'); if (errEl) errEl.style.display = 'none';
    }

    renderAllDropStats();
    renderSchema();
    if (state.assessmentType) runDqGate();   // only if a type is selected
    renderParams();
    populateScopeOptions();
    renderScopePreview();
    renderJsonPreview();
    renderScopeSummary();

    const statusEl = $('#reuseStatus');
    if (statusEl) {
      statusEl.style.display = '';
      statusEl.innerHTML = `✓ Reused <b>${reusedSources.length}</b> dataset${reusedSources.length === 1 ? '' : 's'} from <span class="src">${escapeHtml(sourceName)}</span>: <b>${reusedSources.join(' · ')}</b><br>Next: pick an <b>assessment type</b> in Step 0 below, then set scope + parameters and save under a new name.`;
    }
    toast(`Loaded ${reusedSources.length} dataset${reusedSources.length===1?'':'s'} from "${sourceName}" — pick assessment type next.`, 'ok');

    // Scroll to the assessment-type step so the operator sees the next action
    const step0 = document.getElementById('step0');
    if (step0) step0.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  /* APP-FIX-REUSE (2026-06-27) — DEAD CODE, intentionally not called.
     This older 2-arg hydrator shadowed the selective 3-arg hydrateFromSavedIntake
     above (JS function hoisting → the last declaration wins), so the Reuse modal
     silently IGNORED the per-dataset checkboxes: it loaded EVERY source — incl.
     userList even when unchecked — and force-inherited the assessment type
     (which then auto-filled the manual paste box). Renamed so the selective
     version is the one that runs. Left unreferenced to keep the diff small;
     safe to delete in a later cleanup. */
  async function hydrateFromSavedIntake_deprecated_unused(json, sourceName){
    const reusedSources = [];
    for (const s of REQUIRED_SOURCES.concat(CONDITIONAL_SOURCES)) {
      const arr = json.data && json.data[s];
      if (Array.isArray(arr) && arr.length > 0) {
        state.parsed[s] = {
          canonical: arr,
          headers:   Object.keys(arr[0] || {}),
          fieldMap:  Object.fromEntries(Object.keys(arr[0] || {}).map(k => [k, k])),
          rowCount:  arr.length,
          unmatched: [],
          missingFields: []
        };
        reusedSources.push(s);
        const drop = document.querySelector(`.drop[data-source="${s}"]`);
        if (drop) {
          drop.classList.add('loaded');
          const fileEl = drop.querySelector('.file');
          if (fileEl) fileEl.textContent = `↻ reused from "${sourceName}" · ${arr.length.toLocaleString()} rows`;
        }
      }
    }
    // Carry over parameters as starting point (operator can change per-run)
    if (json.parameters) {
      state.paramsRun = Object.assign({}, state.paramsSaved, json.parameters);
    }
    // Do NOT carry over the scope — that's exactly what we want to change.
    // We DO carry the assessmentType as a starting point (operator can change Step 0).
    if (json.metadata && json.metadata.assessmentType) {
      applyAssessmentType(json.metadata.assessmentType);
    }
    // Suggest a default new name (don't overwrite if user typed one)
    const nameInput = $('#assessmentName');
    if (nameInput && !nameInput.value) {
      const base = (json.metadata && json.metadata.assessmentName) || sourceName;
      const now = new Date();
      const hhmm = String(now.getHours()).padStart(2,'0') + String(now.getMinutes()).padStart(2,'0');
      nameInput.value = `${base} — batch ${hhmm}`;
      state.name = nameInput.value;
    }

    // Re-render everything that depends on parsed data
    renderAllDropStats();
    renderSchema();
    runDqGate();
    renderParams();
    populateScopeOptions();
    renderScopePreview();
    renderJsonPreview();
    renderScopeSummary();

    const statusEl = $('#reuseStatus');
    if (statusEl) {
      statusEl.style.display = '';
      statusEl.innerHTML = `✓ Reused <b>${reusedSources.length}</b> source${reusedSources.length === 1 ? '' : 's'} from <span class="src">${escapeHtml(sourceName)}</span> · <b>${reusedSources.join(' · ')}</b><br>Now pick a new <b>assessment type + scope</b> below, then save as a new named intake.`;
    }
    toast(`Loaded ${reusedSources.length} source${reusedSources.length===1?'':'s'} from ${sourceName} — set new scope + save as new intake.`, 'ok');

    // Scroll the metadata header into view so the user sees the rename prompt
    $('#assessmentName').focus();
    $('#assessmentName').select();
  }

  /* ─── APP-E6 · Alignment acknowledgement gate ───────────────────────────
     Per-assessment gate. On page load, if state.alignmentAck is null, dim
     Step 0 / Step 1 / Reuse panel + metadata header via body.intake-gated
     and show the modal. Only the "I confirm…" button clears it. Backdrop +
     ✕ are intentionally non-acknowledging — the gate is binary.            */
  function setupAlignmentGate(){
    const modal = $('#alignModal');
    const btn   = $('#alignConfirm');
    if (!modal || !btn) return;

    if (state.alignmentAck) return;  // already acknowledged for this assessment

    document.body.classList.add('intake-gated');
    modal.classList.remove('hidden');
    modal.setAttribute('aria-hidden', 'false');

    btn.addEventListener('click', () => {
      const nowIso = (typeof AppLocale !== 'undefined' && AppLocale.localDateTimeISO)
        ? AppLocale.localDateTimeISO()
        : new Date().toISOString();
      state.alignmentAck = {
        acknowledgedAt: nowIso,
        dimensions: ['plant', 'dateRange', 'materials', 'fleet']
      };
      modal.classList.add('hidden');
      modal.setAttribute('aria-hidden', 'true');
      document.body.classList.remove('intake-gated');
      // Focus first interactive control after gate clears
      const nameInput = $('#assessmentName');
      if (nameInput) nameInput.focus();
    });
  }

  document.addEventListener('DOMContentLoaded', async () => {
    await loadDefaults();
    setupAlignmentGate();   // APP-E6 · fires before anything else interactive
    setupAssessmentType();
    /* PERF-INT-TYPE — only one assessment type in this app: pre-select it. */
    { const r = document.querySelector('input[name="atype"][value="scPerformance"]'); if (r) r.checked = true; applyAssessmentType('scPerformance'); }
    setupDropZones();
    setupScopeTabs();
    setupManualPaste();
    setupClassifInputs();
    setupParamSearch();
    setupParamButtons();
    setupReviewActions();
    await setupReusePanel();
    renderJsonPreview();

    // Keyboard hint: Esc clears toasts
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') $$('.toast').forEach(t => t.remove()); });
  });

})();
