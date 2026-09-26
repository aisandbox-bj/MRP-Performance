# Backlog — Calibre Mirror (formerly Calibre MRP Performance)

## ✅ SHIPPED — v0.3.0-dev (2026-09-26) — slice 1 of the operator's Mirror plan · browser-verified, pending operator validation
**The Mirror loop** (operator's thoughts, 2026-09-26 — saved verbatim in the project's `_Hand-over docs/Calibre Mirror - operator thoughts 2026-09-26.md`): phase box-and-whisker (completed solid, in flight hatched; stretched log scale by default, even days on request) → click a phase → its histogram with **Completed / In flight** switches → click a bar → drill list with quick filters (overdue vs need-by · below Min / SS now · stocked out now · continuous use = issued in ≥ 6 of the last 12 months · created by · MRP type · supplier · days ≥ N) → PR / PO lines ⇄ Materials → **Excel** (Lines · Materials · About). Rename to Calibre Mirror (repo `Calibre-Mirror`).

## NEXT — slice 2 · Aged POs and open PRs (operator 2026-09-26)
- **Aged POs** as a PO-level list (the PO is the tracking document), two sets: **with the supplier** (PO placed, no 107) and **blocked stock** (107, no 109 — at the 3PL). Age to the data date; 3PL tail (the "5–10 days typical, some 6 weeks+" case).
- **Open PRs** (no PO): days open to the data date; open PRs per material; flag **superseded** — a later PR on the same material became a PO whose qty covers it — vs genuinely stuck.

## PENDING — slice 3 · MRP PR cancelled → replaced by manual PR(s)
Pair each cancelled MRP PR with the manual PR(s) for the same material raised between its date and 7 days after its cancellation (Changed On); compare quantities; **flag when the manual total is more than 15% off** (tolerance a setting).

## PENDING — slice 4 · PERF-REPORT (was next; operator moved the Mirror loop ahead 2026-09-26)
See below.


## ✅ SHIPPED — v0.2.0-dev (2026-09-25) — browser-verified, pending operator off-repo validation
Material deep-dive (tailorable block stack, one time axis for stock · MRP cadence · events · consumption · chains; annual progression; month-on-month band; durations; crossings; order to Max; raw data incl. MB51 ledger) · drill → deep-dive with Prev / Next and Back-restores-state · month-on-month band charts replace the monthly boxes · annual progression on the Overview · PR / PO volume splits (MRP / manual · V1 / PD · outcome) · MRP-activity heat map · Materials table · no-PR 3PL cover. Parity re-checked (1,673/1,673 chains, 200/200 stock series).

## NEXT — PERF-REPORT (operator request 2026-09-25)
Report output on the deep-dive blocks (and Workbench cards): choose + order the graphs (e.g. stock graph with the MRP cadence underneath on the same time scale, then annual progression), then export as **US Letter (light)** or **widescreen 16:9 (light or dark)** with tiles you drag / resize / delete / add on a blank page → PDF. Heavy on graphics. Borrow the pattern from Tune's report builder (copy, don't touch Tune). Needs a light-theme chart palette (validate against white).

## ✅ SHIPPED — v0.1.0-dev (2026-09-25) — browser-verified, pending operator off-repo validation
See `record-of-change.html`. Intake (performance type), population engine with parity check, 13 distribution views, material segments, KPI target slots, data checks.

**Verified in the browser:** real June 2026 assessment (331 materials, 2,351 PR lines, 15,002 movements) — all views render, zero console errors, with and without a segment; parity 2,351/2,351 chains vs Trace and 275/275 stock series vs Tune's back-calc; raw SAP extracts (PR History + MB51 xlsx for one material + a one-row Inventory Master CSV) through Intake → Save → Workbench, need-by dates read on 100% of PR lines; ×30 synthetic scale set built by the engine in ~1.8 s.
**Not verified yet:** a real 150–500k-line extract end to end through the Intake (parse time, storage size) — the operator reports Tune's intake handles very large files; the engine side is proven at 450k synthetic lines.

## NEXT
1. **Operator validation on real extracts** — timings, anything that looks wrong, which views earn their place.

## RESOLVED
- **PERF-107** (2026-09-26) — operator: "3PL transfers — the difference between the dates of the 107 and the 109"; "blocked stock is when there's been a 107 but not a 109". So 107 = arrived at the 3PL (blocked stock), 109 = received at site — as built. Tune's back-calc note (107 = dispatch from 3PL) does not apply here. Original note kept below for the record:
- ~~PERF-107~~ — confirm what 107 means at this site. Built on 107 = arrived at the 3PL (operator 2026-09-25, Trace skill spec). Tune's `inventory-back-calc.js` records (2026-05-16) "101 = GR at 3PL; 107 = shipping from 3PL toward site". Test data: 351/391 POs go 107 → 109 (median 7 d); 101 only on 4800-series stock-transfer POs with 641. If 107 is the dispatch, the "3PL" leg = transit only and 3PL dwell sits in the supplier leg.

## BLOCKED — needs a decision
- **PERF-PAGES** — publish on GitHub Pages (repository setting) — operator's OK needed. (Repo renamed to Calibre-Mirror 2026-09-26 with the operator's OK; Pages still off.)

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
