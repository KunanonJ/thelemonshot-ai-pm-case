import { z } from "zod";
import { errorMessage } from "./env";

// NFR-5: external cost over the last seven days against the Operator's weekly threshold. Breaching it raises
// an alert in the app; it never stops anything. Model costs come from llm_calls, Apify costs from Apify's own
// per-run figure in apify_runs. fal.ai responses carry no cost, so image generations are counted, not priced.

const WEEK_MS = 7 * 86_400_000;
const SETTINGS_KEY = "cost:settings";

// The threshold is the PRD's demo-scale default. The exchange rate is a placeholder the Operator should set to
// the rate their finance team uses; the System page shows both and lets an admin change them.
export const COST_DEFAULTS = { weeklyThresholdThb: 1500, usdToThb: 33 } as const;

export const costSettingsSchema = z.object({
  weeklyThresholdThb: z.number().min(0).max(10_000_000),
  usdToThb: z.number().gt(0).max(1000),
});
export type CostSettings = z.infer<typeof costSettingsSchema>;

export async function getCostSettings(env: Env): Promise<CostSettings & { rateSetByOperator: boolean }> {
  const raw = await env.CONFIG.get(SETTINGS_KEY);
  const parsed = raw ? costSettingsSchema.safeParse(parseJson(raw)) : null;
  return parsed?.success ? { ...parsed.data, rateSetByOperator: true } : { ...COST_DEFAULTS, rateSetByOperator: false };
}

// A stored value that isn't JSON reads as "not set", so the defaults apply instead of the cost page failing
function parseJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export async function setCostSettings(env: Env, settings: CostSettings): Promise<void> {
  await env.CONFIG.put(SETTINGS_KEY, JSON.stringify(settings));
}

export type WeeklyCost = {
  since: number;
  llmUsd: number;
  apifyUsd: number;
  totalUsd: number;
  totalThb: number;
  byProduct: { product: string; usd: number }[];
  apifyRunsWithoutCost: number;
  imageGenerations: number;
  settings: CostSettings & { rateSetByOperator: boolean };
  over: boolean;
};

const round = (v: number, digits = 2) => Math.round(v * 10 ** digits) / 10 ** digits;

// Apify purposes map to the product that spent the money
const PURPOSE_PRODUCT: Record<string, string> = { profile: "enrichment", discovery: "enrichment", posts: "optimization", trends: "trends" };

export async function weeklyCost(env: Env, now = Date.now()): Promise<WeeklyCost> {
  const since = now - WEEK_MS;
  const [llm, apify, unpriced, images, settings] = await Promise.all([
    env.DB.prepare("SELECT product, SUM(COALESCE(cost_usd, 0)) AS usd FROM llm_calls WHERE created_at >= ?1 GROUP BY product").bind(since).all<{ product: string; usd: number }>(),
    env.DB.prepare("SELECT purpose, SUM(COALESCE(cost_usd, 0)) AS usd FROM apify_runs WHERE started_at >= ?1 GROUP BY purpose").bind(since).all<{ purpose: string; usd: number }>(),
    env.DB.prepare("SELECT COUNT(*) AS n FROM apify_runs WHERE started_at >= ?1 AND cost_usd IS NULL AND status = 'SUCCEEDED'").bind(since).first<{ n: number }>(),
    // dco_visuals exists once the Phase 5 migration is applied; only a missing table counts as none
    env.DB.prepare("SELECT COUNT(*) AS n FROM dco_visuals WHERE submitted_at >= ?1")
      .bind(since)
      .first<{ n: number }>()
      .catch((e) => {
        if (/no such table/i.test(errorMessage(e))) return { n: 0 };
        throw e;
      }),
    getCostSettings(env),
  ]);
  const byProduct = new Map<string, number>();
  for (const r of llm.results) byProduct.set(r.product, (byProduct.get(r.product) ?? 0) + r.usd);
  for (const r of apify.results) {
    const product = PURPOSE_PRODUCT[r.purpose] ?? r.purpose;
    byProduct.set(product, (byProduct.get(product) ?? 0) + r.usd);
  }
  const llmUsd = llm.results.reduce((s, r) => s + r.usd, 0);
  const apifyUsd = apify.results.reduce((s, r) => s + r.usd, 0);
  const totalUsd = llmUsd + apifyUsd;
  const totalThb = totalUsd * settings.usdToThb;
  return {
    since,
    llmUsd: round(llmUsd, 4),
    apifyUsd: round(apifyUsd, 4),
    totalUsd: round(totalUsd, 4),
    totalThb: round(totalThb),
    byProduct: [...byProduct.entries()].map(([product, usd]) => ({ product, usd: round(usd, 4) })).sort((a, b) => b.usd - a.usd),
    apifyRunsWithoutCost: unpriced?.n ?? 0,
    imageGenerations: images?.n ?? 0,
    settings,
    over: totalThb > settings.weeklyThresholdThb,
  };
}
