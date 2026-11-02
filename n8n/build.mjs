// Builds importable n8n workflows for the case:
//   CM-01_brief-to-shortlist.json  (Creator Match MVP, with demo data pinned so "Test workflow" runs without credentials)
//   OPS-01_error-handler.json      (assign as the Error workflow of CM-01)
// The Code-node logic below is executed locally against the demo data, so pinned outputs stay consistent with it.
// Node typeVersions were checked against n8n-nodes-base 2.15.1 (n8n 2.45.7).
import { writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const OUT = fileURLToPath(new URL('.', import.meta.url));

// ---------------------------------------------------------------- demo data
const brief = {
  Brand: 'Sunny Snacks (demo)',
  Product: 'Chili-lime potato chips, new SKU',
  Category: 'Food & snacks',
  Objective: 'Sales',
  'Target audience': '18-34, all genders, Bangkok and large cities',
  Platforms: ['TikTok', 'Instagram'],
  'Creator budget (THB)': 400000,
  'Creators needed': 5,
  Exclusions: 'No competitor snack brands in the last 90 days. No gambling content.',
  submittedAt: '2026-11-01T09:12:00.000+07:00',
  formMode: 'test',
};

const criteria = {
  category: 'Food & snacks',
  objective: 'sales',
  primary_kpi: 'cost_per_order',
  audience: { age_min: 18, age_max: 34, genders: ['all'], locations: ['Bangkok', 'Chiang Mai', 'Khon Kaen'] },
  platforms: ['tiktok', 'instagram'],
  budget_total_thb: 400000,
  creators_needed: 5,
  tone_keywords: ['spicy', 'playful', 'street food'],
  exclusions: { competitor_brands: ['competitor snack brands'], topics: ['gambling'] },
  missing_fields: [],
};

// Rows as BigQuery would return them (SQL already applied platform, category, consent and 90-day competitor filters)
const candidates = [
  { creator_id: 'c001', handle: '@demo.foodie.a', platform: 'tiktok', tier: 'mid', followers: 420000, audience_fit: 0.82, er: 6.1, er_tier_median: 4.0, campaigns_count: 6, perf_vs_benchmark: 1.28, est_rate_thb: 70000, data_age_days: 3, brand_safety_status: 'clear' },
  { creator_id: 'c002', handle: '@demo.mukbang.b', platform: 'tiktok', tier: 'macro', followers: 1600000, audience_fit: 0.74, er: 3.2, er_tier_median: 3.0, campaigns_count: 9, perf_vs_benchmark: 1.10, est_rate_thb: 95000, data_age_days: 12, brand_safety_status: 'clear' },
  { creator_id: 'c003', handle: '@demo.streetfood.c', platform: 'instagram', tier: 'micro', followers: 85000, audience_fit: 0.88, er: 7.4, er_tier_median: 4.8, campaigns_count: 1, perf_vs_benchmark: 1.45, est_rate_thb: 28000, data_age_days: 2, brand_safety_status: 'clear' },
  { creator_id: 'c004', handle: '@demo.homecook.d', platform: 'instagram', tier: 'mid', followers: 260000, audience_fit: 0.61, er: 3.9, er_tier_median: 3.6, campaigns_count: 4, perf_vs_benchmark: 0.95, est_rate_thb: 55000, data_age_days: 5, brand_safety_status: 'clear' },
  { creator_id: 'c005', handle: '@demo.gamer.e', platform: 'tiktok', tier: 'macro', followers: 2100000, audience_fit: 0.70, er: 5.0, er_tier_median: 3.0, campaigns_count: 3, perf_vs_benchmark: 1.05, est_rate_thb: 120000, data_age_days: 4, brand_safety_status: 'clear' },
  { creator_id: 'c006', handle: '@demo.campus.f', platform: 'tiktok', tier: 'micro', followers: 64000, audience_fit: 0.91, er: 8.2, er_tier_median: 4.8, campaigns_count: 0, perf_vs_benchmark: 1.0, est_rate_thb: 18000, data_age_days: 1, brand_safety_status: 'clear' },
  { creator_id: 'c007', handle: '@demo.lifestyle.g', platform: 'instagram', tier: 'mid', followers: 310000, audience_fit: 0.55, er: 2.4, er_tier_median: 3.6, campaigns_count: 5, perf_vs_benchmark: 0.88, est_rate_thb: 60000, data_age_days: 6, brand_safety_status: 'clear' },
  { creator_id: 'c008', handle: '@demo.spicy.h', platform: 'tiktok', tier: 'mid', followers: 510000, audience_fit: 0.79, er: 5.6, er_tier_median: 4.0, campaigns_count: 2, perf_vs_benchmark: 1.35, est_rate_thb: 78000, data_age_days: 9, brand_safety_status: 'review' },
  { creator_id: 'c009', handle: '@demo.travel.j', platform: 'instagram', tier: 'micro', followers: 120000, audience_fit: 0.72, er: 4.6, er_tier_median: 4.8, campaigns_count: 3, perf_vs_benchmark: 1.12, est_rate_thb: 35000, data_age_days: 4, brand_safety_status: 'clear' },
  { creator_id: 'c010', handle: '@demo.snackhaul.k', platform: 'tiktok', tier: 'nano', followers: 18000, audience_fit: 0.69, er: 9.8, er_tier_median: 6.0, campaigns_count: 1, perf_vs_benchmark: 0.92, est_rate_thb: 6000, data_age_days: 2, brand_safety_status: 'clear' },
];

// What the LLM judge returns per creator (Claude structured output, JSON in content[0].text)
const judgements = {
  '@demo.foodie.a': { brand_fit: 86, rationale: 'Snack reviews are about 40% of recent posts and followers ask where to buy (post 2026-10-12). Playful tone suits a chili-lime launch.', risk_flags: [], competitor_mentions: [], confidence: 'high' },
  '@demo.mukbang.b': { brand_fit: 71, rationale: 'Big food reach, but recent posts favor buffet challenges over packaged snacks (posts 2026-10-03, 2026-10-19).', risk_flags: ['format_fit_check'], competitor_mentions: [], confidence: 'medium' },
  '@demo.streetfood.c': { brand_fit: 81, rationale: 'Street-food discovery content; comments ask about flavors (post 2026-10-21). Small but highly engaged Bangkok audience.', risk_flags: [], competitor_mentions: [], confidence: 'medium' },
  '@demo.homecook.d': { brand_fit: 58, rationale: 'Family cooking content; snacks appear rarely in the last 12 posts.', risk_flags: [], competitor_mentions: [], confidence: 'medium' },
  '@demo.campus.f': { brand_fit: 78, rationale: 'Student-life food content with high saves (post 2026-10-25). No paid history yet, so performance is estimated.', risk_flags: ['no_campaign_history'], competitor_mentions: [], confidence: 'medium' },
  '@demo.lifestyle.g': { brand_fit: 49, rationale: 'Beauty and lifestyle focus; food appears in 1 of the last 12 posts.', risk_flags: [], competitor_mentions: [], confidence: 'high' },
  '@demo.spicy.h': { brand_fit: 84, rationale: 'Spicy food challenges match the product (post 2026-10-08). Two September posts include strong language.', risk_flags: ['brand_safety_review: language'], competitor_mentions: [], confidence: 'medium' },
  '@demo.travel.j': { brand_fit: 66, rationale: 'Travel-food mix; snack content is occasional (post 2026-10-15).', risk_flags: [], competitor_mentions: [], confidence: 'medium' },
  '@demo.snackhaul.k': { brand_fit: 74, rationale: 'Snack haul videos every week (post 2026-10-27); very high engagement for a nano creator.', risk_flags: ['small_reach'], competitor_mentions: ['mentions a rival chip brand in a 2026-08 haul'], confidence: 'medium' },
};

// ---------------------------------------------------------------- Code-node sources (run in n8n AND locally)
const CODE = {
  validate: `// Parse the LLM output (Claude: content[].text, OpenAI fallback: output_text) and check required fields
const r = $input.first().json;
if (r.stop_reason === 'refusal') throw new Error('Brief parser refused; route this brief to a human.');
const text = (r.content || []).find(b => b.type === 'text')?.text
  ?? r.output_text
  ?? (r.output || []).flatMap(o => o.content || []).find(c => c.type === 'output_text')?.text;
let criteria;
try { criteria = JSON.parse(text); } catch (e) { throw new Error('Brief parser returned invalid JSON: ' + e.message); }
const required = ['category', 'objective', 'platforms', 'budget_total_thb', 'creators_needed'];
const missing = required.filter(k => criteria[k] === undefined || criteria[k] === null || (Array.isArray(criteria[k]) && criteria[k].length === 0));
return [{ json: { ...criteria, missing_fields: [...new Set([...(criteria.missing_fields || []), ...missing])], request_id: $execution.id } }];`,

  score: `// Hard filters, then tier-normalized quantitative scores (0-100). Top N go to the LLM judge.
const crit = $('Validate criteria').first().json;
const perCreator = crit.budget_total_thb / crit.creators_needed;
const K = 3; // Bayesian shrinkage: creators with few campaigns are pulled toward benchmark (1.0), so newcomers aren't over- or under-rated
const BENCH_CPE = 3.0; // THB per engagement for this category; production reads it from marts.tier_benchmarks
const clamp = (x, lo = 0, hi = 100) => Math.max(lo, Math.min(hi, x));
const round1 = x => Math.round(x * 10) / 10;
const scored = $input.all().map(i => i.json)
  .filter(c => c.brand_safety_status !== 'blocked' && c.est_rate_thb <= 1.2 * perCreator)
  .map(c => {
    const shrunk = (c.campaigns_count * c.perf_vs_benchmark + K * 1.0) / (c.campaigns_count + K);
    const history = clamp((shrunk - 0.6) * 100);              // 0.6x benchmark = 0, 1.6x = 100
    const engagement = clamp((c.er / c.er_tier_median) * 50);  // tier median = 50, 2x median = 100
    const perf_score = round1(0.7 * history + 0.3 * engagement);
    const audience_score = round1(clamp(c.audience_fit * 100));
    const cpe = c.est_rate_thb / (c.followers * c.er / 100);   // THB per expected engagement
    const cost_score = round1(clamp(50 * BENCH_CPE / cpe));    // benchmark CPE = 50, half the CPE = 100
    const pre_score = round1(0.4 * perf_score + 0.35 * audience_score + 0.25 * cost_score);
    return { ...c, perf_score, audience_score, cost_score, pre_score, data_as_of: c.data_age_days > 7 ? 'refreshing' : 'fresh' };
  })
  .sort((a, b) => b.pre_score - a.pre_score)
  .slice(0, 8); // production: top 20
return scored.map(c => ({ json: c }));`,

  merge: `// Pair each LLM judgement with its creator. Failed calls become "not assessed" instead of blocking the shortlist.
const creators = $('Refresh stale profiles (CM-02)').all();
return $input.all().map((item, i) => {
  const p = Array.isArray(item.pairedItem) ? item.pairedItem[0] : item.pairedItem;
  const c = (creators[p?.item ?? i] ?? creators[i]).json;
  let judge = { brand_fit: null, rationale: 'Brand fit not assessed (LLM error). Quantitative score only.', risk_flags: ['not_assessed'], competitor_mentions: [], confidence: 'low' };
  if (!item.json.error) {
    try { judge = JSON.parse((item.json.content || []).find(b => b.type === 'text').text); } catch (e) { /* keep fallback */ }
  }
  return { json: { ...c, ...judge } };
});`,

  rank: `// Starting weights by objective. Calibrated with CDs in the pilot, then against campaign outcomes (deck appendix A5).
const WEIGHTS = {
  sales:      { perf: 0.35, audience: 0.25, brand: 0.20, cost: 0.20 },
  awareness:  { perf: 0.20, audience: 0.35, brand: 0.25, cost: 0.20 },
  engagement: { perf: 0.25, audience: 0.25, brand: 0.30, cost: 0.20 },
};
const crit = $('Validate criteria').first().json;
const w = WEIGHTS[crit.objective] ?? WEIGHTS.sales;
const ranked = $input.all().map(i => i.json).map(c => {
  const brand = c.brand_fit ?? c.audience_score; // not assessed: audience fit stands in, and the row keeps its not_assessed flag
  const match_score = Math.round(w.perf * c.perf_score + w.audience * c.audience_score + w.brand * brand + w.cost * c.cost_score);
  return { ...c, match_score };
}).sort((a, b) => b.match_score - a.match_score);
// Budget fit: take the best-ranked creators whose combined rates stay within the creator budget
const N = Math.min(crit.creators_needed, ranked.length);
const picks = [];
let spent = 0;
for (const c of ranked) {
  if (picks.length === N) break;
  if (spent + c.est_rate_thb <= crit.budget_total_thb) { picks.push(c); spent += c.est_rate_thb; }
}
// Diversity rule: keep at least one rising (micro or nano) creator among the picks
const isRising = c => ['micro', 'nano'].includes(c.tier);
if (picks.length && !picks.some(isRising)) {
  const rising = ranked.find(c => isRising(c) && !picks.includes(c));
  const last = picks[picks.length - 1];
  if (rising && spent - last.est_rate_thb + rising.est_rate_thb <= crit.budget_total_thb) picks[picks.length - 1] = rising;
}
const alternates = ranked.filter(c => !picks.includes(c)).slice(0, 3);
// Flags are shown with a reason, never silently dropped
return [...picks.map(c => ({ ...c, pick: 'recommended' })), ...alternates.map(c => ({ ...c, pick: 'alternate' }))]
  .map((c, i) => ({ json: { rank: i + 1, ...c } }));`,

  rows: `// One row per creator for the shortlist Sheet; Decision and Reason are filled in by the strategist
const sheetId = $('Drive: copy shortlist template').first().json.id;
return $('Rank + hard rules').all().map(({ json: c }) => ({ json: {
  sheet_id: sheetId,
  Rank: c.rank,
  Pick: c.pick,
  Creator: c.handle,
  Platform: c.platform,
  Tier: c.tier,
  'Match score': c.match_score,
  Performance: Math.round(c.perf_score),
  'Audience fit': Math.round(c.audience_score),
  'Brand fit': c.brand_fit ?? 'not assessed',
  'Cost efficiency': Math.round(c.cost_score),
  Why: c.rationale,
  'Risk flags': (c.risk_flags || []).join(', ') || 'none',
  'Est. rate (THB)': c.est_rate_thb,
  Decision: '',
  Reason: '',
} }));`,

  classify: `// Classify the failure so ops knows whether to wait, retry, or fix a token
const e = $input.first().json;
const msg = e.execution?.error?.message ?? '';
const status = Number((msg.match(/\\b(4\\d\\d|5\\d\\d)\\b/) || [])[1]) || null;
const retryable = [408, 429, 500, 502, 503, 504, 529].includes(status) || /timeout|ETIMEDOUT|ECONNRESET/i.test(msg);
const category = (status === 401 || status === 403 || /code 190|access token/i.test(msg)) ? 'auth: reconnect needed'
  : retryable ? 'transient: will retry' : 'permanent: needs a human';
return [{ json: {
  workflow: e.workflow?.name, node: e.execution?.lastNodeExecuted, message: msg, http_status: status,
  category, retryable, execution_url: e.execution?.url, retry_count: 0,
  next_retry_at: retryable ? new Date(Date.now() + 5 * 60 * 1000).toISOString() : null,
} }];`,
};

// ---------------------------------------------------------------- local runner (shims n8n globals)
// Executes only the CODE constants defined above in this file (no external input), to compute consistent demo pinData.
const runs = {};
function runCode(name, src, input) {
  const $input = { all: () => input, first: () => input[0] };
  const $ = n => ({ all: () => runs[n], first: () => runs[n][0] });
  const out = new Function('$input', '$', '$execution', src)($input, $, { id: 'demo-001' });
  runs[name] = out;
  return out;
}
const asItems = arr => arr.map(json => ({ json }));
const claudeMessage = (obj, usage) => ({ id: 'msg_demo', type: 'message', role: 'assistant', model: 'claude-sonnet-5-5', content: [{ type: 'text', text: JSON.stringify(obj) }], stop_reason: 'end_turn', usage });

runs['Creator brief (form)'] = asItems([brief]);
runs['Claude: parse brief'] = asItems([claudeMessage(criteria, { input_tokens: 4812, output_tokens: 1630 })]);
runCode('Validate criteria', CODE.validate, runs['Claude: parse brief']);
runs['BigQuery: get candidates'] = asItems(candidates);
const scored = runCode('Score + pre-filter', CODE.score, runs['BigQuery: get candidates']);
runs['Refresh stale profiles (CM-02)'] = scored.map(i => ({ json: { ...i.json, data_as_of: '2026-11-01' } }));
runs['Claude: brand-fit judge'] = runs['Refresh stale profiles (CM-02)'].map(i => ({ json: claudeMessage(judgements[i.json.handle], { input_tokens: 2950, output_tokens: 980 }) }));
runCode('Merge judgements', CODE.merge, runs['Claude: brand-fit judge']);
const ranked = runCode('Rank + hard rules', CODE.rank, runs['Merge judgements']);
runs['Drive: copy shortlist template'] = asItems([{ id: '1DemoShortlistSheetId', name: 'Shortlist - Sunny Snacks (demo) - 2026-11-01', mimeType: 'application/vnd.google-apps.spreadsheet' }]);
const rows = runCode('Prepare sheet rows', CODE.rows, runs['Drive: copy shortlist template']);

const errorSample = { execution: { id: '231', url: 'https://n8n.example.com/workflow/cm01/executions/231', error: { message: 'The service is receiving too many requests from you (HTTP 429)' }, lastNodeExecuted: 'Claude: brand-fit judge', mode: 'trigger' }, workflow: { id: 'cm01', name: 'CM-01 Creator Match: brief to shortlist' } };
const classified = runCode('Classify error', CODE.classify, asItems([errorSample]));

// ---------------------------------------------------------------- workflow builder helpers
const node = (name, type, typeVersion, position, parameters = {}, extra = {}) => ({ parameters, id: randomUUID(), name, type, typeVersion, position, ...extra });
const sticky = (name, content, position, width, height, color) => node(name, 'n8n-nodes-base.stickyNote', 1, position, { content, height, width, color });
const link = (to, index = 0) => ({ node: to, type: 'main', index });
const RETRY = { retryOnFail: true, maxTries: 3, waitBetweenTries: 5000 };
const ifNode = (name, position, leftValue, operator, rightValue = '') => node(name, 'n8n-nodes-base.if', 2.2, position, {
  conditions: { options: { caseSensitive: true, leftValue: '', typeValidation: 'loose', version: 2 }, conditions: [{ id: randomUUID(), leftValue, rightValue, operator }], combinator: 'and' },
  looseTypeValidation: true, options: {},
});
const headerAuth = { authentication: 'genericCredentialType', genericAuthType: 'httpHeaderAuth' };
const RL = (value, mode = 'id') => ({ __rl: true, value, mode });
const PROJECT = RL('tls-data-ai');

const CRITERIA_SCHEMA = {
  type: 'object',
  properties: {
    category: { type: 'string' },
    objective: { type: 'string', enum: ['awareness', 'engagement', 'sales'] },
    primary_kpi: { type: 'string' },
    audience: { type: 'object', properties: { age_min: { type: 'integer' }, age_max: { type: 'integer' }, genders: { type: 'array', items: { type: 'string' } }, locations: { type: 'array', items: { type: 'string' } } }, required: ['age_min', 'age_max', 'genders', 'locations'], additionalProperties: false },
    platforms: { type: 'array', items: { type: 'string' } },
    budget_total_thb: { type: 'number' },
    creators_needed: { type: 'integer' },
    tone_keywords: { type: 'array', items: { type: 'string' } },
    exclusions: { type: 'object', properties: { competitor_brands: { type: 'array', items: { type: 'string' } }, topics: { type: 'array', items: { type: 'string' } } }, required: ['competitor_brands', 'topics'], additionalProperties: false },
    missing_fields: { type: 'array', items: { type: 'string' } },
  },
  required: ['category', 'objective', 'primary_kpi', 'audience', 'platforms', 'budget_total_thb', 'creators_needed', 'tone_keywords', 'exclusions', 'missing_fields'],
  additionalProperties: false,
};
const JUDGE_SCHEMA = {
  type: 'object',
  properties: {
    brand_fit: { type: 'integer' },
    rationale: { type: 'string' },
    risk_flags: { type: 'array', items: { type: 'string' } },
    competitor_mentions: { type: 'array', items: { type: 'string' } },
    confidence: { type: 'string', enum: ['low', 'medium', 'high'] },
  },
  required: ['brand_fit', 'rationale', 'risk_flags', 'competitor_mentions', 'confidence'],
  additionalProperties: false,
};
const PARSE_SYSTEM = 'You turn a client brief into structured campaign criteria for The Lemon Shot. Extract only what is stated. If something is unknown, give your best neutral value and list the field in missing_fields. Never invent budgets or KPIs. Briefs may be in Thai or English.';
const JUDGE_SYSTEM = 'You judge creator-brand fit for a Thai creator agency. Use only the brief and the creator data provided. brand_fit is 0-100. Cite post dates or permalinks in the rationale (max 40 words). Flag brand-safety and competitor issues; never hide them. Never invent numbers. Thai and English captions are both normal.';

const parseBody = `={{ JSON.stringify({
  model: 'claude-sonnet-5-5',
  max_tokens: 4000,
  output_config: { effort: 'low', format: { type: 'json_schema', schema: ${JSON.stringify(CRITERIA_SCHEMA)} } },
  system: ${JSON.stringify(PARSE_SYSTEM)},
  messages: [{ role: 'user', content: 'BRIEF FORM: ' + JSON.stringify($('Creator brief (form)').first().json) + ($json.text ? '\\nBRIEF DOCUMENT:\\n' + $json.text : '') }]
}) }}`;
const fallbackBody = `={{ JSON.stringify({
  model: 'gpt-6.1-sol',
  input: [
    { role: 'system', content: ${JSON.stringify(PARSE_SYSTEM)} },
    { role: 'user', content: 'BRIEF FORM: ' + JSON.stringify($('Creator brief (form)').first().json) }
  ],
  text: { format: { type: 'json_schema', name: 'brief_criteria', strict: true, schema: ${JSON.stringify(CRITERIA_SCHEMA)} } }
}) }}`;
const judgeBody = `={{ JSON.stringify({
  model: 'claude-sonnet-5-5',
  max_tokens: 3000,
  output_config: { effort: 'medium', format: { type: 'json_schema', schema: ${JSON.stringify(JUDGE_SCHEMA)} } },
  system: ${JSON.stringify(JUDGE_SYSTEM)},
  messages: [{ role: 'user', content: 'BRIEF: ' + JSON.stringify($('Validate criteria').first().json) + '\\nCREATOR: ' + JSON.stringify({ handle: $json.handle, platform: $json.platform, tier: $json.tier, recent_captions: $json.recent_captions, content_tags: $json.content_tags, past_brands: $json.past_brands, sentiment: $json.comment_sentiment }) }]
}) }}`;

const CANDIDATE_SQL = `-- GoogleSQL. Hard rules run here, before any AI.
DECLARE criteria JSON DEFAULT PARSE_JSON(@criteria_json);
SELECT c.creator_id, c.handle, c.platform, c.tier, m.followers,
       a.audience_fit, m.er, b.er_tier_median,
       p.campaigns_count, p.perf_vs_benchmark, c.est_rate_thb,
       DATE_DIFF(CURRENT_DATE(), m.snapshot_date, DAY) AS data_age_days,
       c.brand_safety_status, t.recent_captions, t.content_tags, p.past_brands, t.comment_sentiment
FROM marts.dim_creator c
JOIN marts.creator_metrics_latest m USING (creator_id)
JOIN marts.creator_audience_fit a USING (creator_id)
JOIN marts.tier_benchmarks b ON b.platform = c.platform AND b.tier = c.tier
LEFT JOIN marts.creator_performance p USING (creator_id)
LEFT JOIN marts.creator_content_tags t USING (creator_id)
WHERE c.platform IN UNNEST(JSON_VALUE_ARRAY(criteria.platforms))
  AND c.consent_status != 'revoked'
  AND c.brand_safety_status != 'blocked'
  AND NOT EXISTS (SELECT 1 FROM marts.creator_brand_history h
                  WHERE h.creator_id = c.creator_id AND h.is_competitor_of = @brand
                    AND h.posted_at > DATE_SUB(CURRENT_DATE(), INTERVAL 90 DAY))
ORDER BY a.audience_fit DESC
LIMIT 60`;

// ---------------------------------------------------------------- CM-01
const Y = 300;
const cm01Nodes = [
  sticky('Note: 1 Intake', '## 1 · Intake\nForm (or PDF brief) → Claude turns it into **criteria JSON** with structured outputs → validate.\nMissing fields? Ask the requester in Slack instead of guessing.\n**Fallback:** if Claude errors after 3 tries, the error output calls OpenAI.', [-80, -40], 1840, 760, 7),
  sticky('Note: 2 Retrieve and score', '## 2 · Retrieve & score\nBigQuery applies the **hard rules** (consent, blocked, 90-day competitor work).\nCode scores performance (Bayesian-shrunk history + engagement vs tier), audience fit and cost. Stale profiles refresh via CM-02.', [1780, -40], 700, 760, 5),
  sticky('Note: 3 Judge', '## 3 · Judge (LLM)\nClaude rates brand fit per creator: score, cited rationale, risk flags. Batches of 5, 1 s apart. A failed call becomes **"not assessed"**; it never blocks the shortlist.', [2500, -40], 480, 760, 4),
  sticky('Note: 4 Deliver and learn', '## 4 · Deliver & learn\nWeighted rank by objective + diversity rule → shortlist Sheet → **Slack approval** (restricted approvers). Approved picks feed Proposal Copilot; every decision and override is logged as feedback.', [3000, -40], 1620, 760, 6),
  sticky('Note: reliability', '### Reliability on every API node\nRetry 3x, 5 s apart · timeout 60 s (LLM) · error output or "not assessed" path · Error workflow = **OPS-01** (Slack #ai-ops alert + dead-letter table + backoff retries).\n_Demo: data is pinned, so "Test workflow" runs without credentials._', [-80, 760], 1000, 220, 3),

  node('Creator brief (form)', 'n8n-nodes-base.formTrigger', 2.2, [0, Y], {
    formTitle: 'Creator Match: new brief',
    formDescription: 'Your shortlist arrives in Slack in about 5 minutes.',
    formFields: { values: [
      { fieldLabel: 'Brand', requiredField: true },
      { fieldLabel: 'Product', requiredField: true },
      { fieldLabel: 'Category', requiredField: true },
      { fieldLabel: 'Objective', fieldType: 'dropdown', fieldOptions: { values: [{ option: 'Awareness' }, { option: 'Engagement' }, { option: 'Sales' }] }, requiredField: true },
      { fieldLabel: 'Target audience', fieldType: 'textarea', requiredField: true },
      { fieldLabel: 'Platforms', fieldType: 'dropdown', fieldOptions: { values: [{ option: 'TikTok' }, { option: 'Instagram' }, { option: 'YouTube' }, { option: 'Facebook' }] }, multiselect: true, requiredField: true },
      { fieldLabel: 'Creator budget (THB)', fieldType: 'number', requiredField: true },
      { fieldLabel: 'Creators needed', fieldType: 'number', requiredField: true },
      { fieldLabel: 'Exclusions', fieldType: 'textarea' },
      { fieldLabel: 'brief_file', fieldType: 'file', multipleFiles: false, acceptFileTypes: '.pdf' },
    ] },
    options: {},
  }, { webhookId: randomUUID() }),
  ifNode('Brief file attached?', [240, Y], '={{ Object.keys($binary || {}).length > 0 }}', { type: 'boolean', operation: 'true', singleValue: true }),
  node('Extract brief text (PDF)', 'n8n-nodes-base.extractFromFile', 1.1, [480, 120], { operation: 'pdf', binaryPropertyName: 'brief_file', options: {} }),
  node('Claude: parse brief', 'n8n-nodes-base.httpRequest', 4.2, [720, Y], {
    method: 'POST', url: 'https://api.anthropic.com/v1/messages', ...headerAuth,
    sendHeaders: true, headerParameters: { parameters: [{ name: 'anthropic-version', value: '2026-10-21' }] },
    sendBody: true, specifyBody: 'json', jsonBody: parseBody, options: { timeout: 60000 },
  }, { ...RETRY, onError: 'continueErrorOutput' }),
  node('OpenAI fallback: parse brief', 'n8n-nodes-base.httpRequest', 4.2, [960, 520], {
    method: 'POST', url: 'https://api.openai.com/v1/responses', ...headerAuth,
    sendBody: true, specifyBody: 'json', jsonBody: fallbackBody, options: { timeout: 60000 },
  }, RETRY),
  node('Validate criteria', 'n8n-nodes-base.code', 2, [1200, Y], { jsCode: CODE.validate }),
  ifNode('Missing fields?', [1420, Y], '={{ $json.missing_fields.length }}', { type: 'number', operation: 'gt' }, 0),
  node('Slack: ask for missing fields', 'n8n-nodes-base.slack', 2.3, [1640, 100], {
    resource: 'message', operation: 'sendAndWait', select: 'channel', channelId: RL('', 'list'),
    message: '=Creator Match needs a bit more before it can shortlist: {{ $json.missing_fields.join(", ") }}',
    responseType: 'freeText', options: {},
  }, { webhookId: randomUUID() }),
  node('BigQuery: get candidates', 'n8n-nodes-base.googleBigQuery', 2.1, [1860, Y], { operation: 'executeQuery', projectId: PROJECT, sqlQuery: CANDIDATE_SQL, options: {} }, RETRY),
  node('Score + pre-filter', 'n8n-nodes-base.code', 2, [2080, Y], { jsCode: CODE.score }),
  node('Refresh stale profiles (CM-02)', 'n8n-nodes-base.executeWorkflow', 1.1, [2300, Y], { workflowId: RL('REPLACE_WITH_CM02_ID'), options: {} }),
  node('Claude: brand-fit judge', 'n8n-nodes-base.httpRequest', 4.2, [2580, Y], {
    method: 'POST', url: 'https://api.anthropic.com/v1/messages', ...headerAuth,
    sendHeaders: true, headerParameters: { parameters: [{ name: 'anthropic-version', value: '2026-10-21' }] },
    sendBody: true, specifyBody: 'json', jsonBody: judgeBody,
    options: { timeout: 60000, batching: { batch: { batchSize: 5, batchInterval: 1000 } } },
  }, { ...RETRY, onError: 'continueRegularOutput' }),
  node('Merge judgements', 'n8n-nodes-base.code', 2, [2800, Y], { jsCode: CODE.merge }),
  node('Rank + hard rules', 'n8n-nodes-base.code', 2, [3080, Y], { jsCode: CODE.rank }),
  node('Drive: copy shortlist template', 'n8n-nodes-base.googleDrive', 3, [3300, Y], {
    operation: 'copy', fileId: RL('REPLACE_WITH_TEMPLATE_SHEET_ID'),
    name: "=Shortlist - {{ $('Creator brief (form)').first().json.Brand }} - {{ $now.toFormat('yyyy-MM-dd') }}", sameFolder: true, options: {},
  }, { ...RETRY, executeOnce: true }),
  node('Prepare sheet rows', 'n8n-nodes-base.code', 2, [3520, Y], { jsCode: CODE.rows }),
  node('Sheets: write shortlist', 'n8n-nodes-base.googleSheets', 4.5, [3740, Y], {
    operation: 'append', documentId: RL('={{ $json.sheet_id }}'), sheetName: { __rl: true, value: 'gid=0', mode: 'list', cachedResultName: 'Shortlist' },
    columns: { mappingMode: 'autoMapInputData', value: {}, matchingColumns: [], schema: [] }, options: {},
  }, RETRY),
  node('Slack: approve shortlist?', 'n8n-nodes-base.slack', 2.3, [3960, Y], {
    resource: 'message', operation: 'sendAndWait', select: 'channel', channelId: RL('', 'list'),
    message: "=*Creator Match* · {{ $('Creator brief (form)').first().json.Brand }} · {{ $('Validate criteria').first().json.objective }}\nTop picks: {{ $('Rank + hard rules').all().filter(i => i.json.pick === 'recommended').slice(0, 5).map(i => i.json.handle + ' (' + i.json.match_score + ')').join(', ') }}\nFlags: {{ $('Rank + hard rules').all().filter(i => (i.json.risk_flags || []).length).length }} · Shortlist: https://docs.google.com/spreadsheets/d/{{ $('Drive: copy shortlist template').first().json.id }}",
    responseType: 'approval',
    approvalOptions: { values: { approvalType: 'double', approveLabel: 'Approve shortlist', disapproveLabel: 'Request changes' } },
    options: { limitWaitTime: { values: { limitType: 'afterTimeInterval', resumeAmount: 24, resumeUnit: 'hours' } } },
  }, { webhookId: randomUUID(), executeOnce: true }),
  ifNode('Approved?', [4180, Y], '={{ $json.data.approved }}', { type: 'boolean', operation: 'true', singleValue: true }),
  node('Run Proposal Copilot (PC-01)', 'n8n-nodes-base.executeWorkflow', 1.1, [4400, 160], { workflowId: RL('REPLACE_WITH_PC01_ID'), options: {} }, { executeOnce: true }),
  node('Slack: what needs changing?', 'n8n-nodes-base.slack', 2.3, [4400, 460], {
    resource: 'message', operation: 'sendAndWait', select: 'channel', channelId: RL('', 'list'),
    message: '=What should change in this shortlist? (tone, tiers, specific creators, budget)', responseType: 'freeText', options: {},
  }, { webhookId: randomUUID() }),
  node('BigQuery: log feedback + run', 'n8n-nodes-base.googleBigQuery', 2.1, [4620, Y], {
    operation: 'insert', projectId: PROJECT, datasetId: RL('creator_match'), tableId: RL('match_feedback'), dataMode: 'autoMap', options: {},
  }, { ...RETRY, executeOnce: true }),
];

const cm01Connections = {
  'Creator brief (form)': { main: [[link('Brief file attached?')]] },
  'Brief file attached?': { main: [[link('Extract brief text (PDF)')], [link('Claude: parse brief')]] },
  'Extract brief text (PDF)': { main: [[link('Claude: parse brief')]] },
  'Claude: parse brief': { main: [[link('Validate criteria')], [link('OpenAI fallback: parse brief')]] },
  'OpenAI fallback: parse brief': { main: [[link('Validate criteria')]] },
  'Validate criteria': { main: [[link('Missing fields?')]] },
  'Missing fields?': { main: [[link('Slack: ask for missing fields')], [link('BigQuery: get candidates')]] },
  'Slack: ask for missing fields': { main: [[link('BigQuery: get candidates')]] },
  'BigQuery: get candidates': { main: [[link('Score + pre-filter')]] },
  'Score + pre-filter': { main: [[link('Refresh stale profiles (CM-02)')]] },
  'Refresh stale profiles (CM-02)': { main: [[link('Claude: brand-fit judge')]] },
  'Claude: brand-fit judge': { main: [[link('Merge judgements')]] },
  'Merge judgements': { main: [[link('Rank + hard rules')]] },
  'Rank + hard rules': { main: [[link('Drive: copy shortlist template')]] },
  'Drive: copy shortlist template': { main: [[link('Prepare sheet rows')]] },
  'Prepare sheet rows': { main: [[link('Sheets: write shortlist')]] },
  'Sheets: write shortlist': { main: [[link('Slack: approve shortlist?')]] },
  'Slack: approve shortlist?': { main: [[link('Approved?')]] },
  'Approved?': { main: [[link('Run Proposal Copilot (PC-01)')], [link('Slack: what needs changing?')]] },
  'Run Proposal Copilot (PC-01)': { main: [[link('BigQuery: log feedback + run')]] },
  'Slack: what needs changing?': { main: [[link('BigQuery: log feedback + run')]] },
};

const strip = items => items.map(i => ({ json: i.json }));
const cm01 = {
  name: 'CM-01 Creator Match: brief to shortlist',
  nodes: cm01Nodes,
  connections: cm01Connections,
  pinData: {
    'Creator brief (form)': strip(runs['Creator brief (form)']),
    'Claude: parse brief': strip(runs['Claude: parse brief']),
    'BigQuery: get candidates': strip(runs['BigQuery: get candidates']),
    'Refresh stale profiles (CM-02)': strip(runs['Refresh stale profiles (CM-02)']),
    'Claude: brand-fit judge': strip(runs['Claude: brand-fit judge']),
    'Drive: copy shortlist template': strip(runs['Drive: copy shortlist template']),
    'Sheets: write shortlist': strip(rows),
    'Slack: approve shortlist?': [{ json: { data: { approved: true } } }],
    'Run Proposal Copilot (PC-01)': [{ json: { status: 'draft_created', deck: 'Proposal - Sunny Snacks (demo) - AI-DRAFT' } }],
    'BigQuery: log feedback + run': [{ json: { inserted_rows: rows.length, table: 'creator_match.match_feedback' } }],
  },
  settings: { executionOrder: 'v1' },
  active: false,
};

// ---------------------------------------------------------------- OPS-01
const ops01 = {
  name: 'OPS-01 Error handler (alert + dead letter)',
  nodes: [
    sticky('Note: OPS-01', '## OPS-01 · Error handler\nSet as the **Error workflow** in CM-01 settings.\nClassify → alert #ai-ops → dead-letter table. A scheduled job retries transient failures with backoff (5 min, 30 min, 2 h; max 3), then opens a ticket for a human.', [-80, -40], 1000, 560, 3),
    node('On workflow error', 'n8n-nodes-base.errorTrigger', 1, [0, 300]),
    node('Classify error', 'n8n-nodes-base.code', 2, [240, 300], { jsCode: CODE.classify }),
    node('Slack: alert #ai-ops', 'n8n-nodes-base.slack', 2.3, [480, 300], {
      resource: 'message', operation: 'post', select: 'channel', channelId: RL('', 'list'),
      text: '=:rotating_light: {{ $json.workflow }} failed at *{{ $json.node }}*\n{{ $json.message }}\nCategory: {{ $json.category }} · {{ $json.execution_url }}',
      otherOptions: {},
    }),
    node('BigQuery: dead-letter insert', 'n8n-nodes-base.googleBigQuery', 2.1, [720, 300], {
      operation: 'insert', projectId: PROJECT, datasetId: RL('ops'), tableId: RL('dead_letter'), dataMode: 'autoMap', options: {},
    }),
  ],
  connections: {
    'On workflow error': { main: [[link('Classify error')]] },
    'Classify error': { main: [[link('Slack: alert #ai-ops')]] },
    'Slack: alert #ai-ops': { main: [[link('BigQuery: dead-letter insert')]] },
  },
  pinData: {
    'On workflow error': [{ json: errorSample }],
    'Slack: alert #ai-ops': [{ json: { ok: true, channel: 'C0AIOPS', ts: '1793500000.000100' } }],
    'BigQuery: dead-letter insert': [{ json: { inserted_rows: 1, table: 'ops.dead_letter' } }],
  },
  settings: { executionOrder: 'v1' },
  active: false,
};

// ---------------------------------------------------------------- sanity checks + write
for (const wf of [cm01, ops01]) {
  const names = new Set(wf.nodes.map(n => n.name));
  if (names.size !== wf.nodes.length) throw new Error(`${wf.name}: duplicate node names`);
  for (const [from, c] of Object.entries(wf.connections)) {
    if (!names.has(from)) throw new Error(`${wf.name}: unknown source ${from}`);
    c.main.flat().forEach(l => { if (!names.has(l.node)) throw new Error(`${wf.name}: unknown target ${l.node}`); });
  }
  Object.keys(wf.pinData).forEach(k => { if (!names.has(k)) throw new Error(`${wf.name}: pinData for unknown node ${k}`); });
}
writeFileSync(OUT + 'CM-01_brief-to-shortlist.json', JSON.stringify(cm01, null, 2));
writeFileSync(OUT + 'OPS-01_error-handler.json', JSON.stringify(ops01, null, 2));

console.log('Shortlist (demo run):');
console.table(ranked.map(i => ({ rank: i.json.rank, pick: i.json.pick, handle: i.json.handle, tier: i.json.tier, perf: i.json.perf_score, audience: i.json.audience_score, brand: i.json.brand_fit, cost: i.json.cost_score, match: i.json.match_score, flags: (i.json.risk_flags || []).join(';') })));
console.log('Error classification sample:', classified[0].json.category);
