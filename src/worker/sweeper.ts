import { and, eq, inArray, isNotNull, lt } from "drizzle-orm";
import { getDb } from "./core/db/client";
import { apifyRuns, campaignRefreshes, enrichmentJobs } from "./core/db/schema";
import { abandonApifyRun } from "./core/enrichment/apify";
import { settleCreators } from "./core/enrichment/service";
import { errorMessage } from "./core/env";
import { sweepStuckDco } from "./products/dco/pipeline";
import { sweepStuckMatrixRuns } from "./products/matrix/pipeline";
import { handleRefreshTimeout, redriveDigests } from "./products/optimization/refresh";
import { sweepStuckProposals } from "./products/proposal/pipeline";
import { sweepStuckTrends } from "./products/trends/pipeline";

// §7.7 and NFR-2: every product hands long work to the queue. A message can be lost, or fail on every delivery,
// and the work it carried would then wait forever. This sweep, run from the cron, moves anything stuck far past
// its normal duration to a visible, retryable end state. It is idempotent: a second pass finds nothing to move.

const SWEEP_EVERY_MS = 10 * 60_000;
const STUCK_MS = 20 * 60_000; // several times the slowest normal run (model timeout plus retries, Apify polling)
const ENRICH_STUCK_MS = 45 * 60_000;
// Far past every poll window: an Apify run still starting or running after this has nothing polling it
const APIFY_STUCK_MS = 30 * 60_000;
const APIFY_ABORTS_PER_SWEEP = 20;

export type CronStatus = { at: string; failed: { step: string; error: string }[] };

// The cron writes this after every run (index.ts); /health shows the step names and System the errors
export function parseCronStatus(raw: string | null): CronStatus | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as CronStatus;
    return typeof v?.at === "string" && Array.isArray(v.failed) ? v : null;
  } catch {
    return null;
  }
}

export type SweepResult = {
  matrixRuns: number;
  proposalSections: number;
  campaignRefreshes: number;
  digests: number;
  trends: number;
  dco: number;
  enrichmentJobs: number;
  apifyRuns: number;
  failedParts: string[];
};
type Counted = Exclude<keyof SweepResult, "failedParts">;

export async function sweepStuckWork(env: Env, now = Date.now(), force = false): Promise<SweepResult | null> {
  const last = Number((await env.CONFIG.get("sweeper:last")) ?? 0);
  if (!force) {
    if (now - last < SWEEP_EVERY_MS) return null;
    await env.CONFIG.put("sweeper:last", String(now));
  }
  const db = getDb(env);
  const cutoff = now - STUCK_MS;
  const result: SweepResult = { matrixRuns: 0, proposalSections: 0, campaignRefreshes: 0, digests: 0, trends: 0, dco: 0, enrichmentJobs: 0, apifyRuns: 0, failedParts: [] };
  // Each part on its own, so one that throws doesn't keep the others from settling their work
  const part = async (name: Counted, run: () => Promise<number>) => {
    try {
      result[name] = await run();
    } catch (e) {
      console.error("stuck-work sweep part failed", { part: name, error: errorMessage(e), stack: e instanceof Error ? e.stack : undefined });
      result.failedParts.push(name);
    }
  };

  // ① a Matrix run whose message never arrived, or whose deliveries all died
  await part("matrixRuns", () => sweepStuckMatrixRuns(env, cutoff));
  // ④ sections stuck drafting, then their runs
  await part("proposalSections", () => sweepStuckProposals(env, now));
  // ③ a refresh whose timeout message was lost, then digests whose message was lost after the refresh finished
  await part("campaignRefreshes", async () => {
    const stuck = await db
      .select({ id: campaignRefreshes.id })
      .from(campaignRefreshes)
      .where(and(eq(campaignRefreshes.status, "running"), lt(campaignRefreshes.startedAt, cutoff)));
    for (const r of stuck) await handleRefreshTimeout(env, { kind: "campaign-refresh-timeout", refreshId: r.id });
    return stuck.length;
  });
  await part("digests", () => redriveDigests(env, now));
  // ② pulls past their timeout, briefs that were never built, runs left with no live pull
  await part("trends", () => sweepStuckTrends(env, now));
  // ⑤ copy and visual slots that never started or never finished
  await part("dco", () => sweepStuckDco(env, now));
  // Enrichment jobs whose Apify poll stopped: failed, so the creator settles. A lost poll is about the system,
  // not the creator, so it doesn't dead-letter anyone (finding 18).
  await part("enrichmentJobs", async () => {
    const jobs = await db
      .select({ id: enrichmentJobs.id, creatorId: enrichmentJobs.creatorId })
      .from(enrichmentJobs)
      .where(and(eq(enrichmentJobs.status, "pending"), lt(enrichmentJobs.updatedAt, now - ENRICH_STUCK_MS)));
    for (let i = 0; i < jobs.length; i += 90) {
      await db
        .update(enrichmentJobs)
        .set({ status: "failed", error: "Timed out waiting for the source", failureScope: "global", updatedAt: now })
        .where(and(inArray(enrichmentJobs.id, jobs.slice(i, i + 90).map((j) => j.id)), eq(enrichmentJobs.status, "pending")));
    }
    if (jobs.length) await settleCreators(env, jobs.map((j) => j.creatorId));
    return jobs.length;
  });
  // Paid Apify runs nothing polls any more are aborted, so they stop billing (NFR-5, finding 16)
  await part("apifyRuns", async () => {
    const orphans = await db
      .select({ localRunId: apifyRuns.id, apifyRunId: apifyRuns.apifyRunId })
      .from(apifyRuns)
      .where(and(inArray(apifyRuns.status, ["READY", "RUNNING"]), lt(apifyRuns.startedAt, now - APIFY_STUCK_MS), isNotNull(apifyRuns.apifyRunId)))
      .limit(APIFY_ABORTS_PER_SWEEP);
    for (const o of orphans) await abandonApifyRun(env, { localRunId: o.localRunId, apifyRunId: o.apifyRunId! }, "No poll was waiting for this run");
    return orphans.length;
  });

  if (result.failedParts.length && !force) {
    // Handed back, so the next cron tries again instead of waiting out the interval; the cron records the error
    await env.CONFIG.put("sweeper:last", String(last)).catch(() => undefined);
    throw new Error(`Stuck-work sweep parts failed: ${result.failedParts.join(", ")}`);
  }
  return result;
}
