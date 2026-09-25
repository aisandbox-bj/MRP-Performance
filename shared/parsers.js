/* ═══════════════════════════════════════════════════════════════════════════
   Parsers — XLSX / CSV → canonical row arrays. Handles SAP export drift via
   column-alias matching. Sheet names auto-detected (skill rule: never hardcode).

   Depends on: SheetJS (XLSX), PapaParse (Papa) — loaded via CDN before this.
═══════════════════════════════════════════════════════════════════════════ */

(function (global) {
  'use strict';

  /* ─── Column alias map per source file ──────────────────────────────────── */
  /* Each canonical field has 1+ candidate header names. Matching is case- and
     punctuation-insensitive (see normalize() below). User-defined overrides
     from Settings are layered on top. */
  const ALIASES = {
    mb51: {
      postingDate:  ['Posting Date', 'Pstng Date', 'Pstng date', 'Date', 'Posting date'],
      order:        ['Order', 'Order Number', 'Order No', 'Order No.'],
      material:     ['Material', 'Material Number', 'Material No', 'Material No.', "Mat'l", 'Mat No', 'Mat. No.', 'SKU', 'Part', 'Part No', 'Part No.', 'Part Number'],
      description:  ['Material Description', 'Material descr.', 'Description', 'Mat Desc'],
      quantity:     ['Quantity', 'Qty', 'Qty in unit of entry', 'Qty in unit', 'Qty in UnE'],
      movementType: ['Movement Type', 'Movement type', 'MvT', 'Mvt Type'],
      /* APP-T-01b — plant alias added so per-file plant breakdown is visible
         in the Intake drop-stats panel. No analytical change in this chunk —
         pipeline still ignores plant on MB51 rows. Plant-scoped filtering /
         scope picker / Settings toggle land in a follow-up chunk. */
      plant:        ['Plant'],
      /* APP-FIX-T-04b (2026-05-17) — purchaseOrder alias was missing on
         MB51, which broke Trace's PR-to-PO-to-receipt chain join (PR
         History supplies the PO number, MB51 109 rows need to match by PO
         to register a Site WH receipt). Without this alias, every row's
         purchaseOrder field is undefined → zero matches → every chain
         reads as IN_FLIGHT or PR_ONLY. Audit §"MB51_Opn.xlsx" col 24
         confirms the header is verbatim "Purchase order". String type
         to preserve leading zeros on PO numbers like 9600010502. */
      purchaseOrder: ['Purchase order', 'PO', 'PO Number', 'PO No', 'PO No.', 'Purchasing Document'],
      /* PERF-ALIASES (MRP Performance v0.1.0-dev) — three MB51 columns the
         standard layout already carries but Tune never imported:
           amountLC        — actual movement value in local currency ($ views)
           entryDate       — when the posting was keyed (vs Posting Date) →
                             posting-lag / back-dating diagnostics
           storageLocation — 107 rows post with a blank SLoc (3PL-side), 109
                             into the site SLoc → receipt-path diagnostics */
      amountLC:        ['Amt.in Loc.Cur.', 'Amount in LC', 'Amount in Local Currency', 'Amt in Loc Cur', 'Amt. in Loc. Cur.'],
      entryDate:       ['Entry Date', 'Entered on'],
      storageLocation: ['Storage Location', 'Sloc', 'Stor. Loc.', 'StorLoc', 'SLoc']
    },
    iw39: {
      order:          ['Order', 'Order Number'],
      sortField:      ['Sort Field', 'Sort field', 'Sort No.', 'SortFld'],
      basicStartDate: ['Basic start date', 'Basic Start Date', 'Bas. Start', 'Basic Start'],
      description:    ['Description', 'Long Text', 'Operation Short Text', 'Order Description']
    },
    fleetMaster: {
      model:               ['Model number', 'Model Number', 'Model', 'Model No.'],
      sortField:           ['Sort Field', 'Sort field'],
      unitType:            ['Unit_Type', 'Unit Type', 'UnitType', 'Type'],
      manufacturer:        ['Manufacturer', 'Make', 'OEM', 'Mfr'],
      functLocDescription: ['FunctLocDescrip.', 'Functional Location', 'FunctLoc.', 'Description']
    },
    /* APP-T-01 (2026-05-16) — widened to ingest the standard SAP Material
       Master Fiori export per Willem's field-mapping audit (Fiori_Field_
       Audit_APP-T-01.md). Existing legacy aliases (Tot_Qty_OH, MRP_Ind etc.)
       kept for back-compat with the old Inventory Master - Output.xlsx.
       Plant is now canonical (was implicit single-plant before — multi-plant
       handling, scope-picker UI, and cross-file consistency check are queued
       for APP-T-01b). openPO is plant-conditional in source data: GM PO Qty
       is plant 1130 (the operator's primary), MLA PO Qty is plant 1120 (3PL
       hub) — first-match-wins resolves to plant 1130 by default; proper
       plant-conditional selection lands in T-01b. */
    inventoryMaster: {
      material:           ['Material', 'Material Number', 'Material No', 'Material No.', "Mat'l", 'Mat No', 'Mat. No.'],
      description:        ['Material Description', 'Mat Desc', 'Description'],
      plant:              ['Plant'],
      uom:                ['Base Unit of Measure', 'Base UoM', 'BUn', 'UoM', 'Unit of Measure', 'Unit'],
      totQtyOh:           ['Unrestricted', 'Unrestricted Stock', 'Unrestricted-Use Stock', 'Tot_Qty_OH', 'Tot Qty OH', 'Total Qty', 'Stock On Hand', 'SOH', 'Qty On Hand'],
      totValueOh:         ['Total Value', 'Tot_Value_OH', 'Tot Value OH', 'Stock Value', 'Value On Hand', 'On-Hand Value', 'Inventory Value'],
      mrpInd:             ['MRP Type', 'MRP_Ind', 'MRP Ind', 'MRP_Type', 'MRP Indicator'],
      mrpMin:             ['Reorder Point', 'MRP_Min', 'MRP Min', 'Min', 'Minimum'],
      mrpMax:             ['Maximum Stock Level', 'MRP_Max', 'MRP Max', 'Max', 'Maximum'],
      safetyStock:        ['Safety Stock', 'SS', 'SS Qty', 'Safety_Stock', 'Buffer Stock'],
      inventoryType:      ['Inventory_Type', 'Inventory Type', 'Inv Type', 'Item Category'],
      materialGroup:      ['Material Group', 'Mat Group', 'MatGrp', 'Material_Group', 'MGroup'],
      manufacturer:       ['Mfg Name', 'Manufacturer', 'Mfr', 'OEM', 'Make', 'Manufacturer Name'],
      primaryVendor:      ['Vendor', 'Primary Vendor', 'Source', 'Vendor No.'],
      /* APP-T-01 — new canonical fields (D20 — five for Compose PR drafting) */
      inTransit:          ['Stock in Transit', 'In Transit', 'In-Transit Qty', 'Stock In Transit'],
      openPO:             ['GM PO Qty', 'MLA PO Qty', 'Open PO Qty', 'Open PO', 'PO Qty', 'PO_QTY'],
      totalReservation:   ['Total Res Qty', 'Total Reservations', 'Total Reservation Qty', 'Res Qty', 'Reservation Qty'],
      unitPrice:          ['Net Price', 'Unit Price', 'Standard Price', 'Std Price'],
      movingAvgPrice:     ['Moving price', 'Moving Avg Price', 'Moving Average Price', 'mov_ave_cost', 'Moving Avg', 'MAP'],
      /* APP-T-01 — high-value carry-through aliases (per audit §8) */
      materialGroupDesc:  ['Material Group Desc.', 'Material Group Description', 'Mat Group Desc'],
      mfgPartNo:          ['Manufacturer Part No.', 'Mfg Part No', 'MPN', 'Manufacturer Part Number'],
      storageLocation:    ['Storage Location', 'Sloc', 'Stor. Loc.', 'StorLoc'],
      mrpController:      ['MRP Controller'],
      mrpControllerName:  ['MRP controller name', 'MRP Controller Name'],
      currency:           ['Local Currency', 'Currency'],
      purchasingGroup:    ['Purchasing Group', 'Purch. Group', 'PGr'],
      purchasingGroupDesc:['Description p. group', 'Purchasing Group Description'],
      blockedStock:       ['Valuated Goods Receipt Blocked Stock', 'Blocked Stock', 'GR Blocked Stock'],
      totalStock:         ['Total Stock'],
      res1Doc:            ['Reservation 1'],
      res1Qty:            ['Res 1 Qty'],
      res2Doc:            ['Reservation 2'],
      res2Qty:            ['Res 2 Qty'],
      res3Doc:            ['Reservation 3'],
      res3Qty:            ['Res 3 Qty']
    },
    userList: {
      material:    ['Material', 'Material Number', 'Material No', 'Material No.', "Mat'l", 'Mat No', 'Mat. No.', 'SKU', 'Part', 'Part No', 'Part No.', 'Part Number'],
      /* APP-E22 — accept either a material OR an order column on uploaded user-list files. */
      order:       ['Order', 'Order Number', 'Order No', 'Order No.', 'Maintenance Order', 'Work Order', 'WO', 'WO Number', 'Order Num'],
      description: ['Description', 'Material Description', 'Mat Desc']
    },
    materialVendor: {
      material:            ['Material', 'Material Number', 'Material No', 'Material No.'],
      vendor:              ['Vendor', 'Vendor Number', 'Vendor No.'],
      vendorName:          ['Vendor Name', 'Name', 'Vendor description'],
      sourceListIndicator: ['Source List', 'SL', 'SL Indicator']
    },
    leadTimes: {
      material:     ['Material'],
      leadTimeDays: ['Lead Time', 'Lead Time (Days)', 'Trigger to GR', 'LT'],
      safetyStock:  ['Safety Stock', 'SS', 'SS Qty'],
      source:       ['Source', 'Method', 'Lead Time Source']
    },
    /* APP-T-02 (2026-05-16) — PR History: new OPTIONAL source. The Trace
       bridge starts here. 21 columns aliased from the 30 in the SAP Fiori
       PR History export per the CoWork field-mapping audit; the 9 columns
       skipped are the audit-flagged low/no-value ones (Deliv. date
       category, Purchasing Info Rec, MPN:Material, No. of requisns, GR
       processing time, Goods Receipt boolean, Delivery Date in yyyymmdd
       string form, Purch. Organization, Short Text — kept for display
       only, no canonical role). All values stay as strings unless
       explicitly typed below — preserves SAP zero-padding on PR numbers,
       PO numbers, and creation indicator flags. */
    prHistory: {
      material:           ['Material'],
      plant:              ['Plant'],
      uom:                ['Unit of Measure', 'Base UoM', 'BUn', 'UoM'],
      purchaseOrder:      ['Purchase order', 'Purchasing Document'],
      poDate:             ['Purchase Order Date', 'PO Date'],
      pr:                 ['Purchase Requisition', 'PR Number', 'Requisition No.'],
      prItem:             ['Item of requisition', 'Item', 'PR Item'],
      prDate:             ['Requisition date', 'PR Date', 'Created on'],
      releaseDate:        ['Release Date'],
      changedOn:          ['Changed On'],
      processingStatus:   ['Processing status', 'Status'],
      deletionIndicator:  ['Deletion Indicator', 'Deletion ind.'],
      creationIndicator:  ['Creation indicator', 'Creation Ind.', 'ESTKZ'],
      releaseIndicator:   ['Release indicator', 'Release Ind.'],
      qtyRequested:       ['Quantity requested', 'Quantity', 'Qty Requested'],
      shortText:          ['Short Text', 'Description', 'Text'],
      requisitioner:      ['Requisitioner'],
      acctAssignmentCat:  ['Acct Assignment Cat.', 'Acc.Assgnmt Cat.', 'AAC'],
      purchasingGroup:    ['Purchasing Group', 'Purch. Group', 'PGr'],
      itemCategory:       ['Item Category', 'Item Cat'],
      desiredVendor:      ['Desired Vendor'],
      fixedVendor:        ['Fixed Vendor', 'Vendor'],
      /* PERF-ALIASES — two PR History columns Tune skipped:
           deliveryDate     — the need-by date on the PR. For MRP-created PRs
                              SAP sets it = PR date + planned lead time, so it
                              IS the "theoretical process" datum (plan vs actual).
                              Arrives as a yyyymmdd string ('20250608').
           grProcessingTime — planned GR processing days (part of the plan). */
      deliveryDate:       ['Delivery Date', 'Deliv. Date', 'Delivery date'],
      grProcessingTime:   ['GR processing time', 'GR Proc. Time', 'GR processing time (days)']
    }
  };

  /* ─── String normalization for fuzzy header matching ────────────────────── */
  function normalize(s){
    return String(s || '')
      .toLowerCase()
      .replace(/[\s._\-()/]+/g, '')
      .trim();
  }

  /**
   * Build a header → canonical-field map for a given source.
   * Layers user-saved aliases (from Settings) over the built-in map.
   *
   * @param {string} source  — one of ALIASES keys (e.g. 'mb51')
   * @param {string[]} headers — actual headers from the parsed file
   * @param {Object} userAliases — saved overrides keyed by source.canonicalField → ['header','aliases']
   * @returns {{ fieldToHeader: Object, unmatched: string[], matchedFields: string[], missingFields: string[] }}
   */
  function buildFieldMap(source, headers, userAliases) {
    const builtIn = ALIASES[source] || {};
    const user    = (userAliases && userAliases[source]) || {};
    const fields  = Object.keys(builtIn);

    // Combined alias list per field — user overrides matched FIRST so they win
    const combined = {};
    for (const f of fields) {
      const list = [...((user[f] || [])), ...(builtIn[f] || [])];
      combined[f] = list.map(normalize);
    }

    const headerNormMap = {};
    headers.forEach(h => { headerNormMap[normalize(h)] = h; });

    const fieldToHeader = {};
    const matched = [];
    const missing = [];
    const usedHeaders = new Set();

    for (const f of fields) {
      let found = null;
      for (const candidate of combined[f]) {
        if (headerNormMap[candidate] && !usedHeaders.has(headerNormMap[candidate])) {
          found = headerNormMap[candidate];
          break;
        }
      }
      if (found) {
        fieldToHeader[f] = found;
        usedHeaders.add(found);
        matched.push(f);
      } else {
        missing.push(f);
      }
    }

    const unmatched = headers.filter(h => !usedHeaders.has(h));
    return { fieldToHeader, unmatched, matchedFields: matched, missingFields: missing };
  }

  /* ─── Coercion helpers ──────────────────────────────────────────────────── */
  function toIsoDate(v){
    if (v == null || v === '') return null;
    if (v instanceof Date) {
      if (isNaN(v.getTime())) return null;
      return v.toISOString().slice(0, 10);
    }
    // SheetJS may return Excel serial or Date depending on options. Handle both.
    /* PERF-DATE-YMD — a yyyymmdd value stored as a NUMBER (20250608) is not an
       Excel serial (serials for 1900–2100 are < 80,000). Read it as yyyymmdd. */
    if (typeof v === 'number' && v >= 19000101 && v <= 21001231 && Number.isInteger(v)) {
      return toIsoDate(String(v));
    }
    if (typeof v === 'number') {
      // Excel serial date → JS Date
      const ms = Math.round((v - 25569) * 86400 * 1000);
      const d  = new Date(ms);
      if (isNaN(d.getTime())) return null;
      return d.toISOString().slice(0, 10);
    }
    const s = String(v).trim();
    // Try common formats: yyyy-mm-dd, dd/mm/yyyy, mm/dd/yyyy, dd.mm.yyyy
    const isoMatch = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (isoMatch) return s;
    /* PERF-DATE-YMD — SAP 'yyyymmdd' strings (PR History "Delivery Date"
       arrives as '20250608'). Without this, new Date('20250608') is Invalid
       and the need-by date would silently come back null. */
    const ymd = s.match(/^(\d{4})(\d{2})(\d{2})$/);
    if (ymd && +ymd[2] >= 1 && +ymd[2] <= 12 && +ymd[3] >= 1 && +ymd[3] <= 31) return ymd[1] + '-' + ymd[2] + '-' + ymd[3];
    const slashMatch = s.match(/^(\d{1,2})[\/\.\-](\d{1,2})[\/\.\-](\d{2,4})$/);
    if (slashMatch) {
      let [_, a, b, y] = slashMatch;
      if (y.length === 2) y = (parseInt(y,10) > 50 ? '19' : '20') + y;
      // SAP exports are typically dd.mm.yyyy or dd/mm/yyyy in many locales,
      // but mm/dd/yyyy in US. Heuristic: if first part > 12, it's the day.
      let day, month;
      if (parseInt(a,10) > 12)      { day = a; month = b; }
      else if (parseInt(b,10) > 12) { day = b; month = a; }
      else                          { day = a; month = b; }   // ambiguous → assume dd/mm
      return `${y}-${String(month).padStart(2,'0')}-${String(day).padStart(2,'0')}`;
    }
    const d = new Date(s);
    if (!isNaN(d.getTime())) return d.toISOString().slice(0, 10);
    return null;
  }

  function toNumber(v){
    if (v == null || v === '') return null;
    if (typeof v === 'number') return v;
    const s = String(v).trim().replace(/,/g, '');   // strip thousands separators
    const n = parseFloat(s);
    return isNaN(n) ? null : n;
  }

  function toString(v){
    if (v == null) return '';
    return String(v).trim();
  }

  /* ─── Type schemas per source — drives coercion ─────────────────────────── */
  const FIELD_TYPES = {
    mb51: {
      postingDate:  'date',
      order:        'string',
      material:     'string',
      description:  'string',
      quantity:     'number',
      movementType: 'string',
      plant:         'string',  /* APP-T-01b */
      purchaseOrder: 'string',  /* APP-FIX-T-04b — preserve PO leading zeros for PR↔MB51 join */
      amountLC:        'number',  /* PERF-ALIASES */
      entryDate:       'date',    /* PERF-ALIASES */
      storageLocation: 'string'   /* PERF-ALIASES */
    },
    iw39: {
      order:          'string',
      sortField:      'string',
      basicStartDate: 'date',
      description:    'string'
    },
    fleetMaster: {
      model:               'string',
      sortField:           'string',
      unitType:            'string',
      manufacturer:        'string',
      functLocDescription: 'string'
    },
    inventoryMaster: {
      material:           'string',
      description:        'string',
      plant:              'string',
      uom:                'string',
      totQtyOh:           'number',
      totValueOh:         'number',
      mrpInd:             'string',
      mrpMin:             'number',
      mrpMax:             'number',
      safetyStock:        'number',
      inventoryType:      'string',
      materialGroup:      'string',
      manufacturer:       'string',
      primaryVendor:      'string',
      /* APP-T-01 — new canonical fields */
      inTransit:          'number',
      openPO:             'number',
      totalReservation:   'number',
      unitPrice:          'number',
      movingAvgPrice:     'number',
      /* APP-T-01 — carry-through aliases */
      materialGroupDesc:  'string',
      mfgPartNo:          'string',
      storageLocation:    'string',
      mrpController:      'string',
      mrpControllerName:  'string',
      currency:           'string',
      purchasingGroup:    'string',
      purchasingGroupDesc:'string',
      blockedStock:       'number',
      totalStock:         'number',
      res1Doc:            'string',
      res1Qty:            'number',
      res2Doc:            'string',
      res2Qty:            'number',
      res3Doc:            'string',
      res3Qty:            'number'
    },
    userList: {
      material:    'string',
      order:       'string',  /* APP-E22 — preserve leading zeros on order numbers */
      description: 'string'
    },
    materialVendor: {
      material:            'string',
      vendor:              'string',
      vendorName:          'string',
      sourceListIndicator: 'string'
    },
    leadTimes: {
      material:     'string',
      leadTimeDays: 'number',
      safetyStock:  'number',
      source:       'string'
    },
    /* APP-T-02 — PR History field types. Dates coerced via toIsoDate. Most
       numeric-looking fields (PR / PO / item / vendor / plant) stay STRING
       to preserve leading zeros. qtyRequested is the only true numeric. */
    prHistory: {
      material:           'string',
      plant:              'string',
      uom:                'string',
      purchaseOrder:      'string',
      poDate:             'date',
      pr:                 'string',
      prItem:             'string',
      prDate:             'date',
      releaseDate:        'date',
      changedOn:          'date',
      processingStatus:   'string',
      deletionIndicator:  'string',
      creationIndicator:  'string',
      releaseIndicator:   'string',
      qtyRequested:       'number',
      shortText:          'string',
      requisitioner:      'string',
      acctAssignmentCat:  'string',
      purchasingGroup:    'string',
      itemCategory:       'string',
      desiredVendor:      'string',
      fixedVendor:        'string',
      deliveryDate:       'date',     /* PERF-ALIASES — yyyymmdd handled in toIsoDate */
      grProcessingTime:   'number'    /* PERF-ALIASES */
    }
  };

  function coerce(v, type){
    if (type === 'date')   return toIsoDate(v);
    if (type === 'number') return toNumber(v);
    return toString(v);
  }

  /* ─── Map raw rows → canonical rows using field map ─────────────────────── */
  function mapRows(rawRows, source, fieldToHeader){
    const types = FIELD_TYPES[source];
    const out = [];
    for (const raw of rawRows) {
      const obj = {};
      for (const [field, header] of Object.entries(fieldToHeader)) {
        obj[field] = coerce(raw[header], types[field]);
      }
      out.push(obj);
    }
    return out;
  }

  /* ─── XLSX parsing — auto-pick sheet ────────────────────────────────────── */
  /**
   * Pick the most "data-like" sheet from a workbook. Heuristic: largest used
   * range with a header row that matches at least one canonical alias for the
   * named source. If nothing matches, fall back to the largest sheet.
   */
  function pickSheet(wb, source){
    const aliases  = ALIASES[source] || {};
    const allCands = new Set();
    for (const arr of Object.values(aliases)) for (const a of arr) allCands.add(normalize(a));

    let best = { name: null, score: -1, rowCount: 0 };
    for (const name of wb.SheetNames) {
      const ws    = wb.Sheets[name];
      /* PERF-PARSE-FAST — score each sheet from its HEADER ROW + used-range
         size only. Tune converted every whole sheet to objects here and then
         converted the winner again in parseFile — two full passes over a
         150k–500k-row MB51. Same scoring rule (alias hits × 10000 + rows),
         so the same sheet wins. */
      if (!ws || !ws['!ref']) continue;
      const rng   = XLSX.utils.decode_range(ws['!ref']);
      const nRows = rng.e.r - rng.s.r;              // data rows under the header
      if (nRows <= 0) continue;
      const headers = [];
      for (let c = rng.s.c; c <= rng.e.c; c++) {
        const cell = ws[XLSX.utils.encode_cell({ r: rng.s.r, c })];
        if (cell && cell.v != null && String(cell.v) !== '') headers.push(String(cell.v));
      }
      const rows = { length: nRows };
      let hits = 0;
      for (const h of headers) if (allCands.has(normalize(h))) hits++;
      const score = hits * 10000 + rows.length;        // alias hits dominate, size as tiebreak
      if (score > best.score) best = { name, score, rowCount: rows.length };
    }
    return best.name;
  }

  /**
   * Parse a File object into { rows, headers } given a source key.
   * Returns a Promise.
   */
  function parseFile(file, source){
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onerror = () => reject(reader.error);
      reader.onload  = () => {
        try {
          const ext = (file.name.split('.').pop() || '').toLowerCase();
          if (ext === 'csv' || ext === 'tsv' || ext === 'txt') {
            const text = reader.result;
            const out  = Papa.parse(text, { header: true, skipEmptyLines: true });
            const rows = out.data || [];
            const headers = out.meta && out.meta.fields ? out.meta.fields : Object.keys(rows[0] || {});
            resolve({ rows, headers, sheet: null });
          } else {
            const data = new Uint8Array(reader.result);
            const wb   = XLSX.read(data, { type: 'array', cellDates: true });
            const sheetName = pickSheet(wb, source) || wb.SheetNames[0];
            const ws   = wb.Sheets[sheetName];
            const rows = XLSX.utils.sheet_to_json(ws, { defval: null, blankrows: false });
            const headers = Object.keys(rows[0] || {});
            resolve({ rows, headers, sheet: sheetName });
          }
        } catch (e) {
          reject(e);
        }
      };
      const ext = (file.name.split('.').pop() || '').toLowerCase();
      if (ext === 'csv' || ext === 'tsv' || ext === 'txt') reader.readAsText(file);
      else reader.readAsArrayBuffer(file);
    });
  }

  /**
   * High-level: parse + map + coerce in one call.
   *   { canonical: [...], headers: [...], sheet, fieldMap, unmatched, missingFields }
   */
  async function parseAndMap(file, source, userAliases){
    const { rows, headers, sheet } = await parseFile(file, source);
    const map = buildFieldMap(source, headers, userAliases);
    const canonical = mapRows(rows, source, map.fieldToHeader);
    return {
      canonical,
      headers,
      sheet,
      fieldMap:      map.fieldToHeader,
      unmatched:     map.unmatched,
      missingFields: map.missingFields,
      matchedFields: map.matchedFields,
      rowCount:      canonical.length
    };
  }

  /* ─── Public API ────────────────────────────────────────────────────────── */
  global.AppParsers = Object.freeze({
    ALIASES,
    FIELD_TYPES,
    parseFile,
    parseAndMap,
    buildFieldMap,
    pickSheet,
    normalize
  });

})(window);
