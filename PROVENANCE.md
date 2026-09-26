# PROVENANCE — files borrowed from Calibre Tune

Calibre Mirror (formerly MRP Performance) reuses Calibre Tune's intake and data-engine modules so its numbers tie to Tune and Trace.
They are **copies** — Tune is never edited from here. Every local change carries a `PERF-*` tag in a comment so
a diff against the source shows exactly what differs.

- **Source:** `aisandbox-bj/Inventory_Optimization`, working folder `v2.2.0-dev` at `origin/main` **2896842** (copied 2026-09-25).
- **Pristine copies** of every borrowed file, exactly as copied, are kept beside the working folder in
  `_rollback/BORROWED-as-copied-from-tune-2896842/` (local, not in this repo) with `SHA256SUMS.txt`.
- **Refresh this table** whenever a borrowed file changes (current SHA-256 column). Last refreshed 2026-09-26 (v0.3.0-dev) — the PERF-NO-SHIFT intake changes of 2026-09-25 had not been recorded here until then.

| File | Status | Source SHA-256 (Tune 2896842) | Current SHA-256 | Local changes |
|---|---|---|---|---|
| `intake/intake.css` | modified | `ae4fb84e46ae37f4…` | `74f057ef6891809d…` | PERF-NO-SHIFT |
| `intake/intake.html` | modified | `1867a94341239740…` | `7aa22ebf9f423ca3…` | PERF-INT-TYPE, rename (Calibre Mirror) |
| `intake/intake.js` | modified | `e0def4ef21bf2dc7…` | `5002428dc8a188dd…` | PERF-INT-DQ, PERF-INT-FAST, PERF-INT-NAV, PERF-INT-TRIM, PERF-INT-TYPE, PERF-NO-SHIFT |
| `shared/brand-tokens.css` | verbatim | `2f0730a613560c3a…` | `2f0730a613560c3a…` | — |
| `shared/canonical-schema.js` | modified | `7e9e476a6e9c200c…` | `b16eb43751dbf5ff…` | PERF-INT-TYPE, rename (Calibre Mirror, v0.3.0-dev) |
| `shared/config.js` | verbatim | `594c45de4531a1c5…` | `594c45de4531a1c5…` | — |
| `shared/inventory-back-calc.js` | verbatim | `f04114e4f285ed4c…` | `f04114e4f285ed4c…` | — |
| `shared/locale.js` | verbatim | `86b558ba9646ad98…` | `86b558ba9646ad98…` | — |
| `shared/parsers.js` | modified | `c092f9b943dae32e…` | `52b85937d5d5b28f…` | PERF-ALIASES, PERF-DATE-YMD, PERF-PARSE-FAST |
| `shared/pipeline.js` | modified | `4e5235be41aa1628…` | `98004a4f1150c1f4…` | PERF-STORE-NS |
| `shared/storage.js` | modified | `4a2511269d47069a…` | `29b766281c9d2d06…` | PERF-STORE-NS (comment updated for the rename) |
| `shared/trace-phase.js` | verbatim | `bd7101a5c4ca8e13…` | `bd7101a5c4ca8e13…` | — |

## What the PERF tags mean

- **PERF-NO-SHIFT** — the column-mapping list of a fully-mapped file opens over the later steps instead of pushing them down (2026-09-25).
- **rename (Calibre Mirror)** — app name, titles and repo links only (2026-09-26); the storage namespace is unchanged.
- **PERF-STORE-NS** — own storage namespace `mrpPerf` / `mrpPerfApp` (Tune uses `invOpt`; both apps share the aisandbox-bj.github.io origin).
- **PERF-INT-TYPE** — the "Supply-chain performance" assessment type, `allMaterials` scope, `APP_NAME` metadata.
- **PERF-INT-DQ** — PR-History and receipt-path checks in the data-quality gate.
- **PERF-INT-TRIM** — trim keeps MB51 ∪ PR-History materials.
- **PERF-INT-NAV** — hands off to the Workbench.
- **PERF-INT-FAST** — JSON preview without deep-copying the dataset.
- **PERF-ALIASES** — PR Delivery Date + GR processing time; MB51 value, entry date, storage location.
- **PERF-DATE-YMD** — `yyyymmdd` dates (string or number) read correctly.
- **PERF-PARSE-FAST** — sheet chosen from its header row instead of converting every sheet twice.

## Upstream candidates (for Tune, only if the operator asks)

- PERF-DATE-YMD: Tune reads the PR "Delivery Date" (`20250608`) as blank.
- PERF-PARSE-FAST: Tune converts every sheet of an uploaded workbook to rows twice.
- PERF-INT-FAST: Tune's intake preview deep-copies the whole dataset on each keystroke in the name box.
