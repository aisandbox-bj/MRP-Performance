/* ═══════════════════════════════════════════════════════════════════════════
   shared/perf-ui.js · Calibre MRP Performance v0.2.0-dev
   Small UI helpers shared by the Workbench and the Material deep-dive:
   sortable table with CSV export, toast, formatting, and the cross-page
   navigation hand-off (drill list → deep-dive Prev / Next → back to the
   Workbench with its view, segment and window intact).
   Navigation state lives in sessionStorage under this app's own keys
   (mrpPerf.*) — same browser origin as Calibre Tune, so never Tune's keys.
═══════════════════════════════════════════════════════════════════════════ */
(function (global) {
  'use strict';

  function esc(s){ return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' })[c]); }
  function fmt(n, d){ return n == null || !Number.isFinite(n) ? '—' : (d ? n.toLocaleString(undefined, { maximumFractionDigits: d }) : Math.round(n).toLocaleString()); }
  function money(n){ return n == null || !Number.isFinite(n) ? '—' : '$' + (Math.abs(n) >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : Math.abs(n) >= 1e4 ? Math.round(n / 1e3) + 'k' : Math.round(n).toLocaleString()); }

  /* renderTable(host, spec)
       spec.cols  [{key, label, num, cls, html, f(v,row), sv(row), link}]
       spec.rows  [object]
       spec.sort  {key, dir}      spec.limit  max rows drawn (CSV = all)
       spec.onRow (row, sortedRows) → void     spec.csv  file-name stem
       spec.csvPrefix  dataset name for the CSV file name
       spec.rowClass (row) → extra class                                       */
  function renderTable(host, spec){
    const st = { key: spec.sort ? spec.sort.key : null, dir: spec.sort ? spec.sort.dir : 1 };
    let sorted = [];
    const draw = () => {
      const rows = spec.rows.slice();
      if (st.key) {
        const col = spec.cols.find(c => c.key === st.key) || {};
        const sv = col.sv || (r => r[st.key]);
        rows.sort((a, b) => {
          const x = sv(a), y = sv(b);
          if (x == null && y == null) return 0; if (x == null) return 1; if (y == null) return -1;
          return (typeof x === 'number' && typeof y === 'number' ? x - y : String(x).localeCompare(String(y), undefined, { numeric: true })) * st.dir;
        });
      }
      sorted = rows;
      const lim = spec.limit || 5000;
      const shown = rows.slice(0, lim);
      host.innerHTML = `<table class="dt"><thead><tr>${spec.cols.map(c => `<th class="${c.num ? 'num' : ''}" data-k="${esc(c.key)}" title="${esc(c.tip || '')}">${esc(c.label)}${st.key === c.key ? `<span class="srt">${st.dir > 0 ? '▲' : '▼'}</span>` : ''}</th>`).join('')}</tr></thead><tbody>` +
        shown.map((r, i) => `<tr class="${spec.onRow ? 'click' : ''} ${spec.rowClass ? spec.rowClass(r) || '' : ''}" data-i="${i}">${spec.cols.map(c => {
          const v = r[c.key];
          const out = c.f ? c.f(v, r) : (typeof v === 'number' ? fmt(v, Math.abs(v) < 10 && v % 1 ? 1 : 0) : v);
          return `<td class="${c.num ? 'num' : ''} ${c.cls || ''}">${c.html ? out : esc(out == null || out === '' ? '—' : out)}</td>`;
        }).join('')}</tr>`).join('') + `</tbody></table>` +
        `<div class="tbl-foot">${rows.length > lim ? `Showing ${fmt(lim)} of ${fmt(rows.length)} — ` : ''}<button class="btn-sm ghost" data-csv>⤓ CSV (${fmt(rows.length)} rows)</button>${spec.footNote ? `<span class="tbl-note">${spec.footNote}</span>` : ''}</div>`;
      host.querySelectorAll('th[data-k]').forEach(th => th.addEventListener('click', () => {
        const k = th.dataset.k; if (st.key === k) st.dir = -st.dir; else { st.key = k; st.dir = (spec.cols.find(c => c.key === k) || {}).num ? -1 : 1; } draw();
      }));
      if (spec.onRow) host.querySelectorAll('tbody tr').forEach(tr => tr.addEventListener('click', (e) => {
        if (e.target.closest('a')) return;
        spec.onRow(shown[+tr.dataset.i], sorted);
      }));
      host.querySelector('[data-csv]').addEventListener('click', () => downloadCsv((spec.csvPrefix ? spec.csvPrefix + '-' : '') + (spec.csv || 'table'), spec.cols, rows));
    };
    draw();
    return { sorted: () => sorted };
  }

  function downloadCsv(name, cols, rows){
    const q = (v) => { if (v == null) return ''; const s = (typeof v === 'object' && v.v != null) ? String(v.v) : String(v); return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
    const lines = [cols.map(c => q(c.label)).join(',')].concat(rows.map(r => cols.map(c => q(r[c.key])).join(',')));
    const blob = new Blob(['﻿' + lines.join('\n')], { type: 'text/csv' });
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob);
    a.download = String(name).replace(/[^A-Za-z0-9_.-]+/g, '_') + '.csv'; a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  function toast(msg, kind){
    const el = document.createElement('div');
    el.className = 'toast ' + (kind || '');
    el.textContent = msg;
    document.body.appendChild(el);
    setTimeout(() => el.remove(), 4200);
  }

  /* ─── cross-page navigation ─────────────────────────────────────────────
     A drill list becomes the deep-dive's Prev / Next list; the Workbench
     parks its UI state so "Back to Workbench" restores it. sessionStorage
     (this tab only) — wrapped, because storage can be blocked. */
  const NAV_KEY = 'mrpPerf.nav.list';
  const WB_KEY  = 'mrpPerf.wb.state';
  function ssGet(k){ try { return JSON.parse(sessionStorage.getItem(k) || 'null'); } catch (e) { return null; } }
  function ssSet(k, v){ try { sessionStorage.setItem(k, JSON.stringify(v)); } catch (e) {} }
  function openMaterial(material, list, title, base){
    const mats = [];
    const seen = new Set();
    for (const m of (list || [material])) { if (m && !seen.has(m)) { seen.add(m); mats.push(m); } }
    if (!seen.has(material)) mats.unshift(material);
    ssSet(NAV_KEY, { title: title || 'materials', materials: mats.slice(0, 5000) });
    location.href = (base || '../material/material.html') + '#mat=' + encodeURIComponent(material);
  }
  function navList(){ return ssGet(NAV_KEY); }
  function saveWorkbenchState(s){ ssSet(WB_KEY, s); }
  function loadWorkbenchState(){ return ssGet(WB_KEY); }

  global.PerfUI = Object.freeze({ esc, fmt, money, renderTable, downloadCsv, toast, openMaterial, navList, saveWorkbenchState, loadWorkbenchState });
})(window);
