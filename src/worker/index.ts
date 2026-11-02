import { Hono } from "hono";
import { devAuthBypass, requireAuth, type AppEnv } from "./core/auth";
import { degradedSources } from "./core/enrichment/failures";
import { sweepStale } from "./core/enrichment/service";
import { errorMessage, readSecret } from "./core/env";
import { QueueUnavailable, type QueueMessage } from "./core/messages";
import { phase0, runPhase0Auto } from "./phase0";
import { runDueRefreshes } from "./products/optimization/refresh";
import { campaignRoutes } from "./products/optimization/routes";
import { matrixRoutes } from "./products/matrix/routes";
import { proposalRoutes } from "./products/proposal/routes";
import { rmnPublicRoutes } from "./products/rmn/store";
import { rmnRoutes } from "./products/rmn/routes";
import { trendRoutes } from "./products/trends/routes";
import { dcoPublicRoutes, dcoRoutes } from "./products/dco/routes";
import { handleMessage, MAX_DELIVERIES, onFinalFailure, refOf, retryDelaySeconds } from "./queue";
import { adminRoutes } from "./routes/admin";
import { parseCronStatus, sweepStuckWork, type CronStatus } from "./sweeper";
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
  // Public, so step names only; the errors themselves are on the admin System page
  const cron = parseCronStatus(await c.env.CONFIG.get("cron:status"));
  return c.json({
    ok: true,
    time: new Date().toISOString(),
    lastCron: await c.env.CONFIG.get("cron:last"),
    cronFailedSteps: cron?.failed.map((f) => f.step) ?? [],
    lastSweep: lastSweep ? new Date(Number(lastSweep)).toISOString() : null,
    freshness,
  });
});

// ⑥ RMN: the public tracked-link redirect and the demo store (no sign-in: shoppers aren't users)
app.route("/", rmnPublicRoutes);

// Public by design: the publishable key is meant for the browser. The local test flag follows requireAuth's rule.
app.get("/config", (c) =>
  c.json({ clerkPublishableKey: readSecret(c.env, "CLERK_PUBLISHABLE_KEY") ?? null, ...(devAuthBypass(c.env, c.req.url) ? { devAuthBypass: true } : {}) }),
);

// Registered before requireAuth on purpose: fal fetches a DCO base asset through this link with no Clerk session
app.route("/api/dco/public", dcoPublicRoutes);
app.use("/api/*", requireAuth);
app.get("/api/me", (c) => c.json({ userId: c.get("userId"), role: c.get("role") }));
// Finding 18: every page says so when a data source is failing for everyone, not only per creator
app.get("/api/status", async (c) => c.json({ degraded: await degradedSources(c.env) }));
app.route("/api/dco", dcoRoutes);
app.route("/api/matrix", matrixRoutes);
app.route("/api/proposals", proposalRoutes);
app.route("/api/campaigns", campaignRoutes);
app.route("/api/trends", trendRoutes);
app.route("/api/creators", creatorRoutes);
app.route("/api/rmn", rmnRoutes);
app.route("/api/admin/phase0", phase0);
app.route("/api/admin", adminRoutes);
app.all("/api/*", (c) => c.json({ error: "not_found" }, 404));

// BR-CORE-3: an unexpected error becomes a plain message, never a raw upstream error
app.onError((e, c) => {
  if (e instanceof QueueUnavailable) {
    console.error("queue send failed", { method: c.req.method, path: c.req.path, error: errorMessage(e.cause ?? e) });
    return c.json({ error: "queue_unavailable" }, 503);
  }
  console.error("unhandled", { method: c.req.method, path: c.req.path, error: errorMessage(e), stack: e instanceof Error ? e.stack : undefined });
  return c.json({ error: "internal_error" }, 500);
});

// NFR-2: each cron step runs on its own, so one that throws can't starve the ones after it
const CRON_STEPS: [string, (env: Env) => Promise<unknown>][] = [
  ["phase0", runPhase0Auto],
  ["enrichment-sweep", sweepStale],
  ["campaign-refreshes", (env) => runDueRefreshes(env)],
  ["stuck-work", (env) => sweepStuckWork(env)],
];

export default {
  fetch: app.fetch,

  async queue(batch, env) {
    for (const message of batch.messages) {
      try {
        await handleMessage(env, message.body, message.attempts);
        message.ack();
      } catch (e) {
        const last = message.attempts >= MAX_DELIVERIES;
        console.error("queue handler failed", {
          kind: message.body.kind,
          messageId: message.id,
          attempts: message.attempts,
          last,
          ...refOf(message.body),
          error: errorMessage(e),
          stack: e instanceof Error ? e.stack : undefined,
        });
        if (!last) {
          message.retry({ delaySeconds: retryDelaySeconds(message.attempts) });
          continue;
        }
        try {
          await onFinalFailure(env, message.body, errorMessage(e));
          message.ack();
        } catch (err) {
          // Settling failed too: the message goes to the dead-letter queue and the stuck-work sweep settles its work
          console.error("queue final-failure handling failed", { kind: message.body.kind, messageId: message.id, error: errorMessage(err) });
          message.retry();
        }
      }
    }
  },

  async scheduled(_controller, env) {
    const failed: CronStatus["failed"] = [];
    for (const [step, run] of CRON_STEPS) {
      try {
        await run(env);
      } catch (e) {
        console.error("cron step failed", { step, error: errorMessage(e), stack: e instanceof Error ? e.stack : undefined });
        failed.push({ step, error: errorMessage(e).slice(0, 200) });
      }
    }
    // Written after the steps: when the cron last finished, and which steps failed in that run
    const at = new Date().toISOString();
    await env.CONFIG.put("cron:last", at).catch(() => undefined);
    await env.CONFIG.put("cron:status", JSON.stringify({ at, failed } satisfies CronStatus)).catch(() => undefined);
  },
} satisfies ExportedHandler<Env, QueueMessage>;
