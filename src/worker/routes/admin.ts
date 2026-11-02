import { Hono } from "hono";
import { z } from "zod";
import { requireRole, type AppEnv } from "../core/auth";
import { DISCOVERY_DEFAULTS, startDiscovery } from "../core/enrichment/discovery";
import { errorMessage } from "../core/env";
import { DEFAULT_MODEL, FORCE_FAIL_FLAG } from "../core/llm";

export const adminRoutes = new Hono<AppEnv>();
adminRoutes.use("*", requireRole("admin"));

const WEEK_MS = 7 * 86_400_000;

// FR-CORE-24: source freshness, failed jobs, staleness spread, run counts and external cost per product
adminRoutes.get("/overview", async (c) => {
  const since = Date.now() - WEEK_MS;
  const db = c.env.DB;
  const [freshness, staleness, failedJobs, failedApify, llm, runsByProduct, openDeadLetters] = await Promise.all([
    db.prepare("SELECT source, MAX(fetched_at) AS last FROM stat_snapshots GROUP BY source").all(),
    db
      .prepare(
        `SELECT
           SUM(CASE WHEN last IS NULL THEN 1 ELSE 0 END) AS never,
           SUM(CASE WHEN last >= ?1 THEN 1 ELSE 0 END) AS under_24h,
           SUM(CASE WHEN last < ?1 AND last >= ?2 THEN 1 ELSE 0 END) AS one_to_three_days,
           SUM(CASE WHEN last < ?2 THEN 1 ELSE 0 END) AS over_72h
         FROM (SELECT c.id, (SELECT MAX(fetched_at) FROM stat_snapshots s WHERE s.creator_id = c.id) AS last FROM creators c WHERE c.active = 1)`,
      )
      .bind(Date.now() - 86_400_000, Date.now() - 3 * 86_400_000)
      .first(),
    db
      .prepare(
        `SELECT j.platform, j.error, j.updated_at, c.display_name FROM enrichment_jobs j JOIN creators c ON c.id = j.creator_id
         WHERE j.status = 'failed' AND j.updated_at >= ?1 ORDER BY j.updated_at DESC LIMIT 20`,
      )
      .bind(since)
      .all(),
    db
      .prepare(
        `SELECT actor, purpose, status, error, started_at FROM apify_runs
         WHERE started_at >= ?1 AND status NOT IN ('SUCCEEDED', 'READY', 'RUNNING') ORDER BY started_at DESC LIMIT 20`,
      )
      .bind(since)
      .all(),
    db
      .prepare(
        `SELECT product, COUNT(*) AS calls, SUM(CASE WHEN status = 'ok' THEN 0 ELSE 1 END) AS failed,
                SUM(COALESCE(cost_usd, 0)) AS cost_usd FROM llm_calls WHERE created_at >= ?1 GROUP BY product`,
      )
      .bind(since)
      .all(),
    db.prepare("SELECT product, status, COUNT(*) AS runs FROM runs WHERE created_at >= ?1 GROUP BY product, status").bind(since).all(),
    db.prepare("SELECT COUNT(*) AS open FROM dead_letters WHERE resolved_at IS NULL").first<{ open: number }>(),
  ]);
  const apifyRuns = await db
    .prepare("SELECT purpose, COUNT(*) AS runs, SUM(COALESCE(item_count, 0)) AS items FROM apify_runs WHERE started_at >= ?1 GROUP BY purpose")
    .bind(since)
    .all();
  return c.json({
    freshness: freshness.results,
    staleness,
    failedJobs: failedJobs.results,
    failedApifyRuns: failedApify.results,
    llm: llm.results,
    apify: apifyRuns.results,
    runs: runsByProduct.results,
    openDeadLetters: openDeadLetters?.open ?? 0,
  });
});

adminRoutes.get("/discovery/defaults", (c) => c.json(DISCOVERY_DEFAULTS));

const discoverySchema = z.object({
  category: z.string().trim().min(1),
  instagramHashtags: z.array(z.string().trim().min(1)).max(10).default([]),
  tiktokHashtags: z.array(z.string().trim().min(1)).max(10).default([]),
  perHashtag: z.number().int().min(5).max(100).default(25),
  maxNewPerPlatform: z.number().int().min(1).max(100).default(35),
});

adminRoutes.post("/discovery", async (c) => {
  const parsed = discoverySchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) return c.json({ error: "invalid_discovery", issues: parsed.error.issues.map((i) => i.message) }, 400);
  try {
    const runs = await startDiscovery(c.env, parsed.data, c.get("userId"));
    return c.json({ started: runs.length }, 202);
  } catch (e) {
    return c.json({ error: "discovery_failed", message: errorMessage(e).slice(0, 200) }, 502);
  }
});

// Test switch for AC-MX-3 and AC-CO-4: makes every LLM call fail as if the gateway were down
adminRoutes.get("/flags", async (c) =>
  c.json({ llmForceFail: (await c.env.CONFIG.get(FORCE_FAIL_FLAG)) === "1", llmModel: (await c.env.CONFIG.get("llm:model")) ?? DEFAULT_MODEL }),
);

adminRoutes.post("/flags", async (c) => {
  const body = z.object({ llmForceFail: z.boolean() }).safeParse(await c.req.json().catch(() => ({})));
  if (!body.success) return c.json({ error: "invalid_flags" }, 400);
  if (body.data.llmForceFail) await c.env.CONFIG.put(FORCE_FAIL_FLAG, "1");
  else await c.env.CONFIG.delete(FORCE_FAIL_FLAG);
  return c.json({ ok: true });
});
