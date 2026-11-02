import { and, eq, inArray, lt, or } from "drizzle-orm";
import { getDb } from "./core/db/client";
import { campaignRefreshes, deadLetters, enrichmentJobs, runs } from "./core/db/schema";
import { settleCreators } from "./core/enrichment/service";
import { newId } from "./core/util";
import { handleRefreshTimeout } from "./products/optimization/refresh";
import { sweepStuckProposals } from "./products/proposal/pipeline";
import { trendPulls } from "./products/trends/schema";
import { handleTrendPullTimeout } from "./products/trends/pipeline";

// §7.7 and NFR-2: every product hands long work to the queue. A message can be lost, or retried into the
// dead-letter queue, and the work it carried would then wait forever. This sweep, run from the cron, moves
// anything stuck far past its normal duration to a visible, retryable end state. It is idempotent: a second
// pass finds nothing left to move.

const SWEEP_EVERY_MS = 10 * 60_000;
const STUCK_MS = 20 * 60_000; // several times the slowest normal run (model timeout plus retries, Apify polling)
const ENRICH_STUCK_MS = 45 * 60_000;

export type SweepResult = { matrixRuns: number; proposalSections: number; campaignRefreshes: number; trendPulls: number; enrichmentJobs: number };

export async function sweepStuckWork(env: Env, now = Date.now(), force = false): Promise<SweepResult | null> {
  if (!force) {
    const last = Number((await env.CONFIG.get("sweeper:last")) ?? 0);
    if (now - last < SWEEP_EVERY_MS) return null;
    await env.CONFIG.put("sweeper:last", String(now));
  }
  const db = getDb(env);
  const cutoff = now - STUCK_MS;

  // ① a Matrix run whose message never arrived, or whose consumer kept failing
  const matrix = await db
    .select({ id: runs.id })
    .from(runs)
    .where(
      and(
        eq(runs.product, "matrix"),
        or(and(eq(runs.status, "queued"), lt(runs.createdAt, cutoff)), and(eq(runs.status, "running"), lt(runs.startedAt, cutoff))),
      ),
    );
  for (const r of matrix) {
    await db.batch([
      db.update(runs).set({ status: "failed", error: "The run stopped before it finished", finishedAt: now }).where(eq(runs.id, r.id)),
      db.insert(deadLetters).values({ id: newId(), kind: "run", runId: r.id, reason: "Run stopped before it finished", detail: { sweptAt: now }, createdAt: now }),
    ]);
  }

  // ④ sections stuck drafting, then their runs
  const proposalSections = await sweepStuckProposals(env, now);

  // ③ a refresh whose timeout message was lost
  const refreshes = await db
    .select({ id: campaignRefreshes.id })
    .from(campaignRefreshes)
    .where(and(eq(campaignRefreshes.status, "running"), lt(campaignRefreshes.startedAt, cutoff)));
  for (const r of refreshes) await handleRefreshTimeout(env, { kind: "campaign-refresh-timeout", refreshId: r.id });

  // ② a pull still waiting on Apify long after its own timeout should have fired
  const pulls = await db
    .select({ id: trendPulls.id })
    .from(trendPulls)
    .where(and(eq(trendPulls.status, "running"), lt(trendPulls.startedAt, cutoff)));
  for (const p of pulls) await handleTrendPullTimeout(env, { kind: "trend-pull-timeout", pullId: p.id });

  // Enrichment jobs whose Apify poll stopped: failed, so the creator settles and the dead-letter list shows it
  const jobs = await db
    .select({ id: enrichmentJobs.id, creatorId: enrichmentJobs.creatorId })
    .from(enrichmentJobs)
    .where(and(eq(enrichmentJobs.status, "pending"), lt(enrichmentJobs.updatedAt, now - ENRICH_STUCK_MS)));
  if (jobs.length) {
    for (let i = 0; i < jobs.length; i += 90) {
      await db
        .update(enrichmentJobs)
        .set({ status: "failed", error: "Timed out waiting for the source", updatedAt: now })
        .where(inArray(enrichmentJobs.id, jobs.slice(i, i + 90).map((j) => j.id)));
    }
    await settleCreators(env, jobs.map((j) => j.creatorId));
  }

  return { matrixRuns: matrix.length, proposalSections, campaignRefreshes: refreshes.length, trendPulls: pulls.length, enrichmentJobs: jobs.length };
}
