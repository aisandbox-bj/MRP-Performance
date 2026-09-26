/* ═══════════════════════════════════════════════════════════════════════════
   shared/perf-charts.js · Calibre Mirror v0.1.0-dev
   ───────────────────────────────────────────────────────────────────────────
   Inline-SVG charts for the Workbench. No chart library. Distribution-first:
   every duration view is a histogram (closed + still-open stacked, an
   out-of-sequence bin on the left, percentile + target markers) and a
   per-month box strip — never a bare average.

   Palette (validated 2026-09-25 with the dataviz validate_palette.js, dark
   mode, surface #091F2D — lightness band, chroma floor, CVD separation,
   normal-vision floor and contrast all PASS):
     slot 1 #12A7B0  cyan    slot 2 #8A7FE0  violet
     slot 3 #C27A2C  amber   slot 4 #3E9C74  green
   Still-open items = slot colour at reduced opacity (same hue, lighter
   weight). Out-of-sequence = the status warning colour, always labelled.
   Target line = dashed hairline (a threshold, so dashed is deliberate).

   Every mark carries a hover/focus tooltip; every chart has a table view
   (the caller renders it — see workbench tableView()). Labels go in with
   textContent / escaped strings — values come from SAP extracts.
═══════════════════════════════════════════════════════════════════════════ */
(function (global) {
  'use strict';

  const PAL = Object.freeze({
    s1: '#12A7B0', s2: '#8A7FE0', s3: '#C27A2C', s4: '#3E9C74',
    early: '#3F86D6', ontime: '#8C97A8', late: '#C27A2C',
    oos: '#FBBF24', grid: 'rgba(155,171,168,0.16)', axis: 'rgba(155,171,168,0.38)',
    text: '#D6DFDE', muted: '#9BABA8', pri: '#F0F4F3', surface: '#091F2D'
  });
  const OPEN_OPACITY = 0.38;

  function esc(s){ return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' })[c]); }
  /* PERF-NO-SHIFT — an empty chart keeps the chart's height, so switching to a
     selection with no data never moves what sits below it */
  function emptyBox(H, msg){ return `<div class="pc-empty" style="height:${H}px;box-sizing:border-box;display:flex;align-items:center;justify-content:center">${esc(msg)}</div>`; }
  function fmt(n){ return n == null ? '—' : Math.round(n).toLocaleString(); }

  /* MIRROR-HIST — in-flight marks are HATCHED (same hue, 45° texture + a light
     tint) so "not finished yet" reads by texture as well as by weight — the
     operator asked for "a shaded or a hashed colour". One pattern per colour. */
  let patSeq = 0;
  function hatchPattern(color){
    const id = 'pch' + (++patSeq);
    return { id, def: `<pattern id="${id}" patternUnits="userSpaceOnUse" width="5" height="5" patternTransform="rotate(45)"><rect width="5" height="5" fill="${color}" fill-opacity="0.16"/><rect width="1.9" height="5" fill="${color}" fill-opacity="0.95"/></pattern>` };
  }

  /* nice axis ticks */
  function niceMax(v){
    if (!(v > 0)) return 1;
    const p = Math.pow(10, Math.floor(Math.log10(v)));
    const f = v / p;
    const nf = f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10;
    return nf * p;
  }
  function ticks(max, n){
    const step = niceMax(max / (n || 4));
    const out = [];
    for (let v = 0; v <= max + 1e-9; v += step) out.push(+v.toFixed(6));
    return out;
  }

  /* rounded-top bar path: square at the baseline, 4px radius at the data end */
  function barPath(x, y, w, h, r){
    if (h <= 0) return '';
    r = Math.min(r, w / 2, h);
    return `M${x},${y + h}V${y + r}Q${x},${y} ${x + r},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + h}Z`;
  }

  /* ─── shared tooltip ──────────────────────────────────────────────────── */
  let tipEl = null;
  function tip(){
    if (tipEl) return tipEl;
    tipEl = document.createElement('div');
    tipEl.className = 'pc-tip';
    tipEl.setAttribute('role', 'tooltip');
    document.body.appendChild(tipEl);
    return tipEl;
  }
  function showTip(evt, rows, title){
    const t = tip();
    t.textContent = '';
    if (title) { const h = document.createElement('div'); h.className = 'pc-tip-h'; h.textContent = title; t.appendChild(h); }
    for (const r of rows) {
      const row = document.createElement('div'); row.className = 'pc-tip-r';
      if (r.color) { const k = document.createElement('span'); k.className = 'pc-tip-k'; k.style.background = r.color; if (r.opacity != null) k.style.opacity = r.opacity; row.appendChild(k); }
      const v = document.createElement('b'); v.textContent = r.value; row.appendChild(v);
      const l = document.createElement('span'); l.className = 'pc-tip-l'; l.textContent = ' ' + r.label; row.appendChild(l);
      t.appendChild(row);
    }
    t.style.display = 'block';
    const rect = evt.target.getBoundingClientRect ? evt.target.getBoundingClientRect() : { left: evt.clientX, top: evt.clientY, width: 0 };
    const x = (evt.clientX != null && evt.clientX > 0) ? evt.clientX : rect.left + rect.width / 2;
    const y = (evt.clientY != null && evt.clientY > 0) ? evt.clientY : rect.top;
    const tw = t.offsetWidth, th = t.offsetHeight;
    let lx = x + 14, ly = y - th - 10;
    if (lx + tw > window.innerWidth - 8) lx = x - tw - 14;
    if (ly < 8) ly = y + 16;
    t.style.left = lx + 'px'; t.style.top = ly + 'px';
  }
  function hideTip(){ if (tipEl) tipEl.style.display = 'none'; }

  function wireHover(host, getRows){
    host.addEventListener('pointermove', (e) => {
      const el = e.target.closest('[data-hit]');
      if (!el) { hideTip(); return; }
      const r = getRows(el); if (r) showTip(e, r.rows, r.title);
    });
    host.addEventListener('pointerleave', hideTip);
    host.addEventListener('focusin', (e) => {
      const el = e.target.closest('[data-hit]'); if (!el) return;
      const r = getRows(el); if (r) showTip({ target: el }, r.rows, r.title);
    });
    host.addEventListener('focusout', hideTip);
  }
  function wireClick(host, fn){
    host.addEventListener('click', (e) => { const el = e.target.closest('[data-hit]'); if (el) fn(el); });
    host.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter' && e.key !== ' ') return;
      const el = e.target.closest('[data-hit]'); if (el) { e.preventDefault(); fn(el); }
    });
  }

  /* ═════════════════════════════════════════════════════════════════════════
     histogram(host, opts)
       opts.bins     [{label}]                     category bins (left → right)
       opts.series   [{key, label, color, opacity, counts:[…per bin]}]  stacked bottom→top
       opts.oos      number | null                 out-of-sequence count (own bin, far left)
       opts.markers  [{bin, frac, label}]           percentile ticks (bin index + position 0..1)
       opts.target   {bin, frac, label} | null     dashed KPI target line
       opts.binColors [colour per bin] | null      diverging colouring (signed metrics)
       opts.selected {bin, key} | null             highlighted bar
       opts.onBin    (binIndex|'oos', seriesKey) → void
       opts.xTitle   axis title (under the labels)
  ═════════════════════════════════════════════════════════════════════════ */
  function histogram(host, o){
    const W = Math.max(420, host.clientWidth || 880);
    const H = o.height || 250;
    const hasOos = o.oos != null && o.oos > 0;
    const nb = o.bins.length + (hasOos ? 1 : 0);
    const padL = 46, padR = 16, padT = 30, padB = 54;
    const pw = W - padL - padR, ph = H - padT - padB;
    const slot = pw / nb;
    const bw = Math.min(24, Math.max(6, slot * 0.62));
    const totals = o.bins.map((_, i) => o.series.reduce((s, se) => s + (se.counts[i] || 0), 0));
    const ymax = niceMax(Math.max(1, ...totals, hasOos ? o.oos : 0));
    const yv = (v) => padT + ph - (v / ymax) * ph;
    const xc = (i) => padL + slot * (i + (hasOos ? 1 : 0)) + slot / 2;
    let g = '', defs = '';
    const pats = new Map();                      // colour → pattern id (hatched series)
    const hatchFill = (col) => { if (!pats.has(col)) { const hp = hatchPattern(col); pats.set(col, hp.id); defs += hp.def; } return `url(#${pats.get(col)})`; };
    /* grid + y ticks */
    for (const t of ticks(ymax, 4)) {
      const y = yv(t);
      g += `<line x1="${padL}" x2="${W - padR}" y1="${y}" y2="${y}" stroke="${t === 0 ? PAL.axis : PAL.grid}" stroke-width="1"/>`;
      g += `<text x="${padL - 8}" y="${y + 4}" text-anchor="end" class="pc-ax">${fmt(t)}</text>`;
    }
    /* out-of-sequence bin */
    if (hasOos) {
      const x = padL + slot / 2 - bw / 2, y = yv(o.oos), h = padT + ph - y;
      const sel = o.selected && o.selected.bin === 'oos';
      g += `<path d="${barPath(x, y, bw, h, 4)}" fill="${PAL.oos}" ${sel ? 'class="pc-sel"' : ''}/>`;
      g += `<rect data-hit="1" data-bin="oos" data-key="oos" tabindex="0" x="${x - (slot - bw) / 2}" y="${padT}" width="${slot}" height="${ph}" fill="transparent" aria-label="Out of sequence ${o.oos}"/>`;
      g += `<text x="${padL + slot / 2}" y="${padT + ph + 16}" text-anchor="middle" class="pc-ax pc-warn">! &lt; 0</text>`;
      g += `<line x1="${padL + slot}" x2="${padL + slot}" y1="${padT}" y2="${padT + ph}" stroke="${PAL.grid}" stroke-width="1"/>`;
    }
    /* stacked bars */
    o.bins.forEach((b, i) => {
      const cx = xc(i), x = cx - bw / 2;
      let base = 0;
      const nonZero = o.series.filter(se => (se.counts[i] || 0) > 0);
      o.series.forEach((se) => {
        const v = se.counts[i] || 0; if (!v) return;
        const isTop = nonZero[nonZero.length - 1] === se;
        const y0 = yv(base), y1 = yv(base + v);
        const gap = base > 0 ? 2 : 0;                 // 2px surface gap between stacked fills
        const h = Math.max(0, y0 - y1 - gap);
        const col = o.binColors ? o.binColors[i] : se.color;   // signed metrics: early / on-time / late for every series (opacity marks still-open)
        const sel = o.selected && o.selected.bin === i && (o.selected.key == null || o.selected.key === se.key);
        const d = isTop ? barPath(x, y1, bw, h, 4) : `M${x},${y1 + h}V${y1}H${x + bw}V${y1 + h}Z`;
        g += se.hatch
          ? `<path d="${d}" fill="${hatchFill(col)}" stroke="${col}" stroke-width="1" stroke-opacity=".9" ${sel ? 'class="pc-sel"' : ''}/>`
          : `<path d="${d}" fill="${col}" fill-opacity="${se.opacity != null ? se.opacity : 1}" ${sel ? 'class="pc-sel"' : ''}/>`;
        base += v;
      });
      g += `<rect data-hit="1" data-bin="${i}" tabindex="0" x="${cx - slot / 2}" y="${padT}" width="${slot}" height="${ph}" fill="transparent" aria-label="${esc(b.label)}: ${totals[i]}"/>`;
      g += `<text x="${cx}" y="${padT + ph + 16}" text-anchor="middle" class="pc-ax">${esc(b.label)}</text>`;
    });
    /* markers (percentiles) — direct labels on the reference ticks */
    const mx = (m) => {
      const bi = m.bin === 'oos' ? -1 : m.bin;
      return padL + slot * (bi + (hasOos ? 1 : 0)) + slot * (m.frac != null ? m.frac : 0.5);
    };
    let lastLabelX = -1e9, row = 0;
    for (const m of (o.markers || [])) {
      if (m.bin == null) continue;
      const x = mx(m);
      row = (x - lastLabelX < 96) ? row + 1 : 0; lastLabelX = x;
      g += `<line x1="${x}" x2="${x}" y1="${padT - 4 + row * 12}" y2="${padT + ph}" stroke="${PAL.pri}" stroke-opacity=".55" stroke-width="1"/>`;
      const nearEnd = x > W - padR - 96;                       // keep the label inside the chart at the right edge
      g += `<text x="${nearEnd ? x - 4 : x + 4}" y="${padT + 5 + row * 12}" ${nearEnd ? 'text-anchor="end" ' : ''}class="pc-mk">${esc(m.label)}</text>`;
    }
    if (o.target && o.target.bin != null) {
      const x = mx(o.target);
      g += `<line x1="${x}" x2="${x}" y1="${padT - 12}" y2="${padT + ph}" stroke="${PAL.pri}" stroke-width="1.5" stroke-dasharray="5 4"/>`;
      g += `<text x="${x - 4}" y="${padT - 16}" text-anchor="end" class="pc-mk pc-tgt">${esc(o.target.label)}</text>`;
    }
    if (o.xTitle) g += `<text x="${padL + pw / 2}" y="${H - 10}" text-anchor="middle" class="pc-ttl">${esc(o.xTitle)}</text>`;
    host.innerHTML = `<svg class="pc-svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(o.aria || 'Distribution')}">${defs ? `<defs>${defs}</defs>` : ''}${g}</svg>`;
    if (!host._pcWired) {
      host._pcWired = true;
      wireHover(host, (el) => host._pcTip && host._pcTip(el));
      wireClick(host, (el) => host._pcClick && host._pcClick(el));
    }
    const grand = totals.reduce((a, b) => a + b, 0) + (hasOos ? o.oos : 0);
    host._pcTip = (el) => {
      const bin = el.dataset.bin;
      if (bin === 'oos') return { title: 'Out of sequence (end dated before start)', rows: [{ value: fmt(o.oos), label: 'items', color: PAL.oos }] };
      const i = +bin;
      const rows = o.series.map(se => ({ value: fmt(se.counts[i] || 0), label: se.label, color: se.color, opacity: se.hatch ? 0.55 : se.opacity }));
      rows.push({ value: grand ? Math.round(totals[i] / grand * 100) + '%' : '—', label: 'of all items' });
      return { title: o.bins[i].label + (o.unit ? ' ' + o.unit : ''), rows };
    };
    host._pcClick = (el) => { if (o.onBin) o.onBin(el.dataset.bin === 'oos' ? 'oos' : +el.dataset.bin, el.dataset.key || null); };
  }

  /* ═════════════════════════════════════════════════════════════════════════
     cohortChart(host, opts) — one box per anchor month
       groups [{month, q:{0.1,0.25,0.5,0.75,0.9}, closedPct, provisional, nDone, nOpen, qAll}]
       opts.signed (allow negative y), opts.target (value), opts.selected (month)
       opts.onMonth(month)
  ═════════════════════════════════════════════════════════════════════════ */
  function cohortChart(host, o){
    const W = Math.max(420, host.clientWidth || 880), H = o.height || 230;
    const padL = 46, padR = 16, padT = 22, padB = 52;
    const pw = W - padL - padR, ph = H - padT - padB;
    const gs = o.groups.filter(g => g.q && g.q[0.5] != null);
    if (!o.groups.length) { host.innerHTML = emptyBox(H, 'No items in this selection.'); return; }
    const vals = [];
    for (const g of gs) { vals.push(g.q[0.1], g.q[0.9]); if (g.qAll && g.qAll[0.9]) vals.push(g.qAll[0.9].v); }
    if (o.target != null) vals.push(o.target);
    let ymin = o.signed ? Math.min(0, ...vals) : 0;
    let ymax = Math.max(1, ...vals);
    ymax = niceMax(ymax); if (ymin < 0) ymin = -niceMax(-ymin);
    const yv = (v) => padT + ph - ((v - ymin) / (ymax - ymin)) * ph;
    const n = o.groups.length, slot = pw / n, bw = Math.min(22, Math.max(5, slot * 0.5));
    let g = '';
    const tk = ticks(ymax - ymin, 4);
    for (const t0 of tk) {
      const t = ymin + t0, y = yv(t);
      g += `<line x1="${padL}" x2="${W - padR}" y1="${y}" y2="${y}" stroke="${t === 0 ? PAL.axis : PAL.grid}" stroke-width="1"/>`;
      g += `<text x="${padL - 8}" y="${y + 4}" text-anchor="end" class="pc-ax">${fmt(t)}</text>`;
    }
    if (o.target != null) {
      const y = yv(o.target);
      g += `<line x1="${padL}" x2="${W - padR}" y1="${y}" y2="${y}" stroke="${PAL.pri}" stroke-width="1.5" stroke-dasharray="5 4"/>`;
      g += `<text x="${W - padR}" y="${y - 5}" text-anchor="end" class="pc-mk pc-tgt">target ${fmt(o.target)} d</text>`;
    }
    const labelEvery = Math.max(1, Math.ceil(n / Math.max(1, Math.floor(pw / 46))));
    o.groups.forEach((gr, i) => {
      const cx = padL + slot * i + slot / 2;
      const sel = o.selected === gr.month;
      const op = gr.provisional ? 0.45 : 1;
      if (gr.q && gr.q[0.5] != null) {
        const q = gr.q;
        g += `<line x1="${cx}" x2="${cx}" y1="${yv(q[0.9])}" y2="${yv(q[0.1])}" stroke="${PAL.s1}" stroke-opacity="${op}" stroke-width="2"/>`;
        const yb = yv(q[0.75]), hb = Math.max(2, yv(q[0.25]) - yb);
        g += `<rect x="${cx - bw / 2}" y="${yb}" width="${bw}" height="${hb}" rx="3" fill="${PAL.s1}" fill-opacity="${0.55 * op}" ${sel ? 'class="pc-sel"' : ''}/>`;
        g += `<line x1="${cx - bw / 2 - 3}" x2="${cx + bw / 2 + 3}" y1="${yv(q[0.5])}" y2="${yv(q[0.5])}" stroke="${PAL.pri}" stroke-opacity="${op}" stroke-width="2"/>`;
      }
      if (gr.nOpen && gr.qAll && gr.qAll[0.9] && gr.qAll[0.9].lowerBound) {
        /* the P90 including still-open items is at least this — a caret */
        const y = yv(gr.qAll[0.9].v);
        g += `<path d="M${cx - 4},${y + 4}L${cx},${y - 2}L${cx + 4},${y + 4}" fill="none" stroke="${PAL.s1}" stroke-opacity="${OPEN_OPACITY + 0.3}" stroke-width="1.5"/>`;
      }
      g += `<rect data-hit="1" data-month="${esc(gr.month)}" tabindex="0" x="${cx - slot / 2}" y="${padT}" width="${slot}" height="${ph}" fill="transparent"/>`;
      if (i % labelEvery === 0) {
        g += `<text x="${cx}" y="${padT + ph + 15}" text-anchor="middle" class="pc-ax">${esc(gr.month.slice(2))}</text>`;
        g += `<text x="${cx}" y="${padT + ph + 29}" text-anchor="middle" class="pc-ax ${gr.provisional ? 'pc-warn' : ''}">${Math.round(gr.closedPct * 100)}%</text>`;
      }
    });
    g += `<text x="${padL - 8}" y="${padT + ph + 29}" text-anchor="end" class="pc-ax">closed</text>`;
    if (o.xTitle) g += `<text x="${padL + pw / 2}" y="${H - 6}" text-anchor="middle" class="pc-ttl">${esc(o.xTitle)}</text>`;
    host.innerHTML = `<svg class="pc-svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(o.aria || 'Per-month distribution')}">${g}</svg>`;
    if (!host._pcWired) {
      host._pcWired = true;
      wireHover(host, (el) => host._pcTip && host._pcTip(el));
      wireClick(host, (el) => host._pcClick && host._pcClick(el));
    }
    host._pcTip = (el) => {
      const gr = o.groups.find(x => x.month === el.dataset.month); if (!gr) return null;
      const q = gr.q || {};
      const rows = [
        { value: fmt(gr.nDone), label: 'closed' },
        { value: fmt(gr.nOpen), label: 'still open' },
        { value: q[0.5] != null ? fmt(q[0.5]) + ' d' : '—', label: 'median of closed' },
        { value: q[0.1] != null ? fmt(q[0.1]) + ' – ' + fmt(q[0.9]) + ' d' : '—', label: 'P10 – P90 of closed' }
      ];
      if (gr.qAll && gr.qAll[0.9]) rows.push({ value: (gr.qAll[0.9].lowerBound ? '≥ ' : '') + fmt(gr.qAll[0.9].v) + ' d', label: 'P90 incl. still-open' });
      if (gr.oos) rows.push({ value: fmt(gr.oos), label: 'out of sequence', color: PAL.oos });
      return { title: gr.month + (gr.provisional ? ' · provisional (' + Math.round(gr.closedPct * 100) + '% closed)' : ''), rows };
    };
    host._pcClick = (el) => { if (o.onMonth) o.onMonth(el.dataset.month); };
  }

  /* ═════════════════════════════════════════════════════════════════════════
     timeBars(host, opts) — one measure over time (small multiple). Several
     timeBars sharing the same `labels` line up vertically — never two scales
     on one plot.
       labels [str], values [num], color, title, fmtV(v), onClick(i), height
  ═════════════════════════════════════════════════════════════════════════ */
  function timeBars(host, o){
    const W = Math.max(420, host.clientWidth || 880), H = o.height || 150;
    const padL = 46, padR = 16, padT = 24, padB = o.showX === false ? 10 : 30;
    const pw = W - padL - padR, ph = H - padT - padB;
    const n = o.values.length, slot = pw / Math.max(1, n);
    const bw = Math.max(1, Math.min(24, slot - 2));
    const ymax = niceMax(Math.max(1, ...o.values));
    const yv = (v) => padT + ph - (v / ymax) * ph;
    let g = `<text x="${padL}" y="14" class="pc-sub">${esc(o.title || '')}</text>`;
    for (const t of ticks(ymax, 3)) {
      const y = yv(t);
      g += `<line x1="${padL}" x2="${W - padR}" y1="${y}" y2="${y}" stroke="${t === 0 ? PAL.axis : PAL.grid}" stroke-width="1"/>`;
      g += `<text x="${padL - 8}" y="${y + 4}" text-anchor="end" class="pc-ax">${fmt(t)}</text>`;
    }
    const labelEvery = Math.max(1, Math.ceil(n / Math.max(1, Math.floor(pw / 52))));
    for (let i = 0; i < n; i++) {
      const v = o.values[i] || 0;
      const x = padL + slot * i + (slot - bw) / 2, y = yv(v);
      if (v > 0) g += `<path d="${barPath(x, y, bw, padT + ph - y, bw >= 6 ? 3 : 0)}" fill="${(o.colors && o.colors[i]) || o.color || PAL.s1}"/>`;
      g += `<rect data-hit="1" data-i="${i}" x="${padL + slot * i}" y="${padT}" width="${slot}" height="${ph}" fill="transparent"/>`;
      if (o.showX !== false && i % labelEvery === 0) g += `<text x="${padL + slot * i + slot / 2}" y="${padT + ph + 16}" text-anchor="middle" class="pc-ax">${esc(o.labels[i])}</text>`;
    }
    host.innerHTML = `<svg class="pc-svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(o.title || 'Time series')}">${g}</svg>`;
    if (!host._pcWired) {
      host._pcWired = true;
      wireHover(host, (el) => host._pcTip && host._pcTip(el));
      wireClick(host, (el) => host._pcClick && host._pcClick(el));
    }
    host._pcTip = (el) => {
      const i = +el.dataset.i;
      return { title: o.labels[i], rows: [{ value: o.fmtV ? o.fmtV(o.values[i]) : fmt(o.values[i]), label: o.unit || '', color: (o.colors && o.colors[i]) || o.color || PAL.s1 }] };
    };
    host._pcClick = (el) => { if (o.onClick) o.onClick(+el.dataset.i); };
  }

  /* ═════════════════════════════════════════════════════════════════════════
     stackedColumns(host, opts) — part-to-whole per period
       labels [str], series [{key,label,color,values:[…]}] bottom→top,
       onClick(i, key)
  ═════════════════════════════════════════════════════════════════════════ */
  function stackedColumns(host, o){
    const W = Math.max(420, host.clientWidth || 880), H = o.height || 230;
    const padL = 46, padR = 16, padT = 18, padB = 34;
    const pw = W - padL - padR, ph = H - padT - padB;
    const n = o.labels.length, slot = pw / Math.max(1, n), bw = Math.max(3, Math.min(24, slot * 0.62));
    const totals = o.labels.map((_, i) => o.series.reduce((s, se) => s + (se.values[i] || 0), 0));
    const ymax = niceMax(Math.max(1, ...totals));
    const yv = (v) => padT + ph - (v / ymax) * ph;
    let g = '';
    for (const t of ticks(ymax, 4)) {
      const y = yv(t);
      g += `<line x1="${padL}" x2="${W - padR}" y1="${y}" y2="${y}" stroke="${t === 0 ? PAL.axis : PAL.grid}" stroke-width="1"/>`;
      g += `<text x="${padL - 8}" y="${y + 4}" text-anchor="end" class="pc-ax">${fmt(t)}</text>`;
    }
    const labelEvery = Math.max(1, Math.ceil(n / Math.max(1, Math.floor(pw / 46))));
    for (let i = 0; i < n; i++) {
      const cx = padL + slot * i + slot / 2, x = cx - bw / 2;
      let base = 0;
      const nz = o.series.filter(se => (se.values[i] || 0) > 0);
      for (const se of o.series) {
        const v = se.values[i] || 0; if (!v) continue;
        const y0 = yv(base), y1 = yv(base + v), gap = base > 0 ? 2 : 0, h = Math.max(0, y0 - y1 - gap);
        const isTop = nz[nz.length - 1] === se;
        g += `<path d="${isTop ? barPath(x, y1, bw, h, 4) : `M${x},${y1 + h}V${y1}H${x + bw}V${y1 + h}Z`}" fill="${se.color}"/>`;
        base += v;
      }
      g += `<rect data-hit="1" data-i="${i}" tabindex="0" x="${padL + slot * i}" y="${padT}" width="${slot}" height="${ph}" fill="transparent"/>`;
      if (i % labelEvery === 0) g += `<text x="${cx}" y="${padT + ph + 16}" text-anchor="middle" class="pc-ax">${esc(o.labels[i])}</text>`;
    }
    host.innerHTML = `<svg class="pc-svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(o.aria || 'Stacked columns')}">${g}</svg>`;
    if (!host._pcWired) {
      host._pcWired = true;
      wireHover(host, (el) => host._pcTip && host._pcTip(el));
      wireClick(host, (el) => host._pcClick && host._pcClick(el));
    }
    host._pcTip = (el) => {
      const i = +el.dataset.i;
      const rows = o.series.slice().reverse().map(se => ({ value: fmt(se.values[i] || 0), label: se.label, color: se.color }));
      rows.push({ value: fmt(totals[i]), label: 'total' });
      return { title: o.labels[i], rows };
    };
    host._pcClick = (el) => { if (o.onClick) o.onClick(+el.dataset.i); };
  }

  /* ═════════════════════════════════════════════════════════════════════════
     bandChart(host, opts) — month-on-month "Bollinger" view of a distribution
     (PERF-BANDS, v0.2.0-dev). Per period: P10–P90 band (light wash), P25–P75
     band (stronger), median line (2px, dots) and mean line (thin). Periods
     below the provisional threshold draw hollow dots; periods with no closed
     items break the lines rather than interpolating.
       groups [{label, nDone, nOpen, closedPct, provisional, q:{0.1..0.9}, mean, qAll}]
       opts.signed, opts.target, opts.selected(label), opts.onClick(label), opts.unit
  ═════════════════════════════════════════════════════════════════════════ */
  function bandChart(host, o){
    const W = Math.max(420, host.clientWidth || 880), H = o.height || 250;
    const padL = 46, padR = 16, padT = 20, padB = 52;
    const pw = W - padL - padR, ph = H - padT - padB;
    const gs = o.groups;
    if (!gs.length) { host.innerHTML = emptyBox(H, 'No closed items in this selection.'); return; }
    const vals = [];
    for (const g of gs) { if (g.q && g.q[0.5] != null) vals.push(g.q[0.1], g.q[0.9], g.mean); }
    if (o.target != null) vals.push(o.target);
    let ymin = o.signed ? Math.min(0, ...vals.filter(v => v != null)) : 0;
    let ymax = Math.max(1, ...vals.filter(v => v != null));
    ymax = niceMax(ymax); if (ymin < 0) ymin = -niceMax(-ymin);
    const yv = (v) => padT + ph - ((v - ymin) / (ymax - ymin)) * ph;
    const n = gs.length, slot = pw / n;
    const xc = (i) => padL + slot * i + slot / 2;
    let g = '';
    for (const t0 of ticks(ymax - ymin, 4)) {
      const t = ymin + t0, y = yv(t);
      g += `<line x1="${padL}" x2="${W - padR}" y1="${y}" y2="${y}" stroke="${t === 0 ? PAL.axis : PAL.grid}" stroke-width="1"/>`;
      g += `<text x="${padL - 8}" y="${y + 4}" text-anchor="end" class="pc-ax">${fmt(t)}</text>`;
    }
    /* contiguous runs of periods that have data → separate band paths */
    const runs = []; let cur = null;
    gs.forEach((gr, i) => { const ok = gr.q && gr.q[0.5] != null; if (ok) { if (!cur) { cur = []; runs.push(cur); } cur.push(i); } else cur = null; });
    const area = (run, lo, hi) => {
      if (run.length === 1) { const i = run[0]; const w = Math.min(slot * 0.5, 14); return `M${xc(i) - w},${yv(gs[i].q[hi])}H${xc(i) + w}V${yv(gs[i].q[lo])}H${xc(i) - w}Z`; }
      let d = run.map((i, k) => (k ? 'L' : 'M') + xc(i) + ',' + yv(gs[i].q[hi])).join('');
      d += run.slice().reverse().map(i => 'L' + xc(i) + ',' + yv(gs[i].q[lo])).join('') + 'Z';
      return d;
    };
    const line = (run, get) => run.map((i, k) => (k ? 'L' : 'M') + xc(i) + ',' + yv(get(gs[i]))).join('');
    for (const run of runs) {
      g += `<path d="${area(run, 0.1, 0.9)}" fill="${PAL.s1}" fill-opacity=".14"/>`;
      g += `<path d="${area(run, 0.25, 0.75)}" fill="${PAL.s1}" fill-opacity=".28"/>`;
      if (run.length > 1) {
        g += `<path d="${line(run, x => x.mean)}" fill="none" stroke="${PAL.s2}" stroke-width="1.5" stroke-opacity=".9"/>`;
        g += `<path d="${line(run, x => x.q[0.5])}" fill="none" stroke="${PAL.pri}" stroke-width="2"/>`;
      }
    }
    if (o.target != null) {
      const y = yv(o.target);
      g += `<line x1="${padL}" x2="${W - padR}" y1="${y}" y2="${y}" stroke="${PAL.pri}" stroke-width="1.5" stroke-dasharray="5 4"/>`;
      g += `<text x="${W - padR}" y="${y - 5}" text-anchor="end" class="pc-mk pc-tgt">target ${fmt(o.target)} ${esc(o.unit || 'd')}</text>`;
    }
    const labelEvery = Math.max(1, Math.ceil(n / Math.max(1, Math.floor(pw / 46))));
    gs.forEach((gr, i) => {
      const cx = xc(i), sel = o.selected === gr.label;
      if (sel) g += `<rect x="${cx - slot / 2}" y="${padT}" width="${slot}" height="${ph}" fill="rgba(240,244,243,0.06)"/>`;
      if (gr.q && gr.q[0.5] != null) {
        g += `<circle cx="${cx}" cy="${yv(gr.mean)}" r="2.5" fill="${PAL.s2}"/>`;
        g += gr.provisional
          ? `<circle cx="${cx}" cy="${yv(gr.q[0.5])}" r="4" fill="${PAL.surface}" stroke="${PAL.pri}" stroke-width="1.5"/>`
          : `<circle cx="${cx}" cy="${yv(gr.q[0.5])}" r="4" fill="${PAL.pri}" stroke="${PAL.surface}" stroke-width="2"/>`;
      }
      if (gr.nOpen && gr.qAll && gr.qAll[0.9] && gr.qAll[0.9].lowerBound) {
        const y = yv(Math.min(ymax, gr.qAll[0.9].v));
        g += `<path d="M${cx - 4},${y + 4}L${cx},${y - 2}L${cx + 4},${y + 4}" fill="none" stroke="${PAL.s1}" stroke-width="1.5"/>`;
      }
      g += `<rect data-hit="1" data-label="${esc(gr.label)}" tabindex="0" x="${cx - slot / 2}" y="${padT}" width="${slot}" height="${ph}" fill="transparent"/>`;
      if (i % labelEvery === 0) {
        g += `<text x="${cx}" y="${padT + ph + 15}" text-anchor="middle" class="pc-ax">${esc(gr.short || gr.label)}</text>`;
        g += `<text x="${cx}" y="${padT + ph + 29}" text-anchor="middle" class="pc-ax ${gr.provisional ? 'pc-warn' : ''}">${gr.nDone}</text>`;
      }
    });
    g += `<text x="${padL - 8}" y="${padT + ph + 29}" text-anchor="end" class="pc-ax">n</text>`;
    if (o.xTitle) g += `<text x="${padL + pw / 2}" y="${H - 6}" text-anchor="middle" class="pc-ttl">${esc(o.xTitle)}</text>`;
    host.innerHTML = `<svg class="pc-svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(o.aria || 'Distribution by period')}">${g}</svg>`;
    if (!host._pcWired) {
      host._pcWired = true;
      wireHover(host, (el) => host._pcTip && host._pcTip(el));
      wireClick(host, (el) => host._pcClick && host._pcClick(el));
    }
    host._pcTip = (el) => {
      const gr = gs.find(x => x.label === el.dataset.label); if (!gr) return null;
      const q = gr.q || {};
      const u = ' ' + (o.unit || 'd');
      const rows = [
        { value: q[0.5] != null ? fmt(q[0.5]) + u : '—', label: 'median (closed)', color: PAL.pri },
        { value: gr.mean != null ? fmt(gr.mean) + u : '—', label: 'mean / average (closed)', color: PAL.s2 },
        { value: q[0.25] != null ? fmt(q[0.25]) + ' – ' + fmt(q[0.75]) + u : '—', label: 'P25 – P75', color: PAL.s1, opacity: .5 },
        { value: q[0.1] != null ? fmt(q[0.1]) + ' – ' + fmt(q[0.9]) + u : '—', label: 'P10 – P90', color: PAL.s1, opacity: .25 },
        { value: fmt(gr.nDone), label: 'closed' }, { value: fmt(gr.nOpen), label: 'still open' }
      ];
      if (gr.qAll && gr.qAll[0.9]) rows.push({ value: (gr.qAll[0.9].lowerBound ? '≥ ' : '') + fmt(gr.qAll[0.9].v) + u, label: 'P90 incl. still-open' });
      return { title: gr.label + (gr.provisional ? ` · provisional (${Math.round(gr.closedPct * 100)}% closed)` : ''), rows };
    };
    host._pcClick = (el) => { if (o.onClick) o.onClick(el.dataset.label); };
  }

  /* ═════════════════════════════════════════════════════════════════════════
     annualChevrons(host, opts) — annual progression (PERF-ANNUAL): one strip
     per year, each leg's median laid end to end on a shared day scale.
       rows [{label, n, legs:[{label, v, lb, color, n}]}]
  ═════════════════════════════════════════════════════════════════════════ */
  function annualChevrons(host, o){
    const rows = o.rows.filter(r => r.legs.some(l => l.v != null));
    if (!rows.length) { host.innerHTML = '<div class="pc-empty">No closed chains to summarise by year.</div>'; return; }
    const W = Math.max(420, host.clientWidth || 880);
    const padL = 120, padR = 110, rowH = 40, top = 8;
    const pw = W - padL - padR;
    const totals = rows.map(r => r.legs.reduce((s, l) => s + (l.v || 0), 0));
    const xmax = niceMax(Math.max(1, ...totals));
    const xs = (v) => padL + (v / xmax) * pw;
    const H = top + rows.length * rowH + 30;
    let g = '';
    for (const t of ticks(xmax, 5)) {
      g += `<line x1="${xs(t)}" x2="${xs(t)}" y1="${top}" y2="${H - 24}" stroke="${PAL.grid}"/>`;
      g += `<text x="${xs(t)}" y="${H - 8}" text-anchor="middle" class="pc-ax">${fmt(t)} d</text>`;
    }
    rows.forEach((r, k) => {
      const y = top + k * rowH + 6, h = rowH - 14;
      g += `<text x="10" y="${y + h / 2 + 4}" class="pc-mk">${esc(r.label)}</text>`;
      g += `<text x="10" y="${y + h / 2 + 17}" class="pc-ax">${fmt(r.n)} chains</text>`;
      let acc = 0;
      r.legs.forEach((l, j) => {
        if (l.v == null) return;
        const x0 = xs(acc), x1 = xs(acc + l.v), w = Math.max(0, x1 - x0);
        const tip = 6;
        const d = w > tip * 2 ? `M${x0},${y}H${x1 - tip}L${x1},${y + h / 2}L${x1 - tip},${y + h}H${x0}${j ? `L${x0 + tip},${y + h / 2}` : ''}Z` : `M${x0},${y}H${x0 + Math.max(2, w)}V${y + h}H${x0}Z`;
        g += `<path d="${d}" fill="${l.color}" stroke="${PAL.surface}" stroke-width="1.5" data-hit="1" data-k="${k}:${j}"/>`;
        if (w > 34) g += `<text x="${x0 + w / 2 + (j ? 3 : 0)}" y="${y + h / 2 + 4}" text-anchor="middle" style="font-size:11px;fill:#06141C;font-weight:600;font-family:var(--font-mono)">${l.lb ? '≥' : ''}${fmt(l.v)}</text>`;
        acc += l.v;
      });
      g += `<text x="${padL + pw + 10}" y="${y + h / 2 + 4}" class="pc-mk">Σ ${fmt(totals[k])} d</text>`;
    });
    host.innerHTML = `<svg class="pc-svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(o.aria || 'Annual progression')}">${g}</svg>`;
    if (!host._pcWired) { host._pcWired = true; wireHover(host, (el) => host._pcTip && host._pcTip(el)); }
    host._pcTip = (el) => {
      const [k, j] = el.dataset.k.split(':').map(Number); const r = rows[k], l = r.legs[j];
      return { title: `${r.label} · ${l.label}`, rows: [{ value: (l.lb ? '≥ ' : '') + fmt(l.v) + ' d', label: 'median', color: l.color }, { value: fmt(l.n), label: 'closed chains in this leg' }] };
    };
  }

  /* legend (HTML) — swatch mirrors the mark */
  function legend(items){
    return '<div class="pc-legend">' + items.map(it => {
      const bg = it.hatch
        ? `background:repeating-linear-gradient(45deg, ${it.color} 0 1.7px, transparent 1.7px 4px);box-shadow:inset 0 0 0 1px ${it.color};`
        : `background:${it.color};${it.opacity != null ? 'opacity:' + it.opacity + ';' : ''}`;
      return `<span class="pc-lg${it.off ? ' off' : ''}"><span class="pc-sw${it.line ? ' line' : ''}" style="${bg}"></span>${esc(it.label)}</span>`;
    }).join('') + '</div>';
  }

  /* ═════════════════════════════════════════════════════════════════════════
     phaseBoxes(host, opts) — MIRROR-BOX: one horizontal box-and-whisker per
     phase on ONE shared day scale. Solid = completed (box P25–P75, median
     line, whiskers P10–P90, hollow dots = fastest / slowest); hatched, just
     under it = in flight at its age so far (P25–P75 box, median, whisker to
     P90, dot = oldest). Click (or Enter on) a row → onClick(key).
       rows [{key, label, done:{n,q:{.1,.25,.5,.75,.9},min,max}, open:{n,q,max}}]
       selected key · xTitle · aria · log (true = log(1 + days) axis, so a
       same-day approval and a 400-day supplier tail are both readable; the
       ticks stay in plain days)
  ═════════════════════════════════════════════════════════════════════════ */
  function phaseBoxes(host, o){
    const W = Math.max(640, host.clientWidth || 1000);
    const rowH = 50, padT = 16, padB = 40, padL = 196, padR = 250;
    const H = padT + o.rows.length * rowH + padB;
    const pw = W - padL - padR;
    let top = 1;
    for (const r of o.rows) {
      if (o.log) { if (r.done.n) top = Math.max(top, r.done.max); if (r.open.n) top = Math.max(top, r.open.max); }
      else { if (r.done.n) top = Math.max(top, r.done.q[0.9]); if (r.open.n) top = Math.max(top, r.open.q[0.9]); }
    }
    const xmax = o.log ? [10, 30, 60, 120, 365, 730, 1500, 3000, 10000].find(t => t >= top) || niceMax(top) : niceMax(top * 1.15);
    const xs = o.log ? (v) => padL + Math.min(1, Math.max(0, Math.log1p(Math.max(0, v)) / Math.log1p(xmax))) * pw
                     : (v) => padL + Math.min(1, Math.max(0, v / xmax)) * pw;
    const tickVals = o.log ? [0, 1, 3, 7, 14, 30, 60, 120, 180, 365, 730, 1500, 3000, 10000].filter(t => t <= xmax) : ticks(xmax, 6);
    let g = '', defs = '';
    const hp = hatchPattern(PAL.s1); defs += hp.def;
    let lastLab = -1e9;
    for (const t of tickVals) {
      g += `<line x1="${xs(t)}" x2="${xs(t)}" y1="${padT - 4}" y2="${H - padB + 4}" stroke="${t === 0 ? PAL.axis : PAL.grid}" stroke-width="1"/>`;
      if (xs(t) - lastLab < 30) continue;          // no colliding tick labels
      g += `<text x="${xs(t)}" y="${H - padB + 18}" text-anchor="middle" class="pc-ax">${fmt(t)}</text>`;
      lastLab = xs(t);
    }
    if (o.xTitle) g += `<text x="${padL + pw / 2}" y="${H - 6}" text-anchor="middle" class="pc-ttl">${esc(o.xTitle)}</text>`;
    const beyond = (v, y) => v > xmax ? `<text x="${padL + pw + 4}" y="${y + 4}" class="pc-ax" style="fill:${PAL.oos}">▸ ${fmt(v)}</text>` : '';
    o.rows.forEach((r, k) => {
      const y0 = padT + k * rowH, yD = y0 + 17, yO = y0 + 34, sel = o.selected === r.key;
      if (sel) g += `<rect x="4" y="${y0 + 1}" width="${W - 8}" height="${rowH - 2}" rx="4" fill="rgba(240,244,243,0.06)"/><rect x="4" y="${y0 + 1}" width="3" height="${rowH - 2}" fill="${PAL.s1}"/>`;
      if (r.group) g += `<line x1="8" x2="${W - 8}" y1="${y0}" y2="${y0}" stroke="${PAL.axis}" stroke-dasharray="2 3"/>`;
      g += `<text x="16" y="${y0 + 21}" class="pc-mk" style="font-size:12.5px;${sel ? 'font-weight:700' : ''}">${esc(r.label)}</text>`;
      g += `<text x="16" y="${y0 + 37}" class="pc-ax">${esc(r.sub || '')}</text>`;
      /* completed */
      if (r.done.n) {
        const q = r.done.q;
        g += `<line x1="${xs(q[0.1])}" x2="${xs(q[0.9])}" y1="${yD}" y2="${yD}" stroke="${PAL.s1}" stroke-width="1.5"/>`;
        g += `<line x1="${xs(q[0.1])}" x2="${xs(q[0.1])}" y1="${yD - 5}" y2="${yD + 5}" stroke="${PAL.s1}" stroke-width="1.5"/><line x1="${xs(q[0.9])}" x2="${xs(q[0.9])}" y1="${yD - 5}" y2="${yD + 5}" stroke="${PAL.s1}" stroke-width="1.5"/>`;
        g += `<rect x="${xs(q[0.25])}" y="${yD - 8}" width="${Math.max(2, xs(q[0.75]) - xs(q[0.25]))}" height="16" rx="3" fill="${PAL.s1}" fill-opacity=".55" stroke="${PAL.s1}" stroke-width="1"/>`;
        g += `<line x1="${xs(q[0.5])}" x2="${xs(q[0.5])}" y1="${yD - 9}" y2="${yD + 9}" stroke="${PAL.pri}" stroke-width="2.2"/>`;
        g += `<circle cx="${xs(r.done.min)}" cy="${yD}" r="3" fill="${PAL.surface}" stroke="${PAL.s1}" stroke-width="1.3"/><circle cx="${xs(r.done.max)}" cy="${yD}" r="3" fill="${PAL.surface}" stroke="${PAL.s1}" stroke-width="1.3"/>`;
        g += beyond(r.done.max, yD);
      } else g += `<text x="${padL + 6}" y="${yD + 4}" class="pc-ax">no completed items</text>`;
      /* in flight */
      if (r.open.n) {
        const q = r.open.q;
        g += `<line x1="${xs(q[0.1])}" x2="${xs(q[0.9])}" y1="${yO}" y2="${yO}" stroke="${PAL.s1}" stroke-width="1" stroke-opacity=".8"/>`;
        g += `<rect x="${xs(q[0.25])}" y="${yO - 5}" width="${Math.max(2, xs(q[0.75]) - xs(q[0.25]))}" height="10" rx="2" fill="url(#${hp.id})" stroke="${PAL.s1}" stroke-width="1"/>`;
        g += `<line x1="${xs(q[0.5])}" x2="${xs(q[0.5])}" y1="${yO - 6}" y2="${yO + 6}" stroke="${PAL.pri}" stroke-width="1.6"/>`;
        g += `<circle cx="${xs(r.open.max)}" cy="${yO}" r="2.6" fill="${PAL.surface}" stroke="${PAL.s1}" stroke-width="1.2"/>`;
        g += beyond(r.open.max, yO);
      }
      const md = r.done.n ? `${fmt(r.done.q[0.5])} d · P90 ${fmt(r.done.q[0.9])} d` : '—';
      const mo = r.open.n ? `${fmt(r.open.n)} in flight · oldest ${fmt(r.open.max)} d` : 'none in flight';
      g += `<text x="${W - padR + 26}" y="${yD + 4}" class="pc-mk">${esc(fmt(r.done.n) + ' done · ' + md)}</text>`;
      g += `<text x="${W - padR + 26}" y="${yO + 4}" class="pc-ax">${esc(mo)}</text>`;
      g += `<rect data-hit="1" data-key="${esc(r.key)}" tabindex="0" x="4" y="${y0 + 1}" width="${W - 8}" height="${rowH - 2}" fill="transparent" aria-label="${esc(r.label)} — open its histogram"/>`;
    });
    host.innerHTML = `<svg class="pc-svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(o.aria || 'Every phase')}"><defs>${defs}</defs>${g}</svg>`;
    if (!host._pcWired) {
      host._pcWired = true;
      wireHover(host, (el) => host._pcTip && host._pcTip(el));
      wireClick(host, (el) => host._pcClick && host._pcClick(el));
    }
    host._pcTip = (el) => {
      const r = o.rows.find(x => x.key === el.dataset.key); if (!r) return null;
      const rows = [];
      if (r.done.n) {
        const q = r.done.q;
        rows.push({ value: fmt(r.done.n), label: 'completed', color: PAL.s1 },
          { value: `${fmt(q[0.1])} · ${fmt(q[0.25])} · ${fmt(q[0.5])} · ${fmt(q[0.75])} · ${fmt(q[0.9])} d`, label: 'P10 · P25 · median · P75 · P90' },
          { value: `${fmt(r.done.min)} – ${fmt(r.done.max)} d`, label: 'fastest – slowest' });
      }
      if (r.open.n) rows.push({ value: fmt(r.open.n), label: 'in flight', color: PAL.s1, opacity: 0.55 },
        { value: `${fmt(r.open.q[0.5])} d · oldest ${fmt(r.open.max)} d`, label: 'median age so far' });
      rows.push({ value: '↵', label: 'click to open this phase\'s histogram' });
      return { title: r.label, rows };
    };
    host._pcClick = (el) => { if (o.onClick) o.onClick(el.dataset.key); };
  }

  global.PerfCharts = Object.freeze({ PAL, OPEN_OPACITY, histogram, cohortChart, bandChart, annualChevrons, timeBars, stackedColumns, phaseBoxes, legend, showTip, hideTip, esc });
})(window);
