/* ═══ BUILD-STAMP ═══════════════════════════════════════════════════════════
   Inventory Optimization App · v2.1.0 · released 2026-05-12
   Config helpers — read / write Settings (parameter defaults, LLM config,
   prompt template, column-alias overrides). Sits on top of AppStorage.

   NOTE: This module only persists SETTINGS (defaults, keys, prompts, aliases).
   LLM REVIEW DATA (single + mass) is NEVER persisted anywhere by design —
   v2.0 data-security posture is in-memory only, with download-and-wipe.

   v2.1.0: factory prompt template restructured to a signal-aware,
   structured-JSON-response format. Operators on the previous (v2.0.x)
   factory default are silently auto-upgraded; customised templates are
   left intact (operator can click Restore-factory to adopt v2.1.0 prompt).
═══════════════════════════════════════════════════════════════════════════ */

(function (global) {
  'use strict';

  const KEY_PARAMS     = 'settings.parameters';
  const KEY_ALIASES    = 'settings.columnAliases';
  const KEY_PROMPT     = 'settings.llm.promptTemplate';
  const KEY_PROMPT_V   = 'settings.llm.promptTemplateV';   // APP-LLM-V — enhanced "(v)" variant prompt
  const KEY_LLM        = (provider) => `settings.llm.${provider}`;
  const KEY_MULTIPLANT = 'settings.multiPlant';                       /* APP-T-01d — multi-plant opt-in toggle (default OFF per D25) */

  /* ─── Factory prompt template — placeholders resolved at call-time ────────
     v2.1.0: signal-aware, customer-context-prefixed, structured-JSON-response.
     Operators on the previous v2.0.x factory default are auto-upgraded; see
     LEGACY_FACTORY_PROMPT_TEMPLATE below + getPromptTemplate() upgrade logic. */
  const FACTORY_PROMPT_TEMPLATE =
`You are reviewing a consumption chart for an MRO inventory recommendation.

CUSTOMER CONTEXT:
{customerContext}

Material:       {material} — {description}
Bucket:         {bucket}
Pattern:        {pattern}

STATISTICS
  Total consumed (analysis window):       {totalNet}
  Consumption sign:                       {netSign}
  P1 rate (baseline, 5 mo):               {p1Rate} / mo  [{p1Flag}]
  P2 rate (current, {p2Months} mo):       {p2Rate} / mo  [{p2Flag}]
  P1 → P2 rate change:                    {rateChange}  {rateChangeFlag}
  Adjusted P2 (HCE excluded):             {adjP2}
  HCE events (P2):                        {hceText}
  Inv-Adj dates excluded (operator-confirmed): {invAdjCount}
  Days since last issue:                  {daysSinceLastIssue}
  Issuing WO count (analysis window):     {woCount}
  Last consumption date:                  {lastConsumptionDate}
  Stockouts in back-calc window:          {stockoutSummary}
  Drop cause (algorithmic):               {rateDropCause}

CURRENT MRP STATE
  MRP type:        {mrpType}
  Stock on hand:   {stock}
  Current Min:     {cmin}
  Current Max:     {cmax}
  Runway @ P2:     {runway} months

RECOMMENDATION (algorithmic)
  Recommended Min: {recMin}
  Recommended Max: {recMax}
  Recommended MRP: {recMrpType}
  Traffic light:   {trafficLight}
  Action:          {action}

The attached chart shows: orange step line = cumulative actual consumption;
cyan dashed = P1 trend; green dashed = P2 trend; amber dots = HCE work orders;
purple dashed verticals = operator-confirmed Inv-Adj exclusion dates;
violet line = stock on hand reconstructed from MB51 movements (RIGHT y-axis, units in stock — site WH unrestricted only; back-calc includes site receipts/issues, scrap/write-off, count variance, project issues, and subcontracting movements; 3PL receipts and bin/storage-location moves within plant are excluded; material-to-material and plant-to-plant transfers are read with their row-level sign);
red wash bands = stockout windows (stock at or below zero);
orange dashed vertical = "last consumption" marker (last date with a 261/201 issue).

WATCH FOR — name the specific signal if you see one:
  • STOCKOUT-DRIVEN DROP — Drop cause is STOCKOUT_DRIVEN: P2 rate fell because
    stock RAN OUT, not because demand softened. Look at the violet SOH line in
    the run-up to the orange "last consumption" marker — if SOH crashed to zero
    before consumption stopped, this is a REPLENISHMENT FAILURE, not a demand
    drop. Do NOT recommend lowering Min/Max — the material still has demand;
    the supply chain failed. Use signal "stockoutDriven".
  • NEGATIVE / FLOWING-BACK consumption — net ≤ 0 means returns exceed issues.
    Material is flowing back to stores. Min/Max recommendation may be moot —
    flag for planner review.
  • STEEP DROP in P2 vs P1 (≥40% decrease) when Drop cause = GENUINE_DEMAND_DROP
    — possible obsolescence, fleet retirement, or process change. Stock was
    available throughout — consumption fell anyway. Flag and ask the planner to
    verify the material is still in use.
  • SPIKE without HCE flag — a large step in the cumulative line with no amber
    dot. A single WO consumed a lot but didn't meet HCE thresholds.
  • LONG FLAT TAIL — consumption stopped recently, stock remains. Look at the
    last 30–60 days of the orange line. Cross-check the violet SOH line: if
    stock is healthy and consumption is flat, that's a genuine demand pause.
  • FEW EVENTS — woCount ≤ 2 means the rate is statistically unreliable.
  • PURPLE / Working Redundant — material with stock-runway beyond the
    configured threshold; algorithm already flagged this if the traffic light
    is PURPLE.

Reply with ONLY a JSON object on a single line — no prose around it, no
markdown fences:
{"verdict":"ok"|"tweak"|"review","signals":[<signal names>],"notes":"<one or two specific sentences>","suggestedEdits":[<optional>]}

Be SPECIFIC in notes — name the signal you saw (e.g. "Negative net consumption
in P2 — material flowing back to stores. Recommend planner verify before
applying any Min/Max change.") rather than generic statements.

verdict semantics:
  "ok"     — recommendation looks right given the chart
  "tweak"  — recommendation is close but a parameter change would improve it
  "review" — a planner needs to look at this manually

signals is an array of zero or more from:
  ["negativeNet","sharpDrop","sharpRise","stockoutDriven","spikeNoHce","flatTail","fewEvents","workingRedundant","seasonal","other"]

suggestedEdits is optional. Each edit is { "field":"recMin|recMax|trafficLight|action", "newValue":<value>, "rationale":"<why>" }.`;

  /* ─── APP-LLM-V · Enhanced "(v)" variant prompt ───────────────────────────
     The "(v)" review button uses this. Reframes the ask from "is the rec right"
     to "WHY does this need attention TODAY + WHAT to check", surfaces the
     batched-consumption + batch-coverage analysis, and forces the model to
     carry a number through to a consequence. Operator-editable separately. */
  const FACTORY_PROMPT_TEMPLATE_V =
`You are an MRO inventory planner reviewing a consumption chart and the algorithm's Min/Max recommendation. Do NOT describe the chart. Your job is to tell the planner WHY THIS MATERIAL NEEDS ATTENTION TODAY (or confirm it does not) and WHAT TO CHECK to make the recommendation right.

CUSTOMER CONTEXT:
{customerContext}

Material:       {material} — {description}
Bucket:         {bucket}
Pattern:        {pattern}

STATISTICS
  Total consumed (analysis window):       {totalNet}
  Consumption sign:                       {netSign}
  P1 rate (baseline, 5 mo):               {p1Rate} / mo  [{p1Flag}]
  P2 rate (current, {p2Months} mo):       {p2Rate} / mo  [{p2Flag}]
  P1 → P2 rate change:                    {rateChange}  {rateChangeFlag}
  Adjusted P2 (HCE excluded):             {adjP2}
  Per-event draw (all issues incl. CC):   median {perEventMedian}, mean {perEventMean} ± {perEventStd} over {perEventN} events
  Batch draw (work orders only, CC excl.): median {batchMedian}, mean {batchMean} ± {batchStd} over {batchN} job draws
  Batch coverage vs recommended Min:       {batchCoverage}
  HCE events (P2):                        {hceText}
  Inv-Adj dates excluded (operator-confirmed): {invAdjCount}
  Days since last issue:                  {daysSinceLastIssue}
  Issuing WO count (analysis window):     {woCount}
  Last consumption date:                  {lastConsumptionDate}
  Stockouts in back-calc window:          {stockoutSummary}
  Drop cause (algorithmic):               {rateDropCause}

CURRENT MRP STATE
  MRP type:  {mrpType}   Stock on hand: {stock}   Current Min: {cmin}   Current Max: {cmax}   Runway @ P2: {runway} months

RECOMMENDATION (algorithmic)
  Recommended Min: {recMin}   Recommended Max: {recMax}   Recommended MRP: {recMrpType}
  Traffic light:   {trafficLight}   Action: {action}

Chart: orange step = cumulative consumption; cyan dashed = P1 trend; green dashed = P2 trend; amber dots = HCE work orders; violet line = back-calculated stock on hand (RIGHT axis); red wash bands = stockout windows (stock ≤ 0); orange dashed vertical = last-consumption marker.

WATCH FOR — name the signal AND carry its number through to a consequence:
  • STOCKOUT-DISTORTED RATE — if there are stockouts in the window, the P2 rate is UNDERSTATED (consumption stopped because stock ran out, not because demand fell). True demand is higher than {p2Rate}/mo. Do NOT recommend lowering Min/Max. signal "stockoutDriven".
  • BATCHED DEMAND — drawn in batches per job, not smoothly (compare the work-order batch MEDIAN {batchMedian} vs MEAN {batchMean}, and the step sizes). Cost-centre draws (shop consumables) are EXCLUDED from the batch figure. The rate-based Min assumes smooth withdrawal; if "Batch coverage" says BELOW or THIN, a single legitimate job draw cannot be filled even though the average looks fine — recommend raising Min to cover at least one typical batch. signal "batchedMinShort".
  • IMMINENT STOCKOUT — Runway @ P2 short ({runway} mo): "stock runs out in ~{runway} months at the current rate". signal "replenishmentGap".
  • NEGATIVE / FLOWING-BACK — net ≤ 0, returns exceed issues. signal "negativeNet".
  • GENUINE DEMAND DROP — Drop cause GENUINE_DEMAND_DROP, stock available throughout: possible obsolescence / fleet change. signal "sharpDrop".
  • Also: SPIKE without HCE, LONG FLAT TAIL, FEW EVENTS (woCount ≤ 2 → rate unreliable), WORKING REDUNDANT.

Reply with ONLY a JSON object on a single line — no prose, no markdown fences:
{"verdict":"ok"|"tweak"|"review","signals":[<signal names>],"notes":"<see below>","suggestedEdits":[<optional>]}

In "notes", answer in this order, each tied to a NUMBER from the data:
  1. WHY NOW — the single most time-relevant reason to look at this today (imminent stockout, a stockout distorting the rate, a batch the Min cannot cover, a genuine demand shift). If nothing is time-relevant, say "no action needed this cycle".
  2. WHAT TO CHECK — the one thing to look at or change to make the recommendation right.
Lead with the consequence, not the description. Do NOT restate the obvious ("consumption is steady", "normal part").

verdict: "ok" = right and nothing time-critical · "tweak" = a parameter change improves it (often raise Min to cover a batch) · "review" = a planner must look manually (stockout-distorted rate, negative net, demand collapse).

signals is zero or more from:
  ["stockoutDriven","batchedMinShort","replenishmentGap","negativeNet","sharpDrop","sharpRise","spikeNoHce","flatTail","fewEvents","workingRedundant","seasonal","other"]

suggestedEdits is optional. Each: { "field":"recMin|recMax|trafficLight|action", "newValue":<value>, "rationale":"<why>" }.`;

  /* ─── Legacy v2.0.x factory template, for auto-upgrade detection ──────────
     If a saved template matches this string EXACTLY, the operator was on the
     previous default and never customised. We silently upgrade to the new
     v2.1.0 factory by clearing the saved override. Customised templates
     (anything else) are left intact. */
  const LEGACY_FACTORY_PROMPT_TEMPLATE =
`You are reviewing a consumption chart for an MRO inventory recommendation.

Material:       {material} — {description}
Bucket:         {bucket}
Pattern:        {pattern}

STATISTICS
  Total consumed (analysis window):       {totalNet}
  P1 rate (baseline, 5 mo):               {p1Rate} / mo  [{p1Flag}]
  P2 rate (current, {p2Months} mo):       {p2Rate} / mo  [{p2Flag}]
  P1 → P2 rate change:                    {rateChange}
  Adjusted P2 (HCE excluded):             {adjP2}
  HCE events (P2):                        {hceText}
  Issuing WO count (analysis window):     {woCount}

CURRENT MRP STATE
  MRP type:        {mrpType}
  Stock on hand:   {stock}
  Current Min:     {cmin}
  Current Max:     {cmax}
  Runway @ P2:     {runway} months

RECOMMENDATION (algorithmic)
  Recommended Min: {recMin}
  Recommended Max: {recMax}
  Recommended MRP: {recMrpType}
  Traffic light:   {trafficLight}
  Action:          {action}

The attached chart shows: orange step line = cumulative actual consumption;
cyan dashed = P1 trend; green dashed = P2 trend; amber dots/annotations = HCE work orders.

Your job is to look at the chart and the numbers together. Sanity-check the recommendation.
Look for: a P2 rate skewed by one HCE, a pattern that looks seasonal not steady,
a lumpy classification the planner should be told about, anomalies the algorithm missed,
and whether the few-events overlay (woCount ≤ 2) or Working Redundant (PURPLE) flag is
justified by what the chart actually shows.

Reply with ONLY a JSON object on a single line — no prose around it, no markdown fences:
{"verdict":"ok"|"tweak"|"review","notes":"<one or two sentences>","suggestedEdits":[<optional edits>]}

verdict semantics:
  "ok"     — recommendation looks right given the chart
  "tweak"  — recommendation is close but a parameter change would improve it
  "review" — a planner needs to look at this manually (seasonal, anomaly, etc.)

suggestedEdits is optional. Each edit is { "field":"recMin|recMax|trafficLight|action", "newValue":<value>, "rationale":"<why>" }.`;

  /* ─── Available placeholder names (used by Settings UI for documentation) ── */
  const PROMPT_PLACEHOLDERS = [
    'customerContext',
    'material', 'description', 'bucket', 'pattern',
    'totalNet', 'netSign',
    'p1Rate', 'p1Flag', 'p2Rate', 'p2Flag', 'p2Months', 'rateChange', 'rateChangeFlag', 'adjP2', 'hceText',
    'invAdjCount', 'daysSinceLastIssue', 'woCount',
    'mrpType', 'stock', 'cmin', 'cmax', 'recMin', 'recMax', 'recMrpType', 'runway',
    'trafficLight', 'action',
    // APP-E1 (v2.1.3) — stockout-aware drop diagnostic tokens
    'lastConsumptionDate', 'rateDropCause', 'stockoutSummary',
    // APP-LLM-V — batched-consumption tokens (enhanced "v" prompt)
    'perEventMedian', 'perEventMean', 'perEventStd', 'perEventN', 'batchCoverage',
    // APP-BATCH-WO — work-order-only batch tokens (cost-centre excluded)
    'batchMedian', 'batchMean', 'batchStd', 'batchN'
  ];

  /* ─── Parameter defaults (read with factory fallback) ───────────────────── */
  async function getDefaults(){
    const saved = await AppStorage.get(KEY_PARAMS);
    return Object.assign({}, CanonicalSchema.FACTORY_DEFAULTS, saved || {});
  }
  async function saveDefaults(obj){
    const allowed = Object.keys(CanonicalSchema.FACTORY_DEFAULTS);
    const clean   = {};
    for (const k of allowed) if (k in obj) clean[k] = obj[k];
    return AppStorage.set(KEY_PARAMS, clean);
  }
  async function resetDefaults(){
    return AppStorage.del(KEY_PARAMS);
  }

  /* ─── Multi-plant opt-in (APP-T-01d) ─────────────────────────────────────
     Default OFF per locked decision D25. When OFF, intake treats data as
     single-plant; first-match-wins resolves plant-conditional fields like
     openPO to the primary plant. When ON, future Intake sessions will offer
     a scope-picker (queued T-01e) and plant-conditional column selection
     (queued T-01f). In T-01d, this toggle only stores the preference — no
     parsing or analytical behaviour changes yet. */
  async function getMultiPlant(){
    const v = await AppStorage.get(KEY_MULTIPLANT);
    return v === true;
  }
  async function setMultiPlant(enabled){
    return AppStorage.set(KEY_MULTIPLANT, !!enabled);
  }

  /* ─── LLM provider config ───────────────────────────────────────────────── */
  async function getLlm(provider){
    const v = await AppStorage.get(KEY_LLM(provider));
    return v || { apiKey: '', model: '' };
  }
  async function saveLlm(provider, cfg){
    const { apiKey = '', model = '' } = cfg || {};
    return AppStorage.set(KEY_LLM(provider), { apiKey, model });
  }
  async function deleteLlm(provider){
    return AppStorage.del(KEY_LLM(provider));
  }

  /* ─── Prompt template (read with factory fallback) ──────────────────────── */
  async function getPromptTemplate(){
    const saved = await AppStorage.get(KEY_PROMPT);
    if (!saved || typeof saved !== 'string' || !saved.trim().length) return FACTORY_PROMPT_TEMPLATE;
    // v2.1.0 auto-upgrade: if saved EXACTLY matches the v2.0.x factory default,
    // the operator never customised — silently clear the override so the new
    // factory takes effect. Customised templates fall through unchanged.
    if (saved === LEGACY_FACTORY_PROMPT_TEMPLATE) {
      await AppStorage.del(KEY_PROMPT);
      return FACTORY_PROMPT_TEMPLATE;
    }
    return saved;
  }
  async function savePromptTemplate(text){
    return AppStorage.set(KEY_PROMPT, String(text || ''));
  }
  async function resetPromptTemplate(){
    return AppStorage.del(KEY_PROMPT);
  }
  /* True if the saved template is non-empty AND not equal to either the
     current or legacy factory — i.e. the operator has actively customised
     it. Settings UI uses this to show "factory updated" affordances. */
  async function isPromptTemplateCustomised(){
    const saved = await AppStorage.get(KEY_PROMPT);
    if (!saved || typeof saved !== 'string' || !saved.trim().length) return false;
    if (saved === FACTORY_PROMPT_TEMPLATE)        return false;
    if (saved === LEGACY_FACTORY_PROMPT_TEMPLATE) return false;
    return true;
  }

  /* ─── APP-LLM-V · the "(v)" variant prompt (own slot, factory fallback) ──── */
  async function getPromptTemplateV(){
    const saved = await AppStorage.get(KEY_PROMPT_V);
    if (!saved || typeof saved !== 'string' || !saved.trim().length) return FACTORY_PROMPT_TEMPLATE_V;
    return saved;
  }
  async function savePromptTemplateV(text){ return AppStorage.set(KEY_PROMPT_V, String(text || '')); }
  async function resetPromptTemplateV(){ return AppStorage.del(KEY_PROMPT_V); }
  async function isPromptTemplateVCustomised(){
    const saved = await AppStorage.get(KEY_PROMPT_V);
    return !!(saved && typeof saved === 'string' && saved.trim().length && saved !== FACTORY_PROMPT_TEMPLATE_V);
  }

  /* ─── Column alias overrides ────────────────────────────────────────────── */
  async function getAliases(){
    const v = await AppStorage.get(KEY_ALIASES);
    return v || {};
  }
  async function saveAliases(map){
    return AppStorage.set(KEY_ALIASES, map || {});
  }

  /* ─── Factory reset (wipes Settings only — not intake JSONs) ────────────── */
  async function factoryReset(){
    await resetDefaults();
    await AppStorage.del(KEY_ALIASES);
    await resetPromptTemplate();
    await resetPromptTemplateV();
    for (const p of ['anthropic', 'openai']) await deleteLlm(p);
  }

  /* ─── Clear session data (inverse of factoryReset) ───────────────────────
     Wipes every saved intake, the current-intake slot, and the intakes
     index — but PRESERVES every settings.* key (parameters, LLM keys,
     prompt template, column aliases).
     Returns the count of keys removed so the caller can confirm. */
  async function clearSessionData(){
    const allKeys = await AppStorage.keys();
    let removed = 0;
    for (const k of allKeys) {
      if (k.startsWith('settings.')) continue;
      await AppStorage.del(k);
      removed++;
    }
    return removed;
  }

  /* ─── Public API ────────────────────────────────────────────────────────── */
  global.AppConfig = Object.freeze({
    FACTORY_PROMPT_TEMPLATE,
    FACTORY_PROMPT_TEMPLATE_V,
    LEGACY_FACTORY_PROMPT_TEMPLATE,
    PROMPT_PLACEHOLDERS,
    getDefaults, saveDefaults, resetDefaults,
    getLlm, saveLlm, deleteLlm,
    getPromptTemplate, savePromptTemplate, resetPromptTemplate, isPromptTemplateCustomised,
    getPromptTemplateV, savePromptTemplateV, resetPromptTemplateV, isPromptTemplateVCustomised,
    getAliases, saveAliases,
    getMultiPlant, setMultiPlant,                                     /* APP-T-01d */
    factoryReset,
    clearSessionData
  });

})(window);
