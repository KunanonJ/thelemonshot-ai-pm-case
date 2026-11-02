import { Hono } from "hono";
import { devAuthBypass, requireAuth, type AppEnv } from "./core/auth";
import { handleApifyPoll, handleEnrich, sweepStale } from "./core/enrichment/service";
import { errorMessage, readSecret } from "./core/env";
import type { QueueMessage } from "./core/messages";
import { phase0, pollApifyRun, recordEcho, runPhase0Auto } from "./phase0";
import { executeMatrixRun } from "./products/matrix/pipeline";
import { handleCampaignDigest } from "./products/optimization/digest";
import { handleCampaignPostsPoll, handleRefreshTimeout, runDueRefreshes } from "./products/optimization/refresh";
import { campaignRoutes } from "./products/optimization/routes";
import { matrixRoutes } from "./products/matrix/routes";
import { handleProposalSection } from "./products/proposal/pipeline";
import { proposalRoutes } from "./products/proposal/routes";
import { handleTrendBrief, handleTrendPoll, handleTrendPullTimeout } from "./products/trends/pipeline";
import { trendRoutes } from "./products/trends/routes";
import { adminRoutes } from "./routes/admin";
import { creatorRoutes } from "./routes/creators";

const app = new Hono<AppEnv>();

// FR-CORE-25: enrichment freshness per source and the last cron run
app.get("/health", async (c) => {
  const { results } = await c.env.DB.prepare("SELECT source, MAX(fetched_at) AS last FROM stat_snapshots GROUP BY source").all<{
    source: string;
    last: number;
  }>();
  const freshness = Object.fromEntries(results.map((r) => [r.source, new Date(r.last).toISOString()]));
  const lastSweep = await c.env.CONFIG.get("sweep:last");
  return c.json({
    ok: true,
    time: new Date().toISOString(),
    lastCron: await c.env.CONFIG.get("cron:last"),
    lastSweep: lastSweep ? new Date(Number(lastSweep)).toISOString() : null,
    freshness,
  });
});

// Public by design: the publishable key is meant for the browser. The local test flag follows requireAuth's rule.
app.get("/config", (c) =>
  c.json({ clerkPublishableKey: readSecret(c.env, "CLERK_PUBLISHABLE_KEY") ?? null, ...(devAuthBypass(c.env, c.req.url) ? { devAuthBypass: true } : {}) }),
);

app.use("/api/*", requireAuth);
app.get("/api/me", (c) => c.json({ userId: c.get("userId"), role: c.get("role") }));
app.route("/api/matrix", matrixRoutes);
app.route("/api/proposals", proposalRoutes);
app.route("/api/campaigns", campaignRoutes);
app.route("/api/trends", trendRoutes);
app.route("/api/creators", creatorRoutes);
app.route("/api/admin/phase0", phase0);
app.route("/api/admin", adminRoutes);
app.all("/api/*", (c) => c.json({ error: "not_found" }, 404));

// BR-CORE-3: an unexpected error becomes a plain message, never a raw upstream error
app.onError((e, c) => {
  console.error("unhandled", errorMessage(e));
  return c.json({ error: "internal_error" }, 500);
});

export default {
  fetch: app.fetch,

  async queue(batch, env) {
    for (const message of batch.messages) {
      const body = message.body;
      try {
        switch (body.kind) {
          case "phase0-echo":
            await recordEcho(env, body.probe);
            break;
          case "phase0-apify-poll":
            await pollApifyRun(env, body);
            break;
          case "enrich":
            await handleEnrich(env, body);
            break;
          case "apify-poll":
            if (body.purpose === "posts") await handleCampaignPostsPoll(env, body);
            else await handleApifyPoll(env, body);
            break;
          case "matrix-run":
            await executeMatrixRun(env, body.runId);
            break;
          case "proposal-section":
            await handleProposalSection(env, body);
            break;
          case "campaign-digest":
            await handleCampaignDigest(env, body);
            break;
          case "campaign-refresh-timeout":
            await handleRefreshTimeout(env, body);
            break;
          case "trend-poll":
            await handleTrendPoll(env, body);
            break;
          case "trend-pull-timeout":
            await handleTrendPullTimeout(env, body);
            break;
          case "trend-brief":
            await handleTrendBrief(env, body);
            break;
        }
        message.ack();
      } catch (e) {
        console.error(`queue ${body.kind} failed`, errorMessage(e));
        message.retry();
      }
    }
  },

  async scheduled(_controller, env) {
    await env.CONFIG.put("cron:last", new Date().toISOString());
    await runPhase0Auto(env);
    await sweepStale(env);
    await runDueRefreshes(env);
  },
} satisfies ExportedHandler<Env, QueueMessage>;
