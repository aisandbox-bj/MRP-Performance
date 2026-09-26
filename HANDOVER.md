# HANDOVER — Calibre Mirror (formerly Calibre MRP Performance)

## Where things are
- **Repo:** `aisandbox-bj/Calibre-Mirror` (public; renamed from `MRP-Performance` 2026-09-26 — the old URL redirects). Repo root mirrors the local dev folder `4 - Build Output/MRP Performance/v0.3.0-dev/` in the Calibre project folder (the local folder keeps its old name for now — it was in use during the rename; `v0.2.0-dev/` and `v0.1.0-dev/` beside it are frozen rollback copies).
- **Current version:** `v0.3.0-dev`. Push with `push-calibre-mirror.sh` (beside the version folders).
- **Browser storage namespace stays `mrpPerf` / `mrpPerfApp`** after the rename, so saved datasets and settings carry over. `SCHEMA_VERSION` 1.0.0 (same canonical JSON as Calibre Tune — additive fields only).
- **The newest `record-of-change.html` entry** is the source of truth for what's on `origin/main` — don't hard-pin a SHA in docs.

## Push protocol (DO NOT DEVIATE)
- **Never** run `git init` in the working folder. It is a plain folder, not a repo.
- Clone to a temporary folder, copy the dev folder's files in, commit with explicit identity flags, push:
  ```
  git -C <tmp>/push-Calibre-Mirror -c user.name='aisandbox-bj' -c user.email='aisandbox-bj@users.noreply.github.com' commit -m "..."
  ```
- Use `git add -A` so new files aren't missed.
- **Before every push** (change management):
  1. Local snapshot of what is about to change → `4 - Build Output/MRP Performance/_rollback/<CHUNK>-pre/`.
  2. Record of Change entry written (what changed, files, rollback, what's still open).
  3. On the clone, at the current `origin/main`: create and push `backup/pre-<chunk>` (branch) and `checkpoint/pre-<chunk>` (annotated tag, identity flags).
  4. Commit + push `main`.
- Annotated tags need identity flags too. Never delete tags or force-push `main` without the operator asking.
- Refresh `PROVENANCE.md` hashes when a borrowed file changes.

## Things NOT to do without asking
- **Touch Calibre Tune / Trace** (`4 - Build Output/Inventory Optimization App/`, repo `Inventory_Optimization`) — operator: "leave them alone". Borrowed modules are copies; improvements go here, tagged `PERF-*`.
- **Write to Tune's browser storage.** Both apps are served from `aisandbox-bj.github.io` — one storage per site. This app uses the `mrpPerf` / `mrpPerfApp` namespace only, never loads Tune's `analyst-marks.js`, never writes `invOpt.*` or `tune.analyst.*`.
- **Commit data.** Public repo — `.gitignore` excludes spreadsheets and JSON; keep test datasets in `_dev/testdata/` beside the repo folder.
- **Bump `SCHEMA_VERSION`** — the contract is shared with Tune.
- **Replace a distribution with an average**, or drop still-open / out-of-sequence items from a chart (operator rule: distributions, both tails drill-able; never hide issues).
- **Enable GitHub Pages or change repo settings** without the operator's OK.

## Verification
- No Node on the build machine — verify in the browser. `.claude/launch.json` → config `mrp-perf` serves the whole project folder on port 8781.
- Data checks → **Run parity check**: chains vs Trace's `computeChains`, stock vs `InventoryBackCalc.backCalcSOH`. Must be N/N identical.
- Scale reference: 450k MB51 lines / 70k PR lines / 9,930 materials builds in ~1.8 s (synthetic ×30 set).

## Open questions
See `roadmap.html` → Decisions, and `Backlog.md`. Headline: **what MB51 107 means at this site** (arrival at 3PL vs dispatch from 3PL).
