import { Hono } from "hono";
import { z } from "zod";
import { requireRole, type AppEnv } from "../core/auth";
import { DISCOVERY_DEFAULTS, startDiscovery } from "../core/enrichment/discovery";
import { errorMessage } from "../core/env";
import { costSettingsSchema, setCostSettings, weeklyCost } from "../core/cost";
import { requestEnrichment } from "../core/enrichment/service";
import { DEFAULT_MODEL, FORCE_FAIL_FLAG } from "../core/llm";
import { recomputeHistory } from "../products/optimization/closing";
import { RefreshError, runDueRefreshes, startCampaignRefresh } from "../products/optimization/refresh";
import { parseCronStatus, sweepStuckWork } from "../sweeper";

export const adminRoutes = new Hono<AppEnv>();
adminRoutes.use("*", requireRole("admin"));

const WEEK_MS = 7 * 86_400_000;
// Well past the 5-minute poll window: a run still READY or RUNNING after this has nothing polling it (finding 16)
const APIFY_STUCK_AFTER_MS = 15 * 60_000;

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
        `SELECT actor, purpose, CASE WHEN status IN ('READY', 'RUNNING') THEN 'STUCK' ELSE status END AS status, error, started_at FROM apify_runs
         WHERE started_at >= ?1
           AND (status NOT IN ('SUCCEEDED', 'READY', 'RUNNING') OR (status IN ('READY', 'RUNNING') AND started_at < ?2))
         ORDER BY started_at DESC LIMIT 20`,
      )
      .bind(since, Date.now() - APIFY_STUCK_AFTER_MS)
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
    // Admin only, so the raw step errors are shown here and nowhere else (finding 19)
    cron: { last: await c.env.CONFIG.get("cron:last"), status: parseCronStatus(await c.env.CONFIG.get("cron:status")) },
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
  const platforms = await startDiscovery(c.env, parsed.data, c.get("userId"));
  const started = platforms.filter((p) => p.status === "started").length;
  if (platforms.length && !started) return c.json({ error: "discovery_failed", platforms }, 502);
  return c.json({ started, platforms }, 202);
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

// ③: the same code path the cron runs, for when a scheduled refresh is wanted now (AC-CO-1 on demand)
adminRoutes.post("/campaigns/run-due", async (c) => c.json({ started: await runDueRefreshes(c.env) }));

// FR-CORE-21: history scores rebuilt from outcome records alone, to prove they are recomputable
adminRoutes.post("/history/recompute", async (c) => c.json(await recomputeHistory(c.env)));

// NFR-5: this week's external cost against the threshold. It alerts; nothing is stopped.
adminRoutes.get("/cost", async (c) => c.json(await weeklyCost(c.env)));

// Kept small so every admin page can ask for it
adminRoutes.get("/cost-alert", async (c) => {
  const w = await weeklyCost(c.env);
  return c.json({ over: w.over, totalThb: w.totalThb, thresholdThb: w.settings.weeklyThresholdThb });
});

adminRoutes.post("/cost/settings", async (c) => {
  const body = costSettingsSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!body.success) return c.json({ error: "invalid_settings" }, 400);
  await setCostSettings(c.env, body.data);
  return c.json(await weeklyCost(c.env));
});

// NFR-7: before a demo, refresh every active creator whose snapshot is over 12 hours old, and every active
// campaign's tracked posts, so no demo step waits on a cold external pull
const PREWARM_AGE_MS = 12 * 3_600_000;
const PREWARM_LIMIT = 60;
// A job pending longer than this is stuck, not in flight, so it doesn't keep its creator out of the pre-warm
const PENDING_IN_FLIGHT_MS = 45 * 60_000;

adminRoutes.post("/prewarm", async (c) => {
  const cutoff = Date.now() - PREWARM_AGE_MS;
  const { results } = await c.env.DB.prepare(
    `SELECT c.id FROM creators c
     WHERE c.active = 1 AND (c.instagram IS NOT NULL OR c.tiktok IS NOT NULL OR c.youtube IS NOT NULL)
       AND COALESCE((SELECT MAX(s.fetched_at) FROM stat_snapshots s WHERE s.creator_id = c.id), 0) < ?1
       AND NOT EXISTS (SELECT 1 FROM enrichment_jobs j WHERE j.creator_id = c.id AND j.status = 'pending' AND j.updated_at > ?3)
     ORDER BY c.updated_at DESC LIMIT ?2`,
  )
    .bind(cutoff, PREWARM_LIMIT, Date.now() - PENDING_IN_FLIGHT_MS)
    .all<{ id: string }>();
  const userId = c.get("userId");
  const jobs = results.length ? await requestEnrichment(c.env, results.map((r) => r.id), "manual", userId) : 0;
  const { results: active } = await c.env.DB.prepare("SELECT id FROM campaigns WHERE status = 'active' AND COALESCE(last_refresh_at, 0) < ?1")
    .bind(cutoff)
    .all<{ id: string }>();
  let campaigns = 0;
  for (const row of active) {
    try {
      if (!(await startCampaignRefresh(c.env, row.id, "manual", userId)).existing) campaigns++;
    } catch (e) {
      // One campaign that can't refresh doesn't stop the rest of the pre-warm
      if (!(e instanceof RefreshError)) console.error("pre-warm refresh failed", { campaignId: row.id, error: errorMessage(e) });
    }
  }
  return c.json({ creators: results.length, jobs, campaigns, olderThanHours: PREWARM_AGE_MS / 3_600_000 });
});

// §7.7: the cron's stuck-work sweep, on demand
adminRoutes.post("/sweep", async (c) => c.json(await sweepStuckWork(c.env, Date.now(), true)));
