/* ═══ BUILD-STAMP ═══════════════════════════════════════════════════════════
   Inventory Optimization App · v2.0.0-dev · released 2026-05-12
   Locale helpers — local time + CAD currency formatting.

   Why this exists:
     • new Date().toISOString() produces UTC, which is hours off the host
       clock west of UTC. runDate / createdAt / "Exported at" / PDF footers
       were therefore showing tomorrow's date in the evening.
     • Currency throughout the app is implicit CAD. Surface that explicitly
       in the UI + deliverables.

   All helpers take the host machine's clock as truth (Date object's local-
   time getters), not UTC.
═══════════════════════════════════════════════════════════════════════════ */

(function (global) {
  'use strict';

  function pad(n){ return String(n).padStart(2, '0'); }

  /** YYYY-MM-DD in the host's local time. */
  function localDateISO(d){
    const x = d || new Date();
    return `${x.getFullYear()}-${pad(x.getMonth() + 1)}-${pad(x.getDate())}`;
  }

  /** YYYY-MM-DD HH:MM:SS in the host's local time (space separator). */
  function localDateTimeISO(d){
    const x = d || new Date();
    return `${localDateISO(x)} ${pad(x.getHours())}:${pad(x.getMinutes())}:${pad(x.getSeconds())}`;
  }

  /** YYYY-MM-DDTHH:MM:SS (T separator) — compact, sort-friendly. */
  function localStampCompact(d){
    const x = d || new Date();
    return `${localDateISO(x)}T${pad(x.getHours())}:${pad(x.getMinutes())}:${pad(x.getSeconds())}`;
  }

  /** Short label like "May 12 2026 · 14:23". */
  function localDateTimeLabel(d){
    const x = d || new Date();
    const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    return `${months[x.getMonth()]} ${x.getDate()} ${x.getFullYear()} · ${pad(x.getHours())}:${pad(x.getMinutes())}`;
  }

  /* ─── CAD currency formatting ────────────────────────────────────────────
     Default to en-CA locale, CAD currency, no fractional digits (inventory
     values are typically rounded). Accepts a number or null/blank. */
  let _cad0, _cad2;
  function fmtCAD(n, opts){
    if (n == null || n === '' || (typeof n === 'number' && isNaN(n))) return '—';
    const v = (typeof n === 'number') ? n : parseFloat(n);
    if (isNaN(v)) return '—';
    const fmt = (opts && opts.fraction)
      ? (_cad2 = _cad2 || new Intl.NumberFormat('en-CA', { style:'currency', currency:'CAD', minimumFractionDigits:2, maximumFractionDigits:2 }))
      : (_cad0 = _cad0 || new Intl.NumberFormat('en-CA', { style:'currency', currency:'CAD', maximumFractionDigits:0 }));
    return fmt.format(v);
  }

  /* ─── Quantity formatting (units, locale-aware thousand-separators) ────── */
  let _qty;
  function fmtQty(n){
    if (n == null || n === '' || (typeof n === 'number' && isNaN(n))) return '—';
    const v = (typeof n === 'number') ? n : parseFloat(n);
    if (isNaN(v)) return '—';
    _qty = _qty || new Intl.NumberFormat('en-CA');
    return _qty.format(Math.round(v));
  }

  /** Excel-friendly currency number format. Use with cell.numFmt. */
  const EXCEL_CURRENCY_FORMAT = '"$"#,##0';
  const EXCEL_CURRENCY_FORMAT_2DP = '"$"#,##0.00';

  global.AppLocale = Object.freeze({
    localDateISO,
    localDateTimeISO,
    localStampCompact,
    localDateTimeLabel,
    fmtCAD,
    fmtQty,
    EXCEL_CURRENCY_FORMAT,
    EXCEL_CURRENCY_FORMAT_2DP
  });

})(window);
