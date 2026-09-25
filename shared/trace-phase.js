/* ═══════════════════════════════════════════════════════════════════════════
   shared/trace-phase.js · APP-SCR-01 (2026-06-25)
   ───────────────────────────────────────────────────────────────────────────
   Single source of truth for the Calibre Trace per-material Phase-Distribution
   render: the A–D timeline chevron + purple "Time to First Use" shelf block
   (per APP-FIX-PD-CHEVRON), the five-box-plot grid (uniform y-scale + Tukey
   fence + on-plot mean, per APP-FIX-PD-POLISH), and the transposed stats table.

   Extracted verbatim from trace/trace.js so Trace AND the Screener render the
   SAME visual. The pieces that were state-coupled in trace.js are reshaped to
   take their inputs explicitly:
     · computeChains(json, material)   — `json` is an argument (was state.json)
     · activeChains/sigmaExcl(chains, filters) — filters passed in, not page state

   trace.js keeps its own filter toolbar (year / sigma / manual-exclude) and its
   own state-coupled active()/sigmaExcl() for the other views; it calls
   renderPhaseEmpty()/renderPhaseVisual() here for the visual. The Screener calls
   render() with default filters (All years, sigma off, no manual excludes).

   No external library deps — pure SVG/HTML. (Chart.js is NOT needed for this
   view.) escapeHtml is self-contained.

   Public API:
     TracePhase.computeChains(json, material) -> chain[]
     TracePhase.boxStats(values) -> stats | null
     TracePhase.getYearsForChains(chains) -> string[]
     TracePhase.sigmaExcl(chains, filters) -> Set<pr>
     TracePhase.activeChains(chains, filters) -> chain[]
     TracePhase.renderPhaseEmpty(material, drawnCount, actCount) -> html
     TracePhase.renderPhaseVisual(drawn) -> html  (chevron + plots + table + caveat)
     TracePhase.render(hostEl, json, material, { filters, toolbarHtml }) -> { chains, act, drawn }
═══════════════════════════════════════════════════════════════════════════ */
(function () {
  'use strict';

  function escapeHtml(s){ return String(s||'').replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'})[c]); }

  const PHASE_KEYS   = ['A', 'B', 'C', 'D', 'E'];
  const PHASE_LABELS = {
    A: 'PR Approval',
    B: 'Internal Processing',
    C: 'Vendor Lead Time',
    D: 'Transfer to Site',
    E: 'Time to First Use'
  };
  const PHASE_COLORS = ['#1FCED8', '#5AB69D', '#FBBF24', '#F87171', '#A78BFA'];

  /* ─── Date utils (copied from trace.js — were only used by computeChains) ─ */
  function parseISO(s){
    if (!s) return null;
    const str = String(s).slice(0, 10);
    const d = new Date(str + 'T00:00:00Z');
    return isNaN(d.getTime()) ? null : d;
  }
  function fmtISO(d){ if (!d) return null; return d.toISOString().slice(0, 10); }
  function days(a, b){
    if (!a || !b) return 0;
    const ms = b - a;
    if (ms < 0) return 0;
    return Math.round(ms / 86400000);
  }
  function numOr(v, fb){
    if (v == null || v === '') return fb;
    const n = parseFloat(v);
    return isNaN(n) ? fb : n;
  }

  /* ═════════════════════════════════════════════════════════════════════════
     computeChains — PR→PO→GR→consumption chains for one material.
     `json` is the canonical intake JSON (was state.json in trace.js).
  ═════════════════════════════════════════════════════════════════════════ */
  function computeChains(json, material){
    const j = json;
    const prHistory = (j.data && j.data.prHistory) || [];
    const mb51      = (j.data && j.data.mb51) || [];

    const prRows = prHistory.filter(r => String(r.material || '').trim() === material);

    const mb51ForMat = mb51.filter(r => String(r.material || '').trim() === material);
    const firstByPoMvt = new Map();
    for (const r of mb51ForMat) {
      const po = String(r.purchaseOrder || '').trim();
      const mvt = String(r.movementType || '').trim();
      if (!po || !mvt) continue;
      const key = po + '|' + mvt;
      const d = parseISO(r.postingDate);
      if (!d) continue;
      const existing = firstByPoMvt.get(key);
      if (!existing || d < existing.date) {
        firstByPoMvt.set(key, { date: d, qty: numOr(r.quantity, 0) });
      }
    }

    const cons261 = mb51ForMat
      .filter(r => String(r.movementType || '').trim() === '261')
      .map(r => parseISO(r.postingDate))
      .filter(Boolean)
      .sort((a, b) => a - b);

    return prRows.map(r => {
      const pr        = String(r.pr || '').trim();
      const po        = String(r.purchaseOrder || '').trim();
      const prDate    = parseISO(r.prDate);
      const relDate   = parseISO(r.releaseDate);
      const poDate    = parseISO(r.poDate);
      const gr3pl     = po ? (firstByPoMvt.get(po + '|107')?.date || null) : null;
      const siteWH    = po ? (firstByPoMvt.get(po + '|109')?.date || null) : null;
      const qtyAtWH   = po ? (firstByPoMvt.get(po + '|109')?.qty || 0)      : 0;
      const c261      = siteWH ? cons261.find(d => d >= siteWH) || null : null;

      // APP-FIX-T-04c — cancellation = deletion flag AND processingStatus 'N'.
      const cancelled = String(r.deletionIndicator || '').toLowerCase() === 'true'
                     && String(r.processingStatus || '').trim().toUpperCase() === 'N';

      // APP-FIX-REL-DATE (2026-06-26) — a PR's release must fall between the PR
      // date and the PO date. A missing release, one dated before the PR, or one
      // dated after the PO is impossible, so the release date is bad → both phases
      // that depend on it (A = PR->release, B = release->PO) are not computable
      // for this chain (null = excluded from those phase stats) rather than
      // reporting a phantom 0d or a huge phantom (the 719d seen on bad source data).
      const releaseBad = !relDate || (prDate && relDate < prDate) || (poDate && relDate > poDate);
      const A = releaseBad ? null : days(prDate, relDate);
      const B = releaseBad ? null : days(relDate, poDate);
      const C = days(poDate, gr3pl);
      const D = days(gr3pl, siteWH);
      const E = days(siteWH, c261);
      const total = [A, B, C, D, E].reduce((s, x) => s + (x || 0), 0);
      // APP-FIX-SIGMA-PROC (2026-06-27) — processing timeline only (phases A–D,
      // "total to site"); excludes phase E (Time to First Use / shelf time).
      // Sigma outlier-trim keys off this: trim on procurement time, not on how
      // long the part then sat on the shelf before first use.
      const totalToSite = (A || 0) + (B || 0) + (C || 0) + (D || 0);

      // APP-V03-PORT-1 — PR/PO precedence rule (a PO means the need was approved;
      // a PR with no PO is treated as cancelled). adminCancelled is reporting-only.
      let state_ = 'COMPLETE';
      if      (!po && cancelled)  state_ = 'CANCELLED';
      else if (!po)               state_ = 'PR_ONLY';
      else if (!siteWH)           state_ = 'IN_FLIGHT';
      else if (!c261)             state_ = 'NOT_YET_CONSUMED';

      const adminCancelled = !!po && cancelled;

      return {
        pr, po,
        prDate:   fmtISO(prDate),
        relDate:  fmtISO(relDate),
        poDate:   fmtISO(poDate),
        gr3pl:    fmtISO(gr3pl),
        siteWH:   fmtISO(siteWH),
        c261:     fmtISO(c261),
        A, B, C, D, E, total, totalToSite,
        releaseBad,
        qty:      qtyAtWH || numOr(r.qtyRequested, 0),
        qtySource: qtyAtWH ? 'MB51-109' : 'PR-requested',
        state:    state_,
        cancelled,
        adminCancelled,
        creationIndicator: String(r.creationIndicator || '').trim() || 'B'
      };
    }).sort((a, b) => (b.prDate || '').localeCompare(a.prDate || ''));
  }

  /* ═════════════════════════════════════════════════════════════════════════
     Filter machinery — explicit filters (not page state).
       filters = { yearFilter: 'All'|year, sigmaLimit: null|3|2|1.5, manualExcl: Set<pr> }
  ═════════════════════════════════════════════════════════════════════════ */
  function getChainYear(c){ return (c.prDate || '').substring(0, 4); }

  function getYearsForChains(chains){
    const yrs = new Set();
    for (const c of chains) { const y = getChainYear(c); if (y) yrs.add(y); }
    return [...yrs].sort();
  }

  // APP-FIX-SIGMA-ROBUST (2026-08-17) — the single source of truth for the Trace
  // outlier trim. It flags chains whose processing time to site (A–D `totalToSite`;
  // phase E / shelf time is deliberately excluded, per APP-FIX-SIGMA-PROC) is an
  // upper outlier. It uses a ROBUST estimator — median + k·1.4826·MAD (Median
  // Absolute Deviation) — instead of mean + k·SD, because the old mean+SD folded
  // the outlier into its own threshold: one extreme chain inflated the SD so much
  // that the threshold sat above everything moderate, so only the single most-
  // extreme chain was ever caught and tightening σ barely moved it. Median + MAD
  // is computed from the middle of the data, so an outlier can't hide itself.
  //   • ONE-SIDED (upper): only anomalously SLOW procurement is trimmed, never fast.
  //   • POST-manual: manual excludes are removed BEFORE the spread is computed, so
  //     the threshold reflects what's left (the old code never recomputed).
  //   • 1.4826 scales MAD to a σ-equivalent for ~normal data, so the 3/2/1.5σ
  //     buttons keep their meaning (looser → tighter). Fallbacks: if MAD collapses
  //     (>50% of values identical) use IQR/1.349; if that's also 0, exclude nothing.
  //   • Needs ≥4 completed chains — too few to judge an outlier robustly.
  function sigmaExcl(chains, filters){
    const sigmaLimit = filters && filters.sigmaLimit;
    const yearFilter = (filters && filters.yearFilter) || 'All';
    const manualExcl = (filters && filters.manualExcl) || new Set();
    if (!sigmaLimit) return new Set();
    const inYear = chains.filter(c => yearFilter === 'All' || getChainYear(c) === yearFilter);
    const drawn  = inYear.filter(c => !!c.siteWH && !manualExcl.has(c.pr));
    if (drawn.length < 4) return new Set();
    const totals = drawn.map(c => c.totalToSite).sort((a, b) => a - b);
    const med    = quantile(totals, 0.5);
    const absDev = totals.map(v => Math.abs(v - med)).sort((a, b) => a - b);
    let spread   = quantile(absDev, 0.5) * 1.4826;          // MAD → σ-equivalent
    if (spread <= 0) spread = (quantile(totals, 0.75) - quantile(totals, 0.25)) / 1.349;  // IQR fallback
    if (spread <= 0) return new Set();                       // fully degenerate — don't trim
    const threshold = med + sigmaLimit * spread;
    const excl = new Set();
    drawn.forEach(c => { if (c.totalToSite > threshold) excl.add(c.pr); });
    return excl;
  }

  function activeChains(chains, filters){
    const yearFilter = (filters && filters.yearFilter) || 'All';
    const manualExcl = (filters && filters.manualExcl) || new Set();
    const sig = sigmaExcl(chains, filters);
    const ex = new Set([...manualExcl, ...sig]);
    return chains.filter(c =>
      (yearFilter === 'All' || getChainYear(c) === yearFilter)
      && !ex.has(c.pr)
    );
  }

  /* ═════════════════════════════════════════════════════════════════════════
     Box-plot math (copied verbatim from trace.js)
  ═════════════════════════════════════════════════════════════════════════ */
  function quantile(sorted, q){
    if (sorted.length === 0) return null;
    const pos = (sorted.length - 1) * q;
    const base = Math.floor(pos);
    const rest = pos - base;
    if (sorted[base + 1] !== undefined) {
      return sorted[base] + rest * (sorted[base + 1] - sorted[base]);
    }
    return sorted[base];
  }

  function boxStats(values){
    const xs = values.filter(v => v != null && Number.isFinite(v)).sort((a, b) => a - b);
    if (xs.length === 0) return null;
    const n = xs.length;
    const min = xs[0];
    const max = xs[n - 1];
    const q1 = quantile(xs, 0.25);
    const q2 = quantile(xs, 0.5);
    const q3 = quantile(xs, 0.75);
    const mean = xs.reduce((s, v) => s + v, 0) / n;
    const iqr = q3 - q1;
    const upperFence = q3 + 1.5 * iqr;
    const outliers = xs.filter(v => v > upperFence);
    const inFence = xs.filter(v => v <= upperFence);
    const whiskerUpper = inFence.length ? inFence[inFence.length - 1] : max;
    return { n, min, max, q1, q2, q3, mean, iqr, upperFence, whiskerUpper, outliers };
  }

  /* APP-FIX-TREND-LT-TIE (2026-08-16) — single source of truth for the "total to
     site" average (phases A–D), so the Trace phase-decomposition headline and the
     Trend "Lead time" figure are computed identically and always tie.
       flowMean = Σ over flow phases (A–D) of the per-phase MEAN across the drawn
       (active + Site-WH) chains, nulls excluded.
     This deliberately differs from averaging each chain's `totalToSite`, because
     totalToSite folds a missing phase in as 0 ((A||0)+(B||0)+…). A chain with an
     invalid release date (releaseBad → A/B dropped to null) would then understate
     the per-chain total and drag the simple mean below the phase-decomposition
     headline. Summing per-phase means (each over only the chains where that phase
     is dated) is the figure the operator sees on Trace. */
  function totalToSiteMean(drawn){
    let sum = 0;
    for (const ph of PHASE_KEYS){
      if (ph === 'E') continue;                 // E = time-to-first-use (shelf), not "to site"
      const s = boxStats((drawn || []).map(c => c[ph]));
      if (s) sum += s.mean;
    }
    return sum;
  }

  // "Nice" axis tick generator — 1/2/5 × 10^n stepping for round numbers
  function niceTicks(min, max, target){
    if (max <= min) return [min];
    const range = max - min;
    const rough = range / Math.max(1, target);
    const mag = Math.pow(10, Math.floor(Math.log10(rough)));
    const norm = rough / mag;
    let step;
    if      (norm < 1.5) step = 1   * mag;
    else if (norm < 3)   step = 2   * mag;
    else if (norm < 7)   step = 5   * mag;
    else                 step = 10  * mag;
    const ticks = [];
    const start = Math.ceil(min / step) * step;
    for (let v = start; v <= max; v += step) ticks.push(Math.round(v * 100) / 100);
    return ticks;
  }

  // SVG box plot — vertical. APP-E-PD-RESTYLE (2026-06-26): carries the YoY
  // box-and-whisker visual style — whiskers to min/max, IQR box, the MEAN as the
  // bold headline line with its value labelled beside the box, jittered data
  // points, min/max labels, and ↑ markers for values above the shared scale
  // (yMaxShared = the average total LT; values above it clip). Needs p.vals (the
  // raw per-phase durations) for the jittered points + above-scale count.
  function renderBoxPlotSvg(p, yMaxShared){
    const W = 168, H = 220, PAD_T = 14, PAD_B = 50, PAD_L = 36, PAD_R = 12;
    const innerH = H - PAD_T - PAD_B;
    const innerW = W - PAD_L - PAD_R;
    if (!p.stats) {
      return `<div class="pd-plot pd-plot-empty">
        <div class="pd-plot-title" style="border-color:${p.color}">${p.key} · ${p.label}</div>
        <div class="pd-plot-nodata">no data</div>
      </div>`;
    }
    const s = p.stats;
    const vals = (p.vals || []).filter(v => v != null && Number.isFinite(v));
    const yMax = yMaxShared || (Math.max(s.upperFence, s.q3 + 1, 1) * 1.06);
    const clamp = v => Math.min(v, yMax);
    const yScale = (v) => PAD_T + innerH - (clamp(v) / yMax) * innerH;
    const boxX = PAD_L + innerW / 2 - 18;
    const boxW = 36;
    const midX = PAD_L + innerW / 2;
    const capW = 16;

    const ticks = niceTicks(0, yMax, 4);
    const tickMarks = ticks.map(t => `
      <line x1="${PAD_L}" x2="${W - PAD_R}" y1="${yScale(t)}" y2="${yScale(t)}" stroke="rgba(255,255,255,.06)" stroke-width="1"/>
      <text x="${PAD_L - 4}" y="${yScale(t) + 3}" text-anchor="end" fill="#9BABA8" font-family="JetBrains Mono, monospace" font-size="9">${t}</text>
    `).join('');

    const meanOn    = s.mean <= yMax;
    const aboveScale = vals.filter(v => v > yMax).length;
    const dots = vals.filter(v => v <= yMax).map((v, i) => {
      const jx = midX + Math.sin(i * 1.7) * boxW * 0.30;     // deterministic jitter (stable across re-renders)
      return `<circle cx="${jx.toFixed(1)}" cy="${yScale(v).toFixed(1)}" r="1.8" fill="${p.color}" fill-opacity="0.5"/>`;
    }).join('');
    const outlierMarkers = aboveScale
      ? `<text x="${midX}" y="${PAD_T - 2}" text-anchor="middle" fill="#f4c14a" font-family="JetBrains Mono, monospace" font-size="12" font-weight="600">↑ ${aboveScale}</text>`
      : '';
    const boxTopY = yScale(s.q3), boxBotY = yScale(s.q1);

    return `<div class="pd-plot" data-phase="${p.key}">
      <div class="pd-plot-title" style="border-color:${p.color}"><span class="pd-plot-code">${p.key}</span><span class="pd-plot-name">${p.label}</span></div>
      <svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMid meet" class="pd-plot-svg">
        ${tickMarks}
        <!-- Whiskers to min / max (clipped at scale) -->
        <line x1="${midX}" x2="${midX}" y1="${yScale(clamp(s.max))}" y2="${yScale(s.min)}" stroke="${p.color}" stroke-width="1.3" stroke-opacity="0.55"/>
        <line x1="${midX - capW/2}" x2="${midX + capW/2}" y1="${yScale(s.min)}" y2="${yScale(s.min)}" stroke="${p.color}" stroke-width="1.3" stroke-opacity="0.7"/>
        ${s.max <= yMax ? `<line x1="${midX - capW/2}" x2="${midX + capW/2}" y1="${yScale(s.max)}" y2="${yScale(s.max)}" stroke="${p.color}" stroke-width="1.3" stroke-opacity="0.7"/>` : ''}
        <!-- IQR box -->
        <rect x="${boxX}" y="${boxTopY}" width="${boxW}" height="${Math.max(boxBotY - boxTopY, 0.5)}" fill="${p.color}" fill-opacity="0.18" stroke="${p.color}" stroke-opacity="0.5" stroke-width="1" rx="2"/>
        <!-- Jittered data points -->
        ${dots}
        <!-- Mean as the bold headline line + value beside the box -->
        ${meanOn ? `<line x1="${boxX - 2}" x2="${boxX + boxW + 2}" y1="${yScale(s.mean)}" y2="${yScale(s.mean)}" stroke="${p.color}" stroke-width="2.5"/>` : ''}
        ${meanOn ? `<text x="${boxX + boxW + 4}" y="${yScale(s.mean) + 3}" text-anchor="start" fill="${p.color}" font-family="JetBrains Mono, monospace" font-size="10" font-weight="700">${s.mean.toFixed(1)}d</text>` : ''}
        <!-- Min / max labels -->
        <text x="${midX}" y="${yScale(s.min) + 11}" text-anchor="middle" fill="${p.color}" fill-opacity="0.8" font-family="JetBrains Mono, monospace" font-size="8">${Math.round(s.min)}d</text>
        ${s.max <= yMax ? `<text x="${midX}" y="${yScale(s.max) - 4}" text-anchor="middle" fill="${p.color}" fill-opacity="0.8" font-family="JetBrains Mono, monospace" font-size="8">${Math.round(s.max)}d</text>` : ''}
        ${outlierMarkers}
      </svg>
      <div class="pd-plot-foot">
        <span class="pd-foot-lbl" title="Completed chains in this phase">n</span><span class="pd-foot-val">${s.n}</span>
        <span class="pd-foot-sep">·</span>
        <span class="pd-foot-lbl" title="Mean (bold line)">μ</span><span class="pd-foot-val">${s.mean.toFixed(1)}d</span>
      </div>
    </div>`;
  }

  /* ═════════════════════════════════════════════════════════════════════════
     Empty state — fewer than 2 complete (siteWH) chains.
  ═════════════════════════════════════════════════════════════════════════ */
  function renderPhaseEmpty(material, drawnCount, actCount){
    return `
        <div class="pd-empty">
          <div class="pd-empty-lab">Need at least 2 complete chains</div>
          <h3>Phase Distribution requires chains that reached Site WH</h3>
          <p>Currently <b>${drawnCount}</b> chain${drawnCount === 1 ? '' : 's'} with full Phase A–E data for material <b>${escapeHtml(material)}</b>.</p>
          <p>Box plots compute quartiles + Tukey fence per phase across the <em>active set</em> (post year / sigma / manual filters). PR-only and in-flight chains carry null phase values and are excluded from this view; they still appear in Raw Data.</p>
          ${drawnCount === 0 && actCount > 0
            ? `<p class="pd-hint">${actCount} chain${actCount === 1 ? '' : 's'} active but none have a Site WH receipt — see Procurement Chain view for the state breakdown.</p>`
            : ''}
        </div>
      `;
  }

  /* ═════════════════════════════════════════════════════════════════════════
     Visual — chevron + box-plot grid + transposed stats table + caveat.
     `drawn` = active chains with a Site WH receipt (>= 2). Copied verbatim
     from trace.js renderPhaseDistribution (the post-empty-state branch).
  ═════════════════════════════════════════════════════════════════════════ */
  function renderPhaseVisual(drawn){
    // ── Per-phase stats ───────────────────────────────────────────────────
    const phaseStats = PHASE_KEYS.map(ph => {
      const vals = drawn.map(c => c[ph]).filter(v => v != null && Number.isFinite(v));
      return {
        key:   ph,
        label: PHASE_LABELS[ph],
        color: PHASE_COLORS[PHASE_KEYS.indexOf(ph)],
        vals,                              // APP-E-PD-RESTYLE — raw durations for jittered points
        stats: boxStats(drawn.map(c => c[ph]))
      };
    });

    // APP-FIX-REL-DATE — data-quality note: chains whose release date is missing
    // or impossible (before PR / after PO) are dropped from PR Approval (A) and
    // Internal Processing (B). Surface the count so a low n on those plots is
    // explained, not silent.
    const relBad = drawn.filter(c => c.releaseBad).length;
    const dqHtml = relBad
      ? `<div class="pd-dq-note">Data note · ${relBad} chain${relBad === 1 ? '' : 's'} dropped from PR Approval &amp; Internal Processing — missing or invalid release date (release must fall between the PR and the PO).</div>`
      : '';

    // Total LT chevron — APP-FIX-PD-CHEVRON: flow covers A–D (up to site
    // availability); phase E (Time to First Use) split out as a purple shelf
    // block. totalMean spans A–E and drives the box-plot shared y-scale.
    const phaseMeans = phaseStats.map(p => (p.stats ? p.stats.mean : 0));
    const totalMean  = phaseMeans.reduce((s, v) => s + v, 0);
    const flowPhases = phaseStats.filter(p => p.key !== 'E');
    const ePhase     = phaseStats.find(p => p.key === 'E');
    // APP-FIX-TREND-LT-TIE — via the shared helper so Trend's "Lead time" matches
    // this headline exactly (identical to the old inline sum-of-phase-means).
    const flowMean   = totalToSiteMean(drawn);
    const eMean      = (ePhase && ePhase.stats) ? ePhase.stats.mean : 0;
    const flowPct    = flowPhases.map(p => (flowMean > 0 ? (p.stats ? p.stats.mean : 0) / flowMean : 0));
    // APP-PD-SPREAD (2026-06-27) — spread of the total-to-site (A–D) across chains
    // with a complete A–D (all phases dated). Shown beside the headline as
    // +（Q3−median) / −(median−Q1) — the box top/bottom around the median, always
    // ≥0. Headline stays = flowMean (the sum of the displayed segment means).
    const adComplete = drawn.filter(c => c.A != null && c.B != null && c.C != null && c.D != null);
    const adStats    = adComplete.length >= 2 ? boxStats(adComplete.map(c => c.totalToSite)) : null;
    const spreadHtml = adStats
      ? `<span class="pd-chev-spread" title="Total-to-site box across ${adComplete.length} fully-dated chain${adComplete.length === 1 ? '' : 's'}: Q1 ${adStats.q1.toFixed(1)}d – Q3 ${adStats.q3.toFixed(1)}d. The +/- is the distance from the ${flowMean.toFixed(1)}d average up to the box top (Q3) and down to the box bottom (Q1); clamped at 0 if the average sits outside the box.">`
        + `<span class="up">+${Math.max(0, adStats.q3 - flowMean).toFixed(1)}</span>`
        + `<span class="dn">−${Math.max(0, flowMean - adStats.q1).toFixed(1)}</span></span>`
      : '';
    const chevronHtml = `
      <div class="pd-chevron">
        <div class="pd-chevron-lab">Total Lead Time to site availability · phase decomposition · avg across ${drawn.length} chain${drawn.length === 1 ? '' : 's'}</div>
        <div class="pd-chevron-row">
          <div class="pd-chevron-bar">
            ${flowPhases.map((p, i) => `
              <div class="pd-chev-seg" style="flex: ${flowPct[i] || 0.001}; background: ${p.color}; --pd-chev-fill: ${p.color};">
                <div class="pd-chev-inner">
                  <span class="pd-chev-code">${p.key}</span>
                  <span class="pd-chev-name">${p.label}</span>
                  <span class="pd-chev-val">${p.stats ? p.stats.mean.toFixed(1) : '—'}d</span>
                </div>
              </div>
            `).join('')}
          </div>
          <div class="pd-chev-total-site" title="Average total processing time until the material is received at site (phases A–D). Excludes shelf time before first use. The small +/- is the box spread (upper/lower quartile) of the per-chain total-to-site.">
            <span class="lab">Total to site</span>
            <span class="v">${flowMean.toFixed(1)}d${spreadHtml}</span>
          </div>
          ${ePhase ? `
          <div class="pd-chev-shelf" style="border-color:${ePhase.color}; background:${ePhase.color}1f;" title="Average time the material sits on the shelf after arriving at site, before its first consumption (phase E). Not part of the lead-time-to-availability total.">
            <span class="pd-chev-shelf-lab">then on shelf</span>
            <span class="pd-chev-shelf-name">${ePhase.key} · ${ePhase.label}</span>
            <span class="pd-chev-shelf-val" style="color:${ePhase.color};">${ePhase.stats ? eMean.toFixed(1) : '—'}d</span>
          </div>` : ''}
        </div>
      </div>
    `;

    // ── Build SVG box plots ───────────────────────────────────────────────
    // APP-E-PD-RESTYLE — y-axis max = the total average duration (sum of phase
    // means), no padding factor (operator: drop the ×1.2). Boxes/whiskers above
    // this clip and flag as ↑ off-chart, matching the YoY view.
    const pdYMax = Math.max(totalMean, 10);
    const plotHtml = `
      <div class="pd-plots">
        ${phaseStats.map(p => renderBoxPlotSvg(p, pdYMax)).join('')}
      </div>
    `;

    // ── Stats table — transposed (columns = phases A–E) ───────────────────
    const PD_STAT_ROWS = [
      { lab:'N',        fmt: s => String(s.n) },
      { lab:'Min',      fmt: s => s.min.toFixed(1) },
      { lab:'Q1',       fmt: s => s.q1.toFixed(1) },
      { lab:'Median',   fmt: s => s.q2.toFixed(1) },
      { lab:'Mean',     fmt: s => s.mean.toFixed(1), bold:true },
      { lab:'Q3',       fmt: s => s.q3.toFixed(1) },
      { lab:'Max',      fmt: s => s.max.toFixed(1) },
      { lab:'Outliers', fmt: s => String(s.outliers.length), warn: s => s.outliers.length > 0 }
    ];
    const tableHtml = `
      <div class="pd-stats-wrap">
        <table class="pd-stats pd-stats-t">
          <thead>
            <tr>
              <th class="rowlab"></th>
              ${phaseStats.map(p => `<th class="num"><span class="pd-phase-dot" style="background:${p.color}"></span>${p.key}<span class="pd-th-name">${p.label}</span></th>`).join('')}
            </tr>
          </thead>
          <tbody>
            ${PD_STAT_ROWS.map(row => `
              <tr>
                <td class="rowlab">${row.lab}</td>
                ${phaseStats.map(p => {
                  if (!p.stats) return `<td class="num mono empty">—</td>`;
                  const warn = row.warn && row.warn(p.stats) ? ' warn' : '';
                  const val  = row.fmt(p.stats);
                  return `<td class="num mono${warn}">${row.bold ? `<b>${val}</b>` : val}</td>`;
                }).join('')}
              </tr>
            `).join('')}
          </tbody>
        </table>
      </div>
    `;

    return `
      ${chevronHtml}
      ${dqHtml}
      ${plotHtml}
      ${tableHtml}
      <div class="chart-caveat">All five plots share one y-axis = the <b>average total lead time</b> (sum of the phase means; no padding) so phase durations compare directly. Each box is the IQR (Q1–Q3); whiskers reach min and max; the <b>mean</b> is the bold line with its value beside the box; individual completed chains show as faint dots. Durations above the scale are clipped and flagged with <span class="pd-mark">↑</span> (count above the plot). <b>n</b> per plot is the count of <em>completed</em> chains (those that reached Site WH) in the active filter set.</div>
    `;
  }

  /* ═════════════════════════════════════════════════════════════════════════
     render — all-in-one for the Screener (computes + branches + writes host).
       opts.filters    = { yearFilter, sigmaLimit, manualExcl }  (all optional)
       opts.toolbarHtml = optional markup prepended above the visual (Trace's
                          filter toolbar; the Screener passes nothing)
  ═════════════════════════════════════════════════════════════════════════ */
  function render(hostEl, json, material, opts){
    opts = opts || {};
    const filters = opts.filters || {};
    const toolbar = opts.toolbarHtml || '';
    const chains = computeChains(json, material);
    const act    = activeChains(chains, filters);
    const drawn  = act.filter(c => !!c.siteWH);
    if (drawn.length < 2) {
      hostEl.innerHTML = toolbar + renderPhaseEmpty(material, drawn.length, act.length);
    } else {
      hostEl.innerHTML = toolbar + renderPhaseVisual(drawn);
    }
    return { chains, act, drawn };
  }

  /* ═════════════════════════════════════════════════════════════════════════
     openProcurement — APP-OPI-01 (2026-06-27). Per-material open-procurement
     status for the 3-lamp indicator (PR · PO · In Transit). Chain-derived
     detail + the Inventory-Master snapshot quantities as a cross-check.
       openPR    — active PR, no PO, not cancelled             (PR_ONLY)
       onOrder   — PO raised, not yet received at the 3PL      (IN_FLIGHT && !gr3pl)
       inTransit — received at 3PL (mvt 107), not yet at site  (IN_FLIGHT && gr3pl)
     The IM snapshot covers the gap where SAP closes the PO at the 3PL GR
     (PO lamp dark, In-Transit lamp lit).
  ═════════════════════════════════════════════════════════════════════════ */
  function openProcurement(json, material){
    const chains    = computeChains(json, material);
    const openPR    = chains.filter(c => c.state === 'PR_ONLY');
    const onOrder   = chains.filter(c => c.state === 'IN_FLIGHT' && !c.gr3pl);
    const inTransit = chains.filter(c => c.state === 'IN_FLIGHT' && !!c.gr3pl);
    // Inventory-Master snapshot quantities (current SAP) for this material, if present.
    let imOpenPO = null, imInTransit = null;
    const im  = (json.data && json.data.inventoryMaster) || [];
    const row = im.find(r => String(r.material || '').trim() === String(material).trim());
    if (row) {
      const n = v => { const x = Number(v); return Number.isFinite(x) ? x : null; };
      imOpenPO    = n(row.openPO);
      imInTransit = n(row.inTransit);
    }
    return { hasPr: chains.length > 0, openPR, onOrder, inTransit, imOpenPO, imInTransit };
  }

  window.TracePhase = {
    PHASE_KEYS, PHASE_LABELS, PHASE_COLORS,
    computeChains,
    boxStats,
    getChainYear,
    getYearsForChains,
    sigmaExcl,
    activeChains,
    openProcurement,
    renderBoxPlotSvg,
    renderPhaseEmpty,
    renderPhaseVisual,
    totalToSiteMean,
    render
  };

})();
