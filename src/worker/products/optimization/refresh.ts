import { and, eq, isNull, sql } from "drizzle-orm";
import type { BatchItem } from "drizzle-orm/batch";
import { getDb, isUniqueViolation, type Db } from "../../core/db/client";
import { campaignPosts, campaignRefreshes, campaigns, contentItems, contentMetrics } from "../../core/db/schema";
import { errorMessage, readSecret } from "../../core/env";
import { abandonApifyRun, ACTORS, finishApifyRun, getActorRun, getDatasetItems, startActor } from "../../core/enrichment/apify";
import { classifySourceFailure, SOURCE_FAILURE_TEXT, type SourceFailure } from "../../core/enrichment/failures";
import { instagramPostResults, tiktokPostResults, youtubePostResults, type PostResult } from "../../core/enrichment/posts";
import { fetchYouTubeVideos } from "../../core/enrichment/youtube";
import type { ApifyPollMessage, CampaignDigestMessage, CampaignRefreshTimeoutMessage } from "../../core/messages";
import { newId } from "../../core/util";

// Workflow step 2: refresh tracked-post metrics through the enrichment sources, then digest once every
// platform has answered. A source that fails keeps its last-good numbers (BR-CO-2).

const APIFY_POLL_LIMIT_MS = 5 * 60_000; // FR-CORE-13
// Anything slower than the Apify poll window plus a margin counts as failed for this refresh
const REFRESH_TIMEOUT_S = 8 * 60;
const MISSES_TO_UNAVAILABLE = 2;
const DAY_MS = 86_400_000;
// The cron fires a few minutes either side of the hour; a refresh due "daily" shouldn't slip a whole day
const CADENCE_SLACK_MS = 10 * 60_000;
export const MANUAL_COOLDOWN_MS = 5 * 60_000;
// A done refresh whose digest message was lost is queued again by the stuck-work sweep, for a while only
const DIGEST_REDRIVE_AFTER_MS = 5 * 60_000;
const DIGEST_REDRIVE_WITHIN_MS = 6 * 3_600_000;

export class RefreshError extends Error {}

type Trigger = "schedule" | "manual" | "registration";
type Tracked = { id: string; contentId: string; platform: "instagram" | "tiktok" | "youtube"; url: string; misses: number; platformPostId: string };

async function trackedPosts(db: Db, campaignId: string, platform?: Tracked["platform"]): Promise<Tracked[]> {
  return db
    .select({
      id: campaignPosts.id,
      contentId: campaignPosts.contentId,
      platform: campaignPosts.platform,
      url: campaignPosts.url,
      misses: campaignPosts.misses,
      platformPostId: contentItems.platformPostId,
    })
    .from(campaignPosts)
    .innerJoin(contentItems, eq(campaignPosts.contentId, contentItems.id))
    .where(and(eq(campaignPosts.campaignId, campaignId), isNull(campaignPosts.unavailableAt), platform ? eq(campaignPosts.platform, platform) : undefined));
}

async function runningRefresh(db: Db, campaignId: string) {
  const [row] = await db
    .select({ id: campaignRefreshes.id, startedAt: campaignRefreshes.startedAt })
    .from(campaignRefreshes)
    .where(and(eq(campaignRefreshes.campaignId, campaignId), eq(campaignRefreshes.status, "running")))
    .limit(1);
  return row;
}

export async function startCampaignRefresh(env: Env, campaignId: string, trigger: Trigger, requestedBy: string): Promise<{ refreshId: string; existing: boolean }> {
  const db = getDb(env);
  const [campaign] = await db.select().from(campaigns).where(eq(campaigns.id, campaignId));
  if (!campaign || campaign.status !== "active") throw new RefreshError("campaign_not_active");
  const inFlight = await runningRefresh(db, campaignId);
  if (inFlight) {
    if (Date.now() - inFlight.startedAt < REFRESH_TIMEOUT_S * 1000) return { refreshId: inFlight.id, existing: true };
    // Past its own timeout, so that message was lost: it's settled here instead of blocking the campaign (finding 11)
    await handleRefreshTimeout(env, { kind: "campaign-refresh-timeout", refreshId: inFlight.id });
  }
  const posts = await trackedPosts(db, campaignId);
  if (!posts.length) throw new RefreshError("no_posts_to_refresh");

  const platforms = [...new Set(posts.map((p) => p.platform))];
  const refreshId = newId();
  const now = Date.now();
  try {
    await db.batch([
      db.insert(campaignRefreshes).values({ id: refreshId, campaignId, trigger, platforms, done: [], failed: [], status: "running", requestedBy, startedAt: now }),
      db.update(campaigns).set({ lastRefreshAt: now, updatedAt: now }).where(eq(campaigns.id, campaignId)),
    ]);
  } catch (e) {
    // One running refresh per campaign (a partial unique index): a start that raced this one got there first
    const other = isUniqueViolation(e) ? await runningRefresh(db, campaignId) : undefined;
    if (other) return { refreshId: other.id, existing: true };
    throw e;
  }
  // The timeout goes first, so a refresh that fails part-way still finishes. If even this send fails, the next
  // start or the stuck-work sweep settles the refresh.
  await env.ENRICH_QUEUE.send({ kind: "campaign-refresh-timeout", refreshId } satisfies CampaignRefreshTimeoutMessage, { delaySeconds: REFRESH_TIMEOUT_S }).catch((e) =>
    console.error("refresh timeout not queued", { refreshId, error: errorMessage(e) }),
  );

  for (const platform of platforms) {
    const mine = posts.filter((p) => p.platform === platform);
    let started: { localRunId: string; apifyRunId: string } | null = null;
    try {
      if (platform === "youtube") {
        // YouTube answers in seconds, so it runs inline
        const res = await fetchYouTubeVideos(env, mine.map((p) => p.platformPostId));
        if ("error" in res) throw new Error(res.error);
        await archive(env, `raw/youtube/posts-${refreshId}.json`, res.raw);
        await applyPlatformResults(db, refreshId, platform, mine, youtubePostResults(res.videos, mine.map((p) => p.platformPostId)), "youtube_api");
        continue;
      }
      const input = platform === "instagram" ? { directUrls: mine.map((p) => p.url), resultsType: "posts", resultsLimit: 1 } : { postURLs: mine.map((p) => p.url) };
      const actor = platform === "instagram" ? ACTORS.instagramPosts : ACTORS.tiktokPosts;
      started = await startActor(env, actor, input, "posts", `${platform}: ${mine.length} campaign posts`);
      await env.ENRICH_QUEUE.send(
        { kind: "apify-poll", purpose: "posts", platform, localRunId: started.localRunId, apifyRunId: started.apifyRunId, startedAt: Date.now(), refreshId } satisfies ApifyPollMessage,
        { delaySeconds: 20 },
      );
    } catch (e) {
      // Nothing would poll a run whose poll wasn't queued, so it's stopped rather than left billing
      if (started) await abandonApifyRun(env, started, "Its poll couldn't be queued");
      await markFailed(env, refreshId, platform, classifySourceFailure(e), errorMessage(e));
    }
  }
  await tryFinalize(env, refreshId);
  return { refreshId, existing: false };
}

export async function handleCampaignPostsPoll(env: Env, msg: ApifyPollMessage): Promise<void> {
  const db = getDb(env);
  const refreshId = msg.refreshId!;
  const [refresh] = await db.select().from(campaignRefreshes).where(eq(campaignRefreshes.id, refreshId));
  if (!refresh) return;
  const withinWindow = Date.now() - msg.startedAt < APIFY_POLL_LIMIT_MS;
  let state;
  try {
    state = await getActorRun(env, msg.apifyRunId, 50);
  } catch (e) {
    if (withinWindow) return void (await env.ENRICH_QUEUE.send(msg, { delaySeconds: 30 }));
    await abandonApifyRun(env, msg, "Polling it kept failing");
    await markFailed(env, refreshId, msg.platform, classifySourceFailure(e), errorMessage(e));
    return tryFinalize(env, refreshId);
  }

  if (state.status === "SUCCEEDED" && state.datasetId) {
    let items: unknown[];
    try {
      items = await getDatasetItems(env, state.datasetId, 500);
    } catch (e) {
      if (withinWindow) return void (await env.ENRICH_QUEUE.send(msg, { delaySeconds: 30 }));
      await finishApifyRun(env, msg.localRunId, "DATASET_FAILED", null, errorMessage(e), state.usageUsd);
      await markFailed(env, refreshId, msg.platform, classifySourceFailure(e), errorMessage(e));
      return tryFinalize(env, refreshId);
    }
    await archive(env, `raw/apify/${msg.apifyRunId}.json`, items);
    await finishApifyRun(env, msg.localRunId, "SUCCEEDED", items.length, undefined, state.usageUsd);
    // Late results after a timeout still count: they are real data for the next digest
    const posts = await trackedPosts(db, refresh.campaignId, msg.platform);
    const results =
      msg.platform === "instagram"
        ? instagramPostResults(items, posts.map((p) => p.platformPostId))
        : tiktokPostResults(items, posts.map((p) => ({ postId: p.platformPostId, url: p.url })));
    await applyPlatformResults(db, refreshId, msg.platform, posts, results, "apify");
    return tryFinalize(env, refreshId);
  }
  const inFlight = state.status === "READY" || state.status === "RUNNING";
  if (inFlight && withinWindow) return void (await env.ENRICH_QUEUE.send(msg, { delaySeconds: 15 }));
  if (inFlight) await abandonApifyRun(env, msg, "Still running after its poll window");
  else await finishApifyRun(env, msg.localRunId, state.status, null, `Apify run ended as ${state.status}`, state.usageUsd);
  await markFailed(env, refreshId, msg.platform, inFlight || state.status === "TIMED-OUT" ? "timeout" : "unavailable", `Apify run ended as ${state.status}`);
  return tryFinalize(env, refreshId);
}

// The queue's last delivery of a posts poll failed (queue.ts): the platform counts as failed for this refresh
export async function failCampaignPostsPoll(env: Env, msg: ApifyPollMessage): Promise<void> {
  if (!msg.refreshId) return;
  await abandonApifyRun(env, msg, "Its poll failed on every delivery");
  await markFailed(env, msg.refreshId, msg.platform, "unavailable");
  await tryFinalize(env, msg.refreshId);
}

// The raw answer is kept for audit; losing that copy doesn't make the numbers any less real
async function archive(env: Env, key: string, data: unknown): Promise<void> {
  await env.FILES.put(key, JSON.stringify(data), { httpMetadata: { contentType: "application/json" } }).catch((e) =>
    console.error("raw source answer not archived", { key, error: errorMessage(e) }),
  );
}

// BR-CO-1: a post the source says is gone, or that goes missing twice in a row, is marked unavailable;
// its last metrics stay for the closing record. Nothing is back-filled.
// One batch per platform answer (finding 13): every write is guarded on the refresh not having this platform's
// answer yet, and the answer is recorded last, so a retried or duplicate delivery changes nothing. Misses aren't
// counted twice and the metric row has an id per refresh and post.
async function applyPlatformResults(
  db: Db,
  refreshId: string,
  platform: Tracked["platform"],
  posts: Tracked[],
  results: Map<string, PostResult>,
  source: "apify" | "youtube_api",
): Promise<void> {
  const unanswered = sql`NOT EXISTS (SELECT 1 FROM json_each((SELECT done FROM campaign_refreshes WHERE id = ${refreshId})) WHERE value = ${platform})`;
  const now = Date.now();
  const statements: BatchItem<"sqlite">[] = [];
  for (const p of posts) {
    const r = results.get(p.platformPostId) ?? { status: "missing" };
    if (r.status === "ok") {
      statements.push(
        db.insert(contentMetrics).values({ id: `${refreshId}:${p.contentId}`, contentId: p.contentId, ...r.metrics, source, fetchedAt: now }).onConflictDoNothing(),
        db.update(campaignPosts).set({ misses: 0 }).where(and(eq(campaignPosts.id, p.id), unanswered)),
        db.update(contentItems).set({ status: "available" }).where(eq(contentItems.id, p.contentId)),
      );
      continue;
    }
    const misses = p.misses + 1;
    const gone = r.status === "gone" || misses >= MISSES_TO_UNAVAILABLE;
    const reason = r.status === "gone" ? r.reason : "Not returned by the source in two refreshes in a row";
    statements.push(db.update(campaignPosts).set(gone ? { misses, unavailableAt: now, unavailableReason: reason } : { misses }).where(and(eq(campaignPosts.id, p.id), unanswered)));
    if (gone) statements.push(db.update(contentItems).set({ status: "unavailable" }).where(and(eq(contentItems.id, p.contentId), unanswered)));
  }
  statements.push(db.update(campaignRefreshes).set({ done: sql`json_insert(done, '$[#]', ${platform})` }).where(and(eq(campaignRefreshes.id, refreshId), unanswered)));
  await db.batch([statements[0]!, ...statements.slice(1)]);
}

// Set-like: a platform that already answered or already failed isn't recorded again. The stored text is the
// fixed phrase for the code (BR-CORE-3); the raw error goes to the log and, for Apify, to apify_runs.
async function markFailed(env: Env, refreshId: string, platform: string, failure: SourceFailure, raw?: string): Promise<void> {
  if (raw) console.error("campaign refresh source failed", { refreshId, platform, failure, error: raw.slice(0, 300) });
  try {
    await env.DB.prepare(
      `UPDATE campaign_refreshes SET failed = json_insert(failed, '$[#]', json(?1))
       WHERE id = ?2
         AND NOT EXISTS (SELECT 1 FROM json_each(campaign_refreshes.done) WHERE value = ?3)
         AND NOT EXISTS (SELECT 1 FROM json_each(campaign_refreshes.failed) WHERE json_extract(value, '$.platform') = ?3)`,
    )
      .bind(JSON.stringify({ platform, code: failure, error: SOURCE_FAILURE_TEXT[failure] }), refreshId, platform)
      .run();
  } catch (e) {
    // The refresh's timeout (or the stuck-work sweep) still closes it; this platform then reads as timed out
    console.error("refresh failure not recorded", { refreshId, platform, error: errorMessage(e) });
  }
}

// Exactly once: the single statement that flips the refresh to done is the one that queues the digest. If that
// send fails, the stuck-work sweep queues it later (a done refresh with no digest).
async function tryFinalize(env: Env, refreshId: string, force = false): Promise<void> {
  const row = await env.DB.prepare(
    `UPDATE campaign_refreshes SET status = 'done', finished_at = ?1
     WHERE id = ?2 AND status = 'running'
       AND (?3 = 1 OR json_array_length(done) + json_array_length(failed) >= json_array_length(platforms))
     RETURNING campaign_id`,
  )
    .bind(Date.now(), refreshId, force ? 1 : 0)
    .first<{ campaign_id: string }>();
  if (!row) return;
  await env.ENRICH_QUEUE.send({ kind: "campaign-digest", campaignId: row.campaign_id, refreshId } satisfies CampaignDigestMessage).catch((e) =>
    console.error("digest not queued", { refreshId, error: errorMessage(e) }),
  );
}

export async function handleRefreshTimeout(env: Env, msg: CampaignRefreshTimeoutMessage): Promise<void> {
  const [r] = await getDb(env).select().from(campaignRefreshes).where(eq(campaignRefreshes.id, msg.refreshId));
  if (!r || r.status !== "running") return;
  const answered = new Set([...r.done, ...r.failed.map((f) => f.platform)]);
  for (const platform of r.platforms.filter((p) => !answered.has(p))) await markFailed(env, r.id, platform, "timeout");
  await tryFinalize(env, r.id, true);
}

// Finding 12: done refreshes whose digest was never written, because the message was lost or kept failing
export async function redriveDigests(env: Env, now = Date.now()): Promise<number> {
  const { results } = await env.DB.prepare(
    `SELECT id, campaign_id FROM campaign_refreshes
     WHERE status = 'done' AND digest_run_id IS NULL AND finished_at < ?1 AND finished_at > ?2
     ORDER BY finished_at LIMIT 20`,
  )
    .bind(now - DIGEST_REDRIVE_AFTER_MS, now - DIGEST_REDRIVE_WITHIN_MS)
    .all<{ id: string; campaign_id: string }>();
  for (const r of results) await env.ENRICH_QUEUE.send({ kind: "campaign-digest", campaignId: r.campaign_id, refreshId: r.id } satisfies CampaignDigestMessage);
  return results.length;
}

// Workflow step 2: daily during the flight, weekly after it ends, until the campaign is closed. The cron calls
// this; so does the admin "run due refreshes" action, which is the same code path.
export async function runDueRefreshes(env: Env, now = Date.now()): Promise<number> {
  if (!readSecret(env, "APIFY_TOKEN") && !readSecret(env, "YOUTUBE_API_KEY")) return 0;
  const db = getDb(env);
  let started = 0;
  for (const c of await db.select().from(campaigns).where(eq(campaigns.status, "active"))) {
    if (now < c.startsAt) continue;
    const cadence = now <= c.endsAt ? DAY_MS : 7 * DAY_MS;
    if (c.lastRefreshAt && now - c.lastRefreshAt < cadence - CADENCE_SLACK_MS) continue;
    // One campaign's error never stops the others' refreshes (finding 19)
    try {
      if (!(await startCampaignRefresh(env, c.id, "schedule", "system:cron")).existing) started++;
    } catch (e) {
      if (!(e instanceof RefreshError)) console.error("scheduled refresh failed", { campaignId: c.id, error: errorMessage(e) });
    }
  }
  return started;
}
