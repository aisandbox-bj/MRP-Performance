/* ═══════════════════════════════════════════════════════════════════════════
   shared/perf-engine.js · Calibre MRP Performance v0.1.0-dev
   ───────────────────────────────────────────────────────────────────────────
   The population engine. Reads the canonical JSON (same contract as Calibre
   Tune) and builds, for EVERY material in the files:

     · procurement chains  — one per PR line: PR → release → PO → 3PL (107)
                              → site (109) → first use (261), with SIGNED
                              stage durations. A negative duration is kept
                              and flagged "out of sequence"; it is never
                              clamped to 0 (Trace clamps — fine for a
                              planning average, wrong for a distribution).
     · the stock rebuild   — site stock-on-hand for every day of the MB51
                              window, walked back from the Inventory Master
                              snapshot with the SAME movement-type signs as
                              Tune's InventoryBackCalc (MVT_SIGN +
                              DIRECTIONAL_MVTS are read from that module, not
                              copied, so the two can't drift).
     · trigger events      — every time stock crosses its trigger line
                              (V1 → Min · PD with SS → SS · otherwise → zero),
                              what was on order at that moment, how long until
                              a PR / PO / recovery, and how many days the part
                              sat below the line with NOTHING on order.
     · order sizing        — V1 order-to-Max ratio at each PR, stock after each
                              site receipt vs Max, reorder frequency vs plan.
     · daily series        — MRP-created PRs per day next to "trigger debt"
                              (materials below their line with nothing on
                              order and no PR) — the silent-MRP detector.

   Definitions that are decisions (recorded in the RoC + manual):
     · 107 = goods arrived at the 3PL; 109 = received at site (operator,
       2026-09-25; matches the Trace skill spec). First date per PO+material,
       as Trace does.
     · Cancelled = deletion flag true AND processing status N (Trace rule).
     · MRP churn = a cancelled, never-PO'd, MRP-created (B) PR whose last
       change is within `churnDays` of its creation (Changed On is a proxy for
       the cancel date — SAP's last-change date, not a deletion timestamp).
     · Creation indicator: B = MRP, R = manual, blank = UNKNOWN (Trace
       defaults blank to B; here it stays unknown and is counted).
     · Min / Max / SS / MRP type are TODAY's values (Inventory Master
       snapshot) — historical changes are invisible to this engine.
     · "As of" = Inventory Master extract date if the intake recorded one,
       otherwise the last MB51 posting date.

   Pure module — no DOM. Async only so a big dataset can yield to the UI
   between material batches (progress callback). Deterministic.
   Depends on: InventoryBackCalc (shared/inventory-back-calc.js).
═══════════════════════════════════════════════════════════════════════════ */
(function (global) {
  'use strict';

  const DAY = 86400000;

  /* ─── Date helpers — integer UTC day numbers ────────────────────────────── */
  const _dn = new Map();
  function dn(s){
    if (s == null || s === '') return null;
    let v = _dn.get(s);
    if (v !== undefined) return v;
    const t = Date.parse(String(s).slice(0, 10) + 'T00:00:00Z');
    v = Number.isFinite(t) ? Math.round(t / DAY) : null;
    _dn.set(s, v);
    return v;
  }
  function iso(d){ return d == null ? null : new Date(d * DAY).toISOString().slice(0, 10); }
  function ym(d){ return d == null ? null : new Date(d * DAY).toISOString().slice(0, 7); }
  function trim(v){ return v == null ? '' : String(v).trim(); }
  function num(v){ if (v == null || v === '') return null; const n = +v; return Number.isFinite(n) ? n : null; }
  function round1(x){ return Math.round(x * 10) / 10; }

  /* first element ≥ x in a sorted numeric array (or null) */
  function firstGE(arr, x){
    let lo = 0, hi = arr.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (arr[mid] < x) lo = mid + 1; else hi = mid; }
    return lo < arr.length ? arr[lo] : null;
  }

  /* consumption movement types (same families the stock rebuild signs) */
  const CONS_ISSUE = new Set(['261', '201', '221', '291', '551']);
  const CONS_REV   = new Set(['262', '202', '222', '292', '552']);

  /* ─── Stock-rebuild primitives (shared by build + stockSeries) ─────────────
     signedDelta: the forward-in-time effect of one MB51 row on site stock —
     the SAME three paths as InventoryBackCalc.backCalcSOH: directional MVTs
     trust the row's sign; mapped MVTs take sign × |qty|; anything else is
     skipped. walkBack: end-of-day stock, walked back from the snapshot. */
  function signedDelta(mt, qRaw, MVT_SIGN, DIRECTIONAL){
    if (qRaw == null || qRaw === 0) return null;
    if (DIRECTIONAL.has(mt)) return qRaw;
    const sg = MVT_SIGN[mt];
    return sg == null ? null : sg * Math.abs(qRaw);
  }
  function walkBack(soh, deltas){
    const N = deltas.length, out = new Float64Array(N);
    let cursor = soh;
    for (let i = N - 1; i >= 0; i--) { out[i] = round1(cursor); cursor -= deltas[i]; }
    return out;
  }

  const DEFAULT_SETTINGS = Object.freeze({
    churnDays:      2,     // cancelled MRP PR within N days of creation = MRP churn
    provisionalPct: 0.9,   // a cohort month is provisional until this share has closed
    stalePoDays:    365    // an open PO older than this with no receipt = "stale" cover
  });

  /* ─── Creation indicator → trigger class ────────────────────────────────── */
  function triggerOf(ci){
    const c = trim(ci).toUpperCase();
    if (c === 'B') return 'MRP';
    if (c === 'R') return 'Manual';
    if (c === '')  return 'Unknown';
    return 'Other';
  }

  /* ─── Stage helper — signed duration + status ───────────────────────────
     status: done · open (end missing, still running; v = age so far)
             oos  (end BEFORE start — out of sequence, v negative)
             term (chain ended before this stage: cancelled)
             nocov(end would come from MB51 but the start predates MB51 cover)
             bad  (a date is known-bad, e.g. release outside PR..PO)
             bypass (stage skipped: site receipt with no 3PL receipt)
             na   (stage never started)                                     */
  function st(v, status){ return { v, s: status }; }

  /* ═════════════════════════════════════════════════════════════════════════
     build(json, settings, onProgress) → Promise<model>
  ═════════════════════════════════════════════════════════════════════════ */
  /* opts (PERF-DEEPDIVE, v0.2.0-dev):
       only        Set<material> — analyse just these materials. The window and
                   "as of" date are still taken from the WHOLE dataset, so a
                   single-material build gives exactly the same numbers as the
                   Workbench's full build.
       keepSeries  keep each analysed material's day arrays in model.series
                   (stock, deltas, cover, open PRs, on-order qty) — for the
                   deep-dive graph. Only use together with `only`. */
  async function build(json, settingsIn, onProgress, opts){
    opts = opts || {};
    const S = Object.assign({}, DEFAULT_SETTINGS, settingsIn || {});
    const BC = global.InventoryBackCalc;
    if (!BC) throw new Error('InventoryBackCalc not loaded');
    const MVT_SIGN = BC.MVT_SIGN, DIRECTIONAL = BC.DIRECTIONAL_MVTS;
    const t0 = performance.now();
    const progress = (p, msg) => { if (onProgress) onProgress(p, msg); };

    const data   = (json && json.data) || {};
    const mb51   = data.mb51 || [];
    const prAll  = data.prHistory || [];
    const imAll  = data.inventoryMaster || [];

    /* ── 1 · index everything by material in ONE pass each ─────────────── */
    progress(0.02, 'Indexing movements');
    const mbBy = new Map();
    let mbStart = null, mbEnd = null;
    for (const r of mb51) {
      const m = trim(r.material); if (!m) continue;
      let a = mbBy.get(m); if (!a) { a = []; mbBy.set(m, a); }
      a.push(r);
      const d = dn(r.postingDate);
      if (d != null) { if (mbStart == null || d < mbStart) mbStart = d; if (mbEnd == null || d > mbEnd) mbEnd = d; }
    }
    const prBy = new Map();
    let prStart = null, prEnd = null, prBlank = 0;
    for (const r of prAll) {
      const m = trim(r.material); if (!m) { prBlank++; continue; }
      let a = prBy.get(m); if (!a) { a = []; prBy.set(m, a); }
      a.push(r);
      const d = dn(r.prDate);
      if (d != null) { if (prStart == null || d < prStart) prStart = d; if (prEnd == null || d > prEnd) prEnd = d; }
    }
    const imBy = new Map();
    const imMulti = new Set();
    for (const r of imAll) {
      const m = trim(r.material); if (!m) continue;
      if (imBy.has(m)) { imMulti.add(m); continue; }   // first row wins (see data checks)
      imBy.set(m, r);
    }

    const imDate = dn(json && json.metadata && json.metadata.inventoryMasterDate);
    const asOf = imDate != null ? imDate : (mbEnd != null ? mbEnd : prEnd);
    const asOfSource = imDate != null ? 'Inventory Master extract date' : (mbEnd != null ? 'last MB51 movement' : 'last PR date');
    if (asOf == null) throw new Error('No dates in MB51 or PR History — nothing to analyse');
    const W0 = mbStart != null ? mbStart : (prStart != null ? prStart : asOf);
    const W1 = asOf;
    const N  = Math.max(1, W1 - W0 + 1);

    const materials = new Set([...mbBy.keys(), ...prBy.keys()]);
    const matList = [...materials].sort().filter(m => !opts.only || opts.only.has(m));

    /* ── 2 · model containers ─────────────────────────────────────────── */
    const model = {
      version: 1, settings: S,
      asOf, asOfIso: iso(asOf), asOfSource,
      window: { start: W0, end: W1, days: N, startIso: iso(W0), endIso: iso(W1) },
      mb51Span: { start: iso(mbStart), end: iso(mbEnd) },
      prSpan:   { start: iso(prStart), end: iso(prEnd) },
      counts: { mb51: mb51.length, pr: prAll.length - prBlank, prBlank, im: imAll.length, materials: materials.size },
      mat: new Map(),          // material → info (filter attributes + summaries)
      chains: [],              // one per PR line
      episodes: [],            // below-trigger-line episodes (trigger health)
      stockouts: [],           // stock ≤ 0 episodes
      orders: [],              // V1 order-to-Max at each converted PR
      receipts: [],            // each site-receipt day (109) with stock before/after
      reorder: [],             // V1 reorder frequency per material
      noPrReceipts: [],        // 107/109 against a PO with no PR line
      receiptPaths: new Map(), // path label → count (per PO+material in MB51)
      daily: {
        mrpPr:   new Int32Array(N), manualPr: new Int32Array(N), otherPr: new Int32Array(N),
        po:      new Int32Array(N),
        belowNoCoverNoPr: new Int32Array(N), belowNoCoverPr: new Int32Array(N),
        belowStaleOnly:   new Int32Array(N), belowCovered:   new Int32Array(N)
      },
      checks: { negativeStock: [], noIm: [], imMulti: [...imMulti], stalePos: [], noSoh: [] },
      series: new Map(),       // PERF-DEEPDIVE — per-material day arrays (opts.keepSeries)
      timingMs: 0
    };

    /* ── 3 · per material ─────────────────────────────────────────────── */
    let done = 0;
    const BATCH = 250;
    for (const m of matList) {
      analyseMaterial(m);
      done++;
      if (done % BATCH === 0) {
        progress(0.05 + 0.9 * done / matList.length, `Materials ${done.toLocaleString()} / ${matList.length.toLocaleString()}`);
        await new Promise(r => setTimeout(r, 0));
      }
    }
    progress(0.97, 'Summarising');
    model.chains.sort((a, b) => (a.prD ?? 0) - (b.prD ?? 0));
    model.timingMs = Math.round(performance.now() - t0);
    progress(1, 'Done');
    return model;

    /* ═══════════════════════════════════════════════════════════════════════
       analyseMaterial — everything for one material
    ═══════════════════════════════════════════════════════════════════════ */
    function analyseMaterial(m){
      const mbRows = mbBy.get(m) || [];
      const prRows = prBy.get(m) || [];
      const im     = imBy.get(m) || null;

      /* receipts per PO (107 / 109 / reversals) + consumption days */
      const rc = new Map();                 // po → { f107, f109, r109:[{d,q}], mv:Set }
      const cons261 = [];
      let consQty = 0;                      // net consumption in window (for reorder frequency)
      let consEvents = 0;                   // consumption movements (261 / 201 …) in window — segment attribute
      const deltas = new Float64Array(N);   // site-stock delta per day (MVT_SIGN / directional)
      let description = '';
      for (const r of mbRows) {
        const mt = trim(r.movementType);
        const d  = dn(r.postingDate);
        if (!description && r.description) description = trim(r.description);
        const po = trim(r.purchaseOrder);
        if (po && d != null) {
          let e = rc.get(po); if (!e) { e = { f107: null, f109: null, q107: 0, r109: [], mv: new Set() }; rc.set(po, e); }
          e.mv.add(mt);
          const q = Math.abs(num(r.quantity) || 0);
          if (mt === '107') { if (e.f107 == null || d < e.f107) e.f107 = d; e.q107 += q; }
          if (mt === '109') { if (e.f109 == null || d < e.f109) e.f109 = d; e.r109.push({ d, q }); }
        }
        if (mt === '261' && d != null) cons261.push(d);
        if (d == null) continue;
        /* stock delta — identical rule to InventoryBackCalc.backCalcSOH */
        const qRaw = num(r.quantity);
        const sd = signedDelta(mt, qRaw, MVT_SIGN, DIRECTIONAL);
        if (sd == null) continue;
        if (d >= W0 && d <= W1) {
          deltas[d - W0] += sd;
          if (CONS_ISSUE.has(mt)) { consQty += Math.abs(qRaw); consEvents++; }
          else if (CONS_REV.has(mt)) consQty -= Math.abs(qRaw);
        }
      }
      cons261.sort((a, b) => a - b);
      for (const e of rc.values()) e.r109.sort((a, b) => a.d - b.d);

      /* receipt-path mix (per PO+material in MB51) */
      for (const [po, e] of rc) {
        const has = (x) => e.mv.has(x);
        let path;
        if (has('641') || has('101')) path = 'Stock transfer (641 / 101)';
        else if (has('107') && has('109')) path = '107 → 109 (3PL → site)';
        else if (has('109')) path = '109 only (no 3PL receipt)';
        else if (has('107')) path = '107 only (at 3PL, not yet at site)';
        else path = 'Other movement types';
        model.receiptPaths.set(path, (model.receiptPaths.get(path) || 0) + 1);
      }

      /* ── material info (filter attributes) ── */
      const mrpType = im ? (trim(im.mrpInd) || '(blank)') : '(not in Inv. Master)';
      const min = im ? num(im.mrpMin) : null, max = im ? num(im.mrpMax) : null, ss = im ? num(im.safetyStock) : null;
      const soh = im ? num(im.totQtyOh) : null;
      const info = {
        material: m,
        description: description || (im && trim(im.description)) || (prRows[0] && trim(prRows[0].shortText)) || '',
        manufacturer: (im && trim(im.manufacturer)) || '(none)',
        mrpType, min, max, ss, soh,
        map: im ? num(im.movingAvgPrice) : null,
        materialGroup: (im && (trim(im.materialGroupDesc) || trim(im.materialGroup))) || '(none)',
        purchasingGroup: (im && trim(im.purchasingGroup)) || (prRows[0] && trim(prRows[0].purchasingGroup)) || '(none)',
        blockedStock: im ? num(im.blockedStock) : null,
        hasIm: !!im,
        /* segment attributes (material-level, window-based) */
        consQty, consEvents,
        consPerYr: consQty / (N / 365),
        consValuePerYr: (im && num(im.movingAvgPrice) != null) ? (consQty / (N / 365)) * num(im.movingAvgPrice) : null,
        stockValue: (im && num(im.movingAvgPrice) != null && soh != null) ? soh * num(im.movingAvgPrice) : null,
        nPr: prRows.length, nChains: 0,
        medE2E: null, triggerLine: null, stockStatus: 'no Min/Max',
        minSoh: null
      };
      model.mat.set(m, info);
      if (!im) model.checks.noIm.push(m);

      /* ── chains (one per PR line) ── */
      const chains = [];
      for (const r of prRows) {
        const prD = dn(r.prDate), relD = dn(r.releaseDate), poD = dn(r.poDate);
        const needD = dn(r.deliveryDate), chgD = dn(r.changedOn);
        const po = trim(r.purchaseOrder);
        const e  = po ? rc.get(po) : null;
        const g107 = e ? e.f107 : null, g109 = e ? e.f109 : null;
        const use  = g109 != null ? firstGE(cons261, g109) : null;
        const cancelled = trim(r.deletionIndicator).toLowerCase() === 'true'
                       && trim(r.processingStatus).toUpperCase() === 'N';
        const releaseBad = relD == null || (prD != null && relD < prD) || (poD != null && relD > poD);
        const trig = triggerOf(r.creationIndicator);
        const qty  = num(r.qtyRequested) || 0;
        const endedNoPo = !po && cancelled;
        const churn = endedNoPo && trig === 'MRP' && chgD != null && prD != null && (chgD - prD) <= S.churnDays;

        /* stage statuses */
        const A = prD == null ? st(null, 'na')
                : (relD != null ? (releaseBad ? st(relD - prD, 'bad') : st(relD - prD, 'done'))
                   : (po ? st(null, 'bad') : (endedNoPo ? st(null, 'term') : st(asOf - prD, 'open'))));
        let B;   // buyer leg: release → PO
        if (prD == null) B = st(null, 'na');
        else if (relD == null) B = po ? st(null, 'bad') : (endedNoPo ? st(null, 'term') : st(null, 'na'));   // not released yet → leg not started
        else if (releaseBad) B = st(po && poD != null ? poD - relD : null, 'bad');
        else if (po && poD != null) B = st(poD - relD, 'done');
        else if (po) B = st(null, 'bad');
        else if (endedNoPo) B = st(null, 'term');
        else B = st(asOf - relD, 'open');
        const AB = prD == null ? st(null, 'na')
                 : (po && poD != null ? (poD - prD < 0 ? st(poD - prD, 'oos') : st(poD - prD, 'done'))
                    : (endedNoPo ? st(null, 'term') : (po ? st(null, 'bad') : st(asOf - prD, 'open'))));
        let C;
        if (!po || poD == null) C = st(null, 'na');
        else if (g107 != null) C = g107 - poD < 0 ? st(g107 - poD, 'oos') : st(g107 - poD, 'done');
        else if (g109 != null) C = st(null, 'bypass');
        else if (mbStart == null || poD < mbStart) C = st(null, 'nocov');
        else C = st(asOf - poD, 'open');
        let D;
        if (g107 == null) D = g109 != null ? st(null, 'bypass') : st(null, 'na');
        else if (g109 != null) D = g109 - g107 < 0 ? st(g109 - g107, 'oos') : st(g109 - g107, 'done');
        else D = st(asOf - g107, 'open');
        const E = g109 == null ? st(null, 'na') : (use != null ? st(use - g109, 'done') : st(asOf - g109, 'open'));
        let E2E;
        if (prD == null) E2E = st(null, 'na');
        else if (g109 != null) E2E = g109 - prD < 0 ? st(g109 - prD, 'oos') : st(g109 - prD, 'done');
        else if (endedNoPo) E2E = st(null, 'term');
        else if (mbStart == null || (poD != null ? poD : prD) < mbStart) E2E = st(null, 'nocov');
        else E2E = st(asOf - prD, 'open');
        let PLAN;   // days late vs need-by (negative = early) — signed by design
        if (needD == null) PLAN = st(null, 'na');
        else if (g109 != null) PLAN = st(g109 - needD, 'done');
        else if (endedNoPo) PLAN = st(null, 'term');
        else if (mbStart == null || (poD != null ? poD : (prD != null ? prD : needD)) < mbStart) PLAN = st(null, 'nocov');
        else if (asOf > needD) PLAN = st(asOf - needD, 'open');
        else PLAN = st(null, 'notdue');
        const PLANLT = (needD != null && prD != null) ? needD - prD : null;

        let path;
        if (!po) path = cancelled ? (churn ? 'PR → cancelled (MRP churn)' : 'PR → cancelled') : (relD != null && !releaseBad ? 'PR released, awaiting PO' : 'PR awaiting release / PO');
        else if (g107 != null && g109 != null) path = 'PR → PO → 3PL → site';
        else if (g109 != null) path = 'PR → PO → site (no 3PL receipt)';
        else if (g107 != null) path = 'PR → PO → at 3PL';
        else if (mbStart == null || (poD != null && poD < mbStart)) path = 'PR → PO (receipt before MB51 window)';
        else path = 'PR → PO, awaiting receipt';

        const c = {
          material: m, pr: trim(r.pr), prItem: trim(r.prItem), po, trig,
          prD, relD, poD, g107, g109, use, needD, chgD,
          qty, purchasingGroup: trim(r.purchasingGroup) || '(none)',
          cancelled, churn, releaseBad, path,
          cancelLag: (endedNoPo && chgD != null && prD != null) ? chgD - prD : null,
          st: { A, B, AB, C, D, E, E2E, PLAN }, planLT: PLANLT,
          rcpt: e
        };
        chains.push(c);
        model.chains.push(c);
        /* daily PR / PO counts */
        if (prD != null && prD >= W0 && prD <= W1) {
          const i = prD - W0;
          if (trig === 'MRP') model.daily.mrpPr[i]++; else if (trig === 'Manual') model.daily.manualPr[i]++; else model.daily.otherPr[i]++;
        }
        if (poD != null && poD >= W0 && poD <= W1) model.daily.po[poD - W0]++;
      }
      info.nChains = chains.length;
      { const v = chains.filter(c => c.st.E2E.s === 'done').map(c => c.st.E2E.v).sort((a, b) => a - b);
        info.medE2E = v.length ? v[Math.floor((v.length - 1) / 2)] : null; }

      /* receipts against POs that have no PR line for this material */
      const prPos = new Set(chains.map(c => c.po).filter(Boolean));
      for (const [po, e] of rc) {
        if (prPos.has(po)) continue;
        if (e.f107 == null && e.f109 == null) continue;
        model.noPrReceipts.push({ material: m, po, g107: e.f107, g109: e.f109, qty: e.r109.reduce((s, x) => s + x.q, 0) || e.q107 });
      }

      /* ── stock rebuild + trigger health (needs Inventory Master stock) ── */
      if (!im || soh == null) { if (im) model.checks.noSoh.push(m); return; }
      const sohArr = walkBack(soh, deltas);
      let minSoh = Infinity;
      for (let i = 0; i < N; i++) if (sohArr[i] < minSoh) minSoh = sohArr[i];
      info.minSoh = minSoh;
      if (minSoh < -0.001) model.checks.negativeStock.push({ material: m, minSoh });

      /* trigger line */
      /* lineKind: 'min' / 'ss' = a real stock-level trigger MRP acts on.
         'demand' = PD with no SS — MRP raises a PR only for DEMAND (a
         reservation), which these files don't carry, so zero stock alone is
         not a trigger. 'none' = V1 with Min 0 — no reorder point. Both are
         still rebuilt (stockouts count) but are kept OUT of the trigger-
         response and trigger-debt measures, labelled for what they are. */
      let line = null, cmp = null, lineLabel = null, lineKind = null;
      if (mrpType === 'V1') { if (min != null && min > 0) { line = min; cmp = 'lt'; lineLabel = 'Min'; lineKind = 'min'; } else { line = 0; cmp = 'le'; lineLabel = 'zero (Min 0)'; lineKind = 'none'; } }
      else if (mrpType === 'PD') { if (ss != null && ss > 0) { line = ss; cmp = 'lt'; lineLabel = 'SS'; lineKind = 'ss'; } else { line = 0; cmp = 'le'; lineLabel = 'zero (no SS)'; lineKind = 'demand'; } }
      const realLine = lineKind === 'min' || lineKind === 'ss';
      info.triggerLine = lineLabel;
      /* today's stock status (filter) */
      if (mrpType === 'V1' && min != null && max != null && max > 0) {
        info.stockStatus = soh < min ? 'below Min' : (soh > max ? 'above Max' : 'within Min–Max');
      } else if (mrpType === 'PD') {
        info.stockStatus = (ss != null && ss > 0) ? (soh < ss ? 'below SS' : 'at / above SS') : (soh <= 0 ? 'stocked out' : 'in stock');
      }

      /* coverage & pipeline arrays (difference arrays) */
      const poFresh = new Int32Array(N + 1), poStale = new Int32Array(N + 1), prOpen = new Int32Array(N + 1);
      const poQty = new Float64Array(N + 1), prQty = new Float64Array(N + 1);
      const addRange = (arr, a, b, v) => {        // [a, b) in day numbers, clipped to window
        const s0 = Math.max(a, W0), e0 = Math.min(b, W1 + 1);
        if (e0 <= s0) return;
        arr[s0 - W0] += v; arr[e0 - W0] -= v;
      };
      for (const c of chains) {
        if (c.prD != null) {
          const prEndD = c.po && c.poD != null ? c.poD : (c.cancelled ? (c.chgD != null ? c.chgD : c.prD) : W1 + 1);
          addRange(prOpen, c.prD, prEndD, 1);
          addRange(prQty, c.prD, prEndD, c.qty);
        }
        if (c.po && c.poD != null) {
          if (mbStart != null && c.poD < mbStart && c.g109 == null) continue;     // receipt may predate MB51 — unknown
          let endD;
          if (c.rcpt && c.rcpt.r109.length) {
            let cum = 0; endD = c.rcpt.r109[c.rcpt.r109.length - 1].d;
            if (c.qty > 0) for (const x of c.rcpt.r109) { cum += x.q; if (cum >= c.qty) { endD = x.d; break; } }
          } else endD = W1 + 1;
          if (endD === W1 + 1 && asOf - c.poD > S.stalePoDays) {
            addRange(poStale, c.poD + S.stalePoDays, W1 + 1, 1);
            addRange(poFresh, c.poD, c.poD + S.stalePoDays, 1);
            addRange(poQty, c.poD, c.poD + S.stalePoDays, c.qty);
            model.checks.stalePos.push({ material: m, po: c.po, pr: c.pr, poD: c.poD, age: asOf - c.poD });
          } else {
            addRange(poFresh, c.poD, endD, 1);
            addRange(poQty, c.poD, endD, c.qty);
          }
        }
      }
      /* PERF-COVER-NOPR (v0.2.0-dev) — goods at the 3PL on a PO that has no PR
         line in the file (e.g. a PO raised before the PR extract starts) are
         still cover from their first 107 until their first 109. Their PO date
         is unknown, so the stretch before the 107 can't be counted. */
      {
        const linked = new Set(chains.map(c => c.po).filter(Boolean));
        for (const [po, e] of rc) {
          if (linked.has(po) || e.f107 == null) continue;
          const endD = e.f109 != null ? e.f109 : W1 + 1;
          addRange(poFresh, e.f107, endD, 1);
          addRange(poQty, e.f107, endD, e.q107);
        }
      }
      for (let i = 1; i <= N; i++) { poFresh[i] += poFresh[i-1]; poStale[i] += poStale[i-1]; prOpen[i] += prOpen[i-1]; poQty[i] += poQty[i-1]; prQty[i] += prQty[i-1]; }
      if (opts.keepSeries) model.series.set(m, { soh: sohArr, deltas, poFresh, poStale, prOpen, poQty, prQty, line, cmp, lineLabel, lineKind });

      /* PR start days sorted (response search) */
      const prStarts = chains.filter(c => c.prD != null).map(c => c.prD).sort((a, b) => a - b);
      const poStarts = chains.filter(c => c.po && c.poD != null).map(c => c.poD).sort((a, b) => a - b);

      if (line != null) {
        const below = (v) => cmp === 'lt' ? v < line : v <= 0.001;
        let i = 0;
        while (i < N) {
          if (!below(sohArr[i])) { i++; continue; }
          const i0 = i;
          let noCoverNoPr = 0, noCoverPr = 0, staleOnly = 0, covered = 0, stockoutDays = 0;
          /* runs: [firstDay, lastDay, kind] — kind 0 nothing on order & no PR,
             1 PR open but no PO, 2 only a stale PO, 3 covered. Lets the Workbench
             rebuild exact per-day exposure for any segment. */
          const runs = [];
          while (i < N && below(sohArr[i])) {
            const fresh = poFresh[i] > 0, pr = prOpen[i] > 0, stale = poStale[i] > 0;
            let kind;
            if (fresh) { covered++; if (realLine) model.daily.belowCovered[i]++; kind = 3; }
            else if (stale) { staleOnly++; if (realLine) model.daily.belowStaleOnly[i]++; kind = 2; }
            else if (pr) { noCoverPr++; if (realLine) model.daily.belowNoCoverPr[i]++; kind = 1; }
            else { noCoverNoPr++; if (realLine) model.daily.belowNoCoverNoPr[i]++; kind = 0; }
            const day = W0 + i, last = runs[runs.length - 1];
            if (last && last[2] === kind && last[1] === day - 1) last[1] = day; else runs.push([day, day, kind]);
            if (sohArr[i] <= 0.001) stockoutDays++;
            i++;
          }
          const i1 = i - 1;                               // last below day
          const ongoing = i1 === N - 1;
          const T = W0 + i0;
          const leftCensored = i0 === 0;                   // crossed before the window opened
          const coveredAtT = poFresh[i0] > 0;
          const prOpenAtT  = prOpen[i0] > 0;
          const lastBelow  = W0 + i1;
          const prAfter = firstGE(prStarts, T);
          const respPr  = (prAfter != null && prAfter <= lastBelow) ? prAfter : null;
          const poAfter = firstGE(poStarts, T);
          const respPo  = (poAfter != null && poAfter <= lastBelow + 0) ? poAfter : null;
          let response;
          if (lineKind === 'demand') response = 'PD without SS — demand-driven';
          else if (lineKind === 'none') response = 'V1 with Min 0 — no reorder point';
          else if (leftCensored) response = 'crossed before the window';
          else if (coveredAtT) response = 'already on order';
          else if (prOpenAtT) response = 'PR already open';
          else if (respPr != null) response = 'PR raised';
          else if (ongoing) response = 'no PR yet';
          else response = 'recovered without a PR';
          model.episodes.push({
            material: m, T, lastBelow, days: i1 - i0 + 1, ongoing, leftCensored,
            line, lineLabel, lineKind, realLine, mrpType, response, coveredAtT, prOpenAtT,
            toPr: (realLine && respPr != null && !leftCensored && !coveredAtT && !prOpenAtT) ? respPr - T : null,
            toPo: (respPo != null && !leftCensored) ? respPo - T : null,
            noCoverNoPr, noCoverPr, staleOnly, covered, stockoutDays, runs,
            sohAtT: sohArr[i0]
          });
        }
      }

      /* stockout episodes (stock ≤ 0) — covered = an order was in flight when it started */
      {
        let i = 0;
        while (i < N) {
          if (sohArr[i] > 0.001) { i++; continue; }
          const i0 = i; let cov = 0, unc = 0;
          while (i < N && sohArr[i] <= 0.001) { if (poFresh[i] > 0) cov++; else unc++; i++; }
          model.stockouts.push({
            material: m, T: W0 + i0, days: i - i0, ongoing: i === N, leftCensored: i0 === 0,
            orderInFlight: poFresh[i0] > 0, daysCovered: cov, daysUncovered: unc, mrpType
          });
        }
      }

      /* site receipts (109 days) — stock before/after vs Min/Max */
      {
        const recDays = new Map();
        for (const r of mbRows) {
          if (trim(r.movementType) !== '109') continue;
          const d = dn(r.postingDate); if (d == null || d < W0 || d > W1) continue;
          recDays.set(d, (recDays.get(d) || 0) + Math.abs(num(r.quantity) || 0));
        }
        for (const [d, q] of recDays) {
          const i = d - W0;
          const after = sohArr[i];
          const before = round1(after - deltas[i]);
          const overMax = (mrpType === 'V1' && max != null && max > 0) ? Math.max(0, after - max) : null;
          model.receipts.push({
            material: m, d, qty: q, before, after, mrpType, min, max, ss,
            fill: (mrpType === 'V1' && max != null && max > 0) ? after / max : null,
            overMax, overMaxValue: (overMax != null && info.map != null) ? overMax * info.map : null,
            beforeVsLine: line != null && line > 0 ? before / line : null
          });
        }
      }

      /* V1 order-to-Max at each converted PR */
      if (mrpType === 'V1' && max != null && max > 0) {
        for (const c of chains) {
          if (!c.po || c.prD == null || c.prD < W0 || c.prD > W1 || !(c.qty > 0)) continue;
          const i = c.prD - W0;
          const sohStart = round1(sohArr[i] - deltas[i]);
          const pipeline = Math.max(0, poQty[i] + prQty[i] - c.qty);   // excluding this PR's own qty
          const gap = max - (sohStart + pipeline);
          c.orderCtx = { sohStart, pipeline, gap, ratio: gap > 0 ? c.qty / gap : null };
          model.orders.push({ material: m, chain: c, d: c.prD, trig: c.trig, qty: c.qty, sohStart, pipeline, max, min, gap,
                              ratio: gap > 0 ? c.qty / gap : null });
        }
        /* reorder frequency: actual POs / yr vs annual consumption / (Max − Min) */
        const yrs = N / 365;
        const posInWin = chains.filter(c => c.po && c.poD != null && c.poD >= W0 && c.poD <= W1).length;
        const band = (min != null) ? max - min : null;
        const expected = (band != null && band > 0 && consQty > 0) ? (consQty / yrs) / band : null;
        model.reorder.push({ material: m, actualPerYr: posInWin / yrs, expectedPerYr: expected,
                             ratio: expected ? (posInWin / yrs) / expected : null, pos: posInWin, consPerYr: consQty / yrs, min, max });
      }
    }
  }

  /* ═════════════════════════════════════════════════════════════════════════
     Metric catalogue — what each distribution view measures
     value(c) → the stage object {v, s}; anchor(c) → the day the cohort is
     keyed on (the stage's START event, per operator 2026-09-25).
  ═════════════════════════════════════════════════════════════════════════ */
  const METRICS = {
    AB:   { key:'AB',   label:'PR → PO (internal)',        start:'PR created',  end:'PO raised',
            anchor: c => c.prD,  anchorLabel:'PRs created in', stage: c => c.st.AB,
            def:'Days from the PR being created to the PO being raised — approval plus buying. Anchored on the month the PR was created.' },
    A:    { key:'A',    label:'PR approval',               start:'PR created',  end:'PR released',
            anchor: c => c.prD,  anchorLabel:'PRs created in', stage: c => c.st.A,
            def:'Days from PR created to PR released. PRs whose release date falls outside PR-date…PO-date are counted as bad dates, not measured.' },
    B:    { key:'B',    label:'Buyer (release → PO)',      start:'PR released', end:'PO raised',
            anchor: c => c.prD,  anchorLabel:'PRs created in', stage: c => c.st.B,
            def:'Days from PR release to PO raised — the buyer leg. Anchored on the month the PR was created.' },
    C:    { key:'C',    label:'Supplier (PO → 3PL)',       start:'PO raised',   end:'arrived at 3PL (107)',
            anchor: c => c.poD,  anchorLabel:'POs placed in',  stage: c => c.st.C,
            def:'Days from PO raised to the goods arriving at the 3PL (first 107). Anchored on the month the PO was placed. Grouped by manufacturer (standing in for vendor).' },
    D:    { key:'D',    label:'3PL (3PL → site)',          start:'arrived at 3PL (107)', end:'received at site (109)',
            anchor: c => c.g107, anchorLabel:'Goods at 3PL in', stage: c => c.st.D,
            def:'Days from arriving at the 3PL (first 107) to being received at site (first 109). Anchored on the month goods arrived at the 3PL.' },
    E2E:  { key:'E2E',  label:'End to end (PR → site)',    start:'PR created',  end:'received at site (109)',
            anchor: c => c.prD,  anchorLabel:'PRs created in', stage: c => c.st.E2E,
            def:'Days from PR created to received at site — the whole chain. Anchored on the month the PR was created.' },
    PLAN: { key:'PLAN', label:'Against plan (need-by)',    start:'need-by date', end:'received at site (109)',
            anchor: c => c.prD,  anchorLabel:'PRs created in', stage: c => c.st.PLAN, signed: true,
            def:'Days the site receipt landed after the PR\'s need-by (Delivery Date); negative = early. For MRP PRs the need-by is PR date + SAP\'s planned lead time, so this is actual vs the planned process.' },
    E:    { key:'E',    label:'Shelf time (site → first use)', start:'received at site (109)', end:'first 261 issue',
            anchor: c => c.g109, anchorLabel:'Received in',   stage: c => c.st.E,
            def:'Days from site receipt to the first work-order issue after it. Long shelf times point at ordering ahead of need.' }
  };

  /* bin sets */
  const BINS_DAYS = [
    { lo:0,   hi:0,   label:'0' },   { lo:1,   hi:2,   label:'1–2' },  { lo:3,   hi:5,   label:'3–5' },
    { lo:6,   hi:10,  label:'6–10' },{ lo:11,  hi:15,  label:'11–15' },{ lo:16,  hi:20,  label:'16–20' },
    { lo:21,  hi:30,  label:'21–30' },{ lo:31, hi:45,  label:'31–45' },{ lo:46,  hi:60,  label:'46–60' },
    { lo:61,  hi:90,  label:'61–90' },{ lo:91, hi:120, label:'91–120' },{ lo:121, hi:180, label:'121–180' },
    { lo:181, hi:365, label:'181–365' },{ lo:366, hi:Infinity, label:'365+' }
  ];
  const BINS_SIGNED = [
    { lo:-Infinity, hi:-31, label:'31+ early' }, { lo:-30, hi:-15, label:'15–30 early' }, { lo:-14, hi:-8, label:'8–14 early' },
    { lo:-7, hi:-1, label:'1–7 early' }, { lo:0, hi:0, label:'on the day' }, { lo:1, hi:7, label:'1–7 late' },
    { lo:8, hi:14, label:'8–14 late' }, { lo:15, hi:30, label:'15–30 late' }, { lo:31, hi:60, label:'31–60 late' },
    { lo:61, hi:90, label:'61–90 late' }, { lo:91, hi:Infinity, label:'90+ late' }
  ];
  const BINS_RATIO = [
    { lo:-Infinity, hi:-1e-9, label:'at / above Max', special:'gap' },
    { lo:0,    hi:0.25, label:'< 25%' }, { lo:0.25, hi:0.5, label:'25–50%' }, { lo:0.5, hi:0.75, label:'50–75%' },
    { lo:0.75, hi:0.9,  label:'75–90%' }, { lo:0.9, hi:1.1, label:'to Max (90–110%)' },
    { lo:1.1,  hi:1.5,  label:'110–150%' }, { lo:1.5, hi:2, label:'150–200%' }, { lo:2, hi:Infinity, label:'> 200%' }
  ];
  function binIndex(bins, v){
    for (let i = 0; i < bins.length; i++) {
      const b = bins[i];
      if (b.hi === b.lo) { if (v === b.lo) return i; continue; }
      if (v >= b.lo && v <= b.hi) return i;
      if (i < bins.length - 1 && v > b.hi && v < bins[i + 1].lo) return i;   // fractional gaps
    }
    return bins.length - 1;
  }

  /* ═════════════════════════════════════════════════════════════════════════
     Statistics — percentiles with open items as LOWER BOUNDS
     done: exact values · open: values that are at least this big.
     A quantile is exact only if no open item ranks at or below it;
     otherwise it is reported as "≥".
  ═════════════════════════════════════════════════════════════════════════ */
  function quantiles(doneVals, openVals, qs){
    const all = [];
    for (const v of doneVals) all.push([v, 0]);
    for (const v of (openVals || [])) all.push([v, 1]);
    all.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    const n = all.length;
    const out = {};
    let openSeen = [], cntOpen = 0;
    for (let i = 0; i < n; i++) { if (all[i][1]) cntOpen++; openSeen.push(cntOpen); }
    for (const q of qs) {
      if (!n) { out[q] = null; continue; }
      const k = Math.min(n - 1, Math.max(0, Math.ceil(q * n) - 1));   // nearest-rank
      out[q] = { v: all[k][0], lowerBound: openSeen[k] > 0 };
    }
    return out;
  }
  function doneQuantiles(vals, qs){
    const a = vals.slice().sort((x, y) => x - y);
    const out = {};
    for (const q of qs) {
      if (!a.length) { out[q] = null; continue; }
      const k = Math.min(a.length - 1, Math.max(0, Math.ceil(q * a.length) - 1));
      out[q] = a[k];
    }
    return out;
  }

  /* Collect a metric over a chain set: returns buckets by status. */
  function collect(chains, metric){
    const r = { done: [], open: [], oos: [], term: 0, nocov: 0, bad: 0, bypass: 0, na: 0, notdue: 0 };
    for (const c of chains) {
      const x = metric.stage(c);
      if (x.s === 'done') {
        if (!metric.signed && x.v < 0) r.oos.push(c); else r.done.push(c);
      } else if (x.s === 'open') r.open.push(c);
      else if (x.s === 'oos') r.oos.push(c);
      else if (r[x.s] != null) r[x.s]++;
    }
    return r;
  }

  /* Cohort by anchor month → per-month distribution summary */
  /* period key for cohort grouping — 'month' (yyyy-mm) or 'quarter' (yyyy-Qn) */
  function periodKey(d, gran){
    if (d == null) return null;
    const k = ym(d);
    if (gran === 'quarter') return k.slice(0, 4) + '-Q' + (Math.floor((+k.slice(5, 7) - 1) / 3) + 1);
    return k;
  }
  function periodShort(k){ return k.includes('Q') ? k.slice(2, 4) + k.slice(5) : k.slice(2); }
  /* every period between the first and last key, so empty months show as gaps */
  function periodRange(keys, gran){
    if (!keys.length) return [];
    const s = keys.slice().sort(), out = [];
    let y = +s[0].slice(0, 4), p = gran === 'quarter' ? +s[0].slice(6) : +s[0].slice(5, 7);
    const last = s[s.length - 1];
    for (let guard = 0; guard < 600; guard++) {
      const k = gran === 'quarter' ? `${y}-Q${p}` : `${y}-${String(p).padStart(2, '0')}`;
      out.push(k);
      if (k === last) break;
      p++; if (p > (gran === 'quarter' ? 4 : 12)) { p = 1; y++; }
    }
    return out;
  }

  function cohorts(chains, metric, provisionalPct, gran){
    const by = new Map();
    for (const c of chains) {
      const a = metric.anchor(c); if (a == null) continue;
      const x = metric.stage(c);
      if (!(x.s === 'done' || x.s === 'open' || x.s === 'oos')) continue;
      const k = periodKey(a, gran);
      let g = by.get(k); if (!g) { g = { month: k, label: k, short: periodShort(k), done: [], open: [], oos: 0, chains: [] }; by.set(k, g); }
      g.chains.push(c);
      if (x.s === 'done' && (metric.signed || x.v >= 0)) g.done.push(x.v);
      else if (x.s === 'open') g.open.push(x.v);
      else g.oos++;
    }
    /* PERF-BANDS — include empty periods between the first and last so a band
       chart shows gaps instead of joining across missing months */
    for (const k of periodRange([...by.keys()], gran)) if (!by.has(k)) by.set(k, { month: k, label: k, short: periodShort(k), done: [], open: [], oos: 0, chains: [] });
    const out = [...by.values()].sort((a, b) => a.month.localeCompare(b.month));
    for (const g of out) {
      const n = g.done.length + g.open.length;
      g.nDone = g.done.length; g.nOpen = g.open.length;
      g.mean = g.done.length ? g.done.reduce((x, y) => x + y, 0) / g.done.length : null;   // PERF-BANDS
      g.closedPct = n ? g.done.length / n : 0;
      g.provisional = g.closedPct < provisionalPct;
      g.q = doneQuantiles(g.done, [0.1, 0.25, 0.5, 0.75, 0.9]);
      g.qAll = quantiles(g.done, g.open, [0.5, 0.9]);
    }
    return out;
  }

  /* ═════════════════════════════════════════════════════════════════════════
     stockSeries — one material's rebuilt daily stock (for drill-down charts
     and the parity check). Uses the SAME primitives as build().
  ═════════════════════════════════════════════════════════════════════════ */
  function stockSeries(json, model, material, mbRowsIn){
    const BC = global.InventoryBackCalc;
    const info = model.mat.get(material);
    if (!info || !info.hasIm || info.soh == null) return null;
    const W0 = model.window.start, N = model.window.days;
    const rows = mbRowsIn || (json.data.mb51 || []).filter(r => trim(r.material) === material);
    const deltas = new Float64Array(N);
    for (const r of rows) {
      const d = dn(r.postingDate); if (d == null || d < W0 || d > model.window.end) continue;
      const sd = signedDelta(trim(r.movementType), num(r.quantity), BC.MVT_SIGN, BC.DIRECTIONAL_MVTS);
      if (sd != null) deltas[d - W0] += sd;
    }
    return { start: W0, soh: walkBack(info.soh, deltas), deltas };
  }

  /* ═════════════════════════════════════════════════════════════════════════
     Parity self-check — the engine vs Tune's own modules on the same data.
     Chains: every in-sequence stage value must equal TracePhase.computeChains.
     Stock: the rebuilt series must equal InventoryBackCalc.backCalcSOH.
     Returns { chains:{checked, mismatched, examples}, stock:{…} }.
  ═════════════════════════════════════════════════════════════════════════ */
  function parityCheck(json, model, sampleSize){
    const out = { chains: { checked: 0, mismatched: 0, examples: [] }, stock: { checked: 0, mismatched: 0, examples: [] } };
    const TP = global.TracePhase, BC = global.InventoryBackCalc;
    const mats = [...model.mat.keys()].filter(m => model.mat.get(m).nChains > 0);
    const step = Math.max(1, Math.floor(mats.length / (sampleSize || 60)));
    const sample = mats.filter((_, i) => i % step === 0).slice(0, sampleSize || 60);
    const mbBy = new Map();
    for (const r of (json.data.mb51 || [])) { const m = trim(r.material); if (!m) continue; let a = mbBy.get(m); if (!a) mbBy.set(m, a = []); a.push(r); }
    const prBy = new Map();
    for (const r of (json.data.prHistory || [])) { const m = trim(r.material); if (!m) continue; let a = prBy.get(m); if (!a) prBy.set(m, a = []); a.push(r); }
    const mine = new Map();
    for (const c of model.chains) { const k = c.material + '|' + c.pr + '|' + c.prItem + '|' + c.po; mine.set(k, c); }
    if (TP && TP.computeChains) {
      for (const m of sample) {
        const mini = { data: { prHistory: prBy.get(m) || [], mb51: mbBy.get(m) || [] } };
        const theirs = TP.computeChains(mini, m);
        for (const t of theirs) {
          const r = (prBy.get(m) || []).find(x => trim(x.pr) === t.pr && trim(x.purchaseOrder) === t.po);
          const k = m + '|' + t.pr + '|' + (r ? trim(r.prItem) : '') + '|' + t.po;
          const c = mine.get(k);
          out.chains.checked++;
          if (!c) { out.chains.mismatched++; if (out.chains.examples.length < 5) out.chains.examples.push({ material: m, pr: t.pr, why: 'chain missing' }); continue; }
          const pairs = [['C', c.st.C], ['D', c.st.D], ['E', c.st.E]];
          if (!t.releaseBad) { pairs.push(['A', c.st.A]); pairs.push(['B', c.st.B]); }
          for (const [k2, s] of pairs) {
            const tv = t[k2];
            if (s.s === 'done' && s.v >= 0 && tv !== s.v) {
              out.chains.mismatched++;
              if (out.chains.examples.length < 5) out.chains.examples.push({ material: m, pr: t.pr, stage: k2, trace: tv, engine: s.v });
              break;
            }
          }
        }
      }
    }
    if (BC && BC.backCalcSOH) {
      const W0 = model.window.start, W1 = model.window.end;
      for (const m of sample) {
        const info = model.mat.get(m); if (!info || !info.hasIm || info.soh == null) continue;
        const r = BC.backCalcSOH({ material: m, currentSOH: info.soh, mb51Rows: mbBy.get(m) || [], windowStart: iso(W0), windowEnd: iso(W1) });
        if (r.error) continue;
        out.stock.checked++;
        /* compare EVERY day of the series, plus the stored minimum */
        const mine = stockSeries(json, model, m, mbBy.get(m) || []);
        let bad = null;
        if (!mine || mine.soh.length !== r.series.length) bad = { why: 'length', a: r.series.length, b: mine && mine.soh.length };
        else for (let i = 0; i < r.series.length; i++) {
          if (Math.abs(r.series[i].soh - mine.soh[i]) > 0.05) { bad = { day: r.series[i].date, backCalc: r.series[i].soh, engine: mine.soh[i] }; break; }
        }
        const minT = Math.min(...r.series.map(p => p.soh));
        if (!bad && Math.abs(minT - info.minSoh) > 0.05) bad = { why: 'min', backCalc: minT, engine: info.minSoh };
        if (bad) {
          out.stock.mismatched++;
          if (out.stock.examples.length < 5) out.stock.examples.push(Object.assign({ material: m }, bad));
        }
      }
    }
    return out;
  }

  /* PERF-DEEPDIVE — the stock-rebuild sign of one MB51 row (null = the row
     doesn't move site stock). Same rule as build(); used by the deep-dive's
     movement ledger so the running stock shown row by row IS the rebuild. */
  function rowDelta(r){
    const BC = global.InventoryBackCalc;
    return signedDelta(trim(r.movementType), num(r.quantity), BC.MVT_SIGN, BC.DIRECTIONAL_MVTS);
  }

  global.PerfEngine = Object.freeze({
    rowDelta,
    build, METRICS, BINS_DAYS, BINS_SIGNED, BINS_RATIO, binIndex,
    quantiles, doneQuantiles, collect, cohorts, periodKey, parityCheck, stockSeries,
    DEFAULT_SETTINGS, dn, iso, ym
  });
})(window);
