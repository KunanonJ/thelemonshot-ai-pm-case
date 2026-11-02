import { and, eq, inArray, isNull } from "drizzle-orm";
import { getDb, insertChunked, type Db } from "../db/client";
import { contentItems, contentMetrics, creators, deadLetters, enrichmentJobs, statSnapshots, type Platform } from "../db/schema";
import { errorMessage, readSecret } from "../env";
import type { ApifyPollMessage, EnrichMessage, EnrichReason } from "../messages";
import { chunk, newId, normaliseHandle } from "../util";
import { ACTORS, finishApifyRun, getActorRun, getDatasetItems, startActor } from "./apify";
import { processDiscoveryResults } from "./discovery";
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

type CreatorRow = typeof creators.$inferSelect;

export function handlesOf(c: Pick<CreatorRow, "instagram" | "tiktok" | "youtube">): Platform[] {
  return (["instagram", "tiktok", "youtube"] as const).filter((p) => Boolean(c[p]));
}

async function creatorsByIds(db: Db, ids: string[]): Promise<CreatorRow[]> {
  const out: CreatorRow[] = [];
  for (const part of chunk(ids, ID_CHUNK)) out.push(...(await db.select().from(creators).where(inArray(creators.id, part))));
  return out;
}

// Queues one pending job per creator and platform, then hands the batch to the queue consumer
export async function requestEnrichment(env: Env, creatorIds: string[], reason: EnrichReason, requestedBy: string): Promise<number> {
  const db = getDb(env);
  const now = Date.now();
  const jobs: (typeof enrichmentJobs.$inferInsert)[] = [];
  const queued: string[] = [];
  for (const c of await creatorsByIds(db, creatorIds)) {
    const platforms = handlesOf(c);
    if (platforms.length === 0) {
      await deadLetter(db, { creatorId: c.id, reason: "No platform handles to enrich", detail: {} });
      await db.update(creators).set({ enrichmentStatus: "failed", updatedAt: now }).where(eq(creators.id, c.id));
      continue;
    }
    for (const platform of platforms) {
      jobs.push({ id: newId(), creatorId: c.id, platform, status: "pending", reason, requestedBy, createdAt: now, updatedAt: now });
    }
    queued.push(c.id);
  }
  await insertChunked(db, enrichmentJobs, jobs);
  for (const batch of chunk(queued, QUEUE_BATCH)) {
    await env.ENRICH_QUEUE.send({ kind: "enrich", creatorIds: batch, reason, requestedBy } satisfies EnrichMessage);
  }
  return jobs.length;
}

export async function handleEnrich(env: Env, msg: EnrichMessage): Promise<void> {
  const db = getDb(env);
  const rows = await creatorsByIds(db, msg.creatorIds);
  const byId = new Map(rows.map((c) => [c.id, c]));
  const pending: (typeof enrichmentJobs.$inferSelect)[] = [];
  for (const part of chunk(msg.creatorIds, ID_CHUNK)) {
    pending.push(
      ...(await db
        .select()
        .from(enrichmentJobs)
        .where(and(inArray(enrichmentJobs.creatorId, part), eq(enrichmentJobs.status, "pending"), isNull(enrichmentJobs.apifyRunId)))),
    );
  }

  // YouTube answers in seconds, so it runs inline
  for (const job of pending.filter((j) => j.platform === "youtube")) {
    const creator = byId.get(job.creatorId);
    if (!creator?.youtube) continue;
    try {
      const result = await fetchYouTubeProfile(env, creator.youtube);
      if ("error" in result) {
        await finishJob(db, job.id, "failed", result.error);
        continue;
      }
      const rawKey = `raw/youtube/${creator.id}-${Date.now()}.json`;
      await env.FILES.put(rawKey, JSON.stringify(result.raw), { httpMetadata: { contentType: "application/json" } });
      await writeSnapshot(db, creator.id, result.profile, "youtube_api", null, rawKey);
      await finishJob(db, job.id, "ok");
    } catch (e) {
      await finishJob(db, job.id, "failed", errorMessage(e));
    }
  }

  // Instagram and TikTok take minutes: start one Apify run per platform for the whole batch, then poll
  for (const platform of ["instagram", "tiktok"] as const) {
    const jobs = pending.filter((j) => j.platform === platform && byId.get(j.creatorId)?.[platform]);
    if (!jobs.length) continue;
    const handles = jobs.map((j) => normaliseHandle(byId.get(j.creatorId)![platform]!));
    const input =
      platform === "instagram"
        ? { usernames: handles }
        : { profiles: handles, resultsPerPage: TIKTOK_VIDEOS_PER_PROFILE };
    const actor = platform === "instagram" ? ACTORS.instagramProfile : ACTORS.tiktokProfile;
    try {
      const { localRunId, apifyRunId } = await startActor(env, actor, input, "profile", `${platform}: ${handles.length} profiles`);
      for (const part of chunk(jobs.map((j) => j.id), ID_CHUNK)) {
        await db.update(enrichmentJobs).set({ apifyRunId, updatedAt: Date.now() }).where(inArray(enrichmentJobs.id, part));
      }
      await env.ENRICH_QUEUE.send(
        { kind: "apify-poll", purpose: "profile", platform, localRunId, apifyRunId, startedAt: Date.now() } satisfies ApifyPollMessage,
        { delaySeconds: 30 },
      );
    } catch (e) {
      // The previous snapshot (if any) stays in place; the failure is recorded (FR-CORE-12)
      for (const job of jobs) await finishJob(db, job.id, "failed", errorMessage(e));
    }
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
    const items = await getDatasetItems(env, state.datasetId, msg.purpose === "profile" ? 1_000 : 2_000);
    const rawKey = `raw/apify/${msg.apifyRunId}.json`;
    await env.FILES.put(rawKey, JSON.stringify(items), { httpMetadata: { contentType: "application/json" } });
    await finishApifyRun(env, msg.localRunId, "SUCCEEDED", items.length);
    if (msg.purpose === "discovery") return processDiscoveryResults(env, msg, items);
    return applyProfileResults(env, db, msg, items, rawKey);
  }
  if ((state.status === "READY" || state.status === "RUNNING") && withinWindow) {
    return void (await env.ENRICH_QUEUE.send(msg, { delaySeconds: 15 }));
  }
  return failApifyRun(env, db, msg, state.status === "RUNNING" ? "POLL_TIMEOUT" : state.status, `Apify run ended as ${state.status}`);
}

async function applyProfileResults(env: Env, db: Db, msg: ApifyPollMessage, items: unknown[], rawKey: string): Promise<void> {
  const profiles = msg.platform === "instagram" ? normaliseInstagram(items) : normaliseTikTok(items);
  const byHandle = new Map(profiles.map((p) => [p.handle, p]));
  const jobs = await db
    .select()
    .from(enrichmentJobs)
    .where(and(eq(enrichmentJobs.apifyRunId, msg.apifyRunId), eq(enrichmentJobs.status, "pending")));
  const byId = new Map((await creatorsByIds(db, jobs.map((j) => j.creatorId))).map((c) => [c.id, c]));
  for (const job of jobs) {
    const handle = byId.get(job.creatorId)?.[msg.platform];
    const profile = handle ? byHandle.get(normaliseHandle(handle)) : undefined;
    if (!profile) await finishJob(db, job.id, "failed", "Handle not found in the actor results");
    else if (profile.isPrivate) await finishJob(db, job.id, "failed", "Account is private");
    else {
      await writeSnapshot(db, job.creatorId, profile, "apify", msg.apifyRunId, rawKey);
      await finishJob(db, job.id, "ok");
    }
  }
  await settleCreators(env, jobs.map((j) => j.creatorId));
}

async function failApifyRun(env: Env, db: Db, msg: ApifyPollMessage, status: string, error: string): Promise<void> {
  await finishApifyRun(env, msg.localRunId, status, null, error);
  if (msg.purpose !== "profile") return;
  const jobs = await db
    .select()
    .from(enrichmentJobs)
    .where(and(eq(enrichmentJobs.apifyRunId, msg.apifyRunId), eq(enrichmentJobs.status, "pending")));
  for (const job of jobs) await finishJob(db, job.id, "failed", error);
  await settleCreators(env, jobs.map((j) => j.creatorId));
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

async function finishJob(db: Db, jobId: string, status: "ok" | "failed", error?: string): Promise<void> {
  await db
    .update(enrichmentJobs)
    .set({ status, error: error?.slice(0, 300) ?? null, updatedAt: Date.now() })
    .where(eq(enrichmentJobs.id, jobId));
}

// Once every platform job for a creator has finished, set its status. A creator whose platforms all
// failed goes to the dead-letter list; everyone else proceeds (BR-CORE-1).
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
      await deadLetter(db, {
        creatorId,
        reason: "Enrichment failed on every platform",
        detail: { platforms: failed.map((j) => ({ platform: j.platform, error: j.error })) },
      });
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

async function deadLetter(db: Db, d: { creatorId: string; reason: string; detail: Record<string, unknown> }): Promise<void> {
  await db.insert(deadLetters).values({ id: newId(), kind: "enrichment", creatorId: d.creatorId, reason: d.reason, detail: d.detail, createdAt: Date.now() });
}

// FR-CORE-12: hourly sweep of active creators whose snapshots are older than the TTL. Creators that
// failed in the last day are skipped, so a dead handle doesn't burn paid actor runs every hour.
export async function sweepStale(env: Env): Promise<void> {
  const last = Number((await env.CONFIG.get("sweep:last")) ?? 0);
  if (Date.now() - last < SWEEP_EVERY_MS) return;
  await env.CONFIG.put("sweep:last", String(Date.now()));
  if (!readSecret(env, "APIFY_TOKEN") && !readSecret(env, "YOUTUBE_API_KEY")) return;

  const now = Date.now();
  const { results } = await env.DB.prepare(
    `SELECT c.id FROM creators c
     WHERE c.active = 1
       AND NOT EXISTS (SELECT 1 FROM enrichment_jobs j WHERE j.creator_id = c.id AND j.status = 'pending' AND j.created_at > ?1)
       AND NOT EXISTS (SELECT 1 FROM enrichment_jobs j WHERE j.creator_id = c.id AND j.status = 'failed' AND j.created_at > ?2)
       AND COALESCE((SELECT MAX(s.fetched_at) FROM stat_snapshots s WHERE s.creator_id = c.id), 0) < ?3
     LIMIT ?4`,
  )
    .bind(now - 3_600_000, now - 86_400_000, now - SNAPSHOT_TTL_MS, SWEEP_LIMIT)
    .all<{ id: string }>();
  if (results.length) await requestEnrichment(env, results.map((r) => r.id), "sweep", "system:cron");
}
