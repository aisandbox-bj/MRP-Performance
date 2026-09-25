/* ═══════════════════════════════════════════════════════════════════════════
   Pipeline — analytical core for the Analysis engine.
   Port of scripts/02_extract_model.py, 03_build_charts.py, 04_mrp_analysis.py.
   Rule semantics preserved line-for-line; deterministic, no inference.
═══════════════════════════════════════════════════════════════════════════ */

(function (global) {
  'use strict';

  /* ─── Movement types ────────────────────────────────────────────────────── */
  const ISSUE_TYPES  = new Set(['261', '201']);   // goods issue
  const RETURN_TYPES = new Set(['262', '202']);   // returns
  const VALID_TYPES  = new Set([...ISSUE_TYPES, ...RETURN_TYPES]);

  /* ─── Date helpers ──────────────────────────────────────────────────────── */
  function toDate(s){ if (!s) return null; const d = new Date(s); return isNaN(d.getTime()) ? null : d; }
  function inRange(d, start, end){ const dd = toDate(d); if (!dd) return false; const ds = toDate(start), de = toDate(end); return ds && de && dd >= ds && dd <= de; }
  function addMonths(iso, months){
    const d = toDate(iso);
    if (!d) return null;
    // APP-FIX-ADDMONTHS-TZ — UTC month math, consistent with monthsBetween /
    // snapMonthStart / snapMonthEnd. Local setMonth/getMonth read a UTC-midnight
    // 'YYYY-MM-DD' as the previous local day west of UTC, shifting the P2 window
    // start by up to a day (and the month at boundaries). UTC keeps it calendar-correct.
    const r = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + months, d.getUTCDate()));
    return r.toISOString().slice(0, 10);
  }
  function monthsBetween(a, b){
    const da = toDate(a), db = toDate(b);
    if (!da || !db) return 0;
    // APP-FIX-P1-RATE — UTC getters. 'YYYY-MM-DD' parses as UTC midnight, so
    // local getters in a west-of-UTC timezone read the 1st of a month as the
    // previous month (Apr 1 → Mar 31), over-counting p1Months by 1 (e.g. 6
    // instead of 5 → P1 rate ~17% low). UTC keeps the count in calendar-day space.
    return (db.getUTCFullYear() - da.getUTCFullYear()) * 12 + (db.getUTCMonth() - da.getUTCMonth());
  }
  // APP-FIX-P1-RATE — snap a date to the 1st / last day of its (UTC) month, so
  // the P1 window is whole calendar months and monthsBetween+1 == its true length.
  function snapMonthStart(iso){
    const d = toDate(iso); if (!d) return iso;
    return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-01`;
  }
  function snapMonthEnd(iso){
    const d = toDate(iso); if (!d) return iso;
    const last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0));
    return `${last.getUTCFullYear()}-${String(last.getUTCMonth() + 1).padStart(2, '0')}-${String(last.getUTCDate()).padStart(2, '0')}`;
  }

  /* ─── Group-by helper ───────────────────────────────────────────────────── */
  function groupBy(rows, keyFn){
    const out = new Map();
    for (const r of rows) {
      const k = keyFn(r);
      if (!out.has(k)) out.set(k, []);
      out.get(k).push(r);
    }
    return out;
  }

  /* ─── Net consumption per material from a transaction set ───────────────── */
  /**
   * Net = sum(quantity of issues) − sum(quantity of returns), per material.
   * Returns Map material → { net, tx261, qty261 (gross), description }.
   */
  function netConsumptionByMaterial(transactions, materialDescIndex){
    const agg = new Map();
    // APP-E9 — distinct consumption events per material. An event is a
    // work-order issue (261, keyed by its order) OR a cost-centre issue
    // (201 / order-less issue, keyed by posting date so same-day line-item
    // splits collapse to one event). Drives the minEventsThreshold screen.
    const evMap = new Map();
    for (const r of transactions) {
      const m = String(r.material || '').trim();
      if (!m) continue;
      const mt = String(r.movementType || '').trim();
      if (!VALID_TYPES.has(mt)) continue;
      const q = Math.abs(parseFloat(r.quantity) || 0);

      const cur = agg.get(m) || { net: 0, qty261: 0, tx261: 0, qty262: 0 };
      if (ISSUE_TYPES.has(mt)) {
        cur.net += q; cur.qty261 += q; if (mt === '261') cur.tx261++;
        let ev = evMap.get(m); if (!ev) { ev = new Set(); evMap.set(m, ev); }
        const o = String(r.order || '').trim();
        ev.add(o ? ('WO|' + o) : ('CC|' + String(r.postingDate || '').trim()));
      }
      if (RETURN_TYPES.has(mt))  { cur.net -= q; cur.qty262 += q; }
      agg.set(m, cur);
    }
    // Attach event count (and description, first non-null seen) per material.
    for (const [m, v] of agg) v.eventCount = (evMap.get(m) ? evMap.get(m).size : 0);
    if (materialDescIndex) {
      for (const [m, v] of agg) v.description = materialDescIndex.get(m) || '';
    }
    return agg;
  }

  function buildMaterialDescIndex(mb51){
    const idx = new Map();
    for (const r of mb51) {
      const m = String(r.material || '').trim();
      if (!m || idx.has(m)) continue;
      const d = String(r.description || '').trim();
      if (d) idx.set(m, d);
    }
    return idx;
  }

  /* ─── Period rate (port of calc_rate from 03_build_charts.py) ───────────── */
  /**
   * net = |sum issues in [start,end]| − |sum returns in [start,end]|
   * rate = net / months
   * flag: 'OK' | 'NO_DATA' (no rows in window) | 'NEGATIVE_NET'
   *
   * `excludeDates` (optional) is a Set<string> of postingDate values to skip
   * — used to drop confirmed inventory-adjustment days from the rate. The
   * row is still counted toward `rows` so we don't mis-flag NO_DATA.
   */
  function calcPeriodRate(transactions, start, end, months, excludeDates){
    let issues = 0, returns = 0, rows = 0;
    const xd = (excludeDates instanceof Set) ? excludeDates : null;
    for (const r of transactions) {
      if (!inRange(r.postingDate, start, end)) continue;
      const mt = String(r.movementType || '').trim();
      if (!VALID_TYPES.has(mt)) continue;
      rows++;
      if (xd && xd.has(r.postingDate)) continue;
      const q = Math.abs(parseFloat(r.quantity) || 0);
      if (ISSUE_TYPES.has(mt))   issues  += q;
      if (RETURN_TYPES.has(mt))  returns += q;
    }
    if (rows === 0) return { rate: 0, flag: 'NO_DATA' };
    const net = issues - returns;
    if (net < 0)   return { rate: 0, flag: 'NEGATIVE_NET' };
    return { rate: net / months, flag: 'OK' };
  }

  /* ─── Inventory-adjustment day detector ────────────────────────────────────
     Groups MB51 issue rows by postingDate, computes the daily-count mean +
     stddev, and returns dates with count ≥ mean + N·σ as candidates.
     The user confirms which dates are real cycle-count / adjustment days;
     confirmed dates' transactions are then excluded from rate calculations
     (same mechanic as HCE, labelled 'Inv Adj'). */
  function detectInvAdjCandidates(mb51, params){
    const sigmaN = (params && params.invAdjSigmaThreshold) || 5;
    const dailyMap = new Map();   // date → { date, count, materials:Set, totalQty }
    for (const r of (mb51 || [])) {
      const mt = String(r.movementType || '').trim();
      if (!ISSUE_TYPES.has(mt)) continue;          // adjustments post as issues (typically 201)
      const d = r.postingDate;
      if (!d) continue;
      const e = dailyMap.get(d) || { date: d, count: 0, materials: new Set(), totalQty: 0 };
      e.count++;
      const m = String(r.material || '').trim();
      if (m) e.materials.add(m);
      e.totalQty += Math.abs(parseFloat(r.quantity) || 0);
      dailyMap.set(d, e);
    }
    const days = [...dailyMap.values()];
    if (days.length < 3) {
      return { sigmaN, mean: 0, stddev: 0, threshold: 0, dayCount: days.length, candidates: [] };
    }
    const counts = days.map(d => d.count);
    const mean = counts.reduce((a, b) => a + b, 0) / counts.length;
    const variance = counts.reduce((a, b) => a + (b - mean) ** 2, 0) / counts.length;
    const stddev = Math.sqrt(variance);
    const threshold = mean + sigmaN * stddev;
    const candidates = days
      .filter(d => stddev > 0 && d.count > threshold)
      .map(d => {
        const dow = new Date(d.date).toLocaleDateString('en-US', { weekday: 'short' });
        return {
          date:              d.date,
          dayOfWeek:         dow,
          count:             d.count,
          sigmaAbove:        stddev > 0 ? Math.round((d.count - mean) / stddev * 10) / 10 : 0,
          materialsAffected: d.materials.size,
          totalQty:          Math.round(d.totalQty * 10) / 10
        };
      })
      .sort((a, b) => b.count - a.count);
    return {
      sigmaN,
      mean:      Math.round(mean * 10) / 10,
      stddev:    Math.round(stddev * 10) / 10,
      threshold: Math.round(threshold * 10) / 10,
      dayCount:  days.length,
      candidates
    };
  }

  /* ─── Per-material Inv Adj events from confirmed dates ────────────────────
     For a material's transactions, gather any rows that fall on a confirmed
     adjustment date. Returns an array shaped like the HCE event array so the
     downstream UI / Excel can render them with the same shape. */
  function buildInvAdjEvents(transactions, confirmedDates){
    if (!Array.isArray(confirmedDates) || confirmedDates.length === 0) return [];
    const set = new Set(confirmedDates);
    const byDate = new Map();
    for (const r of transactions) {
      const mt = String(r.movementType || '').trim();
      if (!ISSUE_TYPES.has(mt)) continue;
      const d = r.postingDate;
      if (!d || !set.has(d)) continue;
      const q = Math.abs(parseFloat(r.quantity) || 0);
      const e = byDate.get(d) || { date: d, qty: 0, orders: new Set(), nRows: 0 };
      e.qty   += q;
      e.nRows += 1;
      const o = String(r.order || '').trim();
      if (o) e.orders.add(o);
      byDate.set(d, e);
    }
    return [...byDate.values()].map(e => ({
      kind:      'INV_ADJ',
      period:    'INV_ADJ',
      date:      e.date,
      order:     e.orders.size === 1 ? [...e.orders][0] : `(${e.orders.size} orders)`,
      equipment: '— Inv Adj —',
      description: 'Inventory adjustment / cycle count',
      qty:       Math.round(e.qty * 10) / 10,
      pct:       null,
      reasons:   `Confirmed inventory-adjustment date (${e.nRows} rows, ${e.orders.size || 0} orders)`
    })).sort((a, b) => (a.date < b.date ? -1 : 1));
  }

  /* ─── HCE detection (port of detect_hce) ────────────────────────────────── */
  /**
   * Flag a WO as a High Consumption Event in a period if either:
   *   A) qty ≥ hcePctThreshold (fraction, e.g. 0.50) × period total
   *   B) qty ≥ hceMultThreshold × avg WO qty  (only when n_orders > 1)
   * Uses ISSUE rows only (261, 201) — returns are not events.
   * Returns array sorted by qty desc.
   */
  function detectHce(transactions, pStart, pEnd, periodLabel, params){
    const pctThresh  = params.hcePctThreshold;
    const multThresh = params.hceMultThreshold;

    const issueRows = transactions.filter(r => {
      if (!inRange(r.postingDate, pStart, pEnd)) return false;
      return ISSUE_TYPES.has(String(r.movementType || '').trim());
    });
    if (issueRows.length === 0) return [];

    // Aggregate per Order
    const byOrder = new Map();
    for (const r of issueRows) {
      const o = String(r.order || '').trim() || '(no order)';
      const q = Math.abs(parseFloat(r.quantity) || 0);
      const cur = byOrder.get(o) || { order: o, qty: 0, firstDate: r.postingDate, equipment: r.equipmentUnit || r.sortField || '—', description: r.woDescription || r.description || '' };
      cur.qty += q;
      if (r.postingDate < cur.firstDate) cur.firstDate = r.postingDate;
      if (!cur.equipment || cur.equipment === '—') cur.equipment = r.equipmentUnit || r.sortField || cur.equipment;
      byOrder.set(o, cur);
    }
    const woAgg = [...byOrder.values()];
    const totalQty = woAgg.reduce((a, w) => a + w.qty, 0);
    if (totalQty === 0) return [];
    const nOrders  = woAgg.length;
    const avgQty   = totalQty / nOrders;

    const out = [];
    for (const w of woAgg) {
      const pctFrac = w.qty / totalQty;
      const critA = pctFrac >= pctThresh;
      const critB = nOrders > 1 && w.qty >= multThresh * avgQty;
      if (!critA && !critB) continue;
      const reasons = [];
      if (critA) reasons.push(`${Math.round(pctFrac * 100)}% of period total`);
      if (critB) reasons.push(`${(w.qty / avgQty).toFixed(1)}× avg WO qty`);
      out.push({
        period:    periodLabel,
        order:     w.order,
        date:      w.firstDate,
        equipment: w.equipment,
        description: w.description || '',
        qty:       Math.round(w.qty),
        pct:       Math.round(pctFrac * 1000) / 10,
        reasons:   reasons.join(' | '),
        totalQty:  Math.round(totalQty),
        nOrders,
        avgQty:    Math.round(avgQty * 10) / 10
      });
    }
    out.sort((a, b) => b.qty - a.qty);
    return out;
  }

  /* ─── Adjusted P2 rate (HCE-excluded) ───────────────────────────────────── */
  function calcAdjustedP2Rate(transactions, p2s, p2e, hceOrders, p2Months){
    const excluded = new Set(hceOrders);
    const filtered = transactions.filter(r => !excluded.has(String(r.order || '').trim()));
    return calcPeriodRate(filtered, p2s, p2e, p2Months);
  }

  /* ─── Lumpy/Smooth classification (port of SKILL.md rule) ───────────────── */
  /**
   * is_lumpy = top1_pct >= lumpyTopWoThreshold
   *           OR cv > lumpyCvThreshold
   *           OR (wo_count <= 3 AND total_qty >= threshold)
   * Operates on the full analysis window's issue rows.
   */
  function classifyPattern(transactions, params){
    const issueRows = transactions.filter(r => ISSUE_TYPES.has(String(r.movementType || '').trim()));
    if (issueRows.length === 0) return 'SMOOTH';
    const byOrder = new Map();
    for (const r of issueRows) {
      const o = String(r.order || '').trim() || `__row_${Math.random()}`;
      const q = Math.abs(parseFloat(r.quantity) || 0);
      byOrder.set(o, (byOrder.get(o) || 0) + q);
    }
    const qtys = [...byOrder.values()];
    const total = qtys.reduce((a, b) => a + b, 0);
    if (total === 0) return 'SMOOTH';
    const max  = Math.max(...qtys);
    const mean = total / qtys.length;
    const variance = qtys.reduce((a, q) => a + (q - mean) ** 2, 0) / qtys.length;
    const sd   = Math.sqrt(variance);
    const cv   = mean > 0 ? sd / mean : 0;
    const top1 = max / total;
    const woCount = qtys.length;

    const isLumpy =
      (top1 >= params.lumpyTopWoThreshold) ||
      (cv > params.lumpyCvThreshold) ||
      (woCount <= 3 && total >= params.threshold);
    return isLumpy ? 'LUMPY' : 'SMOOTH';
  }

  /* ─── Cumulative consumption series ─────────────────────────────────────── */
  /**
   * Returns array of { date: ISO, delta, cum } sorted by date asc.
   * delta = +qty for issues, −qty for returns.
   */
  function cumulativeSeries(transactions){
    const byDate = new Map();
    for (const r of transactions) {
      const d = r.postingDate;
      if (!d) continue;
      const mt = String(r.movementType || '').trim();
      if (!VALID_TYPES.has(mt)) continue;
      const q = Math.abs(parseFloat(r.quantity) || 0);
      const delta = ISSUE_TYPES.has(mt) ? q : -q;
      byDate.set(d, (byDate.get(d) || 0) + delta);
    }
    const sorted = [...byDate.entries()].sort((a, b) => a[0] < b[0] ? -1 : 1);
    const out = [];
    let cum = 0;
    for (const [d, delta] of sorted) {
      cum += delta;
      out.push({ date: d, delta, cum });
    }
    return out;
  }

  /* ─── Traffic-light decision (port of assess() in 04_mrp_analysis.py) ───── */
  /**
   * Rules in priority order:
   *  0. stockoutDominated (APP-E11)           → GREY   ("stockout-dominated P2 — manual review")
   *  1. p2Flag != OK or p2Rate == 0           → GREY   ("no recent consumption")
   *  2. mrpType == "NOT IN MASTER"             → GREY   ("excluded")
   *  3. recMin is null                         → GREY   ("not calculable")
   *  4. PD AND stock-runway > 12 mo            → PURPLE ("likely Working Redundant")     ← v1.1.0
   *  5. PD AND stock-runway > 6 mo             → PURPLE ("possible Working Redundant")   ← v1.1.0
   *  6. mrp=PD AND total ≥ threshold           → RED    ("change to V1")
   *  7. mrp=V1 AND rec=current                 → GREEN  ("no action")
   *  8. mrp=V1 AND ALL rec < current           → BLUE   ("lower, safe")
   *  9. mrp=V1 AND any rec > current           → ORANGE ("raise, insufficient")
   * 10. else                                   → GREY   ("manual review")
   *
   * Then a FEW-EVENTS overlay: if the material had ≤ 2 issuing work orders
   * over the full analysis window AND the primary code was GREEN/BLUE, the
   * outcome is upgraded to ORANGE with a "few events" rationale. RED, GREY,
   * and PURPLE keep their priority (they're already review-priority).
   */
  function assess(mrpType, total, threshold, p2r, p2f, cmin, cmax, rmin, rmax, stock, woCount, params, stockoutDominated){
    // ── APP-E11 · STOCKOUT-DOMINATED gate (rule 0) ──────────────────────
    // More than one stockout window inside the chosen P2 window — the P2
    // rate (and therefore the rate-change verdict) is not trustworthy.
    // Forced GREY with a stockout-specific message; supply continuity
    // should be addressed before any Min/Max change.
    if (stockoutDominated) {
      return finalise({
        code:'GREY',
        action:'Stockout-dominated recent-rate window — multiple stockouts inside the P2 window make the rate unreliable. Verify supply continuity before changing Min/Max.',
        recMin:null, recMax:null
      }, woCount);
    }
    // ── GREY gates ───────────────────────────────────────────────────────
    if (p2f !== 'OK' || p2r === 0) {
      return finalise({ code:'GREY', action:'Refer for manual review — no recent (P2) consumption', recMin:null, recMax:null }, woCount);
    }
    if (String(mrpType || '').trim() === 'NOT IN MASTER') {
      return finalise({ code:'GREY', action:'Not in Inventory Master — excluded', recMin:null, recMax:null }, woCount);
    }
    if (rmin == null) {
      return finalise({ code:'GREY', action:'Recommended Min/Max not calculable', recMin:null, recMax:null }, woCount);
    }
    const mt = String(mrpType || '').trim().toUpperCase();

    // ── PURPLE — Working Redundant check (configurable thresholds, v2.0.1) ─
    // Runway = months of cover at the P2 rate. Items on a watched MRP type
    // (default PD) with a surplus runway indicate the Min/Max are mis-sized
    // or the item shouldn't be stocked at this level. V1 is consumption-driven
    // and self-corrects; not in the default watch-list.
    const wrSoft  = (params && typeof params.wrSoftMonths === 'number') ? params.wrSoftMonths : 6;
    const wrHard  = (params && typeof params.wrHardMonths === 'number') ? params.wrHardMonths : 9;
    const wrTypes = (params && Array.isArray(params.wrMrpTypes) && params.wrMrpTypes.length)
                    ? params.wrMrpTypes.map(s => String(s || '').trim().toUpperCase()).filter(Boolean)
                    : ['PD'];

    if (wrTypes.includes(mt) && typeof stock === 'number' && stock > 0 && p2r > 0) {
      const runway = stock / p2r;
      if (runway > wrHard) {
        return finalise({
          code:'PURPLE',
          action:`Likely Working Redundant — ${runway.toFixed(1)} months of stock at P2 rate (>${wrHard}mo with ${mt}). Review for destocking / write-down.`,
          recMin: rmin, recMax: rmax
        }, woCount);
      }
      if (runway > wrSoft) {
        return finalise({
          code:'PURPLE',
          action:`Possible Working Redundant — ${runway.toFixed(1)} months of stock at P2 rate (>${wrSoft}mo with ${mt}). Review stocking necessity.`,
          recMin: rmin, recMax: rmax
        }, woCount);
      }
    }

    // ── Standard MRP-type rules ──────────────────────────────────────────
    if (mt === 'PD' && total >= threshold) {
      return finalise({ code:'RED', action:`Change MRP type to V1. Set Min=${rmin}, Max=${rmax}`, recMin:rmin, recMax:rmax }, woCount);
    }
    if (mt === 'V1') {
      const minOk = cmin != null && Math.round(parseFloat(cmin)) === rmin;
      const maxOk = cmax != null && Math.round(parseFloat(cmax)) === rmax;
      if (minOk && maxOk) {
        return finalise({ code:'GREEN', action:'No action required — MRP type and parameters correct', recMin:rmin, recMax:rmax }, woCount);
      }
      const parts = [];
      const dirs  = [];
      if (!minOk) {
        const cur = cmin != null ? Math.round(parseFloat(cmin)) : null;
        parts.push(`Min: current=${cur != null ? cur : 'blank'}, rec=${rmin}`);
        if (cur != null) dirs.push(rmin < cur ? 'down' : 'up');
      }
      if (!maxOk) {
        const cur = cmax != null ? Math.round(parseFloat(cmax)) : null;
        parts.push(`Max: current=${cur != null ? cur : 'blank'}, rec=${rmax}`);
        if (cur != null) dirs.push(rmax < cur ? 'down' : 'up');
      }
      if (dirs.length && dirs.every(d => d === 'down')) {
        return finalise({ code:'BLUE', action:`Lower Min/Max (low risk). ${parts.join('; ')}`, recMin:rmin, recMax:rmax }, woCount);
      }
      return finalise({ code:'ORANGE', action:`Increase Min/Max (insufficient). ${parts.join('; ')}`, recMin:rmin, recMax:rmax }, woCount);
    }
    return finalise({ code:'GREY', action:`${mrpType} not assessed — manual review`, recMin:null, recMax:null }, woCount);
  }

  /**
   * Few-events overlay: a material with ≤ 2 issuing work orders in the
   * analysis window has an unreliable rate (statistical noise dominates).
   * Override GREEN / BLUE to ORANGE so the planner reviews the pattern
   * manually before accepting the recommendation. RED / GREY / PURPLE
   * stay — they're already review-priority states.
   */
  function finalise(tl, woCount){
    if (woCount != null && woCount <= 2 && (tl.code === 'GREEN' || tl.code === 'BLUE')) {
      return {
        code:'ORANGE',
        action:`Only ${woCount} consumption event${woCount === 1 ? '' : 's'} over the analysis window — pattern unreliable, manual review of rate + Min/Max recommended. (Original: ${tl.code} — ${tl.action})`,
        recMin: tl.recMin,
        recMax: tl.recMax,
        fewEvents: true
      };
    }
    return tl;
  }

  /* ─── Count distinct issue work orders for a material's transactions ─── */
  function countIssueWorkOrders(transactions){
    const orders = new Set();
    for (const r of transactions) {
      const mt = String(r.movementType || '').trim();
      if (!ISSUE_TYPES.has(mt)) continue;
      const o = String(r.order || '').trim();
      if (o) orders.add(o);
    }
    return orders.size;
  }

  /* ═════════════════════════════════════════════════════════════════════════
     BUCKET BUILDING
     Builds analysis buckets from canonical JSON based on scope mode.
     Returns array of { key, name, materials: Set<string>, transactions: [...] }.
  ═════════════════════════════════════════════════════════════════════════ */
  function buildBuckets(json){
    const mode    = json.scope.mode;
    const mb51    = json.data.mb51 || [];
    const iw39    = json.data.iw39 || [];
    const fleet   = json.data.fleetMaster || [];
    const master  = json.data.inventoryMaster || [];
    const vendors = json.data.materialVendor || [];

    if (mode === 'fleet') return bucketsFleet(json, mb51, iw39, fleet);
    if (mode === 'manual') return bucketsManual(json, mb51);
    if (mode === 'byClassification') return bucketsByClassification(json, mb51, master);
    if (mode === 'byVendor') return bucketsByVendor(json, mb51, vendors);
    if (mode === 'parameterSearch') return bucketsParameterSearch(json, mb51);
    return [];
  }

  /* ─── Parameter Search bucketing ────────────────────────────────────────────
     The intake page resolves filters → list of materials. The pipeline simply
     uses that resolved list — same shape as 'manual'. */
  function bucketsParameterSearch(json, mb51){
    const ps   = (json.scope && json.scope.parameterSearch) || {};
    const mats = new Set(ps.resolvedMaterials || []);
    const transactions = mb51.filter(t => {
      const m = String(t.material || '').trim();
      if (!mats.has(m)) return false;
      const mt = String(t.movementType || '').trim();
      return VALID_TYPES.has(mt);
    });
    return [{
      key: 'paramSearch',
      name: `Parameter search · ${mats.size} mat${mats.size === 1 ? '' : 's'}`,
      kind: 'parameterSearch',
      materials: mats,
      transactions
    }];
  }

  /* ─── Fleet bucketing + multi-model detection ───────────────────────────── */
  function bucketsFleet(json, mb51, iw39, fleet){
    const runDate = (json.metadata && json.metadata.inventoryMasterDate) || new Date().toISOString().slice(0, 10);  // APP-FIX-SNAPSHOT-ALIGN — anchor IW39 cutoff to extract date
    const threshold = json.parameters.threshold;
    const models = (json.scope.fleet && json.scope.fleet.models) || [];

    // Per-model: sortFields → orders → transactions
    const perModel = [];
    for (const model of models) {
      const sortFields = new Set(
        fleet
          .filter(f => String(f.model || '').trim().toUpperCase() === model.trim().toUpperCase())
          .map(f => String(f.sortField || '').trim())
          .filter(Boolean)
      );
      const orderSf = new Map(); // order → equipmentUnit
      for (const w of iw39) {
        const sf = String(w.sortField || '').trim();
        const o  = String(w.order || '').trim();
        if (!sf || !o) continue;
        if (!sortFields.has(sf)) continue;
        if (w.basicStartDate && w.basicStartDate > runDate) continue;
        if (!orderSf.has(o)) orderSf.set(o, sf);
      }
      const orders = new Set(orderSf.keys());
      const transactions = [];
      for (const t of mb51) {
        const o = String(t.order || '').trim();
        if (!orders.has(o)) continue;
        const mt = String(t.movementType || '').trim();
        if (!VALID_TYPES.has(mt)) continue;
        transactions.push({ ...t, equipmentUnit: orderSf.get(o) });
      }
      perModel.push({ key: model, name: model, transactions });
    }

    // Multi-model detection: per-material net per model
    const materialModels = new Map();   // material → Set<model>
    for (const bucket of perModel) {
      const desc = buildMaterialDescIndex(bucket.transactions);
      const net  = netConsumptionByMaterial(bucket.transactions, desc);
      for (const [mat, agg] of net) {
        if (agg.net < threshold) continue;
        if (!materialModels.has(mat)) materialModels.set(mat, new Set());
        materialModels.get(mat).add(bucket.key);
      }
    }
    const multiSet = new Set();
    for (const [mat, mods] of materialModels) {
      if (mods.size >= 2) multiSet.add(mat);
    }

    // Strip multi materials from per-model buckets; build MULTI bucket from all selected models' transactions
    const out = [];
    for (const bucket of perModel) {
      const filtered = bucket.transactions.filter(t => !multiSet.has(String(t.material || '').trim()));
      out.push({
        key: bucket.key,
        name: bucket.name,
        kind: 'fleet',
        materials: null,
        transactions: filtered
      });
    }
    if (multiSet.size > 0) {
      // MULTI bucket = transactions across all per-model buckets for these materials
      const allTx = [];
      for (const bucket of perModel) {
        for (const t of bucket.transactions) {
          if (multiSet.has(String(t.material || '').trim())) allTx.push(t);
        }
      }
      out.push({ key: '__MULTI__', name: 'MULTI · cross-fleet', kind: 'multi', materials: multiSet, transactions: allTx });
    }
    return out;
  }

  function bucketsManual(json, mb51){
    /* APP-E22 — branch on scope.manual.listType. When 'workOrders', filter
       MB51 by `order` and derive the material set from matched transactions
       (so downstream traffic-light / LLM / Excel see a normal material bucket
       and don't need branch awareness). Legacy assessments without listType
       default to 'materials' (existing behaviour). */
    const m = json.scope.manual || {};
    const useWO = (m.listType === 'workOrders');
    const set = new Set((useWO ? m.workOrders : m.materials) || []);
    const transactions = mb51.filter(t => {
      const v = String((useWO ? t.order : t.material) || '').trim();
      if (!set.has(v)) return false;
      const mt = String(t.movementType || '').trim();
      return VALID_TYPES.has(mt);
    });
    const materials = useWO
      ? new Set(transactions.map(t => String(t.material || '').trim()).filter(Boolean))
      : set;
    return [{
      key:          'manual',
      name:         useWO ? 'Manual WO list' : 'Manual list',
      kind:         'manual',
      listType:     useWO ? 'workOrders' : 'materials',
      orders:       useWO ? set : null,
      materials,
      transactions
    }];
  }

  function bucketsByClassification(json, mb51, master){
    const f = json.scope.byClassification || {};
    const types = new Set((f.inventoryTypes || []).map(s => String(s).trim()));
    const mrps  = new Set((f.mrpClassifiers || []).map(s => String(s).trim()));
    const mmin  = f.movementAmount && f.movementAmount.min;
    const mmax  = f.movementAmount && f.movementAmount.max;

    // Filter master to matching materials
    const matSet = new Set();
    for (const r of master) {
      const it = String(r.inventoryType || '').trim();
      const mp = String(r.mrpInd || '').trim();
      if (types.size && !types.has(it)) continue;
      if (mrps.size  && !mrps.has(mp)) continue;
      matSet.add(String(r.material || '').trim());
    }
    // Movement-amount filter is applied per-material against MB51 net
    let transactions = mb51.filter(t => {
      const m = String(t.material || '').trim();
      if (!matSet.has(m)) return false;
      const mt = String(t.movementType || '').trim();
      return VALID_TYPES.has(mt);
    });
    if (mmin != null || mmax != null) {
      const desc = buildMaterialDescIndex(transactions);
      const net  = netConsumptionByMaterial(transactions, desc);
      const pass = new Set();
      for (const [mat, agg] of net) {
        if (mmin != null && agg.net < mmin) continue;
        if (mmax != null && agg.net > mmax) continue;
        pass.add(mat);
      }
      transactions = transactions.filter(t => pass.has(String(t.material || '').trim()));
    }
    return [{ key: 'classif', name: 'By Classification', kind: 'classification', materials: matSet, transactions }];
  }

  function bucketsByVendor(json, mb51, vendors){
    const sel = new Set((json.scope.byVendor && json.scope.byVendor.vendors) || []);
    const matToVendors = new Map();  // material → Set<vendor>
    for (const r of vendors) {
      const m = String(r.material || '').trim();
      const v = String(r.vendor || '').trim();
      if (!sel.has(v)) continue;
      if (!matToVendors.has(m)) matToVendors.set(m, new Set());
      matToVendors.get(m).add(v);
    }
    // Multi-vendor materials → MULTI bucket
    const multi = new Set();
    for (const [mat, vs] of matToVendors) if (vs.size >= 2) multi.add(mat);
    const out = [];
    for (const vendor of sel) {
      const mats = new Set();
      for (const [mat, vs] of matToVendors) {
        if (multi.has(mat)) continue;
        if (vs.has(vendor)) mats.add(mat);
      }
      const tx = mb51.filter(t => {
        const m = String(t.material || '').trim();
        if (!mats.has(m)) return false;
        const mt = String(t.movementType || '').trim();
        return VALID_TYPES.has(mt);
      });
      out.push({ key: vendor, name: vendor, kind: 'vendor', materials: mats, transactions: tx });
    }
    if (multi.size > 0) {
      const tx = mb51.filter(t => {
        const m = String(t.material || '').trim();
        if (!multi.has(m)) return false;
        const mt = String(t.movementType || '').trim();
        return VALID_TYPES.has(mt);
      });
      out.push({ key: '__MULTI__', name: 'MULTI · cross-vendor', kind: 'multi', materials: multi, transactions: tx });
    }
    return out;
  }

  /* ═════════════════════════════════════════════════════════════════════════
     RUN PIPELINE
     For each bucket, produce a per-material result with all derived stats.
     Returns { buckets: [...], runDate, parameters, summary }.
  ═════════════════════════════════════════════════════════════════════════ */
  function runPipeline(json, options){
    options = options || {};
    // APP-FIX-SNAPSHOT-ALIGN (v2.1.4) — anchor the analysis "as of" the Inventory
    // Master extract date when present (the snapshot the SOH back-calc walks back
    // from), so the purple line + P2 window stop drifting when the analysis runs
    // days after the extract. Falls back to the caller's runDate, then today.
    const runDate    = (json.metadata && json.metadata.inventoryMasterDate) || options.runDate || new Date().toISOString().slice(0, 10);
    const params     = json.parameters;
    const threshold  = params.threshold;
    const minMonths  = params.minMonths;
    const maxMonths  = params.maxMonths;
    const p2Months   = params.p2Months;
    const p1Start    = snapMonthStart(params.p1Start);   // APP-FIX-P1-RATE — whole-month window
    const p1End      = snapMonthEnd(params.p1End);
    const p1Months   = Math.max(1, monthsBetween(p1Start, p1End) + 1);
    const p2Start    = addMonths(runDate, -p2Months);
    const p2End      = runDate;

    const master = json.data.inventoryMaster || [];
    const masterIdx = new Map();
    for (const r of master) {
      masterIdx.set(String(r.material || '').trim(), r);
    }

    // APP-E1 (v2.1.4-dev FIX-1) — Pre-group the FULL MB51 by material for the
    // stock-on-hand back-calc. Bucket-filtered transactions (`bucket.transactions`)
    // are restricted to consumption-related movement types {261,201,262,202} —
    // they DO NOT include goods receipts (109/101) or their reversals (102).
    // The back-calc needs supply events too; without receipts, walking backward
    // through only-issues makes stock appear to monotonically rise — the
    // "infinite supply" bug. Pre-grouping here keeps it O(n) instead of per-loop.
    const mb51FullByMat = groupBy(json.data.mb51 || [], r => String(r.material || '').trim());

    // Inv-Adj candidates (always detected) + user-confirmed exclusion set
    const invAdjAnalysis = detectInvAdjCandidates(json.data.mb51 || [], params);
    const confirmedInvAdjDates = Array.isArray(params.invAdjConfirmedDates) ? params.invAdjConfirmedDates : [];
    const invAdjSet = new Set(confirmedInvAdjDates);

    const buckets = buildBuckets(json);
    const bucketResults = [];

    const summary = { GREEN:0, BLUE:0, ORANGE:0, RED:0, GREY:0, PURPLE:0, total: 0 };

    // APP-E9 — second screen: minimum distinct consumption events (WO 261 or
    // cost-centre 201). Absent on legacy assessments → 0 (off) so re-runs are
    // unchanged; new intakes carry the factory default (3) from the schema.
    const minEvents = (typeof params.minEventsThreshold === 'number' && params.minEventsThreshold > 0)
                        ? params.minEventsThreshold : 0;

    for (const bucket of buckets) {
      const desc = buildMaterialDescIndex(bucket.transactions);
      const net  = netConsumptionByMaterial(bucket.transactions, desc);
      // APP-USERLIST-SHOWALL — "Show all list materials" override (Trend toggle,
      // User-Specified material lists only). When on, include EVERY material the
      // operator listed, bypassing BOTH the quantity (threshold) and event
      // (minEvents) screens — even the structural "must have consumption" one,
      // since a material with no transactions isn't in `net`. Parts with no
      // consumption in the window flow through as net 0 / no events → assess()
      // gives them GREY ("no recent consumption"), so nothing drops silently.
      const showAllList = !!options.showAllUserList
                          && bucket.kind === 'manual' && bucket.listType === 'materials'
                          && bucket.materials;
      const qualifying = [];
      if (showAllList) {
        for (const mat of bucket.materials) {
          const m = String(mat || '').trim();
          if (!m) continue;
          const agg = net.get(m);
          const mr  = masterIdx.get(m);
          qualifying.push({
            material:    m,
            description: (agg && agg.description) || (mr && mr.description) || '',
            totalNet:    (agg && agg.net) || 0
          });
        }
      } else {
        for (const [mat, agg] of net) {
          if (agg.net < threshold) continue;
          if (agg.eventCount < minEvents) continue;   // APP-E9 — min consumption events screen
          qualifying.push({ material: mat, description: agg.description, totalNet: agg.net });
        }
      }
      qualifying.sort((a, b) => b.totalNet - a.totalNet);

      // Group transactions by material for per-material analysis
      const txByMat = groupBy(bucket.transactions, t => String(t.material || '').trim());

      const materials = [];
      const bucketSummary = { GREEN:0, BLUE:0, ORANGE:0, RED:0, GREY:0, PURPLE:0, total: 0 };

      for (const q of qualifying) {
        const tx = txByMat.get(q.material) || [];

        // ── Master lookup (moved up — back-calc needs `stock` early) ──────
        const masterRow     = masterIdx.get(q.material);
        const mrpType       = masterRow ? (masterRow.mrpInd || '') : 'NOT IN MASTER';
        const stock         = masterRow ? masterRow.totQtyOh : null;
        const cmin          = masterRow ? masterRow.mrpMin   : null;
        const cmax          = masterRow ? masterRow.mrpMax   : null;
        const safetyStock   = masterRow ? masterRow.safetyStock : null;
        const materialGroup = masterRow ? (masterRow.materialGroup || '') : '';
        const manufacturer  = masterRow ? (masterRow.manufacturer  || '') : '';
        const totValueOh    = masterRow ? masterRow.totValueOh : null;
        const movingAvgPrice= masterRow ? masterRow.movingAvgPrice : null;   // APP-TREND-UNITCOST — Inv Master moving average price (per unit)
        const totalReservation = masterRow ? masterRow.totalReservation : null;  // APP-TRACE-DEMAND / APP-MRP-REQ — open reservations from Inv Master

        // ── Signal scan: net issues/returns + last consumption date ───────
        // Pulled up so APP-E11's P2-anchoring decision can see lastConsDate.
        let _issuesQty = 0, _returnsQty = 0, _lastIssueDate = '';
        for (const r of tx) {
          const mt = String(r.movementType || '').trim();
          if (!VALID_TYPES.has(mt)) continue;
          const qv = Math.abs(parseFloat(r.quantity) || 0);
          if (ISSUE_TYPES.has(mt)) {
            _issuesQty += qv;
            const d = String(r.postingDate || '');
            if (d > _lastIssueDate) _lastIssueDate = d;
          } else if (RETURN_TYPES.has(mt)) {
            _returnsQty += qv;
          }
        }
        const lastConsumptionDate = _lastIssueDate || null;

        // APP-TREND-PEC — per-event consumption distribution (units issued per
        // consumptive event). An "event" is the SAME unit the event-count screen
        // uses: a work-order issue (261, keyed by its order) or a cost-centre
        // issue (201 / order-less, keyed by posting date). Per-event qty = the
        // gross issued units for that event; we report mean ± sample std over the
        // full analysis window (operator decision 2026-06-27). Returns (262/202)
        // are NOT events and don't reduce an event's size.
        const _evQty = new Map();
        for (const r of tx) {
          const mt = String(r.movementType || '').trim();
          if (!ISSUE_TYPES.has(mt)) continue;
          const qv = Math.abs(parseFloat(r.quantity) || 0);
          const o  = String(r.order || '').trim();
          const key = o ? ('WO|' + o) : ('CC|' + String(r.postingDate || '').trim());
          _evQty.set(key, (_evQty.get(key) || 0) + qv);
        }
        const _evVals = [..._evQty.values()];
        let perEventStats = { mean: null, median: null, std: null, n: _evVals.length };
        if (_evVals.length) {
          const _mean = _evVals.reduce((s, v) => s + v, 0) / _evVals.length;
          // median = typical batch draw (robust to spot-pull outliers) — APP-RENAME-BATCHED / batched-Min
          const _sorted = [..._evVals].sort((a, b) => a - b);
          const _mid = Math.floor(_sorted.length / 2);
          const _median = _sorted.length % 2 ? _sorted[_mid] : (_sorted[_mid - 1] + _sorted[_mid]) / 2;
          let _std = null;
          if (_evVals.length > 1) {
            const _var = _evVals.reduce((s, v) => s + (v - _mean) * (v - _mean), 0) / (_evVals.length - 1);
            _std = Math.sqrt(_var);
          }
          perEventStats = {
            mean:   Math.round(_mean * 100) / 100,
            median: Math.round(_median * 100) / 100,
            std:    _std == null ? null : Math.round(_std * 100) / 100,
            n:      _evVals.length
          };
        }

        // APP-BATCH-WO (operator 2026-06-28) — the BATCH parameters use WORK-ORDER
        // draws only: 261 net of 262, grouped by order. A cost-centre issue
        // (201/202) is shop consumables for the bin, NOT a job batch, so it's
        // excluded. Kept separate from perEventStats above (the all-events "Per
        // event cons" display stat). Empty when the material is drawn only via CC.
        const _batchQty = new Map();
        for (const r of tx) {
          const mt = String(r.movementType || '').trim();
          if (mt !== '261' && mt !== '262') continue;          // WO issue / return only
          const o = String(r.order || '').trim();
          if (!o) continue;                                     // order-less → not a job batch
          const qv = Math.abs(parseFloat(r.quantity) || 0);
          _batchQty.set(o, (_batchQty.get(o) || 0) + (mt === '261' ? qv : -qv));
        }
        const _batchVals = [..._batchQty.values()].filter(v => v > 0);   // net job draws only
        let batchStats = { mean: null, median: null, std: null, n: _batchVals.length };
        if (_batchVals.length) {
          const _bm  = _batchVals.reduce((s, v) => s + v, 0) / _batchVals.length;
          const _bso = [..._batchVals].sort((a, b) => a - b);
          const _bi  = Math.floor(_bso.length / 2);
          const _bmed = _bso.length % 2 ? _bso[_bi] : (_bso[_bi - 1] + _bso[_bi]) / 2;
          let _bstd = null;
          if (_batchVals.length > 1) {
            const _bvar = _batchVals.reduce((s, v) => s + (v - _bm) * (v - _bm), 0) / (_batchVals.length - 1);
            _bstd = Math.sqrt(_bvar);
          }
          batchStats = {
            mean:   Math.round(_bm * 100) / 100,
            median: Math.round(_bmed * 100) / 100,
            std:    _bstd == null ? null : Math.round(_bstd * 100) / 100,
            n:      _batchVals.length
          };
        }

        // ── APP-E1 · Back-calc SOH series (pulled up — APP-E11 needs ──────
        // stockoutWindows to make the P2 anchoring decision below).
        let stockOnHandSeries = [];
        let stockoutWindows   = [];
        let socBackCalcAnchor = null;
        if (typeof InventoryBackCalc !== 'undefined' && typeof stock === 'number') {
          const backCalcMonths = (typeof params?.socBackCalcMonths === 'number' && params.socBackCalcMonths > 0)
                                    ? params.socBackCalcMonths
                                    : 6;
          const win = InventoryBackCalc.buildWindow({
            lastConsDate:   lastConsumptionDate,
            runDate,
            backCalcMonths
          });
          if (win) {
            socBackCalcAnchor = win.anchor;
            // FIX-1 — pass the FULL per-material MB51 slice (includes 109
            // site receipts), not the bucket-filtered `tx`.
            const fullMb51 = mb51FullByMat.get(q.material) || [];
            const out = InventoryBackCalc.backCalcSOH({
              material:     q.material,
              currentSOH:   stock,
              mb51Rows:     fullMb51,
              windowStart:  win.windowStart,
              windowEnd:    win.windowEnd
            });
            stockOnHandSeries = out.series;
            stockoutWindows   = out.stockoutWindows;
          }
        }

        // ── APP-E11 · Per-material P2 anchor selection ───────────────────
        // If the back-calc tail is in an ongoing stockout > 7 days, anchor
        // P2 at lastConsumptionDate (not runDate) — analysing the trailing
        // ongoing-stockout days as "recent demand" misleads the rate-drop
        // verdict. Default behaviour (anchor at runDate) preserved when
        // there is no qualifying ongoing stockout. The chosen window
        // shadows the outer-scope p2Start/p2End for the rest of this
        // iteration ONLY; the top-level pipeline return still uses defaults.
        let p2AnchorMode = 'runDate';
        let p2Start = addMonths(runDate, -p2Months);
        let p2End   = runDate;
        if (typeof InventoryBackCalc !== 'undefined') {
          const tailInStockout = InventoryBackCalc.isTailInOngoingStockout(stockoutWindows, runDate, 7);
          const p2win = InventoryBackCalc.chooseP2Window({
            runDate,
            lastConsDate: lastConsumptionDate,
            p2Months,
            tailInOngoingStockout: tailInStockout
          });
          if (p2win && p2win.p2Start && p2win.p2End) {
            p2Start = p2win.p2Start;
            p2End = p2win.p2End;
            p2AnchorMode = p2win.anchor;
          }
        }

        // P1/P2 rates exclude any transactions on confirmed Inv-Adj dates
        const { rate: p1r, flag: p1f } = calcPeriodRate(tx, p1Start, p1End, p1Months, invAdjSet);
        const { rate: p2r, flag: p2f } = calcPeriodRate(tx, p2Start, p2End, p2Months, invAdjSet);

        // HCE detection runs on the FULL transaction set (HCE flags work-order
        // events regardless of Inv-Adj exclusion — they're independent signals)
        const hceP1 = detectHce(tx, p1Start, p1End, 'P1', params);
        const hceP2 = detectHce(tx, p2Start, p2End, 'P2', params);

        // Inv Adj events for THIS material (only those on confirmed dates)
        const invAdj = buildInvAdjEvents(tx, confirmedInvAdjDates);

        // Adjusted P2 rate excludes BOTH HCE work orders AND Inv-Adj dates
        let adjP2 = null;
        if (hceP2.length || invAdj.length) {
          const orders = hceP2.map(e => e.order);
          // Re-implement here so we can pass excludeDates too
          const excluded = new Set(orders);
          const filtered = tx.filter(r => !excluded.has(String(r.order || '').trim()));
          const r = calcPeriodRate(filtered, p2Start, p2End, p2Months, invAdjSet);
          adjP2 = { rate: r.rate, flag: r.flag };
        }

        // ── APP-E11 · Stockout-dominated detection ───────────────────────
        // If MORE THAN ONE stockout window falls inside the chosen P2 window,
        // P2 is too dominated by stockouts to produce a trustworthy
        // demand-rate verdict. The traffic-light is forced GREY (handled
        // inside assess()), and rateDropFlag / rateRiseFlag / rateChange
        // are suppressed below.
        let p2StockoutCount = 0;
        let p2StockoutDays  = 0;
        let p2StockoutFrac  = 0;
        let stockoutDominated = false;
        if (typeof InventoryBackCalc !== 'undefined' && stockoutWindows.length) {
          p2StockoutCount = InventoryBackCalc.countStockoutsInRange(stockoutWindows, p2Start, p2End);
          // APP-E11b — dominance by DURATION as well as count. A single long stockout
          // suppresses the P2 rate just as badly as several short ones, so a high
          // stockout-day fraction also forces GREY (keeps the original count trigger).
          p2StockoutDays  = InventoryBackCalc.stockoutDaysInRange(stockoutWindows, p2Start, p2End);
          const p2Days    = Math.max(1, Math.round((Date.parse(p2End) - Date.parse(p2Start)) / 86400000) + 1);
          p2StockoutFrac  = p2StockoutDays / p2Days;
          const domFrac   = (params.p2StockoutDomFraction != null) ? params.p2StockoutDomFraction : 0.25;
          stockoutDominated = (p2StockoutCount > 1) || (p2StockoutFrac >= domFrac);
        }

        const pattern = classifyPattern(tx, params);
        const cum = cumulativeSeries(tx);
        const rateChange = stockoutDominated
          ? null
          : ((p1f === 'OK' && p1r > 0 && p2f === 'OK')
              ? Math.round((p2r - p1r) / p1r * 1000) / 10
              : null);

        // APP-BATCH-MIN-ALONGSIDE / APP-BATCH-MIN-GOVERNS (operator 2026-06-28) —
        // calc Min = rate-based (p2 × minMonths). batchedMin = typical WO batch
        // (median, CC excluded) × factor, shown beside it. Whether the batched Min
        // GOVERNS (recommended Min = max of the two, so it always covers one batch)
        // is a setting: batchedMinGoverns 'off' (default — calc governs, batch is
        // comparison-only) | 'on' (max governs + drives the traffic light).
        // Max stays single (rmax = p2 × maxMonths), unaffected either way.
        const rminCalc = (p2f === 'OK' && p2r > 0) ? Math.round(p2r * minMonths) : null;
        const rmax     = (p2f === 'OK' && p2r > 0) ? Math.round(p2r * maxMonths) : null;
        const batchedMin = (batchStats.median != null && batchStats.median > 0)
          ? Math.round(batchStats.median * (params.batchedMinFactor || 1.2))
          : null;
        const rmin = (params.batchedMinGoverns === 'on' && rminCalc != null && batchedMin != null)
          ? Math.max(rminCalc, batchedMin)
          : rminCalc;

        const woCount = countIssueWorkOrders(tx);
        const tl = assess(mrpType, q.totalNet, threshold, p2r, p2f, cmin, cmax, rmin, rmax, stock, woCount, params, stockoutDominated);
        bucketSummary[tl.code] = (bucketSummary[tl.code] || 0) + 1;
        bucketSummary.total++;
        summary[tl.code]  = (summary[tl.code]  || 0) + 1;
        summary.total++;

        // Derived: runway @ P2 rate (in months of cover), null if no rate / no stock
        const runway = (p2f === 'OK' && p2r > 0 && typeof stock === 'number' && stock > 0)
                          ? Math.round((stock / p2r) * 10) / 10
                          : null;

        // ── APP-E8 · MRP type vs Min/Max applicability ───────────────────
        // Min/Max settings only operate under MRP type V1; PD cannot legitimately
        // hold Min/Max. Min/Max is still computed for ALL materials (PD included) —
        // so when the algorithm recommends a Min/Max for a PD material we must ALSO
        // recommend reclassifying its MRP type to V1. This SURFACES misclassified
        // PD items (the whole point) rather than excluding/hiding them. LUMPY / HCE
        // patterns also point at V1 (a fixed Min/Max is a poor fit for them).
        const _curMrp       = String(mrpType || '').trim().toUpperCase();
        const _hasRecMinMax = (tl.recMin != null || tl.recMax != null);
        const recMrpType = ((_curMrp === 'PD' && _hasRecMinMax) || pattern === 'LUMPY' || (hceP2 && hceP2.length))
                              ? 'V1'
                              : (mrpType || 'PD');
        // Reclass recommended only when we're changing the MRP type AND there is a
        // Min/Max to apply under it — the operator-stated trigger: "a Min/Max
        // recommendation means the MRP type must become V1, because PD cannot hold
        // Min/Max." Surfaces every misclassified PD → V1 candidate.
        const mrpReclassRecommended = _hasRecMinMax && !!_curMrp
                                       && String(recMrpType).trim().toUpperCase() !== _curMrp;
        const mrpReclassNote = mrpReclassRecommended
          ? `${mrpType} cannot hold Min/Max — reclassify MRP type to V1 to apply the recommended Min/Max.`
          : null;
        // Display-ready token for the analysis list column + set filter (clean,
        // operator-facing). null → renders as '—' and filters out of the set.
        const mrpRecFlag = mrpReclassRecommended
          ? `${_curMrp} → V1`
          : null;

        // v2.1.0 signal fields — netSign / daysSinceLastIssue use the
        // _issuesQty / _returnsQty / _lastIssueDate computed up top.
        let netSign;
        if (_issuesQty === 0 && _returnsQty === 0)   netSign = 'NO_DATA';
        else if (_issuesQty - _returnsQty < 0)       netSign = 'NEGATIVE (returns dominate)';
        else if (_returnsQty >= 0.25 * _issuesQty)   netSign = 'MIXED';
        else                                         netSign = 'POSITIVE';
        let daysSinceLastIssue = null;
        if (_lastIssueDate) {
          const _ms = Date.parse(runDate) - Date.parse(_lastIssueDate);
          if (Number.isFinite(_ms)) daysSinceLastIssue = Math.max(0, Math.floor(_ms / 86400000));
        }
        // APP-E11: when STOCKOUT-DOMINATED, suppress rateDropFlag / rateRiseFlag —
        // the rate comparison is not trustworthy under stockout dominance.
        const rateDropFlag = !stockoutDominated && (p1f === 'OK' && p1r > 0 && p2f === 'OK' && p2r <= 0.6 * p1r);
        const rateRiseFlag = !stockoutDominated && (p1f === 'OK' && p1r > 0 && p2f === 'OK' && p2r >= 1.6 * p1r);
        const invAdjCount  = invAdj.length;

        // ── APP-E1 · Stockout-driven drop classification ─────────────────
        // (Back-calc is already done above; this just runs the classifier
        // against the chosen P2 window.)
        let rateDropCause      = null;
        let stockoutDrivenDrop = false;
        if (typeof InventoryBackCalc !== 'undefined' && rateDropFlag && stockoutWindows.length) {
          rateDropCause = InventoryBackCalc.classifyRateDropCause({
            rateDropFlag,
            p2Start, p2End,
            stockoutWindows
          });
          stockoutDrivenDrop = (rateDropCause === 'STOCKOUT_DRIVEN');
        }

        materials.push({
          material:     q.material,
          description:  q.description,
          materialGroup,
          manufacturer,
          totValueOh,
          movingAvgPrice,
          totalReservation,
          totalNet:     Math.round(q.totalNet * 10) / 10,
          p1Net:        Math.round((tx.filter(r => inRange(r.postingDate, p1Start, p1End) && VALID_TYPES.has(String(r.movementType || '').trim())).reduce((s, r) => {
                          const mt = String(r.movementType || '').trim();
                          const qv = Math.abs(parseFloat(r.quantity) || 0);
                          return s + (ISSUE_TYPES.has(mt) ? qv : -qv);
                        }, 0)) * 10) / 10,
          p1Rate:       Math.round(p1r * 100) / 100,
          p1Flag:       p1f,
          p2Net:        Math.round((tx.filter(r => inRange(r.postingDate, p2Start, p2End) && VALID_TYPES.has(String(r.movementType || '').trim())).reduce((s, r) => {
                          const mt = String(r.movementType || '').trim();
                          const qv = Math.abs(parseFloat(r.quantity) || 0);
                          return s + (ISSUE_TYPES.has(mt) ? qv : -qv);
                        }, 0)) * 10) / 10,
          p2Rate:       Math.round(p2r * 100) / 100,
          p2Flag:       p2f,
          rateChange,
          adjP2Rate:    adjP2 ? Math.round(adjP2.rate * 100) / 100 : null,
          adjP2Flag:    adjP2 ? adjP2.flag : null,
          hceP1, hceP2,
          invAdj,                                  // events on confirmed Inv-Adj dates (excluded from rate)
          invAdjCount,                             // count of Inv-Adj events for this material (v2.1.0)
          pattern,
          stock, mrpType, cmin, cmax, safetyStock,
          recMin:       tl.recMin,
          recMax:       tl.recMax,
          recMrpType,
          mrpReclassRecommended,                   // APP-E8 — true when a Min/Max is recommended on a PD item → reclassify to V1
          mrpReclassNote,                          // APP-E8 — plain-English reclass note, or null
          mrpRecFlag,                              // APP-E8 — display token ('PD → V1') for list column + set filter, or null
          runway,                                  // months of cover at P2 rate
          woCount,                                 // unique issuing work orders in window
          perEventStats,                           // APP-TREND-PEC — {mean, median, std, n} units per consumptive event, ALL events incl. cost-centre (display stat)
          batchStats,                              // APP-BATCH-WO — {mean, median, std, n} net job draw per WORK ORDER (261/262 only, CC excluded) — the batch parameter
          batchedMin,                              // APP-BATCH-MIN-ALONGSIDE — WO-batch Min (median × factor); shown next to the calc Min
          recMinCalc: rminCalc,                    // APP-BATCH-MIN-GOVERNS — the rate-based calc Min (p2 × minMonths). recMin = this, or max(this, batchedMin) when batchedMinGoverns='on'
          fewEvents:    !!tl.fewEvents,            // true if few-events overlay tripped
          // v2.1.0 signal fields — additive, used by LLM prompt context
          netSign,                                 // 'POSITIVE' | 'NEGATIVE (returns dominate)' | 'MIXED' | 'NO_DATA'
          daysSinceLastIssue,                      // integer or null
          rateDropFlag,                            // boolean — p2Rate <= 0.6 * p1Rate
          rateRiseFlag,                            // boolean — p2Rate >= 1.6 * p1Rate
          // APP-E1 (v2.1.3) — stockout-aware diagnostic fields
          lastConsumptionDate,                     // ISO or null — max(postingDate) where mvt ∈ {261,201}
          stockOnHandSeries,                       // [{date, soh}] daily SOH back-calc over the window
          stockoutWindows,                         // [{start, end, days}] periods where SOH ≤ 0
          rateDropCause,                           // 'STOCKOUT_DRIVEN' | 'GENUINE_DEMAND_DROP' | null
          stockoutDrivenDrop,                      // boolean — true when rateDropFlag + stockout window overlaps P2
          socBackCalcAnchor,                       // 'lastConsumption' | 'today' | null — which date anchored the back-calc window
          // APP-E11 (v2.1.3) — P2 anchor + stockout-dominated diagnostic
          p2AnchorMode,                            // 'runDate' | 'lastConsumption' — where P2 window was anchored for this material
          p2StockoutCount,                         // integer — number of distinct stockout windows overlapping the chosen P2 window
          p2StockoutDays,                          // APP-E11b — total stockout days inside the chosen P2 window
          p2StockoutFrac,                          // APP-E11b — p2StockoutDays / P2 days (0..1)
          stockoutDominated,                       // boolean — GREY-forcing: >1 window OR stockout-day fraction ≥ p2StockoutDomFraction
          trafficLight: tl.code,
          action:       tl.action,
          // Multi-model is filled in post-bucketing (see below). Defaults to 'Single'.
          multiModelFlag: bucket.kind === 'multi' ? 'Multi' : 'Single',
          bucketKey:    bucket.key,
          bucketName:   bucket.name,
          cumulative:   cum,
          p2Start, p2End, p1Start, p1End
        });
      }

      bucketResults.push({
        key: bucket.key,
        name: bucket.name,
        kind: bucket.kind,
        summary: bucketSummary,
        materials,
        txCount: bucket.transactions.length
      });
    }

    // APP-FIX-SNAPSHOT-ALIGN — Inventory Master extract date vs last MB51 posting.
    // Strict same-day check. If misaligned, every reconstructed SOH line is offset
    // by the net of the gap movements; the flag drives the chart caption + the
    // intake validation issue. No imDate (older assessments) → can't check → aligned.
    const _imDate    = (json.metadata && json.metadata.inventoryMasterDate) || null;
    const _mb51Dates = (json.data.mb51 || []).map(r => r.postingDate).filter(Boolean);
    const _lastMb51  = _mb51Dates.length ? _mb51Dates.reduce((a, b) => (a > b ? a : b)) : null;
    const _gapDays   = (_imDate && _lastMb51) ? Math.round((Date.parse(_lastMb51) - Date.parse(_imDate)) / 86400000) : null;
    const snapshotAlign = {
      hasImDate:    !!_imDate,
      imDate:       _imDate,
      lastMb51Date: _lastMb51,
      gapDays:      _gapDays,
      aligned:      (_imDate && _lastMb51) ? (_imDate === _lastMb51) : true
    };

    return {
      runDate,
      parameters: params,
      p2Start, p2End,
      p1Start, p1End,
      buckets: bucketResults,
      summary,
      snapshotAlign,                               // APP-FIX-SNAPSHOT-ALIGN — extract-date vs MB51 cutoff
      invAdjAnalysis,                              // { sigmaN, mean, stddev, threshold, dayCount, candidates[] }
      invAdjConfirmedDates: confirmedInvAdjDates   // currently-applied exclusion list
    };
  }

  /* ─── Phase-0 result cache (APP-PIPE-CACHE, 2026-08-18) ───────────────────────
     Trend/Trace/Screener/Sandbox each re-run the WHOLE pipeline on every page load,
     so hopping "Trace it!" ↔ "Back to Trend" rebuilds needlessly. runPipelineCached
     memoises the LAST result in sessionStorage (survives same-tab navigation, cleared
     on tab close) keyed by a fingerprint of everything the result depends on: the
     assessment identity/stamps, the row counts of each source, json.parameters, and
     the runDate. Any real change (new/edited data, changed params, new day, different
     assessment) changes the fingerprint → miss → recompute. The result is plain
     JSON-serialisable data (ISO-string dates), so the cached copy is faithful; on a
     miss the FRESH result is always returned. Safety: cache read is shape-checked;
     oversized results (> cap) or a quota error simply skip caching (recompute, exactly
     today's behaviour) — no stale, no regression. */
  function pipelineFingerprint(json, options){
    const m = (json && json.metadata) || {};
    const d = (json && json.data) || {};
    const c = k => (Array.isArray(d[k]) ? d[k].length : 0);
    return [
      'pc1',
      m.assessmentName || m.name || '', m.uploadedAt || '', m.savedAt || '', m.createdAt || '',
      m.inventoryMasterDate || '',
      (json && json.SCHEMA_VERSION) || m.schemaVersion || '',
      c('mb51'), c('inventoryMaster'), c('iw39'), c('prHistory'), c('fleetMaster'), c('materialVendor'), c('userList'),
      JSON.stringify((json && json.parameters) || {}),
      (options && options.runDate) || '',
      (options && options.showAllUserList) ? 'showall' : ''   // APP-USERLIST-SHOWALL — cache on/off separately
    ].join('|');
  }
  const PIPE_CACHE_KEY = 'mrpPerf.pipelineResultCache';   // PERF-STORE-NS — own key (Tune uses invOpt.* on the same origin)
  const PIPE_CACHE_MAX = 4500000;   // ~4.5 MB serialised cap — larger runs just recompute (no cache)

  function runPipelineCached(json, options){
    let fp = null, ss = null;
    try { ss = (typeof sessionStorage !== 'undefined') ? sessionStorage : null; } catch (e) { ss = null; }
    try { fp = pipelineFingerprint(json, options); } catch (e) { fp = null; }
    if (fp && ss){
      try {
        const raw = ss.getItem(PIPE_CACHE_KEY);
        if (raw){
          const cached = JSON.parse(raw);
          if (cached && cached.fp === fp && cached.result && Array.isArray(cached.result.buckets)){
            return cached.result;   // HIT — skip the whole pipeline
          }
        }
      } catch (e) { /* corrupt/unreadable cache → fall through to recompute */ }
    }
    const result = runPipeline(json, options);   // MISS — always the fresh result
    if (fp && ss && result && Array.isArray(result.buckets)){
      try {
        const payload = JSON.stringify({ fp, result });
        if (payload.length <= PIPE_CACHE_MAX) ss.setItem(PIPE_CACHE_KEY, payload);
        else ss.removeItem(PIPE_CACHE_KEY);   // too big to cache → clear any prior entry so nothing stale lingers
      } catch (e) { /* quota / serialise error → skip caching, no regression */ }
    }
    return result;
  }

  /* ─── Public API ────────────────────────────────────────────────────────── */
  global.AppPipeline = Object.freeze({
    ISSUE_TYPES, RETURN_TYPES, VALID_TYPES,
    netConsumptionByMaterial,
    calcPeriodRate,
    detectHce,
    calcAdjustedP2Rate,
    detectInvAdjCandidates,
    buildInvAdjEvents,
    classifyPattern,
    cumulativeSeries,
    assess,
    buildBuckets,
    runPipeline,
    runPipelineCached,           // APP-PIPE-CACHE — sessionStorage-memoised result (skips rebuild on Trend↔Trace hops)
    addMonths, monthsBetween
  });

})(window);
