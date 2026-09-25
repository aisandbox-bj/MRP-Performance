# Backlog — Calibre MRP Performance

## ✅ SHIPPED — v0.1.0-dev (2026-09-25) — browser-verified, pending operator off-repo validation
See `record-of-change.html`. Intake (performance type), population engine with parity check, 13 distribution views, material segments, KPI target slots, data checks.

**Verified in the browser:** real June 2026 assessment (331 materials, 2,351 PR lines, 15,002 movements) — all views render, zero console errors, with and without a segment; parity 2,351/2,351 chains vs Trace and 275/275 stock series vs Tune's back-calc; raw SAP extracts (PR History + MB51 xlsx for one material + a one-row Inventory Master CSV) through Intake → Save → Workbench, need-by dates read on 100% of PR lines; ×30 synthetic scale set built by the engine in ~1.8 s.
**Not verified yet:** a real 150–500k-line extract end to end through the Intake (parse time, storage size) — the operator reports Tune's intake handles very large files; the engine side is proven at 450k synthetic lines.

## NEXT
1. **Operator validation on real extracts** — timings, anything that looks wrong, which views earn their place.

## BLOCKED — needs a decision
- **PERF-107** — confirm what 107 means at this site. Built on 107 = arrived at the 3PL (operator 2026-09-25, Trace skill spec). Tune's `inventory-back-calc.js` records (2026-05-16) "101 = GR at 3PL; 107 = shipping from 3PL toward site". Test data: 351/391 POs go 107 → 109 (median 7 d); 101 only on 4800-series stock-transfer POs with 641. If 107 is the dispatch, the "3PL" leg = transit only and 3PL dwell sits in the supplier leg.
- **PERF-PAGES** — publish on GitHub Pages (repository setting) — operator's OK needed.

## PENDING
- **PERF-SEG-SAVE** — save / name segments; compare two segments side by side (small multiples).
- **PERF-TRACK** — scorecard snapshots to a file (per-leg distributions + KPI targets); run-over-run comparison.
- **PERF-ROOT** — stockout root-cause attribution to the leg that broke (no trigger / late trigger / approval / buyer / supplier / 3PL / Min too low for lead time).
- **PERF-PD-DEMAND** — PD without SS is demand-driven; add IW39 / reservation data to measure demand → PR and "job waited for the part".
- **PERF-SPLIT** — split deliveries (107 / 109 lines per PO) and qty fill (received vs PR qty) per manufacturer.
- **PERF-LAG** — posting lag / back-dating (Entry Date vs Posting Date, now captured).

## FUTURE
- **PERF-STO** — 641 → 101 stock-transfer in transit counted as cover.
- **PERF-WORKER** — move the engine to a Web Worker if real builds stall the page.
- **PERF-REPORT** — reporting module (PDF / Excel scorecard) — operator: workbench first.
- **PERF-VENDOR** — real vendor + PO data (MB51 Vendor column or PO extract) — "next phase, if ever".
- **PERF-MINMAX-HIST** — historical Min / Max from material-master change documents.

## Notes carried from the build
- Trace's `computeChains` clamps negative durations to 0 and takes the FIRST 107 / 109 per PO (its skill spec says qty-weighted for split deliveries). This engine keeps signed values; "first" kept for parity.
- Trace's cadence view counts same-day MRP churn as "Cancelled"; this app separates churn from genuine cancellation (Tune not changed — operator rule).
- Tune's parser turns the PR "Delivery Date" (`20250608`) into blank — fixed here (PERF-DATE-YMD), not in Tune.
