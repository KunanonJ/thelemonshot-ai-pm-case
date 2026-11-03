import { and, eq, inArray, isNull, like, or } from "drizzle-orm";
import { getDb, insertChunked, type Db } from "../db/client";
import { contentItems, contentMetrics, creators, deadLetters, enrichmentJobs, statSnapshots, type Platform } from "../db/schema";
import { errorMessage, readSecret } from "../env";
import type { ApifyPollMessage, EnrichMessage, EnrichReason } from "../messages";
import { chunk, newId, normaliseHandle } from "../util";
import { abandonApifyRun, ACTORS, finishApifyRun, getActorRun, getDatasetItems, startActor } from "./apify";
import { processDiscoveryResults } from "./discovery";
import { classifySourceFailure, clearDegraded, markDegraded, type FailureScope } from "./failures";
import { computeStats, normaliseInstagram, normaliseTikTok, type NormalisedProfile } from "./normalise";
import { fetchYouTubeProfile } from "./youtube";

// FR-CORE-9: the only module that pulls external creator data. Products read snapshots, never sources (PRD §6.3).

export const SNAPSHOT_TTL_MS = 72 * 3_600_000; // FR-CORE-12
const QUEUE_BATCH = 25;
const APIFY_POLL_LIMIT_MS = 5 * 60_000; // FR-CORE-13
const TIKTOK_VIDEOS_PER_PROFILE = 12;
const SWEEP_EVERY_MS = 55 * 60_000;
const SWEEP_LIMIT = 50;
const ID_CHUNK = 90; // stays under D1's 100 bound parameters
// A job claimed by a delivery carries this prefix in apify_run_id until its Apify run id replaces it
const CLAIM_PREFIX = "claim:";

type CreatorRow = typeof creators.$inferSelect;
type JobRow = typeof enrichmentJobs.$inferSelect;

export function handlesOf(c: Pick<CreatorRow, "instagram" | "tiktok" | "youtube">): Platform[] {
  return (["instagram", "tiktok", "youtube"] as const).filter((p) => Boolean(c[p]));
}

async function creatorsByIds(db: Db, ids: string[]): Promise<CreatorRow[]> {
  const out: CreatorRow[] = [];
  for (const part of chunk(ids, ID_CHUNK)) out.push(...(await db.select().from(creators).where(inArray(creators.id, part))));
  return out;
}

// Queues one pending job per creator and platform, then hands the batch to the queue consumer. Returns the
// number of jobs actually queued.
export async function requestEnrichment(env: Env, creatorIds: string[], reason: EnrichReason, requestedBy: string): Promise<number> {
  const db = getDb(env);
  const now = Date.now();
  const jobs: (typeof enrichmentJobs.$inferInsert)[] = [];
  const queued: string[] = [];
  for (const c of await creatorsByIds(db, creatorIds)) {
    const platforms = handlesOf(c);
    if (platforms.length === 0) {
      await deadLetterOnce(db, { creatorId: c.id, reason: "No platform handles to enrich", detail: {} });
      await db.update(creators).set({ enrichmentStatus: "failed", updatedAt: now }).where(eq(creators.id, c.id));
      continue;
    }
    for (const platform of platforms) {
      jobs.push({ id: newId(), creatorId: c.id, platform, status: "pending", reason, requestedBy, createdAt: now, updatedAt: now });
    }
    queued.push(c.id);
  }
  await insertChunked(db, enrichmentJobs, jobs);
  let sent = jobs.length;
  for (const batch of chunk(queued, QUEUE_BATCH)) {
    try {
      await env.ENRICH_QUEUE.send({ kind: "enrich", creatorIds: batch, reason, requestedBy } satisfies EnrichMessage);
    } catch (e) {
      // Nothing will pick these jobs up, so they fail now and the creators settle with a reason (finding 15)
      console.error("enrichment not queued", { creators: batch.length, error: errorMessage(e) });
      const ids = jobs.filter((j) => batch.includes(j.creatorId)).map((j) => j.id!);
      await failJobs(db, ids, "The refresh couldn't be queued", "global");
      await settleCreators(env, batch);
      sent -= ids.length;
    }
  }
  return sent;
}

export async function handleEnrich(env: Env, msg: EnrichMessage): Promise<void> {
  const db = getDb(env);
  const rows = await creatorsByIds(db, msg.creatorIds);
  const byId = new Map(rows.map((c) => [c.id, c]));
  // Claimed in one guarded UPDATE per chunk, so a duplicate delivery can't start a second paid run (finding 20)
  const claim = `${CLAIM_PREFIX}${newId()}`;
  const pending: JobRow[] = [];
  for (const part of chunk(msg.creatorIds, ID_CHUNK)) {
    pending.push(
      ...(await db
        .update(enrichmentJobs)
        .set({ apifyRunId: claim, updatedAt: Date.now() })
        .where(and(inArray(enrichmentJobs.creatorId, part), eq(enrichmentJobs.status, "pending"), isNull(enrichmentJobs.apifyRunId)))
        .returning()),
    );
  }

  // YouTube answers in seconds, so it runs inline. After the first failure that would hit anyone (quota, key,
  // outage), the rest of the batch fails the same way without spending more calls (finding 18).
  let outage: string | null = null;
  let youtubeOk = false;
  for (const job of pending.filter((j) => j.platform === "youtube")) {
    const creator = byId.get(job.creatorId);
    if (!creator?.youtube) {
      await finishJob(db, job.id, "failed", "No YouTube handle", "handle");
      continue;
    }
    if (outage) {
      await finishJob(db, job.id, "failed", outage, "global");
      continue;
    }
    try {
      const result = await fetchYouTubeProfile(env, creator.youtube);
      if ("error" in result) {
        await finishJob(db, job.id, "failed", result.error, result.scope);
        if (result.scope === "global") {
          outage = result.error;
          await markDegraded(env, "youtube_api", classifySourceFailure(result.error));
        }
        continue;
      }
      const rawKey = await archiveRaw(env, `raw/youtube/${creator.id}-${Date.now()}.json`, result.raw);
      await writeSnapshot(db, creator.id, result.profile, "youtube_api", null, rawKey);
      await finishJob(db, job.id, "ok");
      youtubeOk = true;
    } catch (e) {
      outage = errorMessage(e);
      await finishJob(db, job.id, "failed", outage, "global");
      await markDegraded(env, "youtube_api", classifySourceFailure(e));
    }
  }
  if (youtubeOk) await clearDegraded(env, "youtube_api");

  // Instagram and TikTok take minutes: start one Apify run per platform for the whole batch, then poll
  for (const platform of ["instagram", "tiktok"] as const) {
    const jobs = pending.filter((j) => j.platform === platform);
    const runnable = jobs.filter((j) => byId.get(j.creatorId)?.[platform]);
    for (const j of jobs.filter((j) => !runnable.includes(j))) await finishJob(db, j.id, "failed", `No ${platform} handle`, "handle");
    if (!runnable.length) continue;
    const handles = runnable.map((j) => normaliseHandle(byId.get(j.creatorId)![platform]!));
    const input =
      platform === "instagram"
        ? { usernames: handles }
        : { profiles: handles, resultsPerPage: TIKTOK_VIDEOS_PER_PROFILE };
    const actor = platform === "instagram" ? ACTORS.instagramProfile : ACTORS.tiktokProfile;
    let started: { localRunId: string; apifyRunId: string } | null = null;
    try {
      started = await startActor(env, actor, input, "profile", `${platform}: ${handles.length} profiles`);
      for (const part of chunk(runnable.map((j) => j.id), ID_CHUNK)) {
        await db.update(enrichmentJobs).set({ apifyRunId: started.apifyRunId, updatedAt: Date.now() }).where(inArray(enrichmentJobs.id, part));
      }
      await env.ENRICH_QUEUE.send(
        { kind: "apify-poll", purpose: "profile", platform, localRunId: started.localRunId, apifyRunId: started.apifyRunId, startedAt: Date.now() } satisfies ApifyPollMessage,
        { delaySeconds: 30 },
      );
    } catch (e) {
      // Nothing would poll a run whose poll wasn't queued, so it's stopped rather than left billing (finding 16).
      // The previous snapshot (if any) stays in place; the failure is recorded (FR-CORE-12).
      if (started) await abandonApifyRun(env, started, "Its poll couldn't be queued");
      else await markDegraded(env, "apify", classifySourceFailure(e));
      await failJobs(db, runnable.map((j) => j.id), errorMessage(e), "global");
    }
  }
  await settleCreators(env, msg.creatorIds);
}

// The queue's last delivery of an enrich message failed (queue.ts): its jobs that never reached Apify fail, and
// the creators settle, instead of staying "pending" until the sweep
export async function failEnrichMessage(env: Env, msg: EnrichMessage): Promise<void> {
  const db = getDb(env);
  for (const part of chunk(msg.creatorIds, ID_CHUNK)) {
    await db
      .update(enrichmentJobs)
      .set({ status: "failed", error: "Enrichment stopped after repeated errors", failureScope: "global", updatedAt: Date.now() })
      .where(
        and(
          inArray(enrichmentJobs.creatorId, part),
          eq(enrichmentJobs.status, "pending"),
          or(isNull(enrichmentJobs.apifyRunId), like(enrichmentJobs.apifyRunId, `${CLAIM_PREFIX}%`)),
        ),
      );
  }
  await settleCreators(env, msg.creatorIds);
}

export async function handleApifyPoll(env: Env, msg: ApifyPollMessage): Promise<void> {
  const db = getDb(env);
  const withinWindow = Date.now() - msg.startedAt < APIFY_POLL_LIMIT_MS;
  let state;
  try {
    state = await getActorRun(env, msg.apifyRunId, 50);
  } catch (e) {
    if (withinWindow) return void (await env.ENRICH_QUEUE.send(msg, { delaySeconds: 30 }));
    return failApifyRun(env, db, msg, "POLL_FAILED", errorMessage(e));
  }

  if (state.status === "SUCCEEDED" && state.datasetId) {
    let items: unknown[];
    try {
      items = await getDatasetItems(env, state.datasetId, msg.purpose === "profile" ? 1_000 : 2_000);
    } catch (e) {
      if (withinWindow) return void (await env.ENRICH_QUEUE.send(msg, { delaySeconds: 30 }));
      return failApifyRun(env, db, msg, "DATASET_FAILED", errorMessage(e), state.usageUsd);
    }
    const rawKey = await archiveRaw(env, `raw/apify/${msg.apifyRunId}.json`, items);
    await finishApifyRun(env, msg.localRunId, "SUCCEEDED", items.length, undefined, state.usageUsd);
    await clearDegraded(env, "apify");
    if (msg.purpose === "discovery") return processDiscoveryResults(env, msg, items);
    return applyProfileResults(env, db, msg, items, rawKey);
  }
  if ((state.status === "READY" || state.status === "RUNNING") && withinWindow) {
    return void (await env.ENRICH_QUEUE.send(msg, { delaySeconds: 15 }));
  }
  return failApifyRun(env, db, msg, state.status === "RUNNING" || state.status === "READY" ? "POLL_TIMEOUT" : state.status, `Apify run ended as ${state.status}`, state.usageUsd);
}

// The queue's last delivery of a profile or discovery poll failed (queue.ts)
export async function failApifyPoll(env: Env, msg: ApifyPollMessage): Promise<void> {
  await failApifyRun(env, getDb(env), msg, "POLL_FAILED", "The poll failed on every delivery");
}

async function applyProfileResults(env: Env, db: Db, msg: ApifyPollMessage, items: unknown[], rawKey: string | null): Promise<void> {
  const jobs = await db
    .select()
    .from(enrichmentJobs)
    .where(and(eq(enrichmentJobs.apifyRunId, msg.apifyRunId), eq(enrichmentJobs.status, "pending")));
  let profiles: NormalisedProfile[];
  try {
    profiles = msg.platform === "instagram" ? normaliseInstagram(items) : normaliseTikTok(items);
  } catch (e) {
    console.error("apify results not readable", { apifyRunId: msg.apifyRunId, platform: msg.platform, error: errorMessage(e) });
    await failJobs(db, jobs.map((j) => j.id), "The source's answer couldn't be read", "global");
    return settleCreators(env, jobs.map((j) => j.creatorId));
  }
  const byHandle = new Map(profiles.map((p) => [p.handle, p]));
  const byId = new Map((await creatorsByIds(db, jobs.map((j) => j.creatorId))).map((c) => [c.id, c]));
  // Each job on its own (finding 15): one bad profile or a failed write never strands the rest as "pending"
  for (const job of jobs) {
    try {
      const handle = byId.get(job.creatorId)?.[msg.platform];
      const profile = handle ? byHandle.get(normaliseHandle(handle)) : undefined;
      if (!profile) await finishJob(db, job.id, "failed", "Handle not found in the actor results", "handle");
      else if (profile.isPrivate) await finishJob(db, job.id, "failed", "Account is private", "handle");
      else {
        await writeSnapshot(db, job.creatorId, profile, "apify", msg.apifyRunId, rawKey);
        await finishJob(db, job.id, "ok");
      }
    } catch (e) {
      console.error("profile not saved", { jobId: job.id, creatorId: job.creatorId, error: errorMessage(e) });
      await finishJob(db, job.id, "failed", "Saving this profile failed", "handle").catch(() => undefined);
    }
  }
  await settleCreators(env, jobs.map((j) => j.creatorId));
}

async function failApifyRun(env: Env, db: Db, msg: ApifyPollMessage, status: string, error: string, costUsd: number | null = null): Promise<void> {
  // A run nobody polls any more is stopped so it doesn't go on billing (finding 16)
  if (status === "POLL_TIMEOUT" || status === "POLL_FAILED") await abandonApifyRun(env, msg, error);
  else await finishApifyRun(env, msg.localRunId, status, null, error, costUsd);
  if (msg.purpose !== "profile") return;
  const jobs = await db
    .select()
    .from(enrichmentJobs)
    .where(and(eq(enrichmentJobs.apifyRunId, msg.apifyRunId), eq(enrichmentJobs.status, "pending")));
  await failJobs(db, jobs.map((j) => j.id), error, "global");
  await settleCreators(env, jobs.map((j) => j.creatorId));
}

// The raw answer is kept for audit; losing that copy doesn't make the snapshot any less real
async function archiveRaw(env: Env, key: string, data: unknown): Promise<string | null> {
  try {
    await env.FILES.put(key, JSON.stringify(data), { httpMetadata: { contentType: "application/json" } });
    return key;
  } catch (e) {
    console.error("raw source answer not archived", { key, error: errorMessage(e) });
    return null;
  }
}

export async function writeSnapshot(
  db: Db,
  creatorId: string,
  profile: NormalisedProfile,
  source: "apify" | "youtube_api",
  sourceRef: string | null,
  rawKey: string | null,
): Promise<void> {
  const stats = computeStats(profile);
  const now = Date.now();
  await db.insert(statSnapshots).values({
    id: newId(),
    creatorId,
    platform: profile.platform,
    followers: profile.followers,
    following: profile.following,
    postsCount: profile.postsCount,
    engagementRate: stats.engagementRate,
    medianViews: stats.medianViews,
    avgLikes: stats.avgLikes,
    avgComments: stats.avgComments,
    recentPosts: stats.recentPosts,
    topHashtags: stats.topHashtags,
    verified: profile.verified,
    source,
    sourceRef,
    rawKey,
    fetchedAt: now,
  });
  const contentId = (postId: string) => `${profile.platform}:${postId}`;
  await insertChunked(
    db,
    contentItems,
    profile.posts.map((p) => ({
      id: contentId(p.platformPostId),
      creatorId,
      platform: profile.platform,
      platformPostId: p.platformPostId,
      url: p.url,
      postedAt: p.postedAt,
      caption: p.caption,
      status: "available" as const,
      firstSeenAt: now,
    })),
  );
  await insertChunked(
    db,
    contentMetrics,
    profile.posts.map((p) => ({
      id: newId(),
      contentId: contentId(p.platformPostId),
      views: p.views,
      likes: p.likes,
      comments: p.comments,
      shares: p.shares,
      source,
      fetchedAt: now,
    })),
  );
}

async function finishJob(db: Db, jobId: string, status: "ok" | "failed", error?: string, scope?: FailureScope): Promise<void> {
  await db
    .update(enrichmentJobs)
    .set({ status, error: error?.slice(0, 300) ?? null, failureScope: status === "failed" ? (scope ?? "handle") : null, updatedAt: Date.now() })
    .where(eq(enrichmentJobs.id, jobId));
}

async function failJobs(db: Db, jobIds: string[], error: string, scope: FailureScope): Promise<void> {
  for (const part of chunk(jobIds, ID_CHUNK)) {
    if (!part.length) continue;
    await db
      .update(enrichmentJobs)
      .set({ status: "failed", error: error.slice(0, 300), failureScope: scope, updatedAt: Date.now() })
      .where(and(inArray(enrichmentJobs.id, part), eq(enrichmentJobs.status, "pending")));
  }
}

// Once every platform job for a creator has finished, set its status. A creator whose platforms all failed for
// reasons about them goes to the dead-letter list; everyone else proceeds (BR-CORE-1). A source outage isn't
// about the creator, so it doesn't dead-letter anyone; the app-wide degraded notice says so instead (finding 18).
export async function settleCreators(env: Env, creatorIds: string[]): Promise<void> {
  const db = getDb(env);
  const now = Date.now();
  for (const creatorId of new Set(creatorIds)) {
    const jobs = await db.select().from(enrichmentJobs).where(eq(enrichmentJobs.creatorId, creatorId));
    const latest = new Map<string, (typeof jobs)[number]>();
    for (const j of jobs) if ((latest.get(j.platform)?.createdAt ?? -1) < j.createdAt) latest.set(j.platform, j);
    const current = [...latest.values()];
    if (current.length === 0 || current.some((j) => j.status === "pending")) continue;

    const failed = current.filter((j) => j.status === "failed");
    const hasSnapshot = (await db.select({ id: statSnapshots.id }).from(statSnapshots).where(eq(statSnapshots.creatorId, creatorId)).limit(1)).length > 0;
    let status: CreatorRow["enrichmentStatus"];
    if (failed.length === current.length) {
      if (failed.some((j) => j.failureScope !== "global")) {
        await deadLetterOnce(db, {
          creatorId,
          reason: "Enrichment failed on every platform",
          detail: { platforms: failed.map((j) => ({ platform: j.platform, error: j.error })) },
        });
      }
      status = hasSnapshot ? "partial" : "failed";
    } else {
      status = failed.length ? "partial" : "ok";
      await db
        .update(deadLetters)
        .set({ resolvedAt: now })
        .where(and(eq(deadLetters.creatorId, creatorId), eq(deadLetters.kind, "enrichment"), isNull(deadLetters.resolvedAt)));
    }
    await db.update(creators).set({ enrichmentStatus: status, updatedAt: now }).where(eq(creators.id, creatorId));
  }
}

// One open dead letter per creator: a retried message or a second failed refresh refreshes it, never duplicates it
export async function deadLetterOnce(db: Db, d: { creatorId: string; reason: string; detail: Record<string, unknown> }): Promise<void> {
  const open = and(eq(deadLetters.creatorId, d.creatorId), eq(deadLetters.kind, "enrichment"), isNull(deadLetters.resolvedAt));
  const [existing] = await db.select({ id: deadLetters.id }).from(deadLetters).where(open).limit(1);
  if (existing) {
    await db.update(deadLetters).set({ reason: d.reason, detail: d.detail }).where(eq(deadLetters.id, existing.id));
    return;
  }
  await db.insert(deadLetters).values({ id: newId(), kind: "enrichment", creatorId: d.creatorId, reason: d.reason, detail: d.detail, createdAt: Date.now() });
}

// FR-CORE-12: hourly sweep of active creators whose snapshots are older than the TTL. Creators that failed for
// reasons about them in the last day are skipped, so a dead handle doesn't burn paid actor runs every hour; a
// source outage doesn't hold anyone back (finding 18).
export async function sweepStale(env: Env): Promise<void> {
  const last = Number((await env.CONFIG.get("sweep:last")) ?? 0);
  if (Date.now() - last < SWEEP_EVERY_MS) return;
  // Claimed before the work so overlapping crons don't both run it, and handed back if the work fails (finding 19)
  await env.CONFIG.put("sweep:last", String(Date.now()));
  try {
    if (!readSecret(env, "APIFY_TOKEN") && !readSecret(env, "YOUTUBE_API_KEY")) return;
    const now = Date.now();
    // Seeded demo creators (seed/demo-creators.sql) are fictional, so there's nothing on any platform to fetch
    const { results } = await env.DB.prepare(
      `SELECT c.id FROM creators c
       WHERE c.active = 1
         AND c.source != 'seed'
         AND NOT EXISTS (SELECT 1 FROM enrichment_jobs j WHERE j.creator_id = c.id AND j.status = 'pending' AND j.created_at > ?1)
         AND NOT EXISTS (SELECT 1 FROM enrichment_jobs j WHERE j.creator_id = c.id AND j.status = 'failed' AND j.created_at > ?2
                           AND COALESCE(j.failure_scope, 'handle') = 'handle')
         AND COALESCE((SELECT MAX(s.fetched_at) FROM stat_snapshots s WHERE s.creator_id = c.id), 0) < ?3
       LIMIT ?4`,
    )
      .bind(now - 3_600_000, now - 86_400_000, now - SNAPSHOT_TTL_MS, SWEEP_LIMIT)
      .all<{ id: string }>();
    if (results.length) await requestEnrichment(env, results.map((r) => r.id), "sweep", "system:cron");
  } catch (e) {
    await env.CONFIG.put("sweep:last", String(last)).catch(() => undefined);
    throw e;
  }
}
