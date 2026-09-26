# Calibre MRP Performance

Browser-only, single-file-per-page app for **supply-chain performance review across every material** in a set of SAP extracts. Where Calibre Tune and Trace start from one material and ask whether it is healthy, MRP Performance starts from the process and asks where it breaks, how often and by how much — and shows every answer as a **distribution you can drill into**, never a bare average.

Part of the **Calibre suite** (Tune · Trace · MRP Performance). It is a separate app with its own repository and its own browser storage; it borrows Tune's intake and data engine as tracked copies (see [`PROVENANCE.md`](PROVENANCE.md)) so its numbers tie to Tune and Trace, and it never writes to Tune.

## Status

**v0.2.0-dev** (2026-09-25) — material deep-dive (a tailorable stack: stock vs Min/Max with the MRP cadence, events and chains underneath on one time axis; annual progression; month-on-month bands; raw data), drill-down from every list with Prev / Next and Back, month-on-month band charts on every leg, PR / PO volume splits (MRP vs manual, V1 vs PD, outcome), an MRP-activity heat map and a per-material parameters table. v0.1.0-dev (first build) is the rollback. Browser-verified; **pending operator validation on real extracts**. `SCHEMA_VERSION` = `1.0.0` (same contract as Tune), `APP_VERSION` = `0.2.0-dev`. Full history and rollback steps: [`record-of-change.html`](record-of-change.html). Queue: [`roadmap.html`](roadmap.html) and [`Backlog.md`](Backlog.md). Operator manual: [`user-manual.html`](user-manual.html).

## What it answers

- How often does MRP raise PRs — and does it go quiet while parts sit below their trigger line with nothing on order?
- How fast does a PR follow stock crossing Min / safety stock?
- How many PRs are really cancelled, and how many are MRP replacing its own proposals (churn)?
- How long do approval, buyers, suppliers (manufacturer for now) and the 3PL take — and how far are they from SAP's planned lead time?
- Do V1 orders replenish to Max, or limp along in small top-ups?
- Where are we over-ordering (receipts landing above Max, arriving when not needed) and under-ordering (stockouts with nothing on order)?

All of it for any **segment** — drop-in tiles for movement quartile, unit cost, stock value, lead time, manufacturer, MRP type, material group, purchasing group, stock status, PR trigger — and any **time window**.

## Pages

```
index.html              Dashboard — saved datasets, open .json, clear this app's session data
intake/                 Intake — MB51 + Inventory Master + PR History → DQ gate → canonical JSON (Tune's intake, adapted)
workbench/              Workbench — segment builder + 15 views (distributions, month-on-month bands, volumes, heat map, materials table) + drill tables
material/               Material deep-dive — tailorable block stack on one time axis (stock · cadence · events · consumption · chains) + annual progression, bands, durations, crossings, order-to-Max, raw data
roadmap.html            Roadmap deck — shipped, queue (drag to reorder), decisions, data contract
record-of-change.html   Every push, what changed, how to roll back
user-manual.html        Operator manual
```

## Shared modules (`shared/`)

```
perf-engine.js          NEW — population engine: PR→PO→3PL→site chains (signed durations), daily stock rebuild,
                        trigger crossings / exposure / stockouts, V1 order-to-Max, receipts vs Min/Max, reorder
                        frequency, daily MRP / trigger-debt series, cohorts with open items as lower bounds, parity check
perf-charts.js          NEW — SVG histogram / month-on-month band / annual chevrons / per-month boxes / time bars / stacked columns (validated palette)
perf-ui.js              NEW — shared sortable table + CSV, toast, cross-page navigation (drill list → deep-dive Prev / Next → back to the Workbench)
perf.css                NEW — app styles on top of the Calibre brand tokens
canonical-schema.js     borrowed · PERF-INT-TYPE (scPerformance type, allMaterials scope, APP_NAME)
parsers.js              borrowed · PERF-ALIASES (Delivery Date, GR processing time, MB51 value / entry date / SLoc),
                        PERF-DATE-YMD (yyyymmdd dates), PERF-PARSE-FAST (header-only sheet pick)
storage.js              borrowed · PERF-STORE-NS (own 'mrpPerf' namespace — Tune shares the same site origin)
pipeline.js             borrowed · intake dependency; cache key renamed
inventory-back-calc.js  borrowed verbatim — the stock-rebuild sign rules the engine reads
trace-phase.js          borrowed verbatim — Trace's chain engine, used by the parity check
brand-tokens.css · locale.js · config.js   borrowed verbatim
```

## Running it

Serve the folder over HTTP (e.g. GitHub Pages, or `python -m http.server` in this folder) and open `index.html`. No build step; CDN libraries only (SheetJS, PapaParse) for the intake.

## Data

The app runs entirely in the browser. SAP extracts and datasets are **never committed** to this public repository (`.gitignore` excludes `.xlsx`, `.xls`, `.csv` and `.json`).
