/* ═══ BUILD-STAMP ═══════════════════════════════════════════════════════════
   Calibre MRP Performance · v0.1.0-dev
   Single source of truth for SCHEMA_VERSION and APP_VERSION (line ~22).
   Repo : https://github.com/aisandbox-bj/MRP-Performance
   RoC  : record-of-change.html
   BORROWED from Calibre Tune (aisandbox-bj/Inventory_Optimization @ 2896842,
   v2.2.0-dev). Same canonical JSON contract (SCHEMA_VERSION 1.0.0) so a Tune
   dataset download loads here unchanged. Local changes are tagged PERF-*.
═══════════════════════════════════════════════════════════════════════════════

   Canonical JSON Schema — the contract between Intake and Analysis engines.
   Versioned. Changes here are breaking changes; bump SCHEMA_VERSION accordingly.
═══════════════════════════════════════════════════════════════════════════ */

(function (global) {
  'use strict';

  const SCHEMA_VERSION = '1.0.0';
  const APP_VERSION    = '0.1.0-dev';
  /* PERF-INT-TYPE — which app built the JSON (additive metadata field; Tune
     JSONs simply don't carry it). APP_VERSION alone would be ambiguous
     between the two apps. */
  const APP_NAME       = 'Calibre MRP Performance';

  /* ─── Factory defaults — seeded from the existing Python skill ──────────── */
  const FACTORY_DEFAULTS = Object.freeze({
    minMaxMethod:           'monthsBased',          // 'monthsBased' | 'leadTimeBased'
    p1Start:                '2025-04-01',
    p1End:                  '2025-08-31',
    p2Months:               3,
    minMonths:              3,
    maxMonths:              6,
    batchedMinFactor:       1.2,                    // APP-BATCH-MIN-ALONGSIDE (2026-06-28): "Min · batched" = typical WO batch (median, CC excluded) × this factor. Shown beside the calc Min.
    batchedMinGoverns:      'off',                  // APP-BATCH-MIN-GOVERNS (2026-06-28): 'off' = calc Min governs the recommendation (batched shown for comparison only). 'on' = recommended Min = max(calc Min, batched Min) — the Min always covers one typical batch, and that drives the traffic light. Default off (no change to existing recommendations).
    threshold:              10,
    minEventsThreshold:     3,                      // APP-E9 (2026-06-25): min distinct consumption events (a WO 261 issue OR a cost-centre 201 issue) a material needs to qualify. Screens out high-qty / few-event materials that can't be reliably Min/Maxed. 0 = off.
    hcePctThreshold:        0.50,                   // 50% of period total
    hceMultThreshold:       3.0,                    // 3× avg WO qty
    lumpyCvThreshold:       1.2,
    lumpyTopWoThreshold:    0.40,                   // 40% top-WO share
    invAdjSigmaThreshold:   5,                      // Inv-Adj day-spike detector: count ≥ mean + N·σ
    invAdjConfirmedDates:   [],                     // User-confirmed cycle-count dates (excluded from rate)
    invAdjReviewed:         false,                  // APP-E25 (2026-05-17): operator has reviewed (Confirmed OR dismissed) the Inv-Adj modal for this assessment — gates the auto-popup so it doesn't fire again on every Analysis page load.
    wrSoftMonths:           6,                      // Stock-runway ≥ this AND mt ∈ wrMrpTypes → PURPLE soft (Possible WR)
    wrHardMonths:           9,                      // Stock-runway ≥ this → PURPLE hard (Likely WR). Lowered from 12 in v2.0.1.
    wrMrpTypes:             ['PD'],                 // MRP types that trigger the WR check at all. PD-only is the safe default (V1 self-corrects via draw-down).
    socBackCalcMonths:      6,                      // APP-E1 (v2.1.3): SOH back-calc window in months, anchored at lastConsumptionDate. Must be ≥ p2Months. Diagnostic for stockout-driven vs genuine demand drops.
    p2StockoutDomFraction:  0.25                    // APP-E11b (v2.1.4): if a material is in stockout for ≥ this fraction of its P2 window, force GREY ("verify supply continuity") even if it's a single window. The existing >1-window trigger is kept. 0 = duration trigger off (count-only).
  });

  /* PERF-INT-TYPE — 'allMaterials' added: the supply-chain performance run
     analyses every material present in the uploaded files (the input files
     determine the scope). Tune's five modes stay valid so Tune downloads load. */
  const SCOPE_MODES = ['fleet', 'manual', 'byClassification', 'byVendor', 'parameterSearch', 'allMaterials'];

  /* ─── Assessment types (set on intake Step 0) ────────────────────────────
     Determines which inputs are required and which scope modes are valid. */
  const ASSESSMENT_TYPES = ['scPerformance', 'unitFloc', 'userList', 'paramSearch'];   /* PERF-INT-TYPE — scPerformance is the only type this app's intake offers */
  const ASSESSMENT_TYPE_REQUIRES = Object.freeze({
    /* PERF-INT-TYPE — PR History carries the procurement chains; MB51 the
       receipts (107 = at 3PL, 109 = at site) + consumption for the stock
       back-calc; Inventory Master the current stock anchor + Min/Max/SS +
       MRP type + manufacturer. All three are needed for a performance run. */
    scPerformance: ['mb51', 'inventoryMaster', 'prHistory'],
    unitFloc:    ['mb51', 'iw39', 'fleetMaster', 'inventoryMaster'],
    // userList file is OPTIONAL — operator can also paste materials directly
    // in Step 4's manual pane. v2.1: removed userList from required set.
    userList:    ['mb51', 'inventoryMaster'],
    paramSearch: ['mb51', 'inventoryMaster']
  });
  const ASSESSMENT_TYPE_SCOPE = Object.freeze({
    scPerformance: ['allMaterials'],   /* PERF-INT-TYPE */
    unitFloc:    ['fleet', 'byClassification', 'byVendor'],
    userList:    ['manual'],
    paramSearch: ['parameterSearch']
  });

  /* ─── Per-parameter descriptors (used by Intake §5 + Settings §1) ────────
     Kept here so every consumer reads the same wording. */
  const PARAMETER_DESCRIPTIONS = Object.freeze({
    minMaxMethod:        'How recommended Min/Max are computed. <b>monthsBased</b> = P2 rate × months. <b>leadTimeBased</b> = rate × lead-time + safety stock (needs lead-time data).',
    p1Start:             'Baseline period start. Together with P1 end, defines the historical 5-month run-rate window.',
    p1End:               'Baseline period end. P1 rate = net consumption in this window ÷ 5 months.',
    p2Months:            'Rolling current window measured back from the run date. <b>P2 rate drives the Min/Max recommendation.</b>',
    minMonths:           'Months of consumption the recommended <b>Min</b> should cover (only used in monthsBased method).',
    maxMonths:           'Months of consumption the recommended <b>Max</b> should cover (only used in monthsBased method).',
    batchedMinFactor:    'Multiplier for the <b>Min · batched</b> = typical work-order batch (median units/job, cost-centre draws excluded) × this factor. Default 1.2.',
    batchedMinGoverns:   'Does the batched Min <b>govern</b> the recommendation? <b>off</b> (default) = the rate-based <b>calc Min</b> governs and the batched Min is shown for comparison only. <b>on</b> = recommended Min = <b>max(calc Min, batched Min)</b> so the Min always covers one typical batch — and that drives the traffic light.',
    threshold:           'Minimum net consumption (units) over the analysis window for a material to qualify for analysis.',
    minEventsThreshold:  'Minimum number of distinct <b>consumption events</b> a material needs over the window to qualify — a work-order issue (261) or a cost-centre issue (201) each counts as one event. Screens out high-quantity / few-event materials that can\'t be reliably Min/Maxed. Set to 0 to disable. Applied alongside the quantity Threshold above (a material must pass <em>both</em>).',
    hcePctThreshold:     'Single WO ≥ this share of the period total flags as a <b>High Consumption Event</b> (one-off spike — e.g. rebuild).',
    hceMultThreshold:    'Single WO ≥ this many times the average WO quantity also flags as an HCE.',
    lumpyCvThreshold:       'Coefficient of variation above this classifies a material as <b>LUMPY</b> (clustered demand, not steady draw-down).',
    lumpyTopWoThreshold:    'If a single WO represents this share or more of total consumption, classify as LUMPY.',
    invAdjSigmaThreshold:   'Standard-deviation threshold for flagging MB51 dates as likely <b>cycle-count / inventory adjustment</b> days. Daily issue-transaction counts above <em>mean + Nσ</em> become candidates the operator can confirm. Default 5σ is conservative; lower this (2–3σ) to surface more candidates, raise it (7–10σ) to flag only extreme spikes.',
    invAdjConfirmedDates:   'Dates the operator has confirmed as inventory adjustments. Transactions on these dates are excluded from the rate calculation (same mechanic as HCE, but labelled <b>Inv Adj</b>).',
    wrSoftMonths:           'Stock-runway threshold (months at P2 rate) above which a material on a watched MRP type is flagged as <b>Possible Working Redundant</b> (PURPLE soft). Default 6 mo.',
    wrHardMonths:           'Stock-runway threshold (months at P2 rate) above which a material on a watched MRP type is flagged as <b>Likely Working Redundant</b> (PURPLE hard — write-down review). Default 9 mo (lowered from 12 in v2.0.1).',
    wrMrpTypes:             'MRP types that trigger the Working Redundant check. Comma-separated. Default <code>PD</code> only; V1 is consumption-driven and self-corrects via draw-down. Add codes (e.g. <code>ZE</code>) if the site uses non-standard MRP types that should also be evaluated.',
    p2StockoutDomFraction:  'How much of the recent (P2) window a material can be <b>out of stock</b> before its recent-consumption rate is considered unreliable. If stockout days reach this share of the P2 window, the material is forced <b>GREY</b> ("verify supply continuity before changing Min/Max") instead of getting a rate-based recommendation — because a material sitting empty can\'t show its true demand. Applies even to a <em>single</em> long stockout (the previous rule only caught two or more separate stockouts). Default <b>0.25</b> (a quarter of the window). Set to 0 to disable the duration trigger and keep only the multi-stockout rule.',
    socBackCalcMonths:      'How far back to reconstruct your <b>site stock-on-hand level</b> for each material — drives the new stock line + stockout bands on the material chart. The window starts on the date someone last consumed the material and extends backward this many months (then forward to today), so the chart shows the supply and consumption behaviour that led up to any stockout. For materials still consuming regularly the window naturally covers the most recent months; for materials whose consumption stopped, it stretches back to the run-up <em>before</em> they stopped — letting you see whether the drop was because <b>replenishment failed</b> (stockout-driven) or because <b>demand genuinely stopped</b> while stock was healthy. Default <b>6 months</b>. Must be at least as long as the P2 period above.'
  });

  /* ─── Empty scope (one of each mode pre-shaped) ─────────────────────────── */
  function emptyScope(mode) {
    const scope = {
      mode,
      fleet:            { models: [] },
      manual:           { materials: [], workOrders: [], listType: 'materials', detection: null }, /* APP-E22 — listType: 'materials' | 'workOrders'; detection holds intake-time auto-detect metadata */
      byClassification: {
        inventoryTypes: [],
        mrpClassifiers: [],
        movementAmount: { min: null, max: null }
      },
      byVendor:         { vendors: [] },
      parameterSearch:  { filters: [], resolvedMaterials: [] },
      allMaterials:     {}   /* PERF-INT-TYPE — no picker: every material in the files */
    };
    return scope;
  }

  /* ─── Empty canonical JSON shell ────────────────────────────────────────── */
  function emptyJson() {
    const now = (typeof AppLocale !== 'undefined' ? AppLocale.localStampCompact() : new Date().toISOString());
    return {
      schemaVersion: SCHEMA_VERSION,
      metadata: {
        assessmentName: '',
        // APP-E15 — uploadedAt is the FIRST-SAVE timestamp and is preserved
        // across re-saves of the same dataset. createdAt is REWRITTEN on every
        // save (acts as "last analysis"). Pre-APP-E15 intakes have no
        // uploadedAt; loaders fall back to createdAt for those. Additive,
        // no SCHEMA_VERSION bump.
        uploadedAt:     now,
        createdAt:      now,
        createdBy:      '',
        appVersion:     APP_VERSION,
        appName:        APP_NAME,        /* PERF-INT-TYPE — additive */
        assessmentType: null
      },
      scope:      emptyScope('fleet'),
      parameters: { ...FACTORY_DEFAULTS },
      data: {
        mb51:            [],
        iw39:            [],
        fleetMaster:     [],
        inventoryMaster: [],
        userList:        [],
        materialVendor:  [],
        leadTimes:       [],
        /* APP-T-02 (2026-05-16) — PR History as new optional intake source.
           Trace bridge phase 1. Schema descriptor only — no validateShape
           gate (optional). Saved canonical JSONs pre-dating T-02 simply
           default to an empty array via the normaliser below. No
           SCHEMA_VERSION bump (additive). */
        prHistory:       []
      },
      validation: { passed: false, issues: [] }
    };
  }

  /* ─── Validators ────────────────────────────────────────────────────────── */
  /**
   * Validate a canonical JSON object structurally. Returns { ok, errors }.
   * Does NOT validate data quality — that's the DQ gate's job. This is shape only.
   */
  function validateShape(json) {
    const errors = [];

    if (!json || typeof json !== 'object') {
      return { ok: false, errors: ['Not an object'] };
    }
    if (json.schemaVersion !== SCHEMA_VERSION) {
      errors.push(`schemaVersion mismatch: expected ${SCHEMA_VERSION}, got ${json.schemaVersion}`);
    }
    if (!json.metadata || typeof json.metadata !== 'object') errors.push('metadata missing');
    if (!json.scope    || typeof json.scope    !== 'object') errors.push('scope missing');
    if (!json.parameters || typeof json.parameters !== 'object') errors.push('parameters missing');
    if (!json.data     || typeof json.data     !== 'object') errors.push('data missing');

    if (json.scope && !SCOPE_MODES.includes(json.scope.mode)) {
      errors.push(`scope.mode invalid: ${json.scope.mode} (expected one of ${SCOPE_MODES.join(', ')})`);
    }

    if (json.scope && json.scope.mode === 'byVendor') {
      if (!Array.isArray(json.data?.materialVendor) || json.data.materialVendor.length === 0) {
        errors.push('byVendor scope requires data.materialVendor to be populated');
      }
    }

    if (json.parameters && json.parameters.minMaxMethod === 'leadTimeBased') {
      if (!Array.isArray(json.data?.leadTimes) || json.data.leadTimes.length === 0) {
        errors.push('leadTimeBased method requires data.leadTimes to be populated');
      }
    }

    const dataKeys = ['mb51', 'iw39', 'fleetMaster', 'inventoryMaster'];
    for (const k of dataKeys) {
      if (!Array.isArray(json.data?.[k])) {
        errors.push(`data.${k} must be an array`);
      }
    }

    return { ok: errors.length === 0, errors };
  }

  /* ─── Parameter sanity (called after Settings or per-run override) ──────── */
  function validateParameters(p) {
    const errors = [];
    if (!p) return { ok: false, errors: ['parameters missing'] };
    if (p.minMonths < 0 || p.maxMonths < 0) errors.push('months cannot be negative');
    if (p.minMonths > p.maxMonths)         errors.push('minMonths > maxMonths');
    if (p.threshold < 0)                    errors.push('threshold cannot be negative');
    if (p.p2Months < 1)                     errors.push('p2Months must be ≥ 1');
    if (p.hcePctThreshold < 0 || p.hcePctThreshold > 1) errors.push('hcePctThreshold must be 0–1');
    if (p.hceMultThreshold < 1)             errors.push('hceMultThreshold must be ≥ 1');
    if (p.lumpyCvThreshold < 0)             errors.push('lumpyCvThreshold must be ≥ 0');
    if (p.lumpyTopWoThreshold < 0 || p.lumpyTopWoThreshold > 1) errors.push('lumpyTopWoThreshold must be 0–1');
    if (p.p1Start && p.p1End && p.p1Start > p.p1End)            errors.push('p1Start > p1End');
    if (!['monthsBased','leadTimeBased'].includes(p.minMaxMethod)) errors.push('minMaxMethod invalid');
    // WR / PURPLE thresholds (v2.0.1) — guarded so older intakes without the keys still pass
    if (typeof p.wrSoftMonths === 'number' && p.wrSoftMonths < 0) errors.push('wrSoftMonths cannot be negative');
    if (typeof p.wrHardMonths === 'number' && p.wrHardMonths < 0) errors.push('wrHardMonths cannot be negative');
    if (typeof p.wrSoftMonths === 'number' && typeof p.wrHardMonths === 'number' && p.wrHardMonths < p.wrSoftMonths) errors.push('wrHardMonths must be ≥ wrSoftMonths');
    if (p.wrMrpTypes !== undefined && (!Array.isArray(p.wrMrpTypes) || p.wrMrpTypes.length === 0)) errors.push('wrMrpTypes must be a non-empty array');
    // APP-E1 (v2.1.3) — SOH back-calc window. Floor: must be ≥ p2Months so the
    // diagnostic window always covers the rate-change comparison period.
    if (typeof p.socBackCalcMonths === 'number') {
      if (p.socBackCalcMonths < 1) errors.push('socBackCalcMonths must be ≥ 1');
      if (typeof p.p2Months === 'number' && p.socBackCalcMonths < p.p2Months) {
        errors.push(`socBackCalcMonths (${p.socBackCalcMonths}) must be ≥ p2Months (${p.p2Months}) — back-calc window must cover the rate-change comparison period`);
      }
    }
    return { ok: errors.length === 0, errors };
  }

  /* ─── Public API ────────────────────────────────────────────────────────── */
  global.CanonicalSchema = Object.freeze({
    SCHEMA_VERSION,
    APP_VERSION,
    APP_NAME,
    SCOPE_MODES,
    ASSESSMENT_TYPES,
    ASSESSMENT_TYPE_REQUIRES,
    ASSESSMENT_TYPE_SCOPE,
    FACTORY_DEFAULTS,
    PARAMETER_DESCRIPTIONS,
    emptyScope,
    emptyJson,
    validateShape,
    validateParameters
  });

})(window);
