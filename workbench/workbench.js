/* ═══════════════════════════════════════════════════════════════════════════
   workbench/workbench.js · Calibre MRP Performance v0.1.0-dev
   ───────────────────────────────────────────────────────────────────────────
   The performance Workbench. Loads this app's current dataset (AppStorage
   'intake.current', namespace mrpPerf), builds the population model with
   PerfEngine, and renders distribution-first views scoped by a SEGMENT:
   drop-in filter tiles (quartiles · top/bottom N% · ranges · value picks ·
   time window), ANDed together. Every view = stat strip + histogram +
   per-month boxes + breakdown + drill table with both tails reachable.
═══════════════════════════════════════════════════════════════════════════ */
(function () {
  'use strict';

  const $  = (s, r) => (r || document).querySelector(s);
  const $$ = (s, r) => Array.from((r || document).querySelectorAll(s));
  const E = window.PerfEngine, C = window.PerfCharts, U = window.PerfUI;
  /* v0.2.0-dev (PERF-DEEPDIVE · PERF-BANDS · PERF-MULTI): drill rows open the
     material deep-dive (Prev / Next through the drill list); the Workbench
     parks its view, segment and window in sessionStorage so "Back" restores
     it; month-on-month band charts replace the monthly boxes; new views:
     Materials in the segment · MRP activity by material (heat map); the
     cadence view splits PR / PO volumes by trigger, MRP type or outcome. */
  const esc = C.esc;
  const iso = E.iso;
  const fmt = (n, d) => n == null || !Number.isFinite(n) ? '—' : (d ? n.toLocaleString(undefined, { maximumFractionDigits: d }) : Math.round(n).toLocaleString());
  const money = (n) => n == null || !Number.isFinite(n) ? '—' : '$' + (Math.abs(n) >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : Math.abs(n) >= 1e4 ? Math.round(n / 1e3) + 'k' : Math.round(n).toLocaleString());
  const pct = (a, b) => b ? Math.round(a / b * 100) + '%' : '—';

  /* ─── state ─────────────────────────────────────────────────────────────── */
  const state = {
    json: null, model: null,
    settings: Object.assign({}, E.DEFAULT_SETTINGS, { targets: {} }),
    view: 'overview',
    sub: { internal: 'AB', overunder: 'receipts' },
    tiles: [],                     // segment tiles
    period: { preset: 'all', from: null, to: null },
    cohortSel: null,               // { view, month }
    drill: null,                   // { title, kind, items }
    breakdownDim: {},
    gran: 'week',
    bandGran: 'month',
    cad: { measure: 'pr', split: 'trigger' },
    heat: { sort: 'exposure', rows: 60 },
    filtersOpen: false,          // PERF-FILTER-COLLAPSE — the Window + Segment panel starts folded to one line
    matPass: null, matCount: 0,
    quartileCache: new Map()
  };
  const UI_KEY = 'mrpPerf.wb.ui';   // per-viewer convenience only (view + window) — this app's own namespace

  /* ═════════════════════════════════════════════════════════════════════════
     SEGMENT DIMENSIONS
  ═════════════════════════════════════════════════════════════════════════ */
  const DIMS = [
    { key: 'movement',   label: 'Movement',               hint: 'units consumed per year',       type: 'num', get: i => i.consPerYr, unit: 'units/yr', zeroNone: true },
    { key: 'events',     label: 'Consumption events',     hint: 'issues in the window',          type: 'num', get: i => i.consEvents, unit: 'events', zeroNone: true },
    { key: 'consValue',  label: 'Consumption value',      hint: '$ consumed per year',            type: 'num', get: i => i.consValuePerYr, money: true, zeroNone: true },
    { key: 'unitCost',   label: 'Unit cost',              hint: 'moving average price',           type: 'num', get: i => i.map, money: true },
    { key: 'stockValue', label: 'Stock value today',      hint: 'on hand × unit cost',            type: 'num', get: i => i.stockValue, money: true },
    { key: 'soh',        label: 'Stock on hand today',    hint: 'Inventory Master',               type: 'num', get: i => i.soh, unit: 'units' },
    { key: 'leadTime',   label: 'Material lead time',     hint: 'median PR → site, days',         type: 'num', get: i => i.medE2E, unit: 'd' },
    { key: 'prCount',    label: 'PR lines',               hint: 'requisitions in the file',        type: 'num', get: i => i.nPr, unit: 'PRs' },
    { key: 'manufacturer', label: 'Manufacturer (supplier)', hint: 'stands in for vendor',       type: 'cat', get: i => i.manufacturer },
    { key: 'mrpType',    label: 'MRP type',               hint: 'V1 · PD · ND …',                 type: 'cat', get: i => i.mrpType },
    { key: 'materialGroup', label: 'Material group',      hint: 'Inventory Master',               type: 'cat', get: i => i.materialGroup },
    { key: 'purchasingGroup', label: 'Purchasing group',  hint: 'Inventory Master',               type: 'cat', get: i => i.purchasingGroup },
    { key: 'stockStatus', label: 'Stock status today',    hint: 'vs Min / Max / SS',              type: 'cat', get: i => i.stockStatus },
    { key: 'material',   label: 'Material / text',        hint: 'number or description contains', type: 'text' },
    { key: 'trigger',    label: 'PR trigger',             hint: 'MRP-created vs manual (per PR)',  type: 'chain', options: ['MRP', 'Manual', 'Unknown', 'Other'] }
  ];
  const DIM = Object.fromEntries(DIMS.map(d => [d.key, d]));
  let tileSeq = 1;

  function quartileCuts(dim){
    if (state.quartileCache.has(dim.key)) return state.quartileCache.get(dim.key);
    const vals = [];
    for (const i of state.model.mat.values()) {
      const v = dim.get(i);
      if (v == null || !Number.isFinite(v)) continue;
      if (dim.zeroNone && v <= 0) continue;
      vals.push(v);
    }
    vals.sort((a, b) => a - b);
    const q = (p) => vals.length ? vals[Math.min(vals.length - 1, Math.max(0, Math.ceil(p * vals.length) - 1))] : null;
    const out = { n: vals.length, q1: q(0.25), q2: q(0.5), q3: q(0.75), vals };
    state.quartileCache.set(dim.key, out);
    return out;
  }
  function fmtDimVal(dim, v){ return dim.money ? money(v) : fmt(v, v != null && Math.abs(v) < 10 ? 1 : 0) + (dim.unit ? ' ' + dim.unit : ''); }

  function newTile(dimKey){
    const d = DIM[dimKey];
    const t = { id: tileSeq++, dim: dimKey, open: true };
    if (d.type === 'num') Object.assign(t, { mode: 'quartile', q: [4], none: false, topMode: 'top', topPct: 20, min: null, max: null });
    if (d.type === 'cat') Object.assign(t, { values: [], exclude: false, search: '' });
    if (d.type === 'text') Object.assign(t, { text: '' });
    if (d.type === 'chain') Object.assign(t, { values: ['MRP'] });
    return t;
  }

  function tilePasses(t, info){
    const d = DIM[t.dim];
    if (d.type === 'chain') return true;
    if (d.type === 'text') {
      const s = (t.text || '').trim().toLowerCase(); if (!s) return true;
      return info.material.toLowerCase().includes(s) || (info.description || '').toLowerCase().includes(s);
    }
    if (d.type === 'cat') {
      if (!t.values.length) return true;
      const hit = t.values.includes(d.get(info));
      return t.exclude ? !hit : hit;
    }
    const v = d.get(info);
    const isNone = v == null || !Number.isFinite(v) || (d.zeroNone && v <= 0);
    if (t.mode === 'quartile') {
      if (!t.q.length && !t.none) return true;
      if (isNone) return !!t.none;
      const c = quartileCuts(d);
      const qi = v <= c.q1 ? 1 : v <= c.q2 ? 2 : v <= c.q3 ? 3 : 4;
      return t.q.includes(qi);
    }
    if (isNone) return false;
    if (t.mode === 'top') {
      const c = quartileCuts(d); if (!c.n) return false;
      const k = Math.max(1, Math.round(c.n * (t.topPct || 0) / 100));
      return t.topMode === 'top' ? v >= c.vals[c.n - k] : v <= c.vals[k - 1];
    }
    if (t.min != null && v < t.min) return false;
    if (t.max != null && v > t.max) return false;
    return true;
  }
  function tileSummary(t){
    const d = DIM[t.dim];
    if (d.type === 'chain') return t.values.length ? t.values.join(' · ') : 'any';
    if (d.type === 'text') return t.text ? `contains “${t.text}”` : 'any';
    if (d.type === 'cat') return !t.values.length ? 'any' : (t.exclude ? 'all except ' : '') + (t.values.length <= 2 ? t.values.join(' · ') : t.values.length + ' selected');
    if (t.mode === 'quartile') {
      const c = quartileCuts(d);
      const lab = { 1: 'Q1 (lowest 25%)', 2: 'Q2', 3: 'Q3', 4: 'Q4 (top 25%)' };
      if (!t.q.length && !t.none) return 'any';
      if (t.q.length === 1 && !t.none) {
        const qi = t.q[0];
        const lo = qi === 1 ? null : c['q' + (qi - 1)], hi = qi === 4 ? null : c['q' + qi];
        return lab[qi] + ' · ' + (lo == null ? '≤ ' + fmtDimVal(d, hi) : hi == null ? '> ' + fmtDimVal(d, lo) : fmtDimVal(d, lo) + ' – ' + fmtDimVal(d, hi));
      }
      return t.q.sort().map(q => 'Q' + q).join(' + ') + (t.none ? ' + none' : '');
    }
    if (t.mode === 'top') return (t.topMode === 'top' ? 'top ' : 'bottom ') + t.topPct + '%';
    return (t.min != null ? '≥ ' + fmtDimVal(d, t.min) : '') + (t.min != null && t.max != null ? ' and ' : '') + (t.max != null ? '≤ ' + fmtDimVal(d, t.max) : '') || 'any';
  }

  /* chain-level tiles (trigger) */
  function chainPass(c){
    for (const t of state.tiles) {
      if (DIM[t.dim].type !== 'chain') continue;
      if (t.dim === 'trigger' && t.values.length && !t.values.includes(c.trig)) return false;
    }
    return true;
  }

  /* ─── time window ─────────────────────────────────────────────────────── */
  function periodBounds(){
    const m = state.model; if (!m) return [null, null];
    const p = state.period;
    const end = m.asOf;
    if (p.preset === 'all') return [null, null];
    if (p.preset === 'custom') {
      const a = p.from ? E.dn(p.from + '-01') : null;
      let b = null;
      if (p.to) { const [y, mo] = p.to.split('-').map(Number); b = Math.round(Date.UTC(y, mo, 1) / 86400000) - 1; }
      return [a, b];
    }
    const months = { '12m': 12, '6m': 6, '3m': 3, '24m': 24 }[p.preset] || 0;
    const d = new Date(end * 86400000); d.setUTCMonth(d.getUTCMonth() - months);
    return [Math.round(d.getTime() / 86400000), null];
  }
  function inPeriod(day){
    if (day == null) return false;
    const [a, b] = periodBounds();
    if (a != null && day < a) return false;
    if (b != null && day > b) return false;
    return true;
  }
  function periodLabel(){
    const p = state.period;
    return { all: 'whole window', '24m': 'last 24 months', '12m': 'last 12 months', '6m': 'last 6 months', '3m': 'last 3 months' }[p.preset]
      || `${p.from || '…'} → ${p.to || '…'}`;
  }

  function recomputeSegment(){
    const pass = new Set();
    const matTiles = state.tiles.filter(t => DIM[t.dim].type !== 'chain');
    for (const [m, info] of state.model.mat) {
      let ok = true;
      for (const t of matTiles) { if (!tilePasses(t, info)) { ok = false; break; } }
      if (ok) pass.add(m);
    }
    state.matPass = pass;
    state.matCount = pass.size;
  }

  /* ─── item selectors (segment + window) ──────────────────────────────── */
  function chainsFor(metric){
    return state.model.chains.filter(c => state.matPass.has(c.material) && chainPass(c) && inPeriod(metric.anchor(c)));
  }
  const matOk = (m) => state.matPass.has(m);

  /* ═════════════════════════════════════════════════════════════════════════
     BOOT
  ═════════════════════════════════════════════════════════════════════════ */
  document.addEventListener('DOMContentLoaded', boot);
  async function boot(){
    try { const s = await AppStorage.get('settings.perf'); if (s) state.settings = Object.assign({}, E.DEFAULT_SETTINGS, { targets: {} }, s); } catch (e) {}
    try { const u = JSON.parse(localStorage.getItem(UI_KEY) || 'null'); if (u) { state.view = u.view || state.view; state.period = u.period || state.period; state.gran = u.gran || state.gran; } } catch (e) {}
    /* PERF-DEEPDIVE — coming back from a material deep-dive: restore exactly
       the view, segment tiles, window and toggles this tab left with. */
    const ws = U.loadWorkbenchState();
    if (ws) {
      state.view = ws.view || state.view; state.period = ws.period || state.period; state.gran = ws.gran || state.gran;
      state.sub = Object.assign(state.sub, ws.sub || {}); state.breakdownDim = ws.breakdownDim || {};
      state.bandGran = ws.bandGran || state.bandGran; state.cad = Object.assign(state.cad, ws.cad || {}); state.heat = Object.assign(state.heat, ws.heat || {});
      state.filtersOpen = !!ws.filtersOpen;
      if (Array.isArray(ws.tiles)) { state.tiles = ws.tiles.map(t => Object.assign({}, t, { open: false })); tileSeq = state.tiles.reduce((mx, t) => Math.max(mx, (t.id || 0) + 1), 1); }
    }
    $('#btnLoadJson').addEventListener('click', () => $('#loadJsonInput').click());
    $('#btnLoadJson2').addEventListener('click', () => $('#loadJsonInput').click());
    $('#loadJsonInput').addEventListener('change', onLoadJson);
    $('#btnSettings').addEventListener('click', openSettings);
    setupSettingsModal();
    let t; window.addEventListener('resize', () => { clearTimeout(t); t = setTimeout(() => state.model && renderView(), 180); });

    const json = await AppStorage.get('intake.current');
    if (!json) { showEmpty(); return; }
    await loadDataset(json);
  }

  function showEmpty(){
    $('#wbEmpty').classList.remove('hidden');
    ['#wbFilters', '#wbGrid'].forEach(s => $(s).classList.add('hidden'));
    $('#dsName').textContent = 'No dataset loaded';
    $('#dsMeta').textContent = '';
  }

  async function onLoadJson(e){
    const f = e.target.files[0]; if (!f) return;
    try {
      const json = JSON.parse(await f.text());
      delete json._analystData;          // Tune's analyst layer — never restored here (it would write Tune's keys)
      const v = CanonicalSchema.validateShape(json);
      if (!v.ok) { toast('Not a canonical dataset: ' + v.errors.join('; '), 'crit'); return; }
      await AppStorage.set('intake.current', json);
      await loadDataset(json);
      toast(`Opened “${json.metadata.assessmentName || f.name}”`, 'ok');
    } catch (err) { toast('Could not read that file: ' + err.message, 'crit'); }
    e.target.value = '';
  }

  async function loadDataset(json){
    state.json = json;
    $('#wbEmpty').classList.add('hidden');
    const prog = $('#wbProgress'); prog.classList.remove('hidden');
    try {
      state.model = await E.build(json, state.settings, (p, msg) => {
        $('#wbProgBar').style.width = Math.round(p * 100) + '%';
        $('#wbProgMsg').textContent = msg;
      });
    } catch (err) {
      prog.classList.add('hidden');
      toast('Build failed: ' + err.message, 'crit');
      console.error(err);
      return;
    }
    prog.classList.add('hidden');
    state.quartileCache = new Map();
    state.cohortSel = null; state.drill = null;
    renderHeader();
    $('#wbFilters').classList.remove('hidden');
    $('#wbGrid').classList.remove('hidden');
    recomputeSegment();
    renderSegments();
    renderRail();
    renderView();
  }

  function renderHeader(){
    const m = state.model, md = state.json.metadata || {};
    $('#dsName').textContent = md.assessmentName || 'Unnamed dataset';
    const tuneNote = md.appName ? '' : ' · <span class="warn-inline" title="Built by Calibre Tune — trimmed to that assessment\'s materials">Tune dataset</span>';
    $('#dsMeta').innerHTML =
      `<span>As of <b>${esc(m.asOfIso)}</b> <span class="muted">(${esc(m.asOfSource)})</span></span>` +
      `<span>MB51 <b>${esc(m.mb51Span.start || '—')} → ${esc(m.mb51Span.end || '—')}</b></span>` +
      `<span>PRs <b>${esc(m.prSpan.start || '—')} → ${esc(m.prSpan.end || '—')}</b></span>` +
      `<span><b>${fmt(m.counts.materials)}</b> materials · <b>${fmt(m.chains.length)}</b> PR lines · <b>${fmt(m.counts.mb51)}</b> movements</span>` +
      `<span class="muted">built in ${fmt(m.timingMs)} ms</span>` + tuneNote;
  }

  function saveUi(){
    try { localStorage.setItem(UI_KEY, JSON.stringify({ view: state.view, period: state.period, gran: state.gran })); } catch (e) {}
    U.saveWorkbenchState({ view: state.view, period: state.period, gran: state.gran, sub: state.sub, breakdownDim: state.breakdownDim,
      bandGran: state.bandGran, cad: state.cad, heat: state.heat, filtersOpen: state.filtersOpen, tiles: state.tiles.map(t => { const c = Object.assign({}, t); delete c.open; return c; }) });
  }

  /* ═════════════════════════════════════════════════════════════════════════
     SEGMENT BUILDER (one row above everything it scopes)
  ═════════════════════════════════════════════════════════════════════════ */
  function renderSegments(){
    const host = $('#wbFilters');
    const presets = [['all', 'All'], ['24m', '24 m'], ['12m', '12 m'], ['6m', '6 m'], ['3m', '3 m'], ['custom', 'Custom']];
    /* PERF-FILTER-COLLAPSE (operator 2026-09-25): the panel folds to ONE line —
       Filters toggle · summary chips (window + each tile, ✕ removes) · count.
       The full window row, dimension palette and tiles show only when open. */
    host.classList.toggle('open', state.filtersOpen);
    host.innerHTML = `
      <div class="seg-bar">
        <button class="btn-sm seg-toggle ${state.filtersOpen ? 'on' : ''}" id="segToggle" aria-expanded="${state.filtersOpen}" aria-controls="segBody">
          ${state.filtersOpen ? '▾' : '▸'} Filters <span class="seg-n" id="segN"></span></button>
        <span class="seg-chips" id="segChips"></span>
        <span class="seg-count" id="segCount"></span>
      </div>
      <div class="seg-body ${state.filtersOpen ? '' : 'hidden'}" id="segBody">
      <div class="seg-top">
        <div class="seg-window">
          <span class="seg-lab">Window</span>
          ${presets.map(([k, l]) => `<button class="btn-sm ${state.period.preset === k ? 'on' : ''}" data-preset="${k}">${l}</button>`).join('')}
          <span class="seg-custom ${state.period.preset === 'custom' ? '' : 'hidden'}">
            <input type="month" id="perFrom" value="${esc(state.period.from || '')}" aria-label="From month" />
            <span>→</span>
            <input type="month" id="perTo" value="${esc(state.period.to || '')}" aria-label="To month" />
          </span>
        </div>
      </div>
      <div class="seg-palette" id="segPalette" aria-label="Segment dimensions — drag or click to add">
        <span class="seg-lab">Segment</span>
        ${DIMS.map(d => `<button class="seg-dim" draggable="true" data-dim="${d.key}" title="${esc(d.hint)}">+ ${esc(d.label)}</button>`).join('')}
      </div>
      <div class="seg-tiles" id="segTiles"></div>
      </div>`;
    $('#segToggle').addEventListener('click', () => { state.filtersOpen = !state.filtersOpen; saveUi(); renderSegments(); });
    host.querySelectorAll('[data-preset]').forEach(b => b.addEventListener('click', () => {
      state.period.preset = b.dataset.preset;
      if (b.dataset.preset === 'custom' && !state.period.from) {
        const m = state.model; state.period.from = E.ym(m.window.start); state.period.to = E.ym(m.asOf);
      }
      state.cohortSel = null; state.drill = null; saveUi(); renderSegments(); renderView();
    }));
    const pf = $('#perFrom'), pt = $('#perTo');
    if (pf) pf.addEventListener('change', () => { state.period.from = pf.value || null; state.drill = null; saveUi(); renderView(); renderSegCount(); });
    if (pt) pt.addEventListener('change', () => { state.period.to = pt.value || null; state.drill = null; saveUi(); renderView(); renderSegCount(); });
    host.querySelectorAll('.seg-dim').forEach(b => {
      b.addEventListener('click', () => addTile(b.dataset.dim));
      b.addEventListener('dragstart', (e) => { e.dataTransfer.setData('text/plain', b.dataset.dim); e.dataTransfer.effectAllowed = 'copy'; });
    });
    const tilesHost = $('#segTiles');
    tilesHost.addEventListener('dragover', (e) => { e.preventDefault(); tilesHost.classList.add('drop'); });
    tilesHost.addEventListener('dragleave', () => tilesHost.classList.remove('drop'));
    tilesHost.addEventListener('drop', (e) => { e.preventDefault(); tilesHost.classList.remove('drop'); const k = e.dataTransfer.getData('text/plain'); if (DIM[k]) addTile(k); });
    renderTiles();
  }
  function addTile(dimKey){
    state.tiles.forEach(t => t.open = false);
    state.tiles.push(newTile(dimKey));
    segmentChanged();
    renderTiles();
  }
  function segmentChanged(){
    recomputeSegment();
    state.cohortSel = null; state.drill = null;
    renderSegCount();
    renderView();
  }
  function renderSegCount(){
    const el = $('#segCount'); if (!el) return;
    const total = state.model.mat.size;
    el.innerHTML = `<b>${fmt(state.matCount)}</b> of ${fmt(total)} materials`
      + (state.tiles.length ? ` <button class="btn-sm ghost" id="segClear">Clear segment</button>` : '');
    const b = $('#segClear'); if (b) b.addEventListener('click', () => { state.tiles = []; segmentChanged(); renderTiles(); });
    renderSegChips();
  }
  /* PERF-FILTER-COLLAPSE — one-line summary: window + one chip per tile */
  function renderSegChips(){
    const host = $('#segChips'); if (!host) return;
    const n = state.tiles.length + (state.period.preset !== 'all' ? 1 : 0);
    const nEl = $('#segN'); if (nEl) nEl.textContent = n ? `(${n})` : '';
    const win = `<span class="schip ${state.period.preset !== 'all' ? 'set' : ''}" data-open="1" title="Time window — click to change">Window: <b>${esc(periodLabel())}</b></span>`;
    const tiles = state.tiles.map(t => `<span class="schip set" data-open="${t.id}" title="Click to edit">${esc(DIM[t.dim].label)}: <b>${esc(tileSummary(t))}</b><button data-rm="${t.id}" aria-label="Remove ${esc(DIM[t.dim].label)} filter">✕</button></span>`).join('');
    host.innerHTML = win + (tiles || '<span class="schip muted">All materials — no segment</span>');
    host.querySelectorAll('[data-rm]').forEach(b => b.addEventListener('click', (e) => {
      e.stopPropagation(); const id = +b.dataset.rm; state.tiles = state.tiles.filter(t => t.id !== id); segmentChanged(); renderTiles();
    }));
    host.querySelectorAll('[data-open]').forEach(c => c.addEventListener('click', () => {
      const id = +c.dataset.open;
      state.tiles.forEach(t => t.open = t.id === id);
      state.filtersOpen = true; saveUi(); renderSegments();
    }));
  }

  function renderTiles(){
    const host = $('#segTiles');
    if (!state.tiles.length) {
      host.innerHTML = `<div class="seg-empty">No segment — every material is in. Drag a dimension here (or click it) to narrow the review, e.g. <i>Movement → Q4</i>, <i>Unit cost → ≥ 10,000</i>, <i>Manufacturer → one supplier</i>.</div>`;
      renderSegCount();
      return;
    }
    host.innerHTML = state.tiles.map(t => tileHtml(t)).join('');
    for (const t of state.tiles) wireTile(t);
    renderSegCount();
  }

  function tileHtml(t){
    const d = DIM[t.dim];
    const head = `<div class="tile-h" data-toggle="${t.id}"><span class="tile-dim">${esc(d.label)}</span><span class="tile-sum">${esc(tileSummary(t))}</span><button class="tile-x" data-remove="${t.id}" aria-label="Remove ${esc(d.label)} filter">✕</button></div>`;
    if (!t.open) return `<div class="tile" data-tile="${t.id}">${head}</div>`;
    let body = '';
    if (d.type === 'num') {
      const c = quartileCuts(d);
      const qRow = [1, 2, 3, 4].map(q => {
        const lo = q === 1 ? null : c['q' + (q - 1)], hi = q === 4 ? null : c['q' + q];
        const rng = lo == null ? '≤ ' + fmtDimVal(d, hi) : hi == null ? '> ' + fmtDimVal(d, lo) : fmtDimVal(d, lo) + ' – ' + fmtDimVal(d, hi);
        return `<label class="qbox"><input type="checkbox" data-q="${q}" ${t.q.includes(q) ? 'checked' : ''}/> <b>Q${q}</b>${q === 4 ? ' top 25%' : q === 1 ? ' lowest 25%' : ''}<span>${esc(rng)}</span></label>`;
      }).join('');
      body = `
        <div class="tile-modes">
          ${[['quartile', 'Quartile'], ['top', 'Top / bottom %'], ['range', 'Range']].map(([k, l]) => `<button class="btn-sm ${t.mode === k ? 'on' : ''}" data-mode="${k}">${l}</button>`).join('')}
        </div>
        <div class="tile-b ${t.mode === 'quartile' ? '' : 'hidden'}" data-pane="quartile">
          <div class="qgrid">${qRow}</div>
          ${d.zeroNone ? `<label class="qbox none"><input type="checkbox" data-none="1" ${t.none ? 'checked' : ''}/> <b>None</b><span>no ${esc(d.hint)} in the window</span></label>` : ''}
          <div class="muted-note">Quartiles are cut across all ${fmt(c.n)} materials with a value${d.zeroNone ? ' above zero' : ''} — not just the current segment — so they stay put as you add tiles.</div>
        </div>
        <div class="tile-b ${t.mode === 'top' ? '' : 'hidden'}" data-pane="top">
          <select data-topmode><option value="top" ${t.topMode === 'top' ? 'selected' : ''}>Top</option><option value="bottom" ${t.topMode === 'bottom' ? 'selected' : ''}>Bottom</option></select>
          <input type="number" min="1" max="100" step="1" data-toppct value="${t.topPct}" aria-label="Percent" /> <span>% of materials by ${esc(d.hint)}</span>
        </div>
        <div class="tile-b ${t.mode === 'range' ? '' : 'hidden'}" data-pane="range">
          <input type="number" data-min placeholder="min" value="${t.min != null ? t.min : ''}" aria-label="Minimum" />
          <span>to</span>
          <input type="number" data-max placeholder="max" value="${t.max != null ? t.max : ''}" aria-label="Maximum" />
          <span>${esc(d.money ? '$' : (d.unit || ''))}</span>
        </div>`;
    } else if (d.type === 'cat') {
      const counts = new Map();
      for (const info of state.model.mat.values()) { const v = d.get(info); counts.set(v, (counts.get(v) || 0) + 1); }
      const opts = [...counts.entries()].sort((a, b) => b[1] - a[1]);
      const s = (t.search || '').toLowerCase();
      const shown = opts.filter(([v]) => !s || String(v).toLowerCase().includes(s)).slice(0, 300);
      body = `
        <div class="tile-modes">
          <button class="btn-sm ${!t.exclude ? 'on' : ''}" data-excl="0">Include</button>
          <button class="btn-sm ${t.exclude ? 'on' : ''}" data-excl="1">Exclude</button>
          <input type="text" data-search placeholder="Search ${opts.length.toLocaleString()} values…" value="${esc(t.search || '')}" />
          <button class="btn-sm ghost" data-clearvals>Clear</button>
        </div>
        <div class="catlist">${shown.map(([v, n]) => `<label><input type="checkbox" data-val="${esc(v)}" ${t.values.includes(v) ? 'checked' : ''}/> ${esc(v)} <span>${n.toLocaleString()}</span></label>`).join('')}
        ${opts.length > shown.length ? `<div class="muted-note">${(opts.length - shown.length).toLocaleString()} more — search to narrow.</div>` : ''}</div>`;
    } else if (d.type === 'text') {
      body = `<div class="tile-b"><input type="text" data-text placeholder="material number or description contains…" value="${esc(t.text)}" /></div>`;
    } else if (d.type === 'chain') {
      body = `<div class="tile-b">${d.options.map(o => `<label class="qbox"><input type="checkbox" data-cval="${o}" ${t.values.includes(o) ? 'checked' : ''}/> <b>${o}</b></label>`).join('')}
        <div class="muted-note">Applies per PR line (the creation indicator: B = MRP, R = manual, blank = unknown). Views of stock events are not affected.</div></div>`;
    }
    return `<div class="tile open" data-tile="${t.id}">${head}${body}</div>`;
  }

  function wireTile(t){
    const el = $(`[data-tile="${t.id}"]`); if (!el) return;
    const redraw = () => { segmentChanged(); const h = el.querySelector('.tile-sum'); if (h) h.textContent = tileSummary(t); };
    el.querySelector('[data-toggle]').addEventListener('click', (e) => {
      if (e.target.closest('[data-remove]')) return;
      const wasOpen = t.open; state.tiles.forEach(x => x.open = false); t.open = !wasOpen; renderTiles();
    });
    el.querySelector('[data-remove]').addEventListener('click', () => { state.tiles = state.tiles.filter(x => x !== t); segmentChanged(); renderTiles(); });
    el.querySelectorAll('[data-mode]').forEach(b => b.addEventListener('click', () => { t.mode = b.dataset.mode; renderTiles(); segmentChanged(); }));
    el.querySelectorAll('[data-q]').forEach(cb => cb.addEventListener('change', () => { const q = +cb.dataset.q; t.q = cb.checked ? [...new Set([...t.q, q])] : t.q.filter(x => x !== q); redraw(); }));
    const none = el.querySelector('[data-none]'); if (none) none.addEventListener('change', () => { t.none = none.checked; redraw(); });
    const tm = el.querySelector('[data-topmode]'); if (tm) tm.addEventListener('change', () => { t.topMode = tm.value; redraw(); });
    const tp = el.querySelector('[data-toppct]'); if (tp) tp.addEventListener('change', () => { t.topPct = Math.max(1, Math.min(100, +tp.value || 20)); redraw(); });
    const mn = el.querySelector('[data-min]'); if (mn) mn.addEventListener('change', () => { t.min = mn.value === '' ? null : +mn.value; redraw(); });
    const mx = el.querySelector('[data-max]'); if (mx) mx.addEventListener('change', () => { t.max = mx.value === '' ? null : +mx.value; redraw(); });
    el.querySelectorAll('[data-excl]').forEach(b => b.addEventListener('click', () => { t.exclude = b.dataset.excl === '1'; renderTiles(); segmentChanged(); }));
    const srch = el.querySelector('[data-search]');
    if (srch) srch.addEventListener('input', () => { t.search = srch.value; const pos = srch.selectionStart; renderTiles(); const s2 = $(`[data-tile="${t.id}"] [data-search]`); if (s2) { s2.focus(); s2.setSelectionRange(pos, pos); } });
    const cv = el.querySelector('[data-clearvals]'); if (cv) cv.addEventListener('click', () => { t.values = []; renderTiles(); segmentChanged(); });
    el.querySelectorAll('[data-val]').forEach(cb => cb.addEventListener('change', () => { const v = cb.dataset.val; t.values = cb.checked ? [...new Set([...t.values, v])] : t.values.filter(x => x !== v); redraw(); }));
    const tx = el.querySelector('[data-text]'); if (tx) tx.addEventListener('change', () => { t.text = tx.value; redraw(); });
    el.querySelectorAll('[data-cval]').forEach(cb => cb.addEventListener('change', () => { const v = cb.dataset.cval; t.values = cb.checked ? [...new Set([...t.values, v])] : t.values.filter(x => x !== v); redraw(); }));
  }

  /* add a category tile pre-set to one value (from a breakdown row click) */
  function segmentOn(dimKey, value){
    let t = state.tiles.find(x => x.dim === dimKey && !x.exclude);
    if (!t) { t = newTile(dimKey); state.tiles.push(t); }
    if (DIM[dimKey].type === 'chain') t.values = [value];
    else t.values = [value];
    state.tiles.forEach(x => x.open = false);
    segmentChanged(); renderTiles();
    toast(`Segment: ${DIM[dimKey].label} = ${value}`, 'ok');
  }

  /* ═════════════════════════════════════════════════════════════════════════
     RAIL
  ═════════════════════════════════════════════════════════════════════════ */
  const VIEWS = [
    { key: 'overview',  label: 'Overview',                        group: null },
    { key: 'materials', label: 'Materials in the segment',        group: null },
    { key: 'response',  label: 'Trigger → PR response',           group: 'MRP response' },
    { key: 'exposure',  label: 'Exposure & stockouts',            group: 'MRP response' },
    { key: 'cadence',   label: 'PR / PO volumes & MRP cadence',   group: 'MRP response' },
    { key: 'heat',      label: 'MRP activity by material',        group: 'MRP response' },
    { key: 'outcomes',  label: 'PR outcomes & cancellations',     group: 'MRP response' },
    { key: 'internal',  label: 'Internal · PR → PO',              group: 'Process legs' },
    { key: 'supplier',  label: 'Supplier · PO → 3PL',             group: 'Process legs' },
    { key: 'threepl',   label: '3PL · 3PL → site',                group: 'Process legs' },
    { key: 'e2e',       label: 'End to end · PR → site',          group: 'Process legs' },
    { key: 'plan',      label: 'Against plan & process paths',    group: 'Process legs' },
    { key: 'sizing',    label: 'Order sizing (V1)',               group: 'Stock outcomes' },
    { key: 'overunder', label: 'Over / under ordering',           group: 'Stock outcomes' },
    { key: 'checks',    label: 'Data checks & assumptions',       group: 'Data' }
  ];
  function renderRail(){
    let g = null, html = '';
    for (const v of VIEWS) {
      if (v.group !== g) { g = v.group; if (g) html += `<div class="rail-g">${esc(g)}</div>`; }
      html += `<button class="rail-b ${state.view === v.key ? 'active' : ''}" data-view="${v.key}">${esc(v.label)}</button>`;
    }
    $('#wbRail').innerHTML = html;
    $$('#wbRail [data-view]').forEach(b => b.addEventListener('click', () => go(b.dataset.view)));
  }
  function go(view){
    state.view = view; state.cohortSel = null; state.drill = null; saveUi();
    renderRail(); renderView();
    window.scrollTo({ top: $('#wbGrid').offsetTop - 70, behavior: 'smooth' });
  }

  /* ═════════════════════════════════════════════════════════════════════════
     VIEW DISPATCH
  ═════════════════════════════════════════════════════════════════════════ */
  function renderView(){
    const host = $('#wbView');
    C.hideTip();
    if (!state.model) return;
    if (!state.matPass) recomputeSegment();
    const fn = {
      overview: viewOverview, response: viewResponse, exposure: viewExposure, cadence: viewCadence,
      outcomes: viewOutcomes, internal: viewInternal, supplier: () => metricView(host, 'C', { breakdown: 'manufacturer', intro: supplierIntro() }),
      threepl: viewThreePL, e2e: () => metricView(host, 'E2E', { breakdown: 'mrpType' }),
      plan: viewPlan, sizing: viewSizing, overunder: viewOverUnder, checks: viewChecks,
      materials: viewMaterials, heat: viewHeat
    }[state.view] || viewOverview;
    host.innerHTML = '';
    fn(host);
    saveUi();
  }

  function card(host, title, sub, actionsHtml){
    const el = document.createElement('div');
    el.className = 'card';
    el.innerHTML = `<div class="card-h"><div><div class="card-t">${esc(title)}</div>${sub ? `<div class="card-s">${sub}</div>` : ''}</div>${actionsHtml ? `<div class="card-actions">${actionsHtml}</div>` : ''}</div>`;
    host.appendChild(el);
    return el;
  }
  function div(parent, cls, html){ const d = document.createElement('div'); if (cls) d.className = cls; if (html != null) d.innerHTML = html; parent.appendChild(d); return d; }
  function statTile(l, v, d, cls, attrs){ return `<div class="stat ${cls || ''}" ${attrs || ''}><span class="l">${esc(l)}</span><div class="v">${v}</div>${d ? `<div class="d">${d}</div>` : ''}</div>`; }
  function qv(q){ return q == null ? '—' : (q.lowerBound ? '≥ ' : '') + fmt(q.v) + '<small>d</small>'; }
  function qtxt(q){ return q == null ? '—' : (q.lowerBound ? '≥ ' : '') + fmt(q.v) + ' d'; }

  /* bin marker position for a value */
  function markerPos(bins, v){
    if (v == null) return { bin: null };
    const i = E.binIndex(bins, v); const b = bins[i];
    let frac = 0.5;
    if (Number.isFinite(b.lo) && Number.isFinite(b.hi) && b.hi > b.lo) frac = Math.max(0.08, Math.min(0.92, (v - b.lo + 0.5) / (b.hi - b.lo + 1)));
    else if (!Number.isFinite(b.hi)) frac = 0.25;
    return { bin: i, frac };
  }

  /* ═════════════════════════════════════════════════════════════════════════
     GENERIC METRIC VIEW — histogram + per-month boxes + breakdown + drill
  ═════════════════════════════════════════════════════════════════════════ */
  function metricView(host, key, opts){
    opts = opts || {};
    const M = E.METRICS[key];
    const base = chainsFor(M);
    const sel = state.cohortSel && state.cohortSel.view === state.view + ':' + key ? state.cohortSel.month : null;
    const chains = sel ? base.filter(c => E.periodKey(M.anchor(c), state.bandGran) === sel) : base;
    const col = E.collect(chains, M);
    const stageV = (c) => M.stage(c).v;
    const doneV = col.done.map(stageV), openV = col.open.map(stageV);
    const bins = M.signed ? E.BINS_SIGNED : E.BINS_DAYS;
    const cDone = new Array(bins.length).fill(0), cOpen = new Array(bins.length).fill(0);
    for (const v of doneV) cDone[E.binIndex(bins, v)]++;
    for (const v of openV) cOpen[E.binIndex(bins, v)]++;
    const qa = E.quantiles(doneV, openV, [0.1, 0.5, 0.9]);
    const qd = E.doneQuantiles(doneV, [0.1, 0.5, 0.9]);
    const target = state.settings.targets[key];

    if (opts.intro) div(host, 'view-intro', opts.intro);
    const c1 = card(host, M.label, esc(M.def) + (sel ? ` <span class="chip">${esc(M.anchorLabel)} ${esc(sel)} <button data-clearsel aria-label="Clear month">✕</button></span>` : ''),
      `<button class="btn-sm" data-tbl>▦ Table</button>`);
    /* stat strip */
    let within = '';
    if (target != null) {
      const w = doneV.filter(v => v <= target).length;
      const missed = doneV.filter(v => v > target).length + openV.filter(v => v > target).length;
      const pend = openV.filter(v => v <= target).length;
      within = statTile(`Within target (≤ ${fmt(target)} d)`, pct(w, w + missed), `${fmt(w)} in · ${fmt(missed)} over${pend ? ` · ${fmt(pend)} still open under target` : ''}`);
    } else {
      within = statTile('KPI target', '<span class="muted">not set</span>', 'set one in ⚙ Settings & targets once the baseline is clear', 'clickable', 'data-settarget="1"');
    }
    div(c1, 'stats',
      statTile('Closed', fmt(col.done.length), 'stage finished') +
      statTile('Still open', fmt(col.open.length), 'counted at their age so far') +
      statTile('Out of sequence', fmt(col.oos.length), col.oos.length ? 'end dated before start' : '', col.oos.length ? 'warn' : '') +
      statTile('P10', qv(qa[0.1]), 'fast tail') +
      statTile('Median', qv(qa[0.5]), `closed only: ${qd[0.5] == null ? '—' : fmt(qd[0.5]) + ' d'}`) +
      statTile('P90', qv(qa[0.9]), `closed only: ${qd[0.9] == null ? '—' : fmt(qd[0.9]) + ' d'}`) +
      within);
    const other = [];
    if (col.bad) other.push(`${fmt(col.bad)} with a bad or missing date (not measured)`);
    if (col.nocov) other.push(`${fmt(col.nocov)} started before MB51 coverage (receipt can't be seen)`);
    if (col.bypass) other.push(`${fmt(col.bypass)} skipped this leg (site receipt with no 3PL receipt)`);
    if (col.term) other.push(`${fmt(col.term)} ended earlier (cancelled)`);
    if (col.notdue) other.push(`${fmt(col.notdue)} not due yet`);
    if (other.length) div(c1, 'muted-note', 'Not in the chart: ' + esc(other.join(' · ')) + '.');
    div(c1, null, C.legend(M.signed ? [
      { label: 'Early', color: C.PAL.early }, { label: 'On the day', color: C.PAL.ontime }, { label: 'Late', color: C.PAL.late },
      { label: 'Still open — late by at least this (dimmed)', color: C.PAL.late, opacity: C.OPEN_OPACITY }
    ] : [
      { label: 'Closed', color: C.PAL.s1 },
      { label: 'Still open — at least this long', color: C.PAL.s1, opacity: C.OPEN_OPACITY },
      ...(col.oos.length ? [{ label: 'Out of sequence (!)', color: C.PAL.oos }] : [])
    ]));
    const hHost = div(c1, 'chart');
    const binColors = M.signed ? bins.map(b => b.hi < 0 ? C.PAL.early : b.lo > 0 ? C.PAL.late : C.PAL.ontime) : null;
    const mk = (q, lab) => q ? Object.assign(markerPos(bins, q.v), { label: `${lab} ${q.lowerBound ? '≥ ' : ''}${fmt(q.v)} d` }) : { bin: null };
    const draw = () => C.histogram(hHost, {
      bins, oos: M.signed ? 0 : col.oos.length, unit: M.signed ? '' : 'days', binColors,
      series: [
        { key: 'done', label: 'closed', color: C.PAL.s1, counts: cDone },
        { key: 'open', label: 'still open (at least)', color: C.PAL.s1, opacity: C.OPEN_OPACITY, counts: cOpen }
      ],
      markers: [mk(qa[0.1], 'P10'), mk(qa[0.5], 'median'), mk(qa[0.9], 'P90')],
      target: target != null ? Object.assign(markerPos(bins, target), { label: `target ${fmt(target)} d` }) : null,
      selected: state.drill && state.drill.metric === key && state.drill.bin != null ? { bin: state.drill.bin } : null,
      xTitle: M.signed ? 'days late against need-by (negative = early)' : `days · ${M.start} → ${M.end}`,
      aria: M.label + ' distribution',
      onBin: (bin) => {
        let items;
        if (bin === 'oos') items = col.oos;
        else items = col.done.filter(c => E.binIndex(bins, stageV(c)) === bin).concat(col.open.filter(c => E.binIndex(bins, stageV(c)) === bin));
        setDrill({ kind: 'chains', metric: key, bin, title: `${M.label} · ${bin === 'oos' ? 'out of sequence' : bins[bin].label + (M.signed ? '' : ' days')}`, items });
      }
    });
    draw();
    const tbl = div(c1, 'hidden');
    tbl.innerHTML = binTable(bins, [['Closed', cDone], ['Still open', cOpen]], M.signed ? null : col.oos.length);
    c1.querySelector('[data-tbl]').addEventListener('click', (e) => { tbl.classList.toggle('hidden'); e.target.classList.toggle('on'); });
    const cs = c1.querySelector('[data-clearsel]'); if (cs) cs.addEventListener('click', () => { state.cohortSel = null; renderView(); });
    const stt = c1.querySelector('[data-settarget]'); if (stt) stt.addEventListener('click', openSettings);
    /* tail buttons */
    const tails = div(c1, 'tails');
    tails.innerHTML = `<span class="seg-lab">Drill</span>
      <button class="btn-sm" data-tail="left">Fast tail · closed ≤ P10</button>
      <button class="btn-sm" data-tail="right">Slow tail · ≥ P90 (incl. open)</button>
      <button class="btn-sm" data-tail="open">Still open (${fmt(col.open.length)})</button>
      ${col.oos.length ? `<button class="btn-sm" data-tail="oos">Out of sequence (${fmt(col.oos.length)})</button>` : ''}`;
    tails.querySelectorAll('[data-tail]').forEach(b => b.addEventListener('click', () => {
      const k = b.dataset.tail;
      let items, title;
      if (k === 'left') { const p = qd[0.1]; items = col.done.filter(c => stageV(c) <= p); title = `fast tail · closed ≤ ${fmt(p)} d`; }
      else if (k === 'right') { const p = qd[0.9] != null ? qd[0.9] : (qa[0.9] ? qa[0.9].v : 0); items = col.done.filter(c => stageV(c) >= p).concat(col.open.filter(c => stageV(c) >= p)); title = `slow tail · ≥ ${fmt(p)} d incl. still open`; }
      else if (k === 'open') { items = col.open.slice(); title = 'still open'; }
      else { items = col.oos; title = 'out of sequence'; }
      setDrill({ kind: 'chains', metric: key, title: `${M.label} · ${title}`, items });
    }));

    /* PERF-BANDS — month-on-month (or quarter) band: median + mean + P25–P75 + P10–P90 */
    const groups = E.cohorts(base, M, state.settings.provisionalPct, state.bandGran);
    const c2 = card(host, `${state.bandGran === 'quarter' ? 'Quarter' : 'Month'} on ${state.bandGran} · ${M.anchorLabel} …`,
      `White line = median, violet = mean (average), bands = P25–P75 and P10–P90 of CLOSED items; n = closed items. Hollow dots = provisional (below ${Math.round(state.settings.provisionalPct * 100)}% closed); the caret marks the P90 once still-open items are counted. Narrowing bands = a more predictable process; a falling median = getting faster. Click a period to focus the view on it.`,
      bandGranButtons());
    wireBandGran(c2);
    div(c2, null, bandLegend());
    C.bandChart(div(c2, 'chart'), { groups, signed: !!M.signed, target, selected: sel, xTitle: `${M.anchorLabel} (${state.bandGran}) · n closed`, aria: M.label + ' by period',
      onClick: (pk) => { state.cohortSel = (sel === pk) ? null : { view: state.view + ':' + key, month: pk }; state.drill = null; renderView(); } });

    /* breakdown */
    breakdownCard(host, key, chains, M, opts.breakdown || 'manufacturer');

    if (opts.after) opts.after(host, chains, col);
    drillCard(host);
  }

  function binTable(bins, rows, oos){
    let h = '<div class="tblwrap" style="max-height:none"><table class="dt"><thead><tr><th>Bin</th>' + rows.map(r => `<th class="num">${esc(r[0])}</th>`).join('') + '</tr></thead><tbody>';
    if (oos) h += `<tr><td>Out of sequence</td><td class="num">${fmt(oos)}</td>${rows.slice(1).map(() => '<td class="num">—</td>').join('')}</tr>`;
    bins.forEach((b, i) => { h += `<tr><td>${esc(b.label)}</td>${rows.map(r => `<td class="num">${fmt(r[1][i] || 0)}</td>`).join('')}</tr>`; });
    return h + '</tbody></table></div>';
  }

  const BREAK_DIMS = [
    ['manufacturer', 'Manufacturer'], ['mrpType', 'MRP type'], ['materialGroup', 'Material group'],
    ['purchasingGroup', 'Purchasing group'], ['trigger', 'PR trigger'], ['stockStatus', 'Stock status']
  ];
  function groupKeyOf(dim, c){
    if (dim === 'trigger') return c.trig;
    const info = state.model.mat.get(c.material);
    return DIM[dim].get(info);
  }
  function breakdownCard(host, key, chains, M, defDim){
    const bk = state.view + ':' + key;
    const dim = state.breakdownDim[bk] || defDim;
    const groups = new Map();
    for (const c of chains) {
      const x = M.stage(c); if (!(x.s === 'done' || x.s === 'open' || x.s === 'oos')) continue;
      const g = groupKeyOf(dim, c);
      let e = groups.get(g); if (!e) { e = { g, done: [], open: [], oos: 0 }; groups.set(g, e); }
      if (x.s === 'done' && (M.signed || x.v >= 0)) e.done.push(x.v); else if (x.s === 'open') e.open.push(x.v); else e.oos++;
    }
    const rows = [...groups.values()].map(e => {
      const q = E.doneQuantiles(e.done, [0.1, 0.5, 0.9]);
      const qa = E.quantiles(e.done, e.open, [0.5, 0.9]);
      return { group: e.g, closed: e.done.length, open: e.open.length, oos: e.oos, p10: q[0.1], med: q[0.5], p90: q[0.9],
               max: e.done.length ? Math.max(...e.done) : null, medAll: qa[0.5], p90All: qa[0.9] };
    });
    const c = card(host, `Breakdown · ${M.label}`,
      'Every group\'s spread side by side — where the process deviates and by how much. Click a row to add it to the segment.',
      `<select data-bdim aria-label="Break down by">${BREAK_DIMS.map(([k, l]) => `<option value="${k}" ${k === dim ? 'selected' : ''}>by ${l}</option>`).join('')}</select>`);
    c.querySelector('[data-bdim]').addEventListener('change', (e) => { state.breakdownDim[bk] = e.target.value; renderView(); });
    const t = div(c, 'tblwrap');
    renderTable(t, {
      rows, sort: { key: 'closed', dir: -1 },
      cols: [
        { key: 'group', label: BREAK_DIMS.find(x => x[0] === dim)[1], cls: 'wrap' },
        { key: 'closed', label: 'Closed', num: true }, { key: 'open', label: 'Open', num: true }, { key: 'oos', label: 'Out of seq.', num: true },
        { key: 'p10', label: 'P10', num: true, f: v => fmt(v) }, { key: 'med', label: 'Median', num: true, f: v => fmt(v) },
        { key: 'p90', label: 'P90', num: true, f: v => fmt(v) }, { key: 'max', label: 'Max', num: true, f: v => fmt(v) },
        { key: 'p90All', label: 'P90 incl. open', num: true, f: v => qtxt(v), sv: r => r.p90All ? r.p90All.v : -1 }
      ],
      onRow: (r) => segmentOn(dim, r.group),
      csv: `breakdown-${key}-${dim}`
    });
  }

  /* ═════════════════════════════════════════════════════════════════════════
     DRILL
  ═════════════════════════════════════════════════════════════════════════ */
  function setDrill(d){
    state.drill = d;
    renderView();
    const el = $('#drillCard'); if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
  function drillCard(host){
    if (!state.drill) return;
    const d = state.drill;
    const c = card(host, 'Drill · ' + d.title, `${fmt(d.items.length)} item${d.items.length === 1 ? '' : 's'} — sort any column, export to CSV.`, `<button class="btn-sm ghost" data-closedrill>✕ Close</button>`);
    c.id = 'drillCard';
    c.querySelector('[data-closedrill]').addEventListener('click', () => { state.drill = null; renderView(); });
    const t = div(c, 'tblwrap');
    const spec = DRILL_SPECS[d.kind];
    const rows = d.items.map(it => spec.row(it, d));
    const hasMat = rows.length && rows[0].material !== undefined;
    renderTable(t, { rows, cols: spec.cols(d), sort: spec.sort || null, limit: 500, csv: 'drill-' + d.kind,
      onRow: hasMat ? (r, sorted) => U.openMaterial(r.material, sorted.map(x => x.material), d.title) : null,
      footNote: hasMat ? 'Click a row to open that material\'s deep-dive — Prev / Next then steps through this list in the order shown.' : '' });
  }
  const mInfo = (m) => state.model.mat.get(m) || {};
  const DRILL_SPECS = {
    chains: {
      cols: (d) => {
        const M = E.METRICS[d.metric];
        return [
          { key: 'material', label: 'Material' }, { key: 'desc', label: 'Description', cls: 'wrap' }, { key: 'mfr', label: 'Manufacturer' },
          { key: 'mrp', label: 'MRP' }, { key: 'trig', label: 'Trigger' }, { key: 'pr', label: 'PR' }, { key: 'prD', label: 'PR date' },
          { key: 'rel', label: 'Released' }, { key: 'po', label: 'PO' }, { key: 'poD', label: 'PO date' }, { key: 'g107', label: 'At 3PL' },
          { key: 'g109', label: 'At site' }, { key: 'need', label: 'Need-by' },
          { key: 'v', label: M ? M.label + ' (d)' : 'Days', num: true, f: (v, r) => (r.st === 'open' ? '≥ ' : '') + fmt(v) },
          { key: 'st', label: 'Status', f: (v) => v === 'open' ? '<span class="st-open">still open</span>' : v === 'oos' ? '<span class="st-oos">! out of sequence</span>' : esc(v), html: true },
          { key: 'path', label: 'Path', cls: 'wrap' }
        ];
      },
      row: (c, d) => {
        const i = mInfo(c.material); const M = E.METRICS[d.metric]; const x = M ? M.stage(c) : { v: null, s: '' };
        return { material: c.material, desc: i.description, mfr: i.manufacturer, mrp: i.mrpType, trig: c.trig, pr: c.pr, prD: iso(c.prD), rel: iso(c.relD),
                 po: c.po, poD: iso(c.poD), g107: iso(c.g107), g109: iso(c.g109), need: iso(c.needD), v: x.v, st: (x.s === 'done' && !M.signed && x.v < 0) ? 'oos' : x.s, path: c.path };
      },
      sort: { key: 'v', dir: -1 }
    },
    episodes: {
      cols: () => [
        { key: 'material', label: 'Material' }, { key: 'desc', label: 'Description', cls: 'wrap' }, { key: 'mfr', label: 'Manufacturer' },
        { key: 'mrp', label: 'MRP' }, { key: 'line', label: 'Trigger line' }, { key: 'T', label: 'Crossed on' }, { key: 'sohAtT', label: 'Stock then', num: true, f: v => fmt(v, 1) },
        { key: 'response', label: 'Response' }, { key: 'toPr', label: 'Days to PR', num: true, f: (v, r) => r.response === 'no PR yet' ? '≥ ' + fmt(r.age) : fmt(v) },
        { key: 'toPo', label: 'Days to PO', num: true, f: v => fmt(v) }, { key: 'days', label: 'Days below line', num: true, f: (v, r) => (r.ongoing ? '≥ ' : '') + fmt(v) },
        { key: 'noCover', label: 'Nothing on order (d)', num: true }, { key: 'noCoverPr', label: '…of which PR open (d)', num: true },
        { key: 'stale', label: 'Stale-PO only (d)', num: true }, { key: 'stockout', label: 'Stocked out (d)', num: true }
      ],
      row: (e) => { const i = mInfo(e.material); return { material: e.material, desc: i.description, mfr: i.manufacturer, mrp: e.mrpType,
        line: `${e.lineLabel} ${e.line ? fmt(e.line, 1) : ''}`.trim(), T: iso(e.T), sohAtT: e.sohAtT, response: e.response, toPr: e.toPr, age: state.model.asOf - e.T,
        toPo: e.toPo, days: e.days, ongoing: e.ongoing, noCover: e.noCoverNoPr + e.noCoverPr, noCoverPr: e.noCoverPr, stale: e.staleOnly, stockout: e.stockoutDays }; },
      sort: { key: 'noCover', dir: -1 }
    },
    stockouts: {
      cols: () => [
        { key: 'material', label: 'Material' }, { key: 'desc', label: 'Description', cls: 'wrap' }, { key: 'mfr', label: 'Manufacturer' }, { key: 'mrp', label: 'MRP' },
        { key: 'T', label: 'Stocked out on' }, { key: 'days', label: 'Days at zero', num: true, f: (v, r) => (r.ongoing ? '≥ ' : '') + fmt(v) },
        { key: 'inflight', label: 'Order in flight at start' }, { key: 'cov', label: 'Days covered', num: true }, { key: 'unc', label: 'Days with nothing on order', num: true }
      ],
      row: (s) => { const i = mInfo(s.material); return { material: s.material, desc: i.description, mfr: i.manufacturer, mrp: s.mrpType, T: iso(s.T), days: s.days, ongoing: s.ongoing,
        inflight: s.orderInFlight ? 'yes' : 'no', cov: s.daysCovered, unc: s.daysUncovered }; },
      sort: { key: 'days', dir: -1 }
    },
    orders: {
      cols: () => [
        { key: 'material', label: 'Material' }, { key: 'desc', label: 'Description', cls: 'wrap' }, { key: 'mfr', label: 'Manufacturer' },
        { key: 'pr', label: 'PR' }, { key: 'd', label: 'PR date' }, { key: 'trig', label: 'Trigger' }, { key: 'min', label: 'Min', num: true }, { key: 'max', label: 'Max', num: true },
        { key: 'soh', label: 'Stock at PR', num: true, f: v => fmt(v, 1) }, { key: 'pipe', label: 'Already on order', num: true, f: v => fmt(v, 1) },
        { key: 'gap', label: 'Gap to Max', num: true, f: v => fmt(v, 1) }, { key: 'qty', label: 'Ordered', num: true }, { key: 'ratio', label: 'Ordered ÷ gap', num: true, f: v => v == null ? 'at / above Max' : Math.round(v * 100) + '%' }
      ],
      row: (o) => { const i = mInfo(o.material); return { material: o.material, desc: i.description, mfr: i.manufacturer, pr: o.chain.pr, d: iso(o.d), trig: o.trig,
        min: o.min, max: o.max, soh: o.sohStart, pipe: o.pipeline, gap: o.gap, qty: o.qty, ratio: o.ratio }; },
      sort: { key: 'ratio', dir: 1 }
    },
    receipts: {
      cols: () => [
        { key: 'material', label: 'Material' }, { key: 'desc', label: 'Description', cls: 'wrap' }, { key: 'mfr', label: 'Manufacturer' }, { key: 'mrp', label: 'MRP' },
        { key: 'd', label: 'Received' }, { key: 'qty', label: 'Qty received', num: true }, { key: 'before', label: 'Stock before', num: true, f: v => fmt(v, 1) },
        { key: 'after', label: 'Stock after', num: true, f: v => fmt(v, 1) }, { key: 'min', label: 'Min / SS', num: true }, { key: 'max', label: 'Max', num: true },
        { key: 'over', label: 'Over Max', num: true, f: v => fmt(v, 1) }, { key: 'overV', label: 'Over Max $', num: true, f: v => money(v) }
      ],
      row: (r) => { const i = mInfo(r.material); return { material: r.material, desc: i.description, mfr: i.manufacturer, mrp: r.mrpType, d: iso(r.d), qty: r.qty,
        before: r.before, after: r.after, min: r.mrpType === 'V1' ? r.min : r.ss, max: r.max, over: r.overMax, overV: r.overMaxValue }; },
      sort: { key: 'overV', dir: -1 }
    },
    reorder: {
      cols: () => [
        { key: 'material', label: 'Material' }, { key: 'desc', label: 'Description', cls: 'wrap' }, { key: 'mfr', label: 'Manufacturer' },
        { key: 'min', label: 'Min', num: true }, { key: 'max', label: 'Max', num: true }, { key: 'cons', label: 'Consumed / yr', num: true, f: v => fmt(v, 1) },
        { key: 'pos', label: 'POs in window', num: true }, { key: 'act', label: 'POs / yr', num: true, f: v => fmt(v, 1) },
        { key: 'exp', label: 'Expected / yr', num: true, f: v => fmt(v, 1) }, { key: 'ratio', label: 'Actual ÷ expected', num: true, f: v => v == null ? '—' : fmt(v, 2) + '×' }
      ],
      row: (r) => { const i = mInfo(r.material); return { material: r.material, desc: i.description, mfr: i.manufacturer, min: r.min, max: r.max, cons: r.consPerYr,
        pos: r.pos, act: r.actualPerYr, exp: r.expectedPerYr, ratio: r.ratio }; },
      sort: { key: 'ratio', dir: -1 }
    },
    list: {
      cols: (d) => d.cols,
      row: (r) => r
    }
  };

  /* ─── sortable table with CSV — shared with the deep-dive (shared/perf-ui.js) ─ */
  function dsName(){ return ((state.json && state.json.metadata) || {}).assessmentName || 'dataset'; }
  function renderTable(host, spec){ return U.renderTable(host, Object.assign({ csvPrefix: dsName() }, spec)); }

  /* ═════════════════════════════════════════════════════════════════════════
     VIEWS
  ═════════════════════════════════════════════════════════════════════════ */
  function supplierIntro(){
    return `<div class="note-box"><b>Manufacturer stands in for vendor</b> (Inventory Master “Mfg Name”) until supplier / PO data is added — one manufacturer can be supplied by several distributors. The leg ends when goods arrive at the 3PL (first 107).</div>`;
  }

  /* ── overview ─────────────────────────────────────────────────────────── */
  function viewOverview(host){
    const m = state.model;
    div(host, 'view-intro', `<h2>Where the process stands</h2><p>Each tile is a distribution summary for the current segment and window — median and P90 counting still-open items as lower bounds (“≥”). Click a tile to open its view.</p>`);
    const legs = [['AB', 'internal'], ['C', 'supplier'], ['D', 'threepl'], ['E2E', 'e2e'], ['PLAN', 'plan']];
    let tiles = '';
    for (const [k, view] of legs) {
      const M = E.METRICS[k], col = E.collect(chainsFor(M), M);
      const qa = E.quantiles(col.done.map(c => M.stage(c).v), col.open.map(c => M.stage(c).v), [0.5, 0.9]);
      tiles += statTile(M.label, qv(qa[0.5]), `P90 ${qtxt(qa[0.9])} · ${fmt(col.done.length)} closed · ${fmt(col.open.length)} open${col.oos.length ? ` · <span class="amber">${fmt(col.oos.length)} out of seq.</span>` : ''}`, 'clickable', `data-go="${view}"`);
    }
    const eps = m.episodes.filter(e => e.realLine && matOk(e.material) && inPeriod(e.T));
    const fresh = eps.filter(e => !e.leftCensored);
    const naked = fresh.filter(e => !e.coveredAtT && !e.prOpenAtT).length;
    const toPr = fresh.filter(e => e.toPr != null).map(e => e.toPr);
    const noPrYet = fresh.filter(e => e.response === 'no PR yet').map(e => m.asOf - e.T);
    const qr = E.quantiles(toPr, noPrYet, [0.5, 0.9]);
    tiles += statTile('Stock crossed its trigger line', fmt(fresh.length), `${pct(naked, fresh.length)} with nothing on order and no PR at that moment`, 'clickable', 'data-go="response"');
    tiles += statTile('Trigger → PR', qv(qr[0.5]), `P90 ${qtxt(qr[0.9])} · when nothing was on order`, 'clickable', 'data-go="response"');
    const so = m.stockouts.filter(s => matOk(s.material) && inPeriod(s.T) && !s.leftCensored);
    tiles += statTile('Stockouts', fmt(so.length), `${pct(so.filter(s => !s.orderInFlight).length, so.length)} began with nothing on order`, so.length ? 'warn clickable' : 'clickable', 'data-go="exposure"');
    const ords = m.orders.filter(o => matOk(o.material) && inPeriod(o.d) && chainPass(o.chain));
    const toMax = ords.filter(o => o.ratio != null && o.ratio >= 0.9 && o.ratio <= 1.1).length;
    const small = ords.filter(o => o.ratio != null && o.ratio < 0.5).length;
    tiles += statTile('V1 orders sized to Max', pct(toMax, ords.length), `${pct(small, ords.length)} top up less than half the gap · ${fmt(ords.length)} orders`, 'clickable', 'data-go="sizing"');
    const prs = m.chains.filter(c => matOk(c.material) && chainPass(c) && inPeriod(c.prD));
    tiles += statTile('PR lines', fmt(prs.length), `${pct(prs.filter(c => c.po).length, prs.length)} became a PO · ${pct(prs.filter(c => c.churn).length, prs.length)} MRP churn · ${pct(prs.filter(c => c.cancelled && !c.po && !c.churn).length, prs.length)} cancelled`, 'clickable', 'data-go="outcomes"');
    const c = card(host, 'Headlines', `Segment: ${fmt(state.matCount)} materials · window: ${esc(periodLabel())}`);
    div(c, 'stats big', tiles);
    c.querySelectorAll('[data-go]').forEach(t => t.addEventListener('click', () => go(t.dataset.go)));

    /* PERF-ANNUAL — annual progression for the segment: per year a PR was
       created, each leg's median end to end (plus the whole window). */
    const c2 = card(host, 'Annual progression · median of each leg',
      'Per year the PR was created: approval → buyer → supplier → 3PL, each leg\'s median laid end to end (“≥” when still-open chains make it a lower bound). Medians don\'t add up to the end-to-end median — they show proportion, and how each leg moved year on year. The spread of every leg is in its own view.');
    C.annualChevrons(div(c2, 'chart'), { rows: annualRowsFor(m.chains.filter(c => matOk(c.material) && chainPass(c) && inPeriod(c.prD))), aria: 'Annual progression for the segment' });

    const c3 = card(host, 'What this dataset can and can\'t show', '');
    div(c3, 'muted-note', `Stock is rebuilt day by day from MB51 back from the Inventory Master snapshot (as of <b>${esc(m.asOfIso)}</b>, ${esc(m.asOfSource)}). Min / Max / SS / MRP type are <b>today's values</b> — earlier changes can't be seen. Manufacturer stands in for vendor. 107 is read as <b>arrival at the 3PL</b> and 109 as <b>received at site</b>. Full list and live checks under <a href="#" data-go2="checks">Data checks &amp; assumptions</a>.`);
    c3.querySelector('[data-go2]').addEventListener('click', (e) => { e.preventDefault(); go('checks'); });
  }

  /* ── trigger → PR response ────────────────────────────────────────────── */
  function viewResponse(host){
    const m = state.model;
    const allK = m.episodes.filter(e => matOk(e.material) && inPeriod(e.T));
    const all = allK.filter(e => e.realLine);
    const notLine = allK.filter(e => !e.realLine);
    const sel = state.cohortSel && state.cohortSel.view === 'response' ? state.cohortSel.month : null;
    const eps = sel ? all.filter(e => E.periodKey(e.T, state.bandGran) === sel) : all;
    const counts = {};
    for (const e of eps) counts[e.response] = (counts[e.response] || 0) + 1;
    div(host, 'view-intro', `<h2>How fast does the system respond when stock drops below its trigger line?</h2><p>A <b>crossing</b> is a day the rebuilt site stock fell below its trigger line — V1 → Min, PD with safety stock → SS. <b>Covered</b> means a PO was open or goods were at the 3PL; a PR on its own is not cover. Response time is measured only when nothing was on order and no PR was open at the crossing.</p>`);
    if (notLine.length) {
      const pd0 = notLine.filter(e => e.lineKind === 'demand'), v0 = notLine.filter(e => e.lineKind === 'none');
      const nb = div(host, 'note-box', `<b>Not counted here:</b> ${fmt(pd0.length)} times a <b>PD part without safety stock</b> ran out, and ${fmt(v0.length)} times a <b>V1 part with Min 0</b> did. For PD without SS, MRP raises a PR for <i>demand</i> (a reservation), not for low stock — and reservations aren't in these files, so the trigger can't be seen. They still count in Exposure &amp; stockouts. <button class="btn-sm" data-nl="pd">List PD</button> <button class="btn-sm" data-nl="v1">List V1 Min 0</button>`);
      nb.querySelector('[data-nl="pd"]').addEventListener('click', () => setDrill({ kind: 'episodes', title: 'PD without SS — at zero stock', items: pd0 }));
      nb.querySelector('[data-nl="v1"]').addEventListener('click', () => setDrill({ kind: 'episodes', title: 'V1 with Min 0 — at zero stock', items: v0 }));
    }
    const c1 = card(host, 'Days from crossing to a PR being raised', (sel ? `<span class="chip">Crossed in ${esc(sel)} <button data-clearsel>✕</button></span> ` : '') + 'Closed = a PR was raised while the part was still below the line; still open = no PR yet, counted at its age.', `<button class="btn-sm" data-tbl>▦ Table</button>`);
    const done = eps.filter(e => e.response === 'PR raised');
    const open = eps.filter(e => e.response === 'no PR yet');
    const dv = done.map(e => e.toPr), ov = open.map(e => m.asOf - e.T);
    const bins = E.BINS_DAYS;
    const cd = new Array(bins.length).fill(0), co = new Array(bins.length).fill(0);
    dv.forEach(v => cd[E.binIndex(bins, v)]++); ov.forEach(v => co[E.binIndex(bins, v)]++);
    const qa = E.quantiles(dv, ov, [0.1, 0.5, 0.9]);
    const target = state.settings.targets.response;
    div(c1, 'stats',
      statTile('Crossings', fmt(eps.length), `${fmt(new Set(eps.map(e => e.material)).size)} materials`) +
      statTile('PR raised', fmt(done.length), 'nothing was on order') +
      statTile('No PR yet', fmt(open.length), 'still below, nothing raised', open.length ? 'warn' : '') +
      statTile('Median', qv(qa[0.5]), '') + statTile('P90', qv(qa[0.9]), '') +
      (target != null ? statTile(`Within ${fmt(target)} d`, pct(dv.filter(v => v <= target).length, dv.length + ov.filter(v => v > target).length), '') : statTile('KPI target', '<span class="muted">not set</span>', '', 'clickable', 'data-settarget="1"')));
    div(c1, null, C.legend([{ label: 'PR raised', color: C.PAL.s1 }, { label: 'No PR yet — at least this long', color: C.PAL.s1, opacity: C.OPEN_OPACITY }]));
    const h = div(c1, 'chart');
    const mk = (q, l) => q ? Object.assign(markerPos(bins, q.v), { label: `${l} ${q.lowerBound ? '≥ ' : ''}${fmt(q.v)} d` }) : { bin: null };
    C.histogram(h, { bins, unit: 'days', series: [{ key: 'done', label: 'PR raised', color: C.PAL.s1, counts: cd }, { key: 'open', label: 'no PR yet (at least)', color: C.PAL.s1, opacity: C.OPEN_OPACITY, counts: co }],
      markers: [mk(qa[0.1], 'P10'), mk(qa[0.5], 'median'), mk(qa[0.9], 'P90')], target: target != null ? Object.assign(markerPos(bins, target), { label: `target ${fmt(target)} d` }) : null,
      xTitle: 'days from stock crossing its trigger line to a PR', aria: 'Trigger to PR distribution',
      onBin: (b) => setDrill({ kind: 'episodes', title: `Trigger → PR · ${bins[b].label} days`, items: done.filter(e => E.binIndex(bins, e.toPr) === b).concat(open.filter(e => E.binIndex(bins, m.asOf - e.T) === b)) }) });
    const tb = div(c1, 'hidden'); tb.innerHTML = binTable(bins, [['PR raised', cd], ['No PR yet', co]]);
    c1.querySelector('[data-tbl]').addEventListener('click', (e) => { tb.classList.toggle('hidden'); e.target.classList.toggle('on'); });
    const cs = c1.querySelector('[data-clearsel]'); if (cs) cs.addEventListener('click', () => { state.cohortSel = null; renderView(); });
    const st = c1.querySelector('[data-settarget]'); if (st) st.addEventListener('click', openSettings);

    /* what happened at each crossing */
    const order = ['PR raised', 'no PR yet', 'already on order', 'PR already open', 'recovered without a PR', 'crossed before the window'];
    const expl = {
      'PR raised': 'nothing on order at the crossing; a PR followed while still below the line',
      'no PR yet': 'still below the line today, nothing on order, no PR',
      'already on order': 'a PO was open (or goods at the 3PL) when stock crossed — the system was ahead',
      'PR already open': 'an earlier PR was still waiting for a PO when stock crossed',
      'recovered without a PR': 'stock came back above the line with no PR — a return, count, transfer or off-PR receipt',
      'crossed before the window': 'already below the line on the first day of MB51 — the crossing date can\'t be known'
    };
    const c2 = card(host, 'What was happening at each crossing', 'Click a row to list those crossings.');
    const t2 = div(c2, 'tblwrap');
    renderTable(t2, { rows: order.map(k => ({ k, n: counts[k] || 0, share: eps.length ? (counts[k] || 0) / eps.length : 0, what: expl[k] })),
      cols: [{ key: 'k', label: 'At the crossing' }, { key: 'n', label: 'Crossings', num: true }, { key: 'share', label: 'Share', num: true, html: true, f: v => `<span class="bar" style="width:${Math.round(v * 120)}px"></span>${Math.round(v * 100)}%` }, { key: 'what', label: 'Meaning', cls: 'wrap' }],
      onRow: (r) => setDrill({ kind: 'episodes', title: 'Crossings · ' + r.k, items: eps.filter(e => e.response === r.k) }), csv: 'crossing-responses' });

    /* per-month */
    const metricLike = { anchor: e => e.T, stage: e => e.response === 'PR raised' ? { v: e.toPr, s: 'done' } : e.response === 'no PR yet' ? { v: m.asOf - e.T, s: 'open' } : { v: null, s: 'na' } };
    const groups = E.cohorts(all.filter(e => !e.leftCensored), metricLike, state.settings.provisionalPct, state.bandGran);
    const c3 = card(host, `${state.bandGran === 'quarter' ? 'Quarter' : 'Month'} on ${state.bandGran} · stock crossed in …`, 'Trigger → PR days of crossings where a PR followed: median, mean, P25–P75 and P10–P90; caret = P90 once crossings with no PR yet are counted. Click a period to focus.', bandGranButtons());
    wireBandGran(c3);
    div(c3, null, bandLegend());
    C.bandChart(div(c3, 'chart'), { groups, target, selected: sel, xTitle: `${state.bandGran} crossed · n with a PR`, aria: 'Trigger to PR by period',
      onClick: (pk) => { state.cohortSel = sel === pk ? null : { view: 'response', month: pk }; state.drill = null; renderView(); } });

    /* breakdown */
    const bk = 'response', dim = state.breakdownDim[bk] || 'mrpType';
    const gmap = new Map();
    for (const e of eps) {
      const g = DIM[dim] && DIM[dim].get ? DIM[dim].get(mInfo(e.material)) : '(all)';
      let x = gmap.get(g); if (!x) gmap.set(g, x = { group: g, n: 0, naked: 0, toPr: [], open: [], exp: 0, so: 0 });
      x.n++; if (!e.leftCensored && !e.coveredAtT && !e.prOpenAtT) x.naked++;
      if (e.toPr != null) x.toPr.push(e.toPr); if (e.response === 'no PR yet') x.open.push(m.asOf - e.T);
      x.exp += e.noCoverNoPr + e.noCoverPr; x.so += e.stockoutDays;
    }
    const rows = [...gmap.values()].map(x => { const q = E.quantiles(x.toPr, x.open, [0.5, 0.9]); return { group: x.group, n: x.n, nakedPct: x.n ? x.naked / x.n : 0, med: q[0.5], p90: q[0.9], exp: x.exp, so: x.so }; });
    const c4 = card(host, 'Breakdown · crossings', 'Click a row to add it to the segment.',
      `<select data-bdim>${BREAK_DIMS.filter(b => b[0] !== 'trigger').map(([k, l]) => `<option value="${k}" ${k === dim ? 'selected' : ''}>by ${l}</option>`).join('')}</select>`);
    c4.querySelector('[data-bdim]').addEventListener('change', (e) => { state.breakdownDim[bk] = e.target.value; renderView(); });
    renderTable(div(c4, 'tblwrap'), { rows, sort: { key: 'n', dir: -1 },
      cols: [{ key: 'group', label: BREAK_DIMS.find(b => b[0] === dim)[1], cls: 'wrap' }, { key: 'n', label: 'Crossings', num: true },
        { key: 'nakedPct', label: 'Nothing on order at crossing', num: true, f: v => Math.round(v * 100) + '%' },
        { key: 'med', label: 'Median → PR', num: true, f: v => qtxt(v), sv: r => r.med ? r.med.v : -1 }, { key: 'p90', label: 'P90 → PR', num: true, f: v => qtxt(v), sv: r => r.p90 ? r.p90.v : -1 },
        { key: 'exp', label: 'Days with nothing on order', num: true }, { key: 'so', label: 'Stocked-out days', num: true }],
      onRow: (r) => segmentOn(dim, r.group), csv: 'crossings-breakdown' });
    drillCard(host);
  }

  /* ── exposure & stockouts ─────────────────────────────────────────────── */
  function viewExposure(host){
    const m = state.model;
    const so = m.stockouts.filter(s => matOk(s.material) && inPeriod(s.T));
    div(host, 'view-intro', `<h2>Where parts sat exposed, and how stockouts started</h2><p>A stockout that began with an order in flight is a <b>late-supply</b> problem. One that began with <b>nothing on order</b> is a trigger problem: MRP didn't run, the Min is too low, or the part isn't planned.</p>`);
    const inF = so.filter(s => s.orderInFlight), none = so.filter(s => !s.orderInFlight);
    const bins = E.BINS_DAYS.slice(1).map(b => b);  // ≥ 1 day
    bins.unshift({ lo: 1, hi: 1, label: '1' }); bins.splice(1, 1, { lo: 2, hi: 2, label: '2' });
    const cA = new Array(bins.length).fill(0), cB = new Array(bins.length).fill(0);
    inF.forEach(s => cA[E.binIndex(bins, s.days)]++); none.forEach(s => cB[E.binIndex(bins, s.days)]++);
    const c1 = card(host, 'Stockout length', 'Days the rebuilt site stock sat at zero, per stockout. Ongoing stockouts are counted at their length so far.', `<button class="btn-sm" data-tbl>▦ Table</button>`);
    const lenAll = so.map(s => s.days).sort((a, b) => a - b);
    div(c1, 'stats',
      statTile('Stockouts', fmt(so.length), `${fmt(new Set(so.map(s => s.material)).size)} materials`, so.length ? 'warn' : '') +
      statTile('Began with an order in flight', fmt(inF.length), pct(inF.length, so.length) + ' — late supply') +
      statTile('Began with nothing on order', fmt(none.length), pct(none.length, so.length) + ' — trigger problem', none.length ? 'warn' : '') +
      statTile('Stocked-out days', fmt(so.reduce((a, s) => a + s.days, 0)), `${fmt(so.reduce((a, s) => a + s.daysUncovered, 0))} with nothing on order`) +
      statTile('Median length', lenAll.length ? fmt(lenAll[Math.floor((lenAll.length - 1) / 2)]) + '<small>d</small>' : '—', '') +
      statTile('Still out today', fmt(so.filter(s => s.ongoing).length), ''));
    div(c1, null, C.legend([{ label: 'Order in flight at start', color: C.PAL.s1 }, { label: 'Nothing on order at start', color: C.PAL.s2 }]));
    C.histogram(div(c1, 'chart'), { bins, unit: 'days', series: [{ key: 'a', label: 'order in flight', color: C.PAL.s1, counts: cA }, { key: 'b', label: 'nothing on order', color: C.PAL.s2, counts: cB }],
      xTitle: 'days at zero stock', aria: 'Stockout length distribution',
      onBin: (b) => setDrill({ kind: 'stockouts', title: `Stockouts · ${bins[b].label} days`, items: so.filter(s => E.binIndex(bins, s.days) === b) }) });
    const tb = div(c1, 'hidden'); tb.innerHTML = binTable(bins, [['Order in flight', cA], ['Nothing on order', cB]]);
    c1.querySelector('[data-tbl]').addEventListener('click', (e) => { tb.classList.toggle('hidden'); e.target.classList.toggle('on'); });

    /* exposure over time — small multiples, same x */
    const series = exposureSeries();
    const c2 = card(host, 'Parts below their trigger line, over time', `Average number of materials per day in each ${state.gran} — each chart its own scale, same time axis. <b>Trigger debt</b> = below the line with nothing on order and no PR. V1 below Min and PD below SS only — PD without SS is demand-driven (see Trigger → PR).`, granButtons());
    wireGran(c2);
    timeBars(div(c2, 'chart'), series.labels, series.debt, C.PAL.s2, 'Trigger debt · nothing on order, no PR', 'materials / day', 150, false);
    timeBars(div(c2, 'chart'), series.labels, series.prOnly, C.PAL.s3, 'PR raised but no PO yet', 'materials / day', 130, false);
    timeBars(div(c2, 'chart'), series.labels, series.covered, C.PAL.s1, 'Below the line but covered (PO open / at 3PL)', 'materials / day', 150, true);
    const c3 = card(host, 'Exposed crossings', 'Every crossing where the part spent days below its line with nothing on order.');
    const exp = m.episodes.filter(e => e.realLine && matOk(e.material) && inPeriod(e.T) && (e.noCoverNoPr + e.noCoverPr) > 0);
    div(c3, 'row', `<button class="btn-sm" data-dr="1">List ${fmt(exp.length)} exposed crossings</button><button class="btn-sm" data-dr="2">List all ${fmt(so.length)} stockouts</button>`);
    c3.querySelector('[data-dr="1"]').addEventListener('click', () => setDrill({ kind: 'episodes', title: 'Exposed crossings', items: exp }));
    c3.querySelector('[data-dr="2"]').addEventListener('click', () => setDrill({ kind: 'stockouts', title: 'All stockouts', items: so }));
    drillCard(host);
  }

  /* per-period aggregation over the model window, restricted to the time window */
  function periodBuckets(){
    const m = state.model;
    let [a, b] = periodBounds();
    a = a == null ? m.window.start : Math.max(a, m.window.start);
    b = b == null ? m.window.end : Math.min(b, m.window.end);
    const keyOf = (d) => {
      if (state.gran === 'day') return iso(d);
      if (state.gran === 'month') return E.ym(d);
      const dt = new Date(d * 86400000); const wd = (dt.getUTCDay() + 6) % 7; return iso(d - wd);   // week starting Monday
    };
    const labels = [], idx = new Map(), days = new Map();
    for (let d = a; d <= b; d++) { const k = keyOf(d); if (!idx.has(k)) { idx.set(k, labels.length); labels.push(k); days.set(k, 0); } days.set(k, days.get(k) + 1); }
    return { a, b, labels, idx, keyOf, days };
  }
  function exposureSeries(){
    const m = state.model, pb = periodBuckets();
    const debt = new Array(pb.labels.length).fill(0), prOnly = debt.slice(), covered = debt.slice();
    /* exact either way: the global per-day arrays when the segment is every
       material, otherwise each episode's per-day runs for the segment. */
    const useGlobal = state.matCount === m.mat.size;
    if (useGlobal) {
      for (let d = pb.a; d <= pb.b; d++) {
        const i = d - m.window.start, j = pb.idx.get(pb.keyOf(d));
        debt[j] += m.daily.belowNoCoverNoPr[i]; prOnly[j] += m.daily.belowNoCoverPr[i]; covered[j] += m.daily.belowCovered[i];
      }
    } else {
      for (const e of m.episodes) {
        if (!e.realLine || !matOk(e.material)) continue;
        for (const r of (e.runs || [])) {
          for (let d = Math.max(r[0], pb.a); d <= Math.min(r[1], pb.b); d++) {
            const j = pb.idx.get(pb.keyOf(d));
            if (r[2] === 0) debt[j]++; else if (r[2] === 1) prOnly[j]++; else if (r[2] === 3) covered[j]++;
          }
        }
      }
    }
    const avg = (arr) => arr.map((v, j) => v / (pb.days.get(pb.labels[j]) || 1));
    return { labels: pb.labels.map(shortLabel), debt: avg(debt), prOnly: avg(prOnly), covered: avg(covered) };
  }
  function shortLabel(k){ return state.gran === 'month' ? k : k.slice(2); }
  function granButtons(){ return ['day', 'week', 'month'].map(g => `<button class="btn-sm ${state.gran === g ? 'on' : ''}" data-gran="${g}">${g[0].toUpperCase() + g.slice(1)}</button>`).join(''); }
  function wireGran(el){ el.querySelectorAll('[data-gran]').forEach(b => b.addEventListener('click', () => { state.gran = b.dataset.gran; saveUi(); renderView(); })); }
  function timeBars(host, labels, values, color, title, unit, height, showX){
    C.timeBars(host, { labels, values, color, title, unit, height, showX, fmtV: (v) => fmt(v, v < 10 ? 1 : 0) });
  }

  /* ── MRP cadence & silent periods ─────────────────────────────────────── */
  function viewCadence(host){
    const m = state.model, pb = periodBuckets();
    const cad = state.cad;
    const inB = (d) => d != null && d >= pb.a && d <= pb.b;
    const chains = m.chains.filter(c => matOk(c.material) && chainPass(c) && inB(cad.measure === 'po' ? (c.po ? c.poD : null) : c.prD));
    /* the MRP run days (for quiet stretches + weekday) always come from MRP-created PRs */
    const mrpDays = new Set(), dow = new Array(7).fill(0);
    for (const c of m.chains) {
      if (!matOk(c.material) || c.trig !== 'MRP' || !inB(c.prD)) continue;
      mrpDays.add(c.prD); dow[(new Date(c.prD * 86400000).getUTCDay() + 6) % 7]++;
    }
    const SPLITS = {
      trigger: { label: 'MRP vs manual', keys: [['MRP', 'MRP-created', C.PAL.s1], ['Manual', 'Manual', C.PAL.s2], ['Other', 'Unknown / other', C.PAL.s3]],
                 of: c => c.trig === 'MRP' ? 'MRP' : c.trig === 'Manual' ? 'Manual' : 'Other' },
      mrp:     { label: 'V1 vs PD', keys: [['V1', 'V1', C.PAL.s1], ['PD', 'PD', C.PAL.s2], ['Other', 'Other / not in Inv. Master', C.PAL.s3]],
                 of: c => { const t = mInfo(c.material).mrpType; return t === 'V1' ? 'V1' : t === 'PD' ? 'PD' : 'Other'; } },
      outcome: cad.measure === 'po'
        ? { label: 'Receipt status', keys: [['site', 'Received at site', C.PAL.s1], ['tpl', 'At the 3PL', C.PAL.s4], ['await', 'Awaiting receipt', C.PAL.s2]],
            of: c => c.g109 != null ? 'site' : c.g107 != null ? 'tpl' : 'await' }
        : { label: 'Outcome', keys: [['po', 'Became a PO', C.PAL.s1], ['open', 'Still open', C.PAL.s2], ['churn', 'MRP churn', C.PAL.s3], ['cancel', 'Cancelled', C.PAL.s4]],
            of: c => c.po ? 'po' : c.churn ? 'churn' : c.cancelled ? 'cancel' : 'open' }
    };
    const sp = SPLITS[cad.split] || SPLITS.trigger;
    const vals = Object.fromEntries(sp.keys.map(k => [k[0], new Array(pb.labels.length).fill(0)]));
    for (const c of chains) { const d = cad.measure === 'po' ? c.poD : c.prD; const j = pb.idx.get(pb.keyOf(d)); vals[sp.of(c)][j]++; }
    const labels = pb.labels.map(shortLabel);
    div(host, 'view-intro', `<h2>PR and PO volumes — where MRP runs, and where it doesn't</h2><p>PRs are counted on the day they were created — with no MRP run log, that date is the evidence of an MRP run. Split by MRP vs manual, V1 vs PD, or outcome, for whatever segment is set above. The <b>trigger debt</b> chart underneath (same time axis) counts materials sitting below their trigger line with nothing on order and no PR: quiet PR days while debt climbs point at MRP not running, or its output not reaching PRs.</p>`);
    const c1 = card(host, `${cad.measure === 'po' ? 'POs raised' : 'PRs created'} per ${state.gran} · by ${sp.label}`, `${fmt(chains.length)} ${cad.measure === 'po' ? 'PO lines' : 'PR lines'} in the segment and window. Click a column to list them.`,
      `<span class="seg-lab">Count</span><button class="btn-sm ${cad.measure === 'pr' ? 'on' : ''}" data-meas="pr">PRs</button><button class="btn-sm ${cad.measure === 'po' ? 'on' : ''}" data-meas="po">POs</button>
       <span class="seg-lab">Split</span>${Object.entries(SPLITS).map(([k, v]) => `<button class="btn-sm ${cad.split === k ? 'on' : ''}" data-split="${k}">${esc(v.label)}</button>`).join('')}
       <span class="seg-lab">By</span>${granButtons()}`);
    wireGran(c1);
    c1.querySelectorAll('[data-meas]').forEach(b => b.addEventListener('click', () => { cad.measure = b.dataset.meas; state.drill = null; renderView(); }));
    c1.querySelectorAll('[data-split]').forEach(b => b.addEventListener('click', () => { cad.split = b.dataset.split; state.drill = null; renderView(); }));
    div(c1, null, C.legend(sp.keys.map(k => ({ label: k[1], color: k[2] }))));
    C.stackedColumns(div(c1, 'chart'), { labels, height: 240, aria: 'Volumes per period',
      series: sp.keys.map(k => ({ key: k[0], label: k[1], color: k[2], values: vals[k[0]] })),
      onClick: (j) => setDrill({ kind: 'chains', metric: 'AB', title: `${cad.measure === 'po' ? 'POs raised' : 'PRs created'} · ${pb.labels[j]}`,
        items: chains.filter(c => pb.idx.get(pb.keyOf(cad.measure === 'po' ? c.poD : c.prD)) === j) }) });
    const series = exposureSeries();
    timeBars(div(c1, 'chart'), labels, series.debt, C.PAL.s3, 'Trigger debt · materials below their line, nothing on order, no PR (avg / day)', 'materials / day', 140, true);

    /* silent gaps between MRP-PR days */
    const daysSorted = [...mrpDays].sort((a, b) => a - b);
    const gaps = [];
    for (let i = 1; i < daysSorted.length; i++) { const g = daysSorted[i] - daysSorted[i - 1] - 1; if (g > 0) gaps.push({ from: daysSorted[i - 1] + 1, to: daysSorted[i] - 1, len: g }); }
    if (daysSorted.length && pb.b > daysSorted[daysSorted.length - 1]) gaps.push({ from: daysSorted[daysSorted.length - 1] + 1, to: pb.b, len: pb.b - daysSorted[daysSorted.length - 1], ongoing: true });
    const gb = [{ lo: 1, hi: 1, label: '1' }, { lo: 2, hi: 2, label: '2' }, { lo: 3, hi: 4, label: '3–4' }, { lo: 5, hi: 7, label: '5–7' }, { lo: 8, hi: 14, label: '8–14' }, { lo: 15, hi: 30, label: '15–30' }, { lo: 31, hi: Infinity, label: '31+' }];
    const cg = new Array(gb.length).fill(0), cgo = cg.slice();
    gaps.forEach(g => (g.ongoing ? cgo : cg)[E.binIndex(gb, g.len)]++);
    /* debt during each gap (exact when no segment, else from runs) */
    const debtByDay = dailyDebt(pb.a, pb.b);
    for (const g of gaps) { let mx = 0, sum = 0; for (let d = g.from; d <= g.to; d++) { const v = debtByDay.get(d) || 0; mx = Math.max(mx, v); sum += v; } g.maxDebt = mx; g.avgDebt = sum / g.len; }
    const c2 = card(host, 'Quiet stretches between MRP-PR days', `Calendar days with no MRP-created PR between two days that had one (weekends show up as 1–2 day gaps). ${fmt(daysSorted.length)} days in the window had at least one MRP PR.`);
    div(c2, null, C.legend([{ label: 'Gap', color: C.PAL.s1 }, { label: 'Ongoing to the end of the window', color: C.PAL.s1, opacity: C.OPEN_OPACITY }]));
    C.histogram(div(c2, 'chart'), { bins: gb, unit: 'days', height: 220, series: [{ key: 'g', label: 'gaps', color: C.PAL.s1, counts: cg }, { key: 'o', label: 'ongoing', color: C.PAL.s1, opacity: C.OPEN_OPACITY, counts: cgo }],
      xTitle: 'days without an MRP-created PR', aria: 'Gap length distribution',
      onBin: (b) => showGapList(gaps.filter(g => E.binIndex(gb, g.len) === b), `Quiet stretches · ${gb[b].label} days`) });
    div(c2, 'row', `<button class="btn-sm" data-glist>List quiet stretches of 5+ days, worst trigger debt first</button>`);
    c2.querySelector('[data-glist]').addEventListener('click', () => showGapList(gaps.filter(g => g.len >= 5), 'Quiet stretches of 5+ days'));

    const c3 = card(host, 'Which weekday MRP PRs are created', 'Reveals the actual run schedule (a weekly run shows one tall bar).');
    C.timeBars(div(c3, 'chart'), { labels: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'], values: dow, color: C.PAL.s1, title: 'MRP-created PR lines by weekday', unit: 'PRs', height: 170 });
    drillCard(host);
  }
  function dailyDebt(a, b){
    const m = state.model, out = new Map();
    if (state.matCount === m.mat.size) { for (let d = a; d <= b; d++) out.set(d, m.daily.belowNoCoverNoPr[d - m.window.start]); return out; }
    for (const e of m.episodes) { if (!e.realLine || !matOk(e.material)) continue; for (const r of (e.runs || [])) if (r[2] === 0) for (let d = Math.max(r[0], a); d <= Math.min(r[1], b); d++) out.set(d, (out.get(d) || 0) + 1); }
    return out;
  }
  function showGapList(gaps, title){
    setDrill({ kind: 'list', title, items: gaps.slice().sort((x, y) => y.maxDebt - x.maxDebt || y.len - x.len).map(g => ({ from: iso(g.from), to: iso(g.to), len: g.len, ongoing: g.ongoing ? 'yes' : '', maxDebt: g.maxDebt, avgDebt: g.avgDebt })),
      cols: [{ key: 'from', label: 'From' }, { key: 'to', label: 'To' }, { key: 'len', label: 'Days', num: true }, { key: 'ongoing', label: 'Ongoing' },
             { key: 'maxDebt', label: 'Max trigger debt', num: true }, { key: 'avgDebt', label: 'Avg trigger debt', num: true, f: v => fmt(v, 1) }] });
  }

  /* ── PR outcomes & cancellations ──────────────────────────────────────── */
  function viewOutcomes(host){
    const m = state.model;
    const prs = m.chains.filter(c => matOk(c.material) && chainPass(c) && inPeriod(c.prD));
    const cat = (c) => c.po ? 'po' : c.churn ? 'churn' : c.cancelled ? 'cancel' : 'open';
    const byMonth = new Map();
    for (const c of prs) { const k = E.ym(c.prD); let g = byMonth.get(k); if (!g) byMonth.set(k, g = { po: 0, open: 0, churn: 0, cancel: 0 }); g[cat(c)]++; }
    const months = [...byMonth.keys()].sort();
    const n = { po: 0, open: 0, churn: 0, cancel: 0 }; prs.forEach(c => n[cat(c)]++);
    div(host, 'view-intro', `<h2>What becomes of the PRs</h2><p><b>MRP churn</b> = an MRP-created PR cancelled within ${state.settings.churnDays} day${state.settings.churnDays === 1 ? '' : 's'} of creation without a PO — usually MRP replacing its own proposal, not a real cancellation. “Changed On” stands in for the cancel date (it is SAP's last-change date).</p>`);
    const c1 = card(host, 'PR lines by outcome, per month created', '');
    div(c1, 'stats',
      statTile('PR lines', fmt(prs.length), '') + statTile('Became a PO', fmt(n.po), pct(n.po, prs.length)) +
      statTile('Still open', fmt(n.open), pct(n.open, prs.length) + ' no PO, not cancelled') +
      statTile('MRP churn', fmt(n.churn), pct(n.churn, prs.length)) + statTile('Cancelled', fmt(n.cancel), pct(n.cancel, prs.length) + ' genuine'));
    div(c1, null, C.legend([{ label: 'Became a PO', color: C.PAL.s1 }, { label: 'Still open', color: C.PAL.s2 }, { label: 'MRP churn', color: C.PAL.s3 }, { label: 'Cancelled', color: C.PAL.s4 }]));
    C.stackedColumns(div(c1, 'chart'), { labels: months.map(x => x.slice(2)), aria: 'PR outcomes by month',
      series: [['po', 'Became a PO', C.PAL.s1], ['open', 'Still open', C.PAL.s2], ['churn', 'MRP churn', C.PAL.s3], ['cancel', 'Cancelled', C.PAL.s4]].map(([k, l, col]) => ({ key: k, label: l, color: col, values: months.map(mo => byMonth.get(mo)[k]) })),
      onClick: (i) => setDrill({ kind: 'chains', metric: 'AB', title: `PR lines created ${months[i]}`, items: prs.filter(c => E.ym(c.prD) === months[i]) }) });

    /* cancel lag */
    const canc = prs.filter(c => c.cancelLag != null);
    const lb = [{ lo: 0, hi: 0, label: 'same day' }, { lo: 1, hi: 1, label: '1' }, { lo: 2, hi: 2, label: '2' }, { lo: 3, hi: 5, label: '3–5' }, { lo: 6, hi: 10, label: '6–10' }, { lo: 11, hi: 30, label: '11–30' }, { lo: 31, hi: 90, label: '31–90' }, { lo: 91, hi: Infinity, label: '90+' }];
    const cm = new Array(lb.length).fill(0), co = cm.slice();
    canc.forEach(c => (c.trig === 'MRP' ? cm : co)[E.binIndex(lb, Math.max(0, c.cancelLag))]++);
    const c2 = card(host, 'How long before cancelled PRs were cancelled', `Days from PR created to its last change, for PRs cancelled without a PO. The line marks the churn window (${state.settings.churnDays} d).`);
    div(c2, null, C.legend([{ label: 'MRP-created', color: C.PAL.s1 }, { label: 'Manual / other', color: C.PAL.s2 }]));
    C.histogram(div(c2, 'chart'), { bins: lb, unit: 'days', height: 220, series: [{ key: 'm', label: 'MRP-created', color: C.PAL.s1, counts: cm }, { key: 'o', label: 'manual / other', color: C.PAL.s2, counts: co }],
      target: Object.assign(markerPos(lb, state.settings.churnDays), { frac: 0.98, label: `churn ≤ ${state.settings.churnDays} d` }),
      xTitle: 'days from PR created to cancelled (Changed On)', aria: 'Cancellation lag',
      onBin: (b) => setDrill({ kind: 'chains', metric: 'AB', title: `Cancelled after ${lb[b].label} days`, items: canc.filter(c => E.binIndex(lb, Math.max(0, c.cancelLag)) === b) }) });

    /* open PR aging */
    const open = prs.filter(c => !c.po && !c.cancelled && c.prD != null);
    const bins = E.BINS_DAYS;
    const ca = new Array(bins.length).fill(0), cr = ca.slice();
    open.forEach(c => ((c.relD != null && !c.releaseBad) ? cr : ca)[E.binIndex(bins, m.asOf - c.prD)]++);
    const c3 = card(host, 'Open PRs today — how long they have waited', `As of ${esc(m.asOfIso)}. Released = approved, waiting for the buyer.`);
    div(c3, null, C.legend([{ label: 'Awaiting release', color: C.PAL.s2 }, { label: 'Released, awaiting PO', color: C.PAL.s1 }]));
    C.histogram(div(c3, 'chart'), { bins, unit: 'days', height: 220, series: [{ key: 'a', label: 'awaiting release', color: C.PAL.s2, counts: ca }, { key: 'r', label: 'released, awaiting PO', color: C.PAL.s1, counts: cr }],
      xTitle: 'days since the PR was created', aria: 'Open PR aging',
      onBin: (b) => setDrill({ kind: 'chains', metric: 'AB', title: `Open PRs · ${bins[b].label} days old`, items: open.filter(c => E.binIndex(bins, m.asOf - c.prD) === b) }) });
    drillCard(host);
  }

  /* ── internal ─────────────────────────────────────────────────────────── */
  function viewInternal(host){
    const tabs = [['AB', 'PR → PO (total)'], ['A', 'Approval'], ['B', 'Buyer']];
    const t = div(host, 'subtabs', tabs.map(([k, l]) => `<button class="btn-sm ${state.sub.internal === k ? 'on' : ''}" data-sub="${k}">${l}</button>`).join(''));
    t.querySelectorAll('[data-sub]').forEach(b => b.addEventListener('click', () => { state.sub.internal = b.dataset.sub; state.cohortSel = null; state.drill = null; renderView(); }));
    metricView(host, state.sub.internal, { breakdown: 'purchasingGroup' });
  }

  /* ── 3PL ──────────────────────────────────────────────────────────────── */
  function viewThreePL(host){
    metricView(host, 'D', { breakdown: 'manufacturer', intro: `<div class="note-box">107 is read as <b>arrival at the 3PL</b> and 109 as <b>received at site</b> (operator, 2026-09-25). A different site-specific reading is recorded in the stock-rebuild module's notes — see Data checks.</div>`,
      after: (h, chains, col) => {
        const c = card(h, 'Sitting at the 3PL now', 'Received at the 3PL, not yet at site — oldest first.');
        div(c, 'row', `<button class="btn-sm">List ${fmt(col.open.length)} items at the 3PL</button>`).querySelector('button')
          .addEventListener('click', () => setDrill({ kind: 'chains', metric: 'D', title: 'At the 3PL, not yet at site', items: col.open }));
      } });
  }

  /* ── against plan & process paths ─────────────────────────────────────── */
  function viewPlan(host){
    const m = state.model;
    const hasNeed = m.chains.some(c => c.needD != null);
    if (!hasNeed) div(host, 'warn-note', 'This dataset has no PR Delivery Date (need-by) — the plan comparison is empty. Re-extract PR History with the “Delivery Date” column (the Intake reads it from this version on).');
    metricView(host, 'PLAN', { breakdown: 'manufacturer', after: (h) => {
      /* planned vs actual lead time */
      const chains = m.chains.filter(c => matOk(c.material) && chainPass(c) && inPeriod(c.prD));
      const bins = E.BINS_DAYS;
      const cp = new Array(bins.length).fill(0), ca = cp.slice();
      chains.forEach(c => { if (c.planLT != null && c.planLT >= 0) cp[E.binIndex(bins, c.planLT)]++; if (c.st.E2E.s === 'done' && c.st.E2E.v >= 0) ca[E.binIndex(bins, c.st.E2E.v)]++; });
      const c1 = card(h, 'Planned vs actual lead time', 'Left: SAP\'s plan (need-by − PR date). Right: actual PR → site, closed chains. Same bins, each its own scale.');
      const g = div(c1, 'twin');
      C.histogram(div(g, 'chart'), { bins, unit: 'days', height: 220, series: [{ key: 'p', label: 'planned', color: C.PAL.s2, counts: cp }], xTitle: 'planned days (need-by − PR date)', aria: 'Planned lead time' });
      C.histogram(div(g, 'chart'), { bins, unit: 'days', height: 220, series: [{ key: 'a', label: 'actual', color: C.PAL.s1, counts: ca }], xTitle: 'actual days (PR → site)', aria: 'Actual lead time' });
      /* process paths */
      const paths = new Map(); chains.forEach(c => paths.set(c.path, (paths.get(c.path) || 0) + 1));
      const noPr = m.noPrReceipts.filter(r => matOk(r.material) && inPeriod(r.g109 != null ? r.g109 : r.g107));
      const rows = [...paths.entries()].map(([k, n]) => ({ path: k, n, share: n / Math.max(1, chains.length) })).sort((a, b) => b.n - a.n);
      rows.push({ path: 'Receipt against a PO with no PR line', n: noPr.length, share: null, special: 'noPr' });
      const c2 = card(h, 'Process paths', 'How each PR line actually travelled. The designed path is PR → PO → 3PL → site. Click a row to list it.');
      renderTable(div(c2, 'tblwrap'), { rows, cols: [{ key: 'path', label: 'Path' }, { key: 'n', label: 'Lines', num: true },
        { key: 'share', label: 'Share of PR lines', num: true, html: true, f: v => v == null ? '<span class="muted">not a PR line</span>' : `<span class="bar" style="width:${Math.round(v * 140)}px"></span>${Math.round(v * 100)}%` }],
        onRow: (r) => r.special === 'noPr'
          ? setDrill({ kind: 'list', title: 'Receipts with no PR line', items: noPr.map(x => ({ material: x.material, desc: mInfo(x.material).description, po: x.po, g107: iso(x.g107), g109: iso(x.g109), qty: x.qty })),
              cols: [{ key: 'material', label: 'Material' }, { key: 'desc', label: 'Description', cls: 'wrap' }, { key: 'po', label: 'PO' }, { key: 'g107', label: 'At 3PL' }, { key: 'g109', label: 'At site' }, { key: 'qty', label: 'Qty', num: true }] })
          : setDrill({ kind: 'chains', metric: 'E2E', title: 'Path · ' + r.path, items: chains.filter(c => c.path === r.path) }), csv: 'process-paths' });
    } });
  }

  /* ── order sizing (V1) ────────────────────────────────────────────────── */
  function viewSizing(host){
    const m = state.model;
    const ords = m.orders.filter(o => matOk(o.material) && inPeriod(o.d) && chainPass(o.chain));
    div(host, 'view-intro', `<h2>Do V1 orders replenish to Max — or limp along?</h2><p>At each converted PR on a V1 part: <b>gap to Max</b> = Max − (stock that morning + qty already on order: open POs and other open PRs). The ordered qty (PR quantity — PO quantities aren't in the data) is compared with that gap. Uses today's Min / Max.</p>`);
    const bins = E.BINS_RATIO;
    const series = [['MRP', C.PAL.s1], ['Manual', C.PAL.s2], ['Other', C.PAL.s3]].map(([k, col]) => ({ key: k, label: k === 'Other' ? 'unknown / other' : k, color: col, counts: new Array(bins.length).fill(0) }));
    const sIdx = (t) => t === 'MRP' ? 0 : t === 'Manual' ? 1 : 2;
    const binOf = (o) => o.ratio == null ? 0 : E.binIndex(bins, o.ratio);
    ords.forEach(o => series[sIdx(o.trig)].counts[binOf(o)]++);
    const toMax = ords.filter(o => o.ratio != null && o.ratio >= 0.9 && o.ratio <= 1.1).length;
    const c1 = card(host, 'Ordered qty as a share of the gap to Max', '', `<button class="btn-sm" data-tbl>▦ Table</button>`);
    div(c1, 'stats',
      statTile('V1 orders', fmt(ords.length), `${fmt(new Set(ords.map(o => o.material)).size)} materials`) +
      statTile('Sized to Max (90–110%)', pct(toMax, ords.length), fmt(toMax)) +
      statTile('Under half the gap', pct(ords.filter(o => o.ratio != null && o.ratio < 0.5).length, ords.length), 'small top-ups') +
      statTile('Over the gap (> 110%)', pct(ords.filter(o => o.ratio != null && o.ratio > 1.1).length, ords.length), 'ordering past Max') +
      statTile('Ordered while at / above Max', fmt(ords.filter(o => o.ratio == null).length), 'no gap at all'));
    div(c1, null, C.legend(series.map(s => ({ label: s.label, color: s.color }))));
    C.histogram(div(c1, 'chart'), { bins, series, xTitle: 'ordered ÷ gap to Max', aria: 'Order-to-Max ratio',
      onBin: (b) => setDrill({ kind: 'orders', title: `V1 orders · ${bins[b].label}`, items: ords.filter(o => binOf(o) === b) }) });
    const tb = div(c1, 'hidden'); tb.innerHTML = binTable(bins, series.map(s => [s.label, s.counts]));
    c1.querySelector('[data-tbl]').addEventListener('click', (e) => { tb.classList.toggle('hidden'); e.target.classList.toggle('on'); });

    /* stock after receipt */
    const rec = m.receipts.filter(r => r.mrpType === 'V1' && r.fill != null && matOk(r.material) && inPeriod(r.d));
    const fb = [{ lo: -Infinity, hi: 0.25, label: '< 25%' }, { lo: 0.25, hi: 0.5, label: '25–50%' }, { lo: 0.5, hi: 0.75, label: '50–75%' }, { lo: 0.75, hi: 0.9, label: '75–90%' }, { lo: 0.9, hi: 1.1, label: 'at Max (90–110%)' }, { lo: 1.1, hi: 1.5, label: '110–150%' }, { lo: 1.5, hi: Infinity, label: '> 150%' }];
    const cf = new Array(fb.length).fill(0); rec.forEach(r => cf[E.binIndex(fb, r.fill)]++);
    const c2 = card(host, 'Stock straight after each site receipt, as a share of Max', 'A healthy V1 part lands near Max after a receipt; one that never gets past half is being topped up, not replenished.');
    C.histogram(div(c2, 'chart'), { bins: fb, height: 220, series: [{ key: 'r', label: 'receipts', color: C.PAL.s1, counts: cf }], xTitle: 'stock after receipt ÷ Max', aria: 'Fill after receipt',
      onBin: (b) => setDrill({ kind: 'receipts', title: `V1 receipts · stock after = ${fb[b].label} of Max`, items: rec.filter(r => E.binIndex(fb, r.fill) === b) }) });

    /* reorder frequency */
    const ro = m.reorder.filter(r => matOk(r.material));
    const rb = [{ lo: 0, hi: 0.5, label: '< 0.5×' }, { lo: 0.5, hi: 0.8, label: '0.5–0.8×' }, { lo: 0.8, hi: 1.25, label: 'as planned (0.8–1.25×)' }, { lo: 1.25, hi: 2, label: '1.25–2×' }, { lo: 2, hi: 4, label: '2–4×' }, { lo: 4, hi: Infinity, label: '> 4×' }];
    const cr = new Array(rb.length).fill(0); const withExp = ro.filter(r => r.ratio != null); withExp.forEach(r => cr[E.binIndex(rb, r.ratio)]++);
    const c3 = card(host, 'Reorder frequency vs plan (per V1 material)', `Actual POs per year ÷ expected (annual consumption ÷ (Max − Min)). Well above 1× = ordering more often than the Min/Max band implies — limping. Whole MB51 window; ${fmt(ro.length - withExp.length)} materials have no consumption or no Max > Min, so no expectation.`);
    C.histogram(div(c3, 'chart'), { bins: rb, height: 220, series: [{ key: 'r', label: 'materials', color: C.PAL.s1, counts: cr }], xTitle: 'actual ÷ expected reorders per year', aria: 'Reorder frequency',
      onBin: (b) => setDrill({ kind: 'reorder', title: `Reorder frequency · ${rb[b].label}`, items: withExp.filter(r => E.binIndex(rb, r.ratio) === b) }) });
    drillCard(host);
  }

  /* ── over / under ─────────────────────────────────────────────────────── */
  function viewOverUnder(host){
    const tabs = [['receipts', 'Receipts vs need'], ['shelf', 'Shelf time']];
    const t = div(host, 'subtabs', tabs.map(([k, l]) => `<button class="btn-sm ${state.sub.overunder === k ? 'on' : ''}" data-sub="${k}">${l}</button>`).join(''));
    t.querySelectorAll('[data-sub]').forEach(b => b.addEventListener('click', () => { state.sub.overunder = b.dataset.sub; state.cohortSel = null; state.drill = null; renderView(); }));
    if (state.sub.overunder === 'shelf') { metricView(host, 'E', { breakdown: 'mrpType' }); return; }
    const m = state.model;
    const rec = m.receipts.filter(r => matOk(r.material) && inPeriod(r.d));
    div(host, 'view-intro', `<h2>Where are we over- and under-ordering?</h2><p><b>Over:</b> receipts that land a V1 part above Max, or arrive when stock is already comfortably above its trigger line. <b>Under:</b> receipts that arrive after the part has already run out (see also Exposure &amp; stockouts).</p>`);
    const lb = [{ lo: -Infinity, hi: 0, label: 'stocked out' }, { lo: 1e-9, hi: 0.9999, label: 'below line' }, { lo: 1, hi: 1.5, label: '1–1.5× line' }, { lo: 1.5001, hi: 2, label: '1.5–2×' }, { lo: 2.0001, hi: Infinity, label: '> 2× line' }];
    const binR = (r) => r.before <= 0.001 ? 0 : (r.beforeVsLine == null ? null : E.binIndex(lb, r.beforeVsLine));
    const sV = new Array(lb.length).fill(0), sP = sV.slice();
    rec.forEach(r => { const b = binR(r); if (b == null) return; (r.mrpType === 'V1' ? sV : sP)[b]++; });
    const noLine = rec.filter(r => binR(r) == null).length;
    const over = rec.filter(r => r.overMax != null && r.overMax > 0);
    const overV = over.reduce((a, r) => a + (r.overMaxValue || 0), 0);
    const c1 = card(host, 'Stock on hand when each site receipt arrived, relative to the trigger line', `Trigger line = Min (V1) or SS (PD). ${fmt(noLine)} receipts on parts with no Min / SS to compare against are left out.`);
    div(c1, 'stats',
      statTile('Site receipts', fmt(rec.length), '') +
      statTile('Arrived after a stockout', fmt(sV[0] + sP[0]), pct(sV[0] + sP[0], rec.length), (sV[0] + sP[0]) ? 'warn' : '') +
      statTile('Arrived with stock > 2× line', fmt(sV[4] + sP[4]), pct(sV[4] + sP[4], rec.length) + ' — ordered early or not needed') +
      statTile('V1 receipts landing above Max', fmt(over.length), money(overV) + ' over Max at unit cost', over.length ? 'warn' : ''));
    div(c1, null, C.legend([{ label: 'V1', color: C.PAL.s1 }, { label: 'PD (with SS)', color: C.PAL.s2 }]));
    C.histogram(div(c1, 'chart'), { bins: lb, series: [{ key: 'v', label: 'V1', color: C.PAL.s1, counts: sV }, { key: 'p', label: 'PD', color: C.PAL.s2, counts: sP }], xTitle: 'stock before the receipt ÷ trigger line', aria: 'Stock at receipt',
      onBin: (b) => setDrill({ kind: 'receipts', title: `Receipts · stock before = ${lb[b].label}`, items: rec.filter(r => binR(r) === b) }) });
    const c2 = card(host, 'Receipts that pushed a V1 part above Max', 'Value = qty above Max × moving average price.');
    div(c2, 'row', `<button class="btn-sm">List ${fmt(over.length)} receipts, largest $ first</button>`).querySelector('button')
      .addEventListener('click', () => setDrill({ kind: 'receipts', title: 'V1 receipts above Max', items: over }));
    drillCard(host);
  }

  /* ── data checks ──────────────────────────────────────────────────────── */
  function viewChecks(host){
    const m = state.model;
    div(host, 'view-intro', `<h2>Data checks &amp; assumptions</h2><p>Everything the numbers rest on, and every place the data looks wrong. Impossible values are listed here — never smoothed out of the charts.</p>`);
    const c0 = card(host, 'Assumptions this version makes', '');
    div(c0, 'assume', `<ul>
      <li><b>107 = goods arrived at the 3PL; 109 = received at site.</b> First date per PO + material (same rule as Trace). <span class="amber">Note:</span> the stock-rebuild module (borrowed from Tune) records a different site reading from 2026-05-16 — “101 = at 3PL, 107 = shipped from 3PL toward site”. In these files 101 appears only on stock-transfer POs (with 641). If 107 really is the dispatch from the 3PL, the “3PL” leg is transit only and 3PL dwell sits inside the supplier leg.</li>
      <li><b>Stock rebuild</b> walks MB51 back from the Inventory Master stock (as of ${esc(m.asOfIso)}, ${esc(m.asOfSource)}) with the same movement-type signs as Tune. Site stock only — 101/107/641 don't count.</li>
      <li><b>Min / Max / SS / MRP type are today's values.</b> Changes during the window can't be seen.</li>
      <li><b>Trigger line:</b> V1 → Min · PD with safety stock → SS. <b>PD without SS</b> is demand-driven — MRP raises a PR for a reservation, which these files don't carry — so its stockouts are counted but it is left out of the trigger-response and trigger-debt measures; same for <b>V1 with Min 0</b> (no reorder point). Other MRP types are not assessed.</li>
      <li><b>Cover</b> = a PO open (PO date → site receipt covering the PR quantity) or goods at the 3PL. A PR alone is not cover. POs open more than ${fmt(m.settings.stalePoDays)} days with no receipt count as <i>stale</i>, not cover.</li>
      <li><b>Cancelled</b> = deletion flag + processing status N. <b>MRP churn</b> = MRP-created, no PO, cancelled within ${m.settings.churnDays} d (Changed On as the cancel date).</li>
      <li><b>Creation indicator:</b> B = MRP · R = manual · blank = unknown (not assumed MRP).</li>
      <li><b>Manufacturer stands in for vendor.</b> Order quantity = PR quantity (no PO data).</li>
      <li><b>Months are provisional</b> until ${Math.round(m.settings.provisionalPct * 100)}% of their items have closed; open items are counted at their age as lower bounds (“≥”).</li>
    </ul>`);

    const c1 = card(host, 'Engine parity with Tune\'s own modules', 'Recomputes a sample with Trace\'s chain engine and Tune\'s stock back-calc and compares every value.', `<button class="btn-sm" id="btnParity">Run parity check</button>`);
    const pr = div(c1, 'muted-note', 'Not run yet.');
    c1.querySelector('#btnParity').addEventListener('click', () => {
      pr.textContent = 'Running…';
      setTimeout(() => {
        const r = E.parityCheck(state.json, m, 200);
        pr.innerHTML = `Chains: <b>${fmt(r.chains.checked - r.chains.mismatched)} / ${fmt(r.chains.checked)}</b> identical to Trace · Stock series: <b>${fmt(r.stock.checked - r.stock.mismatched)} / ${fmt(r.stock.checked)}</b> identical day-by-day to the back-calc.` +
          (r.chains.examples.length || r.stock.examples.length ? `<br><span class="amber">Mismatches:</span> ${esc(JSON.stringify(r.chains.examples.concat(r.stock.examples)))}` : '');
      }, 30);
    });

    const oosRows = Object.values(E.METRICS).filter(M => !M.signed).map(M => { const col = E.collect(m.chains.filter(c => matOk(c.material)), M); return { k: M.key, label: M.label, oos: col.oos.length, bad: col.bad, nocov: col.nocov, items: col.oos }; });
    const c2 = card(host, 'Impossible or missing dates', 'Out of sequence = the end of a leg is dated before its start. Click to list.');
    renderTable(div(c2, 'tblwrap'), { rows: oosRows, cols: [{ key: 'label', label: 'Leg' }, { key: 'oos', label: 'Out of sequence', num: true }, { key: 'bad', label: 'Bad / missing date', num: true }, { key: 'nocov', label: 'Before MB51 coverage', num: true }],
      onRow: (r) => setDrill({ kind: 'chains', metric: r.k, title: `${r.label} · out of sequence`, items: r.items }), csv: 'date-checks' });

    const paths = [...m.receiptPaths.entries()].sort((a, b) => b[1] - a[1]);
    const c3 = card(host, 'How POs were received (MB51)', 'Per PO + material with any 101 / 107 / 109 / 641 movement.');
    renderTable(div(c3, 'tblwrap'), { rows: paths.map(([p, n]) => ({ p, n })), cols: [{ key: 'p', label: 'Receipt path' }, { key: 'n', label: 'PO + material', num: true }], csv: 'receipt-paths' });

    const lists = [
      ['Rebuilt stock goes negative', m.checks.negativeStock.filter(x => matOk(x.material)).map(x => ({ material: x.material, desc: mInfo(x.material).description, v: x.minSoh })), 'Lowest rebuilt stock', 'The history can\'t be right as given: movements are missing from MB51, a movement type is signed wrong for this site, or the Inventory Master snapshot date doesn\'t match the MB51 cut-off.'],
      ['Open POs with no receipt for over ' + m.settings.stalePoDays + ' days', m.checks.stalePos.filter(x => matOk(x.material)).map(x => ({ material: x.material, desc: mInfo(x.material).description, v: x.age, po: x.po })), 'Days open', 'Treated as stale (not cover) from day ' + m.settings.stalePoDays + '. They may be closed in SAP without a receipt.'],
      ['Receipts against a PO with no PR line', m.noPrReceipts.filter(x => matOk(x.material)).map(x => ({ material: x.material, desc: mInfo(x.material).description, v: x.qty, po: x.po })), 'Qty', 'Buying outside the PR process, or PR History not covering the same period.'],
      ['Materials not in the Inventory Master', m.checks.noIm.filter(matOk).map(x => ({ material: x, desc: mInfo(x).description, v: null })), '', 'No stock rebuild, Min/Max or manufacturer for these.'],
      ['Materials with several Inventory Master rows', m.checks.imMulti.filter(matOk).map(x => ({ material: x, desc: mInfo(x).description, v: null })), '', 'Multi-plant rows — the first row is used.']
    ];
    for (const [title, rows, vlab, note] of lists) {
      const c = card(host, `${title} · ${fmt(rows.length)}`, esc(note));
      if (!rows.length) continue;
      div(c, 'row', `<button class="btn-sm">List them</button>`).querySelector('button').addEventListener('click', () => setDrill({ kind: 'list', title, items: rows,
        cols: [{ key: 'material', label: 'Material' }, { key: 'desc', label: 'Description', cls: 'wrap' }].concat(rows[0].po !== undefined ? [{ key: 'po', label: 'PO' }] : []).concat(vlab ? [{ key: 'v', label: vlab, num: true, f: v => fmt(v, 1) }] : []) }));
    }
    drillCard(host);
  }

  /* ─── PERF-BANDS helpers ──────────────────────────────────────────────── */
  function bandGranButtons(){ return ['month', 'quarter'].map(g => `<button class="btn-sm ${state.bandGran === g ? 'on' : ''}" data-bgran="${g}">${g[0].toUpperCase() + g.slice(1)}</button>`).join(''); }
  function wireBandGran(el){ el.querySelectorAll('[data-bgran]').forEach(b => b.addEventListener('click', () => { state.bandGran = b.dataset.bgran; state.cohortSel = null; state.drill = null; renderView(); })); }
  function bandLegend(){
    return C.legend([{ label: 'Median', color: C.PAL.pri, line: true }, { label: 'Mean (average)', color: C.PAL.s2, line: true },
      { label: 'P25 – P75', color: C.PAL.s1, opacity: .5 }, { label: 'P10 – P90', color: C.PAL.s1, opacity: .22 }, { label: 'Hollow dot = provisional', color: C.PAL.pri, opacity: .35 }]);
  }
  /* PERF-ANNUAL — per-year leg medians (open items as lower bounds) */
  const ANNUAL_LEGS = [['A', C.PAL.s1], ['B', C.PAL.s2], ['C', C.PAL.s3], ['D', C.PAL.s4]];
  function annualRowsFor(chains){
    const years = [...new Set(chains.map(x => x.prD != null ? iso(x.prD).slice(0, 4) : null).filter(Boolean))].sort();
    const row = (label, cs) => ({ label, n: cs.length, legs: ANNUAL_LEGS.map(([k, color]) => {
      const M = E.METRICS[k], done = [], open = [];
      for (const c of cs) { const x = M.stage(c); if (x.s === 'done' && x.v >= 0) done.push(x.v); else if (x.s === 'open') open.push(x.v); }
      const q = E.quantiles(done, open, [0.5])[0.5];
      return { label: M.label, v: q ? q.v : null, lb: q ? q.lowerBound : false, color, n: done.length };
    }) });
    const out = years.map(y => row(y, chains.filter(c => c.prD != null && iso(c.prD).startsWith(y))));
    if (years.length > 1) out.push(row('All years', chains));
    return out;
  }

  /* ═════════════════════════════════════════════════════════════════════════
     PERF-MULTI — Materials in the segment: the parameters side by side
  ═════════════════════════════════════════════════════════════════════════ */
  function viewMaterials(host){
    const m = state.model;
    div(host, 'view-intro', `<h2>Materials in the segment — the parameters side by side</h2><p>One row per material in the segment and window: PR volumes (MRP vs manual, churn), leg medians, trigger crossings and exposure, stockouts, and whether V1 orders reach Max. Sort any column; click a row to open that material's deep-dive — Prev / Next then steps through this list in the order shown.</p>`);
    const per = new Map();
    const get = (mat) => {
      let r = per.get(mat);
      if (!r) { const i = mInfo(mat); r = { material: mat, desc: i.description, mfr: i.manufacturer, mrp: i.mrpType, min: i.min, max: i.max, ss: i.ss, soh: i.soh, map: i.map, consYr: i.consPerYr,
        pr: 0, mrpPr: 0, manPr: 0, churn: 0, canc: 0, po: 0, _AB: [], _C: [], _D: [], _E2E: [], cross: 0, naked: 0, _toPr: [], exp: 0, so: 0, soDays: 0, ord: 0, _ratio: [], toMax: 0, small: 0,
        reorder: null, neg: i.minSoh != null && i.minSoh < -0.001 ? 'yes' : '', oos: 0 }; per.set(mat, r); }
      return r;
    };
    for (const mat of state.matPass) get(mat);
    for (const c of m.chains) {
      if (!matOk(c.material) || !chainPass(c)) continue;
      if (inPeriod(c.prD)) { const r = get(c.material); r.pr++; if (c.trig === 'MRP') r.mrpPr++; else if (c.trig === 'Manual') r.manPr++; if (c.churn) r.churn++; else if (c.cancelled && !c.po) r.canc++; if (c.po) r.po++; }
      for (const k of ['AB', 'C', 'D', 'E2E']) {
        const M = E.METRICS[k]; if (!inPeriod(M.anchor(c))) continue;
        const x = M.stage(c); if (x.s === 'done' && x.v >= 0) get(c.material)['_' + k].push(x.v); else if (x.s === 'oos' || (x.s === 'done' && x.v < 0)) get(c.material).oos++;
      }
    }
    for (const e of m.episodes) {
      if (!e.realLine || !matOk(e.material) || !inPeriod(e.T)) continue;
      const r = get(e.material);
      if (!e.leftCensored) { r.cross++; if (!e.coveredAtT && !e.prOpenAtT) r.naked++; }
      if (e.toPr != null) r._toPr.push(e.toPr);
      r.exp += e.noCoverNoPr + e.noCoverPr;
    }
    for (const x of m.stockouts) { if (!matOk(x.material) || !inPeriod(x.T)) continue; const r = get(x.material); r.so++; r.soDays += x.days; }
    for (const o of m.orders) {
      if (!matOk(o.material) || !inPeriod(o.d) || !chainPass(o.chain)) continue;
      const r = get(o.material); r.ord++;
      if (o.ratio != null) { r._ratio.push(o.ratio); if (o.ratio >= 0.9 && o.ratio <= 1.1) r.toMax++; if (o.ratio < 0.5) r.small++; }
    }
    for (const x of m.reorder) if (per.has(x.material)) per.get(x.material).reorder = x.ratio;
    const med = (a) => { if (!a.length) return null; const t = a.slice().sort((x, y) => x - y); return t[Math.floor((t.length - 1) / 2)]; };
    const rows = [...per.values()].map(r => Object.assign(r, { mAB: med(r._AB), mC: med(r._C), mD: med(r._D), mE2E: med(r._E2E), mToPr: med(r._toPr), mRatio: med(r._ratio),
      toMaxPct: r.ord ? r.toMax / r.ord : null, churnPct: r.pr ? r.churn / r.pr : null, manPct: r.pr ? r.manPr / r.pr : null }));
    const pctF = (v) => v == null ? '—' : Math.round(v * 100) + '%';
    const c = card(host, `${fmt(rows.length)} materials`, `Window: ${esc(periodLabel())}. Leg medians are of closed chains anchored on each leg's start; “exposed” = days below the trigger line with nothing on order.`);
    renderTable(div(c, 'tblwrap tall'), {
      rows, sort: { key: 'exp', dir: -1 }, limit: 600, csv: 'materials',
      cols: [
        { key: 'material', label: 'Material' }, { key: 'desc', label: 'Description', cls: 'wrap' }, { key: 'mfr', label: 'Manufacturer' }, { key: 'mrp', label: 'MRP' },
        { key: 'min', label: 'Min', num: true }, { key: 'max', label: 'Max', num: true }, { key: 'ss', label: 'SS', num: true }, { key: 'soh', label: 'Stock', num: true },
        { key: 'map', label: 'Unit $', num: true, f: v => money(v) }, { key: 'consYr', label: 'Used / yr', num: true, f: v => fmt(v, 1) },
        { key: 'pr', label: 'PRs', num: true }, { key: 'mrpPr', label: 'MRP', num: true }, { key: 'manPr', label: 'Manual', num: true }, { key: 'manPct', label: 'Manual %', num: true, f: pctF },
        { key: 'churnPct', label: 'Churn %', num: true, f: pctF }, { key: 'canc', label: 'Cancelled', num: true }, { key: 'po', label: 'POs', num: true },
        { key: 'mAB', label: 'PR→PO (d)', num: true }, { key: 'mC', label: 'Supplier (d)', num: true }, { key: 'mD', label: '3PL (d)', num: true }, { key: 'mE2E', label: 'PR→site (d)', num: true },
        { key: 'cross', label: 'Crossings', num: true }, { key: 'naked', label: 'Nothing on order at crossing', num: true }, { key: 'mToPr', label: 'Trigger→PR (d)', num: true },
        { key: 'exp', label: 'Exposed (d)', num: true }, { key: 'so', label: 'Stockouts', num: true }, { key: 'soDays', label: 'Stocked-out (d)', num: true },
        { key: 'ord', label: 'V1 orders', num: true }, { key: 'toMaxPct', label: 'To Max %', num: true, f: pctF }, { key: 'mRatio', label: 'Ordered ÷ gap', num: true, f: pctF },
        { key: 'reorder', label: 'Reorders vs plan', num: true, f: v => v == null ? '—' : fmt(v, 2) + '×' },
        { key: 'oos', label: 'Out of seq.', num: true }, { key: 'neg', label: 'Negative stock' }
      ],
      onRow: (r, sorted) => U.openMaterial(r.material, sorted.map(x => x.material), 'Materials in the segment'),
      footNote: 'Click a row to open its deep-dive.'
    });
  }

  /* ═════════════════════════════════════════════════════════════════════════
     PERF-MULTI — MRP activity by material (heat map: materials × weeks)
  ═════════════════════════════════════════════════════════════════════════ */
  function viewHeat(host){
    const m = state.model;
    let [a, b] = periodBounds();
    a = a == null ? m.window.start : Math.max(a, m.window.start);
    b = b == null ? m.window.end : Math.min(b, m.window.end);
    const wk0 = a - ((new Date(a * 86400000).getUTCDay() + 6) % 7);
    const nW = Math.floor((b - wk0) / 7) + 1;
    const wIdx = (d) => Math.floor((d - wk0) / 7);
    const per = new Map();
    const get = (mat) => { let x = per.get(mat); if (!x) per.set(mat, x = { material: mat, exp: new Uint8Array(nW), mrp: new Uint16Array(nW), man: new Uint16Array(nW), expTot: 0, mrpN: 0, manN: 0 }); return x; };
    for (const e of m.episodes) {
      if (!e.realLine || !matOk(e.material)) continue;
      for (const r of (e.runs || [])) {
        if (r[2] !== 0 && r[2] !== 1) continue;
        for (let d = Math.max(r[0], a); d <= Math.min(r[1], b); d++) { const x = get(e.material); x.exp[wIdx(d)]++; x.expTot++; }
      }
    }
    for (const c of m.chains) {
      if (!matOk(c.material) || c.prD == null || c.prD < a || c.prD > b || !chainPass(c)) continue;
      const x = get(c.material);
      if (c.trig === 'MRP') { x.mrp[wIdx(c.prD)]++; x.mrpN++; } else { x.man[wIdx(c.prD)]++; x.manN++; }
    }
    const sorts = { exposure: ['Most days with nothing on order', x => -x.expTot], mrp: ['Most MRP PRs', x => -x.mrpN], manual: ['Most manual PRs', x => -x.manN], material: ['Material number', null] };
    const hs = state.heat;
    let rows = [...per.values()];
    if (hs.sort === 'material') rows.sort((p, q) => p.material.localeCompare(q.material)); else rows.sort((p, q) => sorts[hs.sort][1](p) - sorts[hs.sort][1](q) || p.material.localeCompare(q.material));
    const total = rows.length;
    rows = rows.slice(0, hs.rows);
    div(host, 'view-intro', `<h2>MRP activity by material</h2><p>Each row a material, each column a week. <b>Amber</b> = days that week the part sat below its trigger line with nothing on order (darker = more days). <b>Cyan dot</b> = an MRP-created PR that week, <b>violet diamond</b> = a manual PR. An MRP gap shows as an amber run with no dots; manual diamonds on amber show people covering for MRP. Click a row to open its deep-dive.</p>`);
    const c = card(host, `${fmt(rows.length)} of ${fmt(total)} active materials · ${fmt(nW)} weeks`, `Window: ${esc(iso(a))} → ${esc(iso(b))}. Only materials with a PR or an exposed day in the window are listed.`,
      `<span class="seg-lab">Sort</span><select data-hsort>${Object.entries(sorts).map(([k, v]) => `<option value="${k}" ${hs.sort === k ? 'selected' : ''}>${esc(v[0])}</option>`).join('')}</select>
       <span class="seg-lab">Rows</span>${[40, 80, 150].map(n => `<button class="btn-sm ${hs.rows === n ? 'on' : ''}" data-hrows="${n}">${n}</button>`).join('')}`);
    c.querySelector('[data-hsort]').addEventListener('change', (e) => { hs.sort = e.target.value; renderView(); });
    c.querySelectorAll('[data-hrows]').forEach(bt => bt.addEventListener('click', () => { hs.rows = +bt.dataset.hrows; renderView(); }));
    div(c, null, C.legend([{ label: 'Below the line, nothing on order (days / week)', color: '#FBBF24', opacity: .75 }, { label: 'MRP-created PR', color: C.PAL.s1 }, { label: 'Manual PR', color: C.PAL.s2 }]));
    const hostEl = div(c, 'chart heatwrap');
    if (!rows.length) { hostEl.innerHTML = '<div class="pc-empty">No PR or exposed day in this segment and window.</div>'; return; }
    const W = Math.max(640, hostEl.clientWidth || 1100), padL = 250, padR = 12, padT = 26, rh = 14;
    const cw = (W - padL - padR) / nW;
    const H = padT + rows.length * rh + 8;
    let g = '';
    for (let w = 0; w < nW; w++) {
      const d0 = wk0 + w * 7; const dt = new Date(d0 * 86400000);
      if (dt.getUTCDate() <= 7) { const xx = padL + w * cw; g += `<line x1="${xx}" x2="${xx}" y1="${padT - 6}" y2="${H - 8}" stroke="${C.PAL.grid}"/><text x="${xx + 2}" y="${padT - 10}" class="pc-ax">${esc(iso(d0).slice(2, 7))}</text>`; }
    }
    rows.forEach((r, k) => {
      const y = padT + k * rh;
      const info = mInfo(r.material);
      const lab = (r.material + '  ' + (info.description || '')).slice(0, 38);
      g += `<text x="6" y="${y + rh - 4}" class="pc-ax" style="font-size:10.5px;fill:var(--text-sec)" data-row="${k}">${esc(lab)}</text>`;
      for (let w = 0; w < nW; w++) {
        const x0 = padL + w * cw, e = r.exp[w];
        g += `<rect x="${x0 + 0.5}" y="${y + 1}" width="${Math.max(1, cw - 1)}" height="${rh - 2}" fill="${e ? '#FBBF24' : 'rgba(155,171,168,0.05)'}" fill-opacity="${e ? (0.18 + 0.8 * Math.min(7, e) / 7).toFixed(2) : 1}" data-cell="${k}:${w}"/>`;
        if (r.mrp[w]) g += `<circle cx="${x0 + cw * 0.33}" cy="${y + rh / 2}" r="${Math.min(3.2, cw / 3)}" fill="${C.PAL.s1}" stroke="${C.PAL.surface}" stroke-width=".8" pointer-events="none"/>`;
        if (r.man[w]) { const cx = x0 + cw * 0.7, cy = y + rh / 2, s2 = Math.min(3.4, cw / 3); g += `<path d="M${cx},${cy - s2}L${cx + s2},${cy}L${cx},${cy + s2}L${cx - s2},${cy}Z" fill="${C.PAL.s2}" stroke="${C.PAL.surface}" stroke-width=".8" pointer-events="none"/>`; }
      }
    });
    hostEl.innerHTML = `<svg class="pc-svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-label="MRP activity by material and week">${g}</svg>`;
    const svg = hostEl.querySelector('svg');
    const list = rows.map(r => r.material);
    svg.addEventListener('pointermove', (ev) => {
      const el = ev.target.closest('[data-cell]');
      if (!el) { C.hideTip(); return; }
      const [k, w] = el.dataset.cell.split(':').map(Number); const r = rows[k]; const d0 = wk0 + w * 7;
      C.showTip(ev, [{ value: String(r.exp[w]), label: 'days below the line, nothing on order', color: '#FBBF24' }, { value: String(r.mrp[w]), label: 'MRP-created PRs', color: C.PAL.s1 }, { value: String(r.man[w]), label: 'manual PRs', color: C.PAL.s2 }],
        `${r.material} · week of ${iso(d0)}`);
    });
    svg.addEventListener('pointerleave', C.hideTip);
    svg.addEventListener('click', (ev) => {
      const el = ev.target.closest('[data-cell],[data-row]'); if (!el) return;
      const k = el.dataset.row != null ? +el.dataset.row : +el.dataset.cell.split(':')[0];
      U.openMaterial(rows[k].material, list, 'MRP activity by material');
    });
  }

  /* ═════════════════════════════════════════════════════════════════════════
     SETTINGS & KPI TARGETS
  ═════════════════════════════════════════════════════════════════════════ */
  const TARGET_KEYS = [['response', 'Trigger → PR'], ['AB', 'PR → PO (internal)'], ['A', 'PR approval'], ['B', 'Buyer'], ['C', 'Supplier (PO → 3PL)'], ['D', '3PL (3PL → site)'], ['E2E', 'End to end'], ['PLAN', 'Days late vs need-by'], ['E', 'Shelf time']];
  function setupSettingsModal(){
    $$('#setModal [data-close]').forEach(b => b.addEventListener('click', closeSettings));
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !$('#setModal').classList.contains('hidden')) closeSettings(); });
    $('#setSave').addEventListener('click', saveSettings);
    $('#setReset').addEventListener('click', () => { fillSettings(Object.assign({}, E.DEFAULT_SETTINGS, { targets: {} })); });
  }
  function fillSettings(s){
    $('#setBody').innerHTML = `
      <h4>Engine</h4>
      <div class="set-grid">
        <label>MRP churn window <span>cancelled MRP PR within N days of creation, no PO</span><input type="number" min="0" max="30" id="sChurn" value="${s.churnDays}"/></label>
        <label>Provisional until % closed <span>a month's distribution is dimmed until this share has closed</span><input type="number" min="50" max="100" id="sProv" value="${Math.round(s.provisionalPct * 100)}"/></label>
        <label>Stale PO after (days) <span>open PO with no receipt stops counting as cover</span><input type="number" min="30" max="3650" id="sStale" value="${s.stalePoDays}"/></label>
      </div>
      <h4>KPI targets <small>days — leave blank until the baseline is clear</small></h4>
      <div class="set-grid">${TARGET_KEYS.map(([k, l]) => `<label>${esc(l)}<input type="number" data-target="${k}" value="${s.targets[k] != null ? s.targets[k] : ''}" placeholder="not set"/></label>`).join('')}</div>
      <div class="muted-note">Saved in this browser only (this app's own storage). Engine changes rebuild the model; targets only redraw.</div>`;
  }
  function openSettings(){ fillSettings(state.settings); $('#setModal').classList.remove('hidden'); }
  function closeSettings(){ $('#setModal').classList.add('hidden'); }
  async function saveSettings(){
    const s = {
      churnDays: Math.max(0, +$('#sChurn').value || 0),
      provisionalPct: Math.min(1, Math.max(0.5, (+$('#sProv').value || 90) / 100)),
      stalePoDays: Math.max(30, +$('#sStale').value || 365),
      targets: {}
    };
    $$('#setBody [data-target]').forEach(i => { if (i.value !== '') s.targets[i.dataset.target] = +i.value; });
    const rebuild = s.churnDays !== state.settings.churnDays || s.stalePoDays !== state.settings.stalePoDays;
    state.settings = s;
    try { await AppStorage.set('settings.perf', s); } catch (e) {}
    closeSettings();
    if (rebuild && state.json) await loadDataset(state.json); else renderView();
    toast('Settings applied', 'ok');
  }

  function toast(msg, kind){
    const el = document.createElement('div');
    el.className = 'toast ' + (kind || '');
    el.textContent = msg;
    document.body.appendChild(el);
    setTimeout(() => el.remove(), 4200);
  }
})();
