/* ═══════════════════════════════════════════════════════════════════════════
   material/material.js · Calibre Mirror v0.2.0-dev · PERF-DEEPDIVE
   ───────────────────────────────────────────────────────────────────────────
   One material's MRP mechanics, as a TAILORABLE STACK of blocks. The engine
   runs for this material only (PerfEngine.build opts.only) against the WHOLE
   dataset's window and "as of" date, so every figure is the one the Workbench
   counted.

   Blocks (switch on/off, drag to reorder — saved as this viewer's default):
     time-axis  stock · cadence · events · consumption · chains
                → consecutive time blocks draw in ONE SVG on ONE day scale, so
                  the MRP cadence sits exactly under the stock graph and you
                  can see stock cross Min and the system respond.
     other      annual progression · month-on-month band · consolidated
                durations · trigger crossings · order to Max / receipts · raw
═══════════════════════════════════════════════════════════════════════════ */
(function () {
  'use strict';
  const $ = (s, r) => (r || document).querySelector(s);
  const $$ = (s, r) => Array.from((r || document).querySelectorAll(s));
  const E = window.PerfEngine, C = window.PerfCharts, U = window.PerfUI;
  const esc = U.esc, fmt = U.fmt, money = U.money, iso = E.iso;
  const PAL = C.PAL;
  const CONS_ISSUE = new Set(['261', '201', '221', '291', '551']);
  const CONS_REV   = new Set(['262', '202', '222', '292', '552']);
  const trim = (v) => v == null ? '' : String(v).trim();

  /* ─── block catalogue ─────────────────────────────────────────────────── */
  const BLOCKS = [
    { id: 'stock',       label: 'Stock vs Min / Max',           time: true,  hint: 'the Trend graph — rebuilt stock, stock + on order, Min / Max / SS, stockout and exposure shading' },
    { id: 'cadence',     label: 'MRP cadence',                  time: true,  hint: 'PRs raised per day / week, by outcome' },
    { id: 'events',      label: 'PR · PO · receipt events',     time: true,  hint: 'every PR (▲ MRP ◆ manual), PO, 3PL arrival and site receipt on its day' },
    { id: 'consumption', label: 'Consumption',                  time: true,  hint: 'issues per day / week' },
    { id: 'chains',      label: 'Procurement chains',           time: true,  hint: 'each PR line as bars: approval → buyer → supplier → 3PL' },
    { id: 'annual',      label: 'Annual progression',           time: false, hint: 'per year, the median of each leg end to end' },
    { id: 'bands',       label: 'Month-on-month band',          time: false, hint: 'median, mean and P10–P90 of a leg per month / quarter' },
    { id: 'durations',   label: 'Consolidated durations',       time: false, hint: 'every chain as a dot on each leg' },
    { id: 'crossings',   label: 'Trigger crossings',            time: false, hint: 'each time stock went below its line and what happened' },
    { id: 'sizing',      label: 'Order to Max / receipts',      time: false, hint: 'V1 order-to-Max at each order; stock before / after receipts' },
    { id: 'raw',         label: 'Raw data',                     time: false, hint: 'PR lines · MB51 ledger · receipts by PO' }
  ];
  const BLK = Object.fromEntries(BLOCKS.map(b => [b.id, b]));
  const PRESETS = {
    'Mechanics':  ['stock', 'cadence', 'events', 'chains', 'crossings', 'sizing'],
    'Graphs':     ['stock', 'cadence', 'consumption', 'annual', 'bands'],
    'Everything': BLOCKS.map(b => b.id)
  };
  const DEFAULT_LAYOUT = BLOCKS.map(b => ({ id: b.id, on: b.id !== 'consumption' }));

  const st = {
    json: null, settings: null, model: null, mat: null, info: null, ser: null,
    chains: [], mbRows: [], range: { preset: 'all', a: null, b: null },
    selChain: null, rawTab: 'pr', descBy: null,
    layout: DEFAULT_LAYOUT.map(x => ({ ...x })), bandLeg: 'E2E', bandGran: 'quarter', sizeTab: null
  };

  document.addEventListener('DOMContentLoaded', boot);
  window.addEventListener('hashchange', () => { const m = matFromHash(); if (m && m !== st.mat) loadMaterial(m); });
  let rz; window.addEventListener('resize', () => { clearTimeout(rz); rz = setTimeout(() => st.model && st.info && renderBlocks(), 160); });

  function matFromHash(){ const m = /[#&]mat=([^&]+)/.exec(location.hash || ''); return m ? decodeURIComponent(m[1]) : null; }

  async function boot(){
    try { const s = await AppStorage.get('settings.perf'); st.settings = Object.assign({}, E.DEFAULT_SETTINGS, s || {}); } catch (e) { st.settings = Object.assign({}, E.DEFAULT_SETTINGS); }
    try { const l = await AppStorage.get('settings.perf.mdLayout'); if (Array.isArray(l) && l.length) st.layout = mergeLayout(l); } catch (e) {}
    st.json = await AppStorage.get('intake.current');
    if (!st.json) { showEmpty(`No dataset loaded in this app yet. Build one on the <a href="../intake/intake.html">Intake</a> page or open a saved <code>.json</code> from the <a href="../index.html">Dashboard</a>.`); return; }
    buildFinder();
    const m = matFromHash() || ((U.navList() || {}).materials || [])[0];
    if (!m) { showEmpty('Pick a material with the box above — or click any material in a Workbench drill table.'); return; }
    await loadMaterial(m);
  }
  function mergeLayout(saved){
    const out = saved.filter(x => BLK[x.id]).map(x => ({ id: x.id, on: !!x.on }));
    for (const b of BLOCKS) if (!out.some(x => x.id === b.id)) out.push({ id: b.id, on: false });
    return out;
  }
  async function saveLayout(){ try { await AppStorage.set('settings.perf.mdLayout', st.layout); } catch (e) {} }

  function showEmpty(html){
    const e = $('#mdEmpty'); e.innerHTML = `<div class="card-t">Material deep-dive</div><p class="card-s" style="margin-top:8px">${html}</p>`;
    e.classList.remove('hidden'); $('#mdBody').classList.add('hidden');
  }

  function buildFinder(){
    const d = new Map();
    for (const r of (st.json.data.inventoryMaster || [])) { const m = trim(r.material); if (m && !d.has(m)) d.set(m, trim(r.description)); }
    const mats = new Set();
    for (const r of (st.json.data.mb51 || [])) { const m = trim(r.material); if (m) { mats.add(m); if (!d.has(m) && r.description) d.set(m, trim(r.description)); } }
    for (const r of (st.json.data.prHistory || [])) { const m = trim(r.material); if (m) { mats.add(m); if (!d.has(m) && r.shortText) d.set(m, trim(r.shortText)); } }
    st.descBy = d;
    const list = [...mats].sort();
    $('#mdMatList').innerHTML = list.slice(0, 20000).map(m => `<option value="${esc(m)}">${esc(d.get(m) || '')}</option>`).join('');
    const inp = $('#mdFind');
    const go = () => {
      const v = inp.value.trim(); if (!v) return;
      let m = mats.has(v) ? v : null;
      if (!m) { const low = v.toLowerCase(); m = list.find(x => (d.get(x) || '').toLowerCase().includes(low)) || null; }
      if (!m) { U.toast(`No material matches “${v}”`, 'warn'); return; }
      inp.value = '';
      location.hash = 'mat=' + encodeURIComponent(m);
    };
    inp.addEventListener('change', go);
    inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') go(); });
  }

  async function loadMaterial(m){
    st.mat = m; st.selChain = null; st.range = { preset: 'all', a: null, b: null }; st.sizeTab = null;
    $('#mdEmpty').classList.add('hidden');
    const prog = $('#mdProgress'); prog.classList.remove('hidden');
    try {
      st.model = await E.build(st.json, st.settings, (p, msg) => { $('#mdProgBar').style.width = Math.round(p * 100) + '%'; $('#mdProgMsg').textContent = msg; },
        { only: new Set([m]), keepSeries: true });
    } catch (err) { prog.classList.add('hidden'); showEmpty('Could not build this material: ' + esc(err.message)); return; }
    prog.classList.add('hidden');
    st.info = st.model.mat.get(m);
    renderNav();
    if (!st.info) { showEmpty(`Material <b>${esc(m)}</b> has no MB51 movement or PR line in this dataset.`); return; }
    st.ser = st.model.series.get(m) || null;
    st.chains = st.model.chains.filter(c => c.material === m).sort((a, b) => (a.prD ?? 1e9) - (b.prD ?? 1e9));
    st.mbRows = (st.json.data.mb51 || []).filter(r => trim(r.material) === m);
    document.title = `Calibre Mirror · ${m}`;
    $('#mdBody').classList.remove('hidden');
    renderBanner(); renderLayoutBar(); renderBlocks();
  }

  /* ─── navigation (Prev / Next through the drill list) ─────────────────── */
  function renderNav(){
    const nav = U.navList();
    const host = $('#mdList');
    if (!nav || !nav.materials || !nav.materials.includes(st.mat)) { host.innerHTML = ''; return; }
    const i = nav.materials.indexOf(st.mat), n = nav.materials.length;
    host.innerHTML = `<button class="btn-sm" id="mdPrev" ${i === 0 ? 'disabled' : ''}>‹ Prev</button>
      <span><b>${i + 1}</b> of ${fmt(n)} · ${esc(nav.title || '')}</span>
      <button class="btn-sm" id="mdNext" ${i === n - 1 ? 'disabled' : ''}>Next ›</button>`;
    $('#mdPrev').addEventListener('click', () => { location.hash = 'mat=' + encodeURIComponent(nav.materials[i - 1]); });
    $('#mdNext').addEventListener('click', () => { location.hash = 'mat=' + encodeURIComponent(nav.materials[i + 1]); });
  }

  /* ─── banner ──────────────────────────────────────────────────────────── */
  function renderBanner(){
    const i = st.info, m = st.model;
    const byTrig = { MRP: 0, Manual: 0, Unknown: 0, Other: 0 }; st.chains.forEach(c => byTrig[c.trig]++);
    const e2e = st.chains.filter(c => c.st.E2E.s === 'done').map(c => c.st.E2E.v);
    const q = E.doneQuantiles(e2e, [0.5, 0.9]);
    const flags = [];
    if (!i.hasIm) flags.push(['crit', 'Not in the Inventory Master — no stock rebuild, Min / Max or manufacturer']);
    if (i.minSoh != null && i.minSoh < -0.001) flags.push(['warn', `Rebuilt stock goes negative (lowest ${fmt(i.minSoh, 1)}) — movements missing from MB51, a site-specific sign, or a snapshot-date mismatch`]);
    const oos = st.chains.filter(c => ['AB', 'C', 'D', 'E2E'].some(k => c.st[k].s === 'oos')).length;
    if (oos) flags.push(['warn', `${oos} chain${oos === 1 ? '' : 's'} with dates out of sequence`]);
    const stale = m.checks.stalePos.filter(x => x.material === st.mat).length;
    if (stale) flags.push(['warn', `${stale} PO${stale === 1 ? '' : 's'} open over ${m.settings.stalePoDays} days with no receipt`]);
    if (st.ser && st.ser.lineKind === 'demand') flags.push(['info', 'PD without safety stock — MRP acts on reservations (not in these files), so zero stock alone is not a trigger']);
    if (st.ser && st.ser.lineKind === 'none') flags.push(['info', 'V1 with Min 0 — no reorder point']);
    const kv = (l, v) => `<div class="kv"><span>${esc(l)}</span><b>${v}</b></div>`;
    $('#mdBanner').innerHTML = `
      <div class="md-id">
        <div class="md-mat">${esc(st.mat)}</div>
        <div class="md-desc">${esc(i.description || '—')}</div>
        <div class="md-sub">${esc(i.manufacturer)} · ${esc(i.materialGroup)} · purchasing group ${esc(i.purchasingGroup)}</div>
      </div>
      <div class="md-kvs">
        ${kv('MRP type', `<span class="mrp-pill">${esc(i.mrpType)}</span>`)}
        ${kv('Min · Max · SS', `${fmt(i.min, 1)} · ${fmt(i.max, 1)} · ${fmt(i.ss, 1)}`)}
        ${kv('Trigger line', esc(st.ser ? st.ser.lineLabel || '—' : '—'))}
        ${kv('Stock today', `${fmt(i.soh, 1)} <small>as of ${esc(m.asOfIso)}</small>`)}
        ${kv('Unit cost', money(i.map))}
        ${kv('Stock value', money(i.stockValue))}
        ${kv('Consumed / yr', fmt(i.consPerYr, 1) + ` <small>${fmt(i.consEvents)} issues</small>`)}
        ${kv('PR lines', `${fmt(st.chains.length)} <small>MRP ${byTrig.MRP} · manual ${byTrig.Manual}${byTrig.Unknown ? ' · unknown ' + byTrig.Unknown : ''}</small>`)}
        ${kv('PR → site', q[0.5] == null ? '—' : `${fmt(q[0.5])} d <small>median · P90 ${fmt(q[0.9])} d</small>`)}
      </div>
      ${flags.length ? `<div class="md-flags">${flags.map(([k, t]) => `<span class="flag ${k}">${esc(t)}</span>`).join('')}</div>` : ''}`;
  }

  /* ─── layout bar: tailor the stack ────────────────────────────────────── */
  function renderLayoutBar(){
    const host = $('#mdLayoutBar');
    host.innerHTML = `<span class="seg-lab">View</span>
      <span class="lchips">${st.layout.map(x => `<span class="lchip ${x.on ? 'on' : ''} ${BLK[x.id].time ? 'time' : ''}" draggable="true" data-id="${x.id}" title="${esc(BLK[x.id].hint)} — drag to reorder">
        <input type="checkbox" ${x.on ? 'checked' : ''} aria-label="Show ${esc(BLK[x.id].label)}"/> ${esc(BLK[x.id].label)}</span>`).join('')}</span>
      <span class="lpresets">${Object.keys(PRESETS).map(p => `<button class="btn-sm ghost" data-preset="${esc(p)}">${esc(p)}</button>`).join('')}</span>
      <span class="lnote">Time-axis blocks (cyan edge) that sit next to each other share one time scale. Drag to reorder — saved as your default.</span>`;
    host.querySelectorAll('.lchip input').forEach(cb => cb.addEventListener('change', () => {
      const id = cb.closest('.lchip').dataset.id; const x = st.layout.find(y => y.id === id); x.on = cb.checked;
      saveLayout(); renderLayoutBar(); renderBlocks();
    }));
    let drag = null;
    host.querySelectorAll('.lchip').forEach(ch => {
      ch.addEventListener('dragstart', (e) => { drag = ch.dataset.id; e.dataTransfer.effectAllowed = 'move'; ch.classList.add('dragging'); });
      ch.addEventListener('dragend', () => ch.classList.remove('dragging'));
      ch.addEventListener('dragover', (e) => { e.preventDefault(); ch.classList.add('over'); });
      ch.addEventListener('dragleave', () => ch.classList.remove('over'));
      ch.addEventListener('drop', (e) => {
        e.preventDefault(); ch.classList.remove('over');
        if (!drag || drag === ch.dataset.id) return;
        const from = st.layout.findIndex(x => x.id === drag); const item = st.layout.splice(from, 1)[0];
        const to = st.layout.findIndex(x => x.id === ch.dataset.id); st.layout.splice(to, 0, item);
        saveLayout(); renderLayoutBar(); renderBlocks();
      });
    });
    host.querySelectorAll('[data-preset]').forEach(b => b.addEventListener('click', () => {
      const ids = PRESETS[b.dataset.preset];
      st.layout = ids.map(id => ({ id, on: true })).concat(BLOCKS.filter(x => !ids.includes(x.id)).map(x => ({ id: x.id, on: false })));
      saveLayout(); renderLayoutBar(); renderBlocks();
    }));
  }

  /* ─── render the stack ────────────────────────────────────────────────── */
  /* PERF-NO-SHIFT (operator 2026-09-25): no click on this page moves the rest
     of the page. The stack re-draws in place with the scroll position kept;
     chain details open in a panel docked over the page; tables that change
     with a tab keep one height; the time-axis card's zoom state is a
     fixed-height status line. */
  function renderBlocks(){
    const host = $('#mdBlocks');
    U.keepScroll(host, () => drawBlocks(host));
    renderChainSel();
  }
  function drawBlocks(host){
    host.innerHTML = '';
    C.hideTip();
    const on = st.layout.filter(x => x.on).map(x => x.id);
    let timeGroup = [];
    let firstTimeCard = true;
    const flushTime = () => {
      if (!timeGroup.length) return;
      renderTimeGroup(host, timeGroup, firstTimeCard);
      firstTimeCard = false;
      timeGroup = [];
    };
    for (const id of on) {
      if (BLK[id].time) { timeGroup.push(id); continue; }
      flushTime();
      ({ annual: renderAnnual, bands: renderBands, durations: renderDurations, crossings: renderTriggers, sizing: renderSizing, raw: renderRaw })[id](host);
    }
    flushTime();
    if (!on.length) host.innerHTML = '<div class="card"><div class="pc-empty">Every block is switched off — tick some in the View bar above.</div></div>';
  }
  function card(host, id){ const c = document.createElement('section'); c.className = 'card'; if (id) c.id = id; host.appendChild(c); return c; }

  /* ═════════════════════════════════════════════════════════════════════════
     TIME-AXIS GROUP — one SVG, one day scale
  ═════════════════════════════════════════════════════════════════════════ */
  const LEG = [
    { k: 'A', label: 'Approval (PR → release)', from: c => c.prD,  to: c => c.relD, col: PAL.s1 },
    { k: 'B', label: 'Buyer (release → PO)',    from: c => c.relD, to: c => c.poD,  col: PAL.s2 },
    { k: 'C', label: 'Supplier (PO → 3PL)',     from: c => c.poD,  to: c => c.g107, col: PAL.s3 },
    { k: 'D', label: '3PL (3PL → site)',        from: c => c.g107, to: c => c.g109, col: PAL.s4 }
  ];
  const OUTCOME = (c) => c.po ? 'po' : c.churn ? 'churn' : c.cancelled ? 'cancel' : 'open';
  const OUT_COL = { po: PAL.s1, open: PAL.s2, churn: '#8C97A8', cancel: PAL.s3 };
  const OUT_LAB = { po: 'became a PO', open: 'still open', churn: 'MRP churn', cancel: 'cancelled' };

  function rangeIdx(){
    const N = st.model.window.days;
    if (st.range.preset === 'zoom') return [Math.max(0, st.range.a), Math.min(N - 1, st.range.b)];
    const back = { '12m': 365, '6m': 183, '3m': 92 }[st.range.preset];
    return back ? [Math.max(0, N - back), N - 1] : [0, N - 1];
  }
  function zoomTo(dayA, dayB){
    const W0 = st.model.window.start;
    st.range = { preset: 'zoom', a: Math.max(0, dayA - W0), b: Math.min(st.model.window.days - 1, dayB - W0) };
    renderBlocks();
    const tc = $('#mdTimelineCard'); if (tc) tc.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  function renderTimeGroup(host, ids, first){
    const c = card(host, first ? 'mdTimelineCard' : null);
    const presets = [['all', 'Whole window'], ['12m', '12 m'], ['6m', '6 m'], ['3m', '3 m']];
    c.innerHTML = `<div class="card-h"><div><div class="card-t">${esc(ids.map(i => BLK[i].label).join(' · '))}</div>
      <div class="card-s">One time axis — hover anywhere for that day. ${ids.includes('stock') ? 'Min / Max / SS are today\'s values. ▼ marks each crossing below the trigger line.' : ''}</div></div>
      <div class="card-actions">${presets.map(([k, l]) => `<button class="btn-sm ${st.range.preset === k ? 'on' : ''}" data-r="${k}">${l}</button>`).join('')}</div></div>
      <div class="card-cap">${rangeCap()}</div>
      <div class="md-legend"></div><div class="md-timeline"></div>`;
    c.querySelectorAll('[data-r]').forEach(b => b.addEventListener('click', () => { st.range = { preset: b.dataset.r, a: null, b: null }; renderBlocks(); }));
    drawTimeline(c, ids);
  }
  function rangeCap(){
    const W0 = st.model.window.start, [a, b] = rangeIdx();
    const span = `${esc(iso(W0 + a))} → ${esc(iso(W0 + b))}`;
    if (st.range.preset === 'zoom') return `Zoomed to <b>${span}</b> <button data-r="all">✕ Show the whole window</button>`;
    const lab = { all: 'the whole window', '12m': 'the last 12 months', '6m': 'the last 6 months', '3m': 'the last 3 months' }[st.range.preset] || '';
    return `Showing <b>${lab}</b> · ${span} <span class="muted">· a row in Trigger crossings or Order to Max zooms onto that date</span>`;
  }

  function drawTimeline(cardEl, ids){
    const host = cardEl.querySelector('.md-timeline');
    const m = st.model, W0 = m.window.start, asOf = m.asOf;
    const [a, b] = rangeIdx();
    const span = b - a + 1;
    const Wd = Math.max(640, host.clientWidth || cardEl.clientWidth - 36 || 1100);
    const padL = 92, padR = 16, pw = Wd - padL - padR;
    const x = (i) => padL + ((i - a) / span) * pw;
    const xd = (d) => x(d - W0);
    const dayW = pw / span;
    const ser = st.ser, info = st.info;
    const bucket = span > 150 ? 7 : 1;
    const bKey = (i) => a + Math.floor((i - a) / bucket) * bucket;
    const inR = (d) => d != null && d >= W0 + a && d <= W0 + b;

    /* per-day data */
    const cons = new Map(), r107 = new Map(), r109 = new Map();
    for (const r of st.mbRows) {
      const mt = trim(r.movementType); const d = E.dn(r.postingDate); if (d == null) continue;
      const q = Math.abs(+r.quantity || 0);
      if (mt === '107') r107.set(d, (r107.get(d) || 0) + q);
      if (mt === '109') r109.set(d, (r109.get(d) || 0) + q);
      const i = d - W0; if (i < a || i > b) continue;
      if (CONS_ISSUE.has(mt)) cons.set(bKey(i), (cons.get(bKey(i)) || 0) + q);
      else if (CONS_REV.has(mt)) cons.set(bKey(i), (cons.get(bKey(i)) || 0) - q);
    }
    const cad = new Map();   // bucket → {po, open, churn, cancel, manual}
    for (const c of st.chains) {
      if (!inR(c.prD)) continue;
      const k = bKey(c.prD - W0); let e = cad.get(k); if (!e) cad.set(k, e = { po: 0, open: 0, churn: 0, cancel: 0, manual: 0, mrp: 0 });
      e[OUTCOME(c)]++; if (c.trig === 'Manual') e.manual++; else if (c.trig === 'MRP') e.mrp++;
    }
    const chainsVis = st.chains.filter(c => {
      const s0 = c.prD, e0 = c.g109 != null ? c.g109 : (c.cancelled && !c.po ? (c.chgD ?? c.prD) : asOf);
      return s0 != null && e0 >= W0 + a && s0 <= W0 + b;
    });

    /* layout, in the operator's order */
    let y = 10; const P = {};
    /* PERF-NO-SHIFT — the chains block is sized for ALL of this material's PR
       lines, so switching range or zooming never changes the card's height
       (fewer lines in range = taller rows with PR labels, then empty space) */
    const nAll = st.chains.length, rowHAll = nAll > 60 ? 6 : 12;
    const chainsH = Math.max(12, nAll * rowHAll);
    const rowH = chainsVis.length * 12 <= chainsH ? 12 : rowHAll;
    const hOf = { stock: 230, cadence: 92, events: 60, consumption: 60, chains: chainsH + 14 };
    for (const id of ids) { P[id] = { y, h: hOf[id] }; y += hOf[id] + (id === 'events' ? 12 : 22); }
    P.axis = { y: y - 8, h: 26 }; const H = y + 22;
    let g = '';
    const top = 10, bottom = P.axis.y;

    /* month gridlines + labels */
    for (let i = a; i <= b; i++) {
      const dt = new Date((W0 + i) * 86400000);
      if (dt.getUTCDate() !== 1) continue;
      const xx = x(i);
      g += `<line x1="${xx}" x2="${xx}" y1="${top}" y2="${bottom}" stroke="${PAL.grid}" stroke-width="1"/>`;
      g += `<text x="${xx + 3}" y="${bottom + 14}" class="pc-ax">${esc(span <= 120 ? iso(W0 + i).slice(5) : iso(W0 + i).slice(2, 7))}</text>`;
    }
    if (span <= 62) for (let i = a; i <= b; i++) { const dt = new Date((W0 + i) * 86400000); if (dt.getUTCDay() === 1 && dt.getUTCDate() !== 1) g += `<text x="${x(i) + 2}" y="${bottom + 14}" class="pc-ax" style="opacity:.6">${dt.getUTCDate()}</text>`; }

    const legendItems = [];
    /* ── stock ── */
    if (P.stock) {
      const p = P.stock;
      let smax = 0, smin = 0;
      if (ser) for (let i = a; i <= b; i++) { const v = ser.soh[i] + ser.poQty[i]; if (v > smax) smax = v; if (ser.soh[i] < smin) smin = ser.soh[i]; }
      [info.min, info.max, info.ss].forEach(v => { if (v != null && v > smax) smax = v; });
      smax = niceMax(Math.max(1, smax * 1.05));
      const sy = (v) => p.y + p.h - ((v - smin) / (smax - smin)) * p.h;
      g += `<text x="10" y="${p.y + 12}" class="pc-sub">Stock on hand</text>`;
      for (const t of niceTicks(smin, smax)) {
        g += `<line x1="${padL}" x2="${Wd - padR}" y1="${sy(t)}" y2="${sy(t)}" stroke="${t === 0 ? PAL.axis : PAL.grid}" stroke-width="1"/>`;
        g += `<text x="${padL - 6}" y="${sy(t) + 4}" text-anchor="end" class="pc-ax">${fmt(t)}</text>`;
      }
      if (ser) {
        const real = ser.lineKind === 'min' || ser.lineKind === 'ss';
        const below = (v) => ser.cmp === 'lt' ? v < ser.line : v <= 0.001;
        let runStart = null, runKind = null;
        const flush = (iEnd) => {
          if (runStart == null) return;
          g += `<rect x="${x(runStart)}" y="${p.y}" width="${x(iEnd + 1) - x(runStart)}" height="${p.h}" fill="${runKind === 'out' ? 'rgba(239,68,68,0.16)' : 'rgba(251,191,36,0.13)'}"/>`;
          runStart = null; runKind = null;
        };
        for (let i = a; i <= b; i++) {
          const v = ser.soh[i];
          const kind = v <= 0.001 ? 'out' : (real && below(v) && ser.poFresh[i] === 0 ? 'exp' : null);
          if (kind !== runKind) { flush(i - 1); if (kind) { runStart = i; runKind = kind; } }
        }
        flush(b);
        const hl = (v, lab, dash) => { if (v == null || !(v > 0)) return; g += `<line x1="${padL}" x2="${Wd - padR}" y1="${sy(v)}" y2="${sy(v)}" stroke="${PAL.pri}" stroke-opacity=".55" stroke-width="1" stroke-dasharray="${dash}"/><text x="${Wd - padR - 4}" y="${sy(v) - 4}" text-anchor="end" class="pc-mk">${esc(lab)} ${fmt(v, 1)}</text>`; };
        if (info.mrpType === 'V1') { hl(info.min, 'Min', '5 4'); hl(info.max, 'Max', '2 3'); }
        if (info.ss) hl(info.ss, 'SS', '1 3');
        const step = (arr, add) => { let d = ''; for (let i = a; i <= b; i++) { const v = arr[i] + (add ? add[i] : 0); d += (i === a ? `M${x(i)},${sy(v)}` : `V${sy(v)}`) + `H${x(i + 1)}`; } return d; };
        g += `<path d="${step(ser.soh, ser.poQty)}" fill="none" stroke="${PAL.s2}" stroke-width="1.5" stroke-opacity=".85"/>`;
        g += `<path d="${step(ser.soh)}" fill="none" stroke="${PAL.s1}" stroke-width="2"/>`;
        /* crossing markers */
        for (const e of st.model.episodes) {
          if (e.material !== st.mat || !e.realLine || e.leftCensored || !inR(e.T)) continue;
          const cx = xd(e.T) + dayW / 2, cy = sy(ser.line);
          g += `<path d="M${cx - 5},${cy - 9}L${cx + 5},${cy - 9}L${cx},${cy - 1}Z" fill="${PAL.oos}" stroke="${PAL.surface}" stroke-width="1"/>`;
        }
      } else g += `<text x="${padL + 10}" y="${p.y + 40}" class="pc-mk">No stock rebuild — this material has no Inventory Master stock.</text>`;
      legendItems.push({ label: 'Stock on hand', color: PAL.s1, line: true }, { label: 'Stock + on order (open POs)', color: PAL.s2, line: true },
        { label: 'Stocked out', color: 'rgba(239,68,68,0.45)' }, { label: 'Below the line, nothing on order', color: 'rgba(251,191,36,0.45)' }, { label: '▼ crossed below the line', color: PAL.oos });
    }

    /* ── cadence ── */
    if (P.cadence) {
      const p = P.cadence;
      let cm = 1; for (const e of cad.values()) cm = Math.max(cm, e.po + e.open + e.churn + e.cancel);
      cm = niceMax(cm);
      const cy = (v) => p.y + p.h - (v / cm) * p.h;
      g += `<text x="10" y="${p.y + 12}" class="pc-sub">PRs / ${bucket === 7 ? 'wk' : 'day'}</text>`;
      g += `<line x1="${padL}" x2="${Wd - padR}" y1="${p.y + p.h}" y2="${p.y + p.h}" stroke="${PAL.axis}"/>`;
      g += `<text x="${padL - 6}" y="${p.y + 8}" text-anchor="end" class="pc-ax">${fmt(cm)}</text>`;
      const bw = Math.max(1.5, dayW * bucket - (dayW * bucket > 4 ? 1.5 : 0));
      for (const [k, e] of cad) {
        let base = 0;
        for (const key of ['po', 'open', 'churn', 'cancel']) {
          const v = e[key]; if (!v) continue;
          const y0 = cy(base), y1 = cy(base + v), gap = base > 0 ? 1.5 : 0;
          g += `<rect x="${x(k)}" y="${y1}" width="${bw}" height="${Math.max(0.5, y0 - y1 - gap)}" fill="${OUT_COL[key]}"/>`;
          base += v;
        }
        if (e.manual) g += `<path d="M${x(k) + bw / 2},${cy(base) - 9}l4,4l-4,4l-4,-4Z" fill="${PAL.pri}" fill-opacity=".8"/>`;
      }
      legendItems.push({ label: 'PR became a PO', color: OUT_COL.po }, { label: 'PR still open', color: OUT_COL.open }, { label: 'MRP churn', color: OUT_COL.churn }, { label: 'cancelled', color: OUT_COL.cancel }, { label: '◆ period includes a manual PR', color: PAL.pri });
    }

    /* ── events ── */
    if (P.events) {
      const p = P.events, rh = p.h / 3;
      const rows = [['PRs', 0], ['POs', 1], ['Receipts', 2]];
      for (const [t, k] of rows) {
        const yy = p.y + k * rh;
        g += `<text x="10" y="${yy + rh / 2 + 4}" class="pc-sub">${t}</text><line x1="${padL}" x2="${Wd - padR}" y1="${yy + rh / 2}" y2="${yy + rh / 2}" stroke="${PAL.grid}"/>`;
      }
      const cyP = p.y + rh / 2, cyO = p.y + rh * 1.5, cyR = p.y + rh * 2.5;
      for (const c of st.chains) {
        if (!inR(c.prD)) continue;
        const cx = xd(c.prD) + dayW / 2, col = OUT_COL[OUTCOME(c)];
        if (c.trig === 'MRP') g += `<path d="M${cx - 5},${cyP + 4}L${cx},${cyP - 5}L${cx + 5},${cyP + 4}Z" fill="${col}" stroke="${PAL.surface}" stroke-width="1"/>`;
        else if (c.trig === 'Manual') g += `<path d="M${cx},${cyP - 5}L${cx + 5},${cyP}L${cx},${cyP + 5}L${cx - 5},${cyP}Z" fill="${col}" stroke="${PAL.surface}" stroke-width="1"/>`;
        else g += `<circle cx="${cx}" cy="${cyP}" r="4" fill="${col}" stroke="${PAL.surface}" stroke-width="1"/>`;
      }
      for (const c of st.chains) if (c.po && inR(c.poD)) g += `<circle cx="${xd(c.poD) + dayW / 2}" cy="${cyO}" r="4" fill="${PAL.s2}" stroke="${PAL.surface}" stroke-width="1"/>`;
      for (const [d] of r107) if (inR(d)) g += `<rect x="${xd(d) + dayW / 2 - 4}" y="${cyR - 4}" width="8" height="8" fill="none" stroke="${PAL.s3}" stroke-width="1.6"/>`;
      for (const [d] of r109) if (inR(d)) g += `<rect x="${xd(d) + dayW / 2 - 4}" y="${cyR - 4}" width="8" height="8" fill="${PAL.s4}"/>`;
      legendItems.push({ label: 'PR ▲ MRP · ◆ manual (colour = outcome)', color: OUT_COL.po }, { label: 'PO raised', color: PAL.s2 }, { label: '□ at 3PL (107) · ■ at site (109)', color: PAL.s4 });
    }

    /* ── consumption ── */
    if (P.consumption) {
      const p = P.consumption;
      let cmax = 1; for (const v of cons.values()) cmax = Math.max(cmax, v);
      cmax = niceMax(cmax);
      const cy = (v) => p.y + p.h - (Math.max(0, v) / cmax) * p.h;
      g += `<text x="10" y="${p.y + 12}" class="pc-sub">Used / ${bucket === 7 ? 'wk' : 'day'}</text>`;
      g += `<line x1="${padL}" x2="${Wd - padR}" y1="${p.y + p.h}" y2="${p.y + p.h}" stroke="${PAL.axis}"/>`;
      g += `<text x="${padL - 6}" y="${p.y + 8}" text-anchor="end" class="pc-ax">${fmt(cmax)}</text>`;
      for (const [k, v] of cons) { if (v <= 0) continue; const bw = Math.max(1, dayW * bucket - (dayW * bucket > 4 ? 1.5 : 0)); g += `<rect x="${x(k)}" y="${cy(v)}" width="${bw}" height="${p.y + p.h - cy(v)}" fill="${PAL.s1}" fill-opacity=".7"/>`; }
      legendItems.push({ label: 'Consumed', color: PAL.s1, opacity: .7 });
    }

    /* ── chains ── */
    if (P.chains) {
      const p = P.chains;
      g += `<text x="10" y="${p.y + 10}" class="pc-sub">Chains</text>`;
      const clampX = (v) => Math.max(padL, Math.min(Wd - padR, v));
      chainsVis.forEach((c, k) => {
        const yy = p.y + k * rowH;
        if (st.selChain === c) g += `<rect x="${padL}" y="${yy - 1}" width="${pw}" height="${rowH}" fill="rgba(240,244,243,0.08)"/>`;
        if (rowH >= 10) g += `<text x="${padL - 6}" y="${yy + rowH - 3}" text-anchor="end" class="pc-ax" style="font-size:9.5px">${esc(c.pr)}</text>`;
        const bh = rowH - 3;
        if (!c.po && c.cancelled) {
          const e0 = c.chgD != null ? c.chgD : c.prD;
          g += `<line x1="${clampX(xd(c.prD))}" x2="${clampX(xd(e0) + dayW)}" y1="${yy + bh / 2}" y2="${yy + bh / 2}" stroke="${OUT_COL[OUTCOME(c)]}" stroke-width="2"/>`;
          g += `<text x="${clampX(xd(e0) + dayW) + 2}" y="${yy + bh}" class="pc-ax" style="font-size:9px">✕</text>`;
        } else {
          for (const L of LEG) {
            const s0 = L.from(c); if (s0 == null) continue;
            let e0 = L.to(c), open = false;
            if (e0 == null) { if (c.st[L.k].s !== 'open') continue; e0 = asOf; open = true; }
            if (e0 < s0) { g += `<rect x="${clampX(xd(e0))}" y="${yy}" width="${Math.max(3, xd(s0) - xd(e0))}" height="${bh}" fill="${PAL.oos}"/>`; continue; }
            const x0 = clampX(xd(s0)), x1 = clampX(xd(e0) + dayW);
            if (x1 <= x0) continue;
            g += `<rect x="${x0}" y="${yy}" width="${Math.max(1, x1 - x0)}" height="${bh}" fill="${L.col}" fill-opacity="${open ? C.OPEN_OPACITY : 1}"/>`;
          }
          if (c.g109 != null && c.use != null) g += `<line x1="${clampX(xd(c.g109) + dayW)}" x2="${clampX(xd(c.use) + dayW)}" y1="${yy + bh / 2}" y2="${yy + bh / 2}" stroke="${PAL.ontime}" stroke-width="1" stroke-opacity=".7"/>`;
        }
        g += `<rect data-chain="${k}" x="${padL}" y="${yy - 1}" width="${pw}" height="${rowH}" fill="transparent" style="cursor:pointer"/>`;
      });
      if (!chainsVis.length) g += `<text x="${padL + 10}" y="${p.y + 10}" class="pc-ax">No PR lines in this range.</text>`;
      legendItems.push(...LEG.map(L => ({ label: L.label, color: L.col })), { label: 'Still-open leg (to today)', color: PAL.s3, opacity: C.OPEN_OPACITY }, { label: 'Out of sequence', color: PAL.oos }, { label: 'site → first use', color: PAL.ontime, line: true });
    }

    /* crosshair */
    g += `<line class="mdCross" x1="0" x2="0" y1="${top}" y2="${bottom}" stroke="${PAL.pri}" stroke-opacity=".5" stroke-width="1" style="display:none;pointer-events:none"/>`;
    const hitBottom = P.chains ? P.chains.y : bottom;
    g += `<rect class="mdHit" x="${padL}" y="${top}" width="${pw}" height="${Math.max(10, hitBottom - top)}" fill="transparent"/>`;

    host.innerHTML = `<svg class="pc-svg" width="${Wd}" height="${H}" viewBox="0 0 ${Wd} ${H}" role="img" aria-label="MRP mechanics timeline for ${esc(st.mat)}">${g}</svg>`;
    cardEl.querySelector('.md-legend').innerHTML = C.legend(legendItems);

    const svg = host.querySelector('svg'), cross = svg.querySelector('.mdCross'), hit = svg.querySelector('.mdHit');
    hit.addEventListener('pointermove', (e) => {
      const r = svg.getBoundingClientRect();
      const i = Math.max(a, Math.min(b, a + Math.floor((e.clientX - r.left - padL) / dayW)));
      const d = W0 + i;
      cross.setAttribute('x1', x(i) + dayW / 2); cross.setAttribute('x2', x(i) + dayW / 2); cross.style.display = '';
      C.showTip(e, dayRows(d, i, r107, r109), iso(d) + (info.mrpType === 'V1' ? ` · Min ${fmt(info.min, 1)} · Max ${fmt(info.max, 1)}` : (info.ss ? ` · SS ${fmt(info.ss, 1)}` : '')));
    });
    hit.addEventListener('pointerleave', () => { cross.style.display = 'none'; C.hideTip(); });
    svg.querySelectorAll('[data-chain]').forEach(el => {
      el.addEventListener('click', () => { st.selChain = chainsVis[+el.dataset.chain]; renderBlocks(); });
      el.addEventListener('pointermove', (e) => { const c = chainsVis[+el.dataset.chain]; C.showTip(e, chainTipRows(c), `PR ${c.pr}${c.po ? ' → PO ' + c.po : ''}`); });
      el.addEventListener('pointerleave', C.hideTip);
    });
  }

  function dayRows(d, i, r107, r109){
    const ser = st.ser, rows = [];
    if (ser) {
      rows.push({ value: fmt(ser.soh[i], 1), label: 'stock on hand (end of day)', color: PAL.s1 });
      rows.push({ value: fmt(ser.poQty[i], 1), label: `on order · ${ser.poFresh[i]} open PO${ser.poFresh[i] === 1 ? '' : 's'}`, color: PAL.s2 });
      if (ser.prOpen[i]) rows.push({ value: String(ser.prOpen[i]), label: `open PR${ser.prOpen[i] === 1 ? '' : 's'} (${fmt(ser.prQty[i], 1)}) — not cover` });
      if (ser.poStale[i]) rows.push({ value: String(ser.poStale[i]), label: 'stale PO(s) — not cover' });
    }
    let used = 0;
    for (const r of st.mbRows) { if (E.dn(r.postingDate) !== d) continue; const mt = trim(r.movementType); if (CONS_ISSUE.has(mt)) used += Math.abs(+r.quantity || 0); else if (CONS_REV.has(mt)) used -= Math.abs(+r.quantity || 0); }
    if (used) rows.push({ value: fmt(used, 1), label: 'consumed' });
    const ep = st.model.episodes.find(e => e.material === st.mat && e.T === d && e.realLine);
    if (ep) rows.push({ value: '▼', label: `crossed below ${ep.lineLabel} — ${ep.response}`, color: PAL.oos });
    st.chains.filter(c => c.prD === d).forEach(c => rows.push({ value: 'PR ' + c.pr, label: `${c.trig} · ${fmt(c.qty)} · ${OUT_LAB[OUTCOME(c)]}`, color: OUT_COL[OUTCOME(c)] }));
    st.chains.filter(c => c.po && c.poD === d).forEach(c => rows.push({ value: 'PO ' + c.po, label: `from PR ${c.pr}`, color: PAL.s2 }));
    if (r107.has(d)) rows.push({ value: fmt(r107.get(d), 1), label: 'arrived at 3PL (107)', color: PAL.s3 });
    if (r109.has(d)) rows.push({ value: fmt(r109.get(d), 1), label: 'received at site (109)', color: PAL.s4 });
    return rows;
  }
  function chainTipRows(c){
    const rows = [
      { value: c.trig, label: 'trigger' }, { value: iso(c.prD) || '—', label: 'PR created' }, { value: iso(c.relD) || '—', label: 'released' },
      { value: iso(c.poD) || '—', label: 'PO raised' }, { value: iso(c.g107) || '—', label: 'at 3PL (107)', color: PAL.s3 },
      { value: iso(c.g109) || '—', label: 'at site (109)', color: PAL.s4 }, { value: iso(c.needD) || '—', label: 'need-by' }
    ];
    for (const k of ['A', 'B', 'C', 'D', 'E2E']) { const x = c.st[k]; if (x.s === 'done' || x.s === 'open' || x.s === 'oos') rows.push({ value: (x.s === 'open' ? '≥ ' : '') + fmt(x.v) + ' d' + (x.s === 'oos' ? ' !' : ''), label: E.METRICS[k].label }); }
    return rows;
  }
  let chainDock = null;
  function renderChainSel(){
    if (!chainDock) chainDock = U.dockPanel('mdChain', { cls: 'inspector', onClose: () => { st.selChain = null; renderBlocks(); } });
    const c = st.selChain;
    if (!c) { chainDock.close(); return; }
    chainDock.open(`PR ${esc(c.pr)}${c.prItem ? ' / ' + esc(c.prItem) : ''}${c.po ? ' → PO ' + esc(c.po) : ''}<small>highlighted on the Procurement chains block</small>`);
    const host = chainDock.body;
    const cell = (k) => { const x = c.st[k]; return x.s === 'done' ? fmt(x.v) + ' d' : x.s === 'open' ? '≥ ' + fmt(x.v) + ' d (open)' : x.s === 'oos' ? `<span class="amber">${fmt(x.v)} d — out of sequence</span>` : `<span class="muted">${esc(x.s)}</span>`; };
    host.innerHTML = `<div class="chain-grid">
        <div><span>Trigger</span><b>${esc(c.trig)}</b></div><div><span>Qty requested</span><b>${fmt(c.qty)}</b></div><div><span>Path</span><b>${esc(c.path)}</b></div>
        <div><span>PR created</span><b>${esc(iso(c.prD) || '—')}</b></div><div><span>Released</span><b>${esc(iso(c.relD) || '—')}</b></div><div><span>PO raised</span><b>${esc(iso(c.poD) || '—')}</b></div>
        <div><span>At 3PL (107)</span><b>${esc(iso(c.g107) || '—')}</b></div><div><span>At site (109)</span><b>${esc(iso(c.g109) || '—')}</b></div><div><span>First use</span><b>${esc(iso(c.use) || '—')}</b></div>
        <div><span>Need-by</span><b>${esc(iso(c.needD) || '—')}</b></div><div><span>Planned lead time</span><b>${c.planLT == null ? '—' : fmt(c.planLT) + ' d'}</b></div><div><span>Changed on</span><b>${esc(iso(c.chgD) || '—')}</b></div>
        <div><span>Approval</span><b>${cell('A')}</b></div><div><span>Buyer</span><b>${cell('B')}</b></div><div><span>Supplier</span><b>${cell('C')}</b></div>
        <div><span>3PL</span><b>${cell('D')}</b></div><div><span>PR → site</span><b>${cell('E2E')}</b></div><div><span>vs need-by</span><b>${cell('PLAN')}</b></div>
        ${c.orderCtx ? `<div><span>Stock at PR</span><b>${fmt(c.orderCtx.sohStart, 1)}</b></div><div><span>Already on order</span><b>${fmt(c.orderCtx.pipeline, 1)}</b></div><div><span>Ordered ÷ gap to Max</span><b>${c.orderCtx.ratio == null ? 'at / above Max' : Math.round(c.orderCtx.ratio * 100) + '%'}</b></div>` : ''}
      </div>`;
  }
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && st.selChain) { st.selChain = null; renderBlocks(); } });

  /* ═════════════════════════════════════════════════════════════════════════
     ANNUAL PROGRESSION — per year, the median of each leg end to end
  ═════════════════════════════════════════════════════════════════════════ */
  function renderAnnual(host){
    const c = card(host);
    c.innerHTML = `<div class="card-h"><div><div class="card-t">Annual progression</div>
      <div class="card-s">Per year a PR was created: the median of each leg, laid end to end (closed chains; “≥” when still-open chains make it a lower bound). Hover a segment for its count.</div></div></div><div class="chart"></div>`;
    C.annualChevrons(c.querySelector('.chart'), { rows: annualRows(st.chains), aria: 'Annual progression for ' + st.mat });
  }
  function annualRows(chains){
    const years = [...new Set(chains.map(x => x.prD != null ? iso(x.prD).slice(0, 4) : null).filter(Boolean))].sort();
    return years.map(yr => {
      const cs = chains.filter(x => x.prD != null && iso(x.prD).startsWith(yr));
      return { label: yr, n: cs.length, legs: LEG.map(L => {
        const M = E.METRICS[L.k];
        const done = [], open = [];
        for (const c of cs) { const s = M.stage(c); if (s.s === 'done' && s.v >= 0) done.push(s.v); else if (s.s === 'open') open.push(s.v); }
        const q = E.quantiles(done, open, [0.5])[0.5];
        return { label: L.label, v: q ? q.v : null, lb: q ? q.lowerBound : false, color: L.col, n: done.length };
      }) };
    });
  }

  /* ═════════════════════════════════════════════════════════════════════════
     MONTH-ON-MONTH BAND — the Bollinger-style view for one leg
  ═════════════════════════════════════════════════════════════════════════ */
  function renderBands(host){
    const c = card(host);
    const legs = ['AB', 'A', 'B', 'C', 'D', 'E2E', 'PLAN', 'E'];
    c.innerHTML = `<div class="card-h"><div><div class="card-t">Month-on-month · ${esc(E.METRICS[st.bandLeg].label)}</div>
      <div class="card-s">Per month or quarter: white line = median, violet = mean (average), bands = P25–P75 and P10–P90 of closed chains. Hollow dots = provisional (still-open chains). n = closed chains. Narrowing bands = a more predictable leg.</div></div>
      <div class="card-actions"><select data-leg aria-label="Leg">${legs.map(k => `<option value="${k}" ${k === st.bandLeg ? 'selected' : ''}>${esc(E.METRICS[k].label)}</option>`).join('')}</select>
      <button class="btn-sm ${st.bandGran === 'month' ? 'on' : ''}" data-g="month">Month</button><button class="btn-sm ${st.bandGran === 'quarter' ? 'on' : ''}" data-g="quarter">Quarter</button></div></div>
      <div class="pc-legend-host"></div><div class="chart"></div>`;
    c.querySelector('[data-leg]').addEventListener('change', (e) => { st.bandLeg = e.target.value; renderBlocks(); });
    c.querySelectorAll('[data-g]').forEach(b => b.addEventListener('click', () => { st.bandGran = b.dataset.g; renderBlocks(); }));
    const M = E.METRICS[st.bandLeg];
    const groups = E.cohorts(st.chains, M, st.settings.provisionalPct, st.bandGran);
    c.querySelector('.pc-legend-host').innerHTML = bandLegend();
    C.bandChart(c.querySelector('.chart'), { groups, signed: !!M.signed, target: (st.settings.targets || {})[st.bandLeg], xTitle: `${M.anchorLabel} (${st.bandGran}) · n closed`, aria: 'Month-on-month ' + M.label });
  }
  function bandLegend(){
    return C.legend([{ label: 'Median', color: PAL.pri, line: true }, { label: 'Mean (average)', color: PAL.s2, line: true },
      { label: 'P25 – P75', color: PAL.s1, opacity: .5 }, { label: 'P10 – P90', color: PAL.s1, opacity: .22 }]);
  }

  /* ═════════════════════════════════════════════════════════════════════════
     CONSOLIDATED DURATIONS — strip plot per leg
  ═════════════════════════════════════════════════════════════════════════ */
  function renderDurations(host){
    const c = card(host);
    c.innerHTML = `<div class="card-h"><div><div class="card-t">Consolidated durations</div>
      <div class="card-s">Every chain of this material as a dot on each leg (hollow = still open, at its age so far; amber = out of sequence). Bar = P10–P90 of closed chains, white tick = median. Click a dot to find its chain on the timeline.</div></div></div><div class="chart"></div>`;
    const host2 = c.querySelector('.chart');
    const keys = ['A', 'B', 'AB', 'C', 'D', 'E2E', 'PLAN', 'E'];
    const legs = keys.map(k => {
      const M = E.METRICS[k], items = [];
      for (const ch of st.chains) {
        const x = M.stage(ch);
        if (x.s === 'done') items.push({ c: ch, v: x.v, kind: (!M.signed && x.v < 0) ? 'oos' : 'done' });
        else if (x.s === 'open') items.push({ c: ch, v: x.v, kind: 'open' });
        else if (x.s === 'oos') items.push({ c: ch, v: x.v, kind: 'oos' });
      }
      const dv = items.filter(i => i.kind === 'done').map(i => i.v);
      return { M, items, q: E.doneQuantiles(dv, [0.1, 0.5, 0.9]), qa: E.quantiles(dv, items.filter(i => i.kind === 'open').map(i => i.v), [0.5, 0.9]),
               nDone: dv.length, nOpen: items.filter(i => i.kind === 'open').length, nOos: items.filter(i => i.kind === 'oos').length };
    });
    let vmin = 0, vmax = 10;
    for (const L of legs) for (const it of L.items) { vmax = Math.max(vmax, it.v); vmin = Math.min(vmin, it.v); }
    vmax = niceMax(vmax); if (vmin < 0) vmin = -niceMax(-vmin);
    const Wd = Math.max(640, host2.clientWidth || 1100), padL = 190, padR = 250, pw = Wd - padL - padR, rowH = 34;
    const xs = (v) => padL + ((v - vmin) / (vmax - vmin)) * pw;
    const H = legs.length * rowH + 30;
    let g = '';
    for (const t of niceTicks(vmin, vmax)) {
      g += `<line x1="${xs(t)}" x2="${xs(t)}" y1="4" y2="${H - 24}" stroke="${t === 0 ? PAL.axis : PAL.grid}"/>`;
      g += `<text x="${xs(t)}" y="${H - 8}" text-anchor="middle" class="pc-ax">${fmt(t)} d</text>`;
    }
    g += `<text x="${padL + pw + 12}" y="14" class="pc-ax">closed · open · median · P90</text>`;
    legs.forEach((L, r) => {
      const yc = 10 + r * rowH + rowH / 2;
      g += `<text x="8" y="${yc + 4}" class="pc-mk">${esc(L.M.label)}</text>`;
      if (L.q[0.1] != null) {
        g += `<rect x="${xs(L.q[0.1])}" y="${yc - 5}" width="${Math.max(2, xs(L.q[0.9]) - xs(L.q[0.1]))}" height="10" rx="3" fill="${PAL.s1}" fill-opacity=".22"/>`;
        g += `<line x1="${xs(L.q[0.5])}" x2="${xs(L.q[0.5])}" y1="${yc - 8}" y2="${yc + 8}" stroke="${PAL.pri}" stroke-width="2"/>`;
      }
      L.items.forEach((it, j) => {
        const jy = yc + (((j * 37) % 9) - 4), cx = xs(it.v), sel = st.selChain === it.c;
        g += it.kind === 'open'
          ? `<circle cx="${cx}" cy="${jy}" r="${sel ? 5 : 3.5}" fill="${PAL.surface}" stroke="${PAL.s1}" stroke-width="1.5" data-dot="${r}:${j}"/>`
          : `<circle cx="${cx}" cy="${jy}" r="${sel ? 5 : 3.5}" fill="${it.kind === 'oos' ? PAL.oos : PAL.s1}" stroke="${PAL.surface}" stroke-width="1" data-dot="${r}:${j}"/>`;
      });
      const med = L.qa[0.5], p90 = L.qa[0.9];
      g += `<text x="${padL + pw + 12}" y="${yc + 4}" class="pc-mk">${L.nDone} · ${L.nOpen}${L.nOos ? ` · ${L.nOos}!` : ''} · ${med ? (med.lowerBound ? '≥' : '') + fmt(med.v) : '—'} · ${p90 ? (p90.lowerBound ? '≥' : '') + fmt(p90.v) : '—'} d</text>`;
    });
    host2.innerHTML = `<svg class="pc-svg" width="${Wd}" height="${H}" viewBox="0 0 ${Wd} ${H}" role="img" aria-label="Durations per leg for ${esc(st.mat)}">${g}</svg>`;
    host2.querySelectorAll('[data-dot]').forEach(el => {
      const [r, j] = el.dataset.dot.split(':').map(Number); const it = legs[r].items[j];
      el.style.cursor = 'pointer';
      el.addEventListener('pointermove', (e) => C.showTip(e, [{ value: (it.kind === 'open' ? '≥ ' : '') + fmt(it.v) + ' d', label: legs[r].M.label + (it.kind === 'oos' ? ' — out of sequence' : '') }, { value: iso(it.c.prD) || '—', label: 'PR created' }], `PR ${it.c.pr}`));
      el.addEventListener('pointerleave', C.hideTip);
      el.addEventListener('click', () => { st.selChain = it.c; renderBlocks(); });
    });
  }

  /* ═════════════════════════════════════════════════════════════════════════
     TRIGGER CROSSINGS
  ═════════════════════════════════════════════════════════════════════════ */
  function renderTriggers(host){
    const c = card(host);
    const eps = st.model.episodes.filter(e => e.material === st.mat);
    const so = st.model.stockouts.filter(s => s.material === st.mat);
    c.innerHTML = `<div class="card-h"><div><div class="card-t">Trigger crossings · ${fmt(eps.length)}</div>
      <div class="card-s">Every time rebuilt stock went below its trigger line (${esc(st.ser ? st.ser.lineLabel || '—' : '—')}). Click a row to zoom the time-axis blocks onto it. Stockouts: ${fmt(so.length)} (${fmt(so.reduce((s, x) => s + x.days, 0))} days; ${fmt(so.filter(s => !s.orderInFlight).length)} began with nothing on order).</div></div></div><div class="tblwrap"></div>`;
    if (!eps.length) { c.querySelector('.tblwrap').innerHTML = '<div class="pc-empty">No crossings in the window.</div>'; return; }
    U.renderTable(c.querySelector('.tblwrap'), {
      rows: eps.map(e => ({ e, T: iso(e.T), sohAtT: e.sohAtT, response: e.response, toPr: e.toPr, toPo: e.toPo, days: e.days, ongoing: e.ongoing,
        noCover: e.noCoverNoPr + e.noCoverPr, prOpen: e.noCoverPr, covered: e.covered, stale: e.staleOnly, so: e.stockoutDays })),
      cols: [{ key: 'T', label: 'Crossed on' }, { key: 'sohAtT', label: 'Stock then', num: true, f: v => fmt(v, 1) }, { key: 'response', label: 'At the crossing / response' },
        { key: 'toPr', label: 'Days to PR', num: true }, { key: 'toPo', label: 'Days to PO', num: true },
        { key: 'days', label: 'Days below line', num: true, f: (v, r) => (r.ongoing ? '≥ ' : '') + fmt(v) }, { key: 'noCover', label: 'Nothing on order (d)', num: true },
        { key: 'prOpen', label: '…PR open (d)', num: true }, { key: 'covered', label: 'Covered (d)', num: true }, { key: 'stale', label: 'Stale PO only (d)', num: true }, { key: 'so', label: 'Stocked out (d)', num: true }],
      sort: { key: 'T', dir: -1 }, csv: `${st.mat}-crossings`,
      onRow: (r) => zoomTo(r.e.T - 30, r.e.lastBelow + 30)
    });
  }

  /* ═════════════════════════════════════════════════════════════════════════
     ORDER TO MAX (V1) + RECEIPTS
  ═════════════════════════════════════════════════════════════════════════ */
  function renderSizing(host){
    const c = card(host);
    const orders = st.model.orders.filter(o => o.material === st.mat);
    const recs = st.model.receipts.filter(r => r.material === st.mat).sort((a, b) => a.d - b.d);
    const ro = st.model.reorder.find(r => r.material === st.mat);
    const isV1 = st.info.mrpType === 'V1';
    const tab = st.sizeTab || (isV1 ? 'o' : 'r');
    const toMax = orders.filter(o => o.ratio != null && o.ratio >= 0.9 && o.ratio <= 1.1).length;
    c.innerHTML = `<div class="card-h"><div><div class="card-t">${isV1 ? 'Order to Max, or top-up?' : 'Receipts'}</div>
      <div class="card-s">${isV1
        ? `At each PR that became a PO: gap to Max = Max − (stock that morning + already on order). ${fmt(orders.length)} orders · <b>${orders.length ? Math.round(toMax / orders.length * 100) : 0}%</b> sized to Max (90–110%). ${ro && ro.ratio != null ? `Reordered <b>${fmt(ro.actualPerYr, 1)}</b>×/yr vs <b>${fmt(ro.expectedPerYr, 1)}</b>×/yr the Min–Max band implies (${fmt(ro.ratio, 2)}×).` : ''}`
        : 'Order-to-Max applies to V1 parts only. Site receipts with stock before and after:'}</div></div>
      <div class="card-actions"><button class="btn-sm ${tab === 'o' ? 'on' : ''}" data-t="o" ${isV1 ? '' : 'disabled'}>Orders</button><button class="btn-sm ${tab === 'r' ? 'on' : ''}" data-t="r">Receipts</button></div></div>
      <div class="tblwrap fixed"></div>`;
    const t = c.querySelector('.tblwrap');
    c.querySelectorAll('[data-t]').forEach(b => b.addEventListener('click', () => { st.sizeTab = b.dataset.t; renderBlocks(); }));
    if (tab === 'o') U.renderTable(t, {
      rows: orders.map(o => ({ o, pr: o.chain.pr, d: iso(o.d), trig: o.trig, soh: o.sohStart, pipe: o.pipeline, gap: o.gap, qty: o.qty, ratio: o.ratio, after: afterFor(o.chain) })),
      cols: [{ key: 'pr', label: 'PR' }, { key: 'd', label: 'PR date' }, { key: 'trig', label: 'Trigger' }, { key: 'soh', label: 'Stock that morning', num: true, f: v => fmt(v, 1) },
        { key: 'pipe', label: 'Already on order', num: true, f: v => fmt(v, 1) }, { key: 'gap', label: `Gap to Max (${fmt(st.info.max, 1)})`, num: true, f: v => fmt(v, 1) },
        { key: 'qty', label: 'Ordered', num: true }, { key: 'ratio', label: 'Ordered ÷ gap', num: true, f: v => v == null ? 'at / above Max' : Math.round(v * 100) + '%' },
        { key: 'after', label: 'Stock after its site receipt', num: true, f: v => fmt(v, 1) }],
      sort: { key: 'd', dir: -1 }, csv: `${st.mat}-orders`,
      onRow: (r) => { st.selChain = r.o.chain; zoomTo(r.o.d - 20, (r.o.chain.g109 || st.model.asOf) + 20); }
    });
    else U.renderTable(t, {
      rows: recs.map(r => ({ r, d: iso(r.d), qty: r.qty, before: r.before, after: r.after, fill: r.fill, over: r.overMax, overV: r.overMaxValue, vsLine: r.beforeVsLine })),
      cols: [{ key: 'd', label: 'Received at site' }, { key: 'qty', label: 'Qty', num: true }, { key: 'before', label: 'Stock before', num: true, f: v => fmt(v, 1) },
        { key: 'after', label: 'Stock after', num: true, f: v => fmt(v, 1) }, { key: 'vsLine', label: 'Before ÷ trigger line', num: true, f: v => v == null ? '—' : fmt(v, 2) + '×' },
        { key: 'fill', label: 'After ÷ Max', num: true, f: v => v == null ? '—' : Math.round(v * 100) + '%' }, { key: 'over', label: 'Over Max', num: true, f: v => fmt(v, 1) }, { key: 'overV', label: 'Over Max $', num: true, f: v => money(v) }],
      sort: { key: 'd', dir: -1 }, csv: `${st.mat}-receipts`,
      onRow: (r) => zoomTo(r.r.d - 30, r.r.d + 30)
    });
  }
  function afterFor(c){
    if (!st.ser || c.g109 == null) return null;
    const i = c.g109 - st.model.window.start;
    return (i >= 0 && i < st.model.window.days) ? st.ser.soh[i] : null;
  }

  /* ═════════════════════════════════════════════════════════════════════════
     RAW DATA
  ═════════════════════════════════════════════════════════════════════════ */
  function renderRaw(hostEl){
    const c = card(hostEl);
    const tabs = [['pr', `PR lines (${st.chains.length})`], ['mb', `MB51 ledger (${st.mbRows.length})`], ['po', 'Receipts by PO']];
    c.innerHTML = `<div class="card-h"><div><div class="card-t">Raw data</div><div class="card-s">The rows behind everything above. The MB51 ledger shows each movement's effect on site stock and the rebuilt stock at the end of each day.</div></div>
      <div class="card-actions">${tabs.map(([k, l]) => `<button class="btn-sm ${st.rawTab === k ? 'on' : ''}" data-raw="${k}">${esc(l)}</button>`).join('')}</div></div>
      <div class="tblwrap fixed tall"></div>`;
    c.querySelectorAll('[data-raw]').forEach(b => b.addEventListener('click', () => { st.rawTab = b.dataset.raw; renderBlocks(); }));
    const host = c.querySelector('.tblwrap');
    if (st.rawTab === 'pr') {
      const legCell = (x) => x.s === 'done' ? x.v : x.s === 'open' ? { v: x.v, open: true } : null;
      U.renderTable(host, {
        rows: st.chains.map(ch => ({ c: ch, pr: ch.pr, item: ch.prItem, trig: ch.trig, prD: iso(ch.prD), rel: iso(ch.relD), po: ch.po, poD: iso(ch.poD), g107: iso(ch.g107), g109: iso(ch.g109), use: iso(ch.use),
          need: iso(ch.needD), chg: iso(ch.chgD), qty: ch.qty, pg: ch.purchasingGroup, cancelled: ch.cancelled ? (ch.churn ? 'churn' : 'yes') : '', path: ch.path,
          A: legCell(ch.st.A), B: legCell(ch.st.B), C: legCell(ch.st.C), D: legCell(ch.st.D), E2E: legCell(ch.st.E2E) })),
        cols: [{ key: 'pr', label: 'PR' }, { key: 'item', label: 'Item' }, { key: 'trig', label: 'Trigger' }, { key: 'prD', label: 'PR date' }, { key: 'rel', label: 'Released' },
          { key: 'po', label: 'PO' }, { key: 'poD', label: 'PO date' }, { key: 'g107', label: 'At 3PL' }, { key: 'g109', label: 'At site' }, { key: 'use', label: 'First use' },
          { key: 'need', label: 'Need-by' }, { key: 'chg', label: 'Changed on' }, { key: 'qty', label: 'Qty', num: true }, { key: 'pg', label: 'P. group' }, { key: 'cancelled', label: 'Cancelled' },
          ...['A', 'B', 'C', 'D', 'E2E'].map(k => ({ key: k, label: k === 'E2E' ? 'PR→site' : E.METRICS[k].label.split(' (')[0], num: true, sv: r => r[k] == null ? null : (r[k].v != null ? r[k].v : r[k]), f: v => v == null ? '—' : (typeof v === 'object' ? '≥ ' + fmt(v.v) : fmt(v)) })),
          { key: 'path', label: 'Path', cls: 'wrap' }],
        sort: { key: 'prD', dir: -1 }, csv: `${st.mat}-pr-lines`,
        onRow: (r) => { st.selChain = r.c; renderBlocks(); }
      });
    } else if (st.rawTab === 'mb') {
      const W0 = st.model.window.start, N = st.model.window.days;
      const rows = st.mbRows.map((r, k) => ({ r, k, d: E.dn(r.postingDate) })).sort((a, b) => (a.d ?? 0) - (b.d ?? 0) || a.k - b.k);
      const lastOfDay = new Map(); rows.forEach((x, j) => { if (x.d != null) lastOfDay.set(x.d, j); });
      U.renderTable(host, {
        rows: rows.map((x, j) => {
          const dl = E.rowDelta(x.r); const i = x.d != null ? x.d - W0 : -1;
          return { date: x.r.postingDate, mt: trim(x.r.movementType), qty: +x.r.quantity, po: trim(x.r.purchaseOrder), order: trim(x.r.order), sloc: trim(x.r.storageLocation),
                   value: x.r.amountLC, entry: x.r.entryDate, delta: dl, seq: j,
                   eod: (st.ser && lastOfDay.get(x.d) === j && i >= 0 && i < N) ? st.ser.soh[i] : null };
        }),
        cols: [{ key: 'date', label: 'Posting date' }, { key: 'mt', label: 'Mvt' }, { key: 'qty', label: 'Qty', num: true, f: v => fmt(v, 2) },
          { key: 'delta', label: 'Site-stock effect', num: true, html: true, f: v => v == null ? '<span class="muted">not counted</span>' : (v > 0 ? '+' : '') + esc(fmt(v, 2)) },
          { key: 'eod', label: 'Rebuilt stock, end of day', num: true, f: v => v == null ? '' : fmt(v, 1) },
          { key: 'po', label: 'PO' }, { key: 'order', label: 'Order' }, { key: 'sloc', label: 'SLoc' }, { key: 'value', label: 'Value (LC)', num: true, f: v => v == null || v === '' ? '—' : fmt(+v, 2) }, { key: 'entry', label: 'Entered' }],
        sort: { key: 'seq', dir: -1 }, csv: `${st.mat}-mb51-ledger`,
        footNote: `“not counted” = the movement type doesn't change site stock in this model (e.g. 101 / 107 / 641 / 561). Stock before ${esc(iso(W0))} can't be rebuilt.`
      });
    } else {
      const byPo = new Map();
      for (const r of st.mbRows) {
        const po = trim(r.purchaseOrder); if (!po) continue;
        const mt = trim(r.movementType); const d = E.dn(r.postingDate);
        let e = byPo.get(po); if (!e) byPo.set(po, e = { po, mv: new Set(), f107: null, q107: 0, n107: 0, f109: null, l109: null, q109: 0, n109: 0 });
        e.mv.add(mt); const q = Math.abs(+r.quantity || 0);
        if (mt === '107') { e.n107++; e.q107 += q; if (e.f107 == null || d < e.f107) e.f107 = d; }
        else if (mt === '109') { e.n109++; e.q109 += q; if (e.f109 == null || d < e.f109) e.f109 = d; if (e.l109 == null || d > e.l109) e.l109 = d; }
      }
      const prsOf = new Map(); st.chains.forEach(ch => { if (ch.po) { const a = prsOf.get(ch.po) || []; a.push(ch); prsOf.set(ch.po, a); } });
      U.renderTable(host, {
        rows: [...byPo.values()].map(e => { const cs = prsOf.get(e.po) || []; return { po: e.po, prs: cs.map(ch => ch.pr).join(', ') || '(no PR line)', prQty: cs.reduce((s, ch) => s + ch.qty, 0) || null,
          f107: iso(e.f107), n107: e.n107, q107: e.q107, f109: iso(e.f109), l109: iso(e.l109), n109: e.n109, q109: e.q109, mv: [...e.mv].sort().join(' · ') }; }),
        cols: [{ key: 'po', label: 'PO' }, { key: 'prs', label: 'PR(s)' }, { key: 'prQty', label: 'PR qty', num: true }, { key: 'f107', label: 'First 107' }, { key: 'n107', label: '107 lines', num: true },
          { key: 'q107', label: '107 qty', num: true }, { key: 'f109', label: 'First 109' }, { key: 'l109', label: 'Last 109' }, { key: 'n109', label: '109 lines', num: true }, { key: 'q109', label: '109 qty', num: true }, { key: 'mv', label: 'Movement types' }],
        sort: { key: 'f109', dir: -1 }, csv: `${st.mat}-receipts-by-po`
      });
    }
  }

  /* ─── helpers ─────────────────────────────────────────────────────────── */
  function niceMax(v){ if (!(v > 0)) return 1; const p = Math.pow(10, Math.floor(Math.log10(v))); const f = v / p; return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10) * p; }
  function niceTicks(lo, hi){ const step = niceMax((hi - lo) / 4); const out = []; for (let v = Math.ceil(lo / step) * step; v <= hi + 1e-9; v += step) out.push(+v.toFixed(6)); return out; }

  /* exposed for the report builder (next chunk) and for tests */
  window.MaterialView = { state: st, BLOCKS, annualRows };
})();
