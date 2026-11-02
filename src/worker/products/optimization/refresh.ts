import { and, eq, isNull } from "drizzle-orm";
import { getDb, type Db } from "../../core/db/client";
import { campaignPosts, campaignRefreshes, campaigns, contentItems, contentMetrics } from "../../core/db/schema";
import { errorMessage, readSecret } from "../../core/env";
import { ACTORS, finishApifyRun, getActorRun, getDatasetItems, startActor } from "../../core/enrichment/apify";
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

export async function startCampaignRefresh(env: Env, campaignId: string, trigger: Trigger, requestedBy: string): Promise<{ refreshId: string; existing: boolean }> {
  const db = getDb(env);
  const [campaign] = await db.select().from(campaigns).where(eq(campaigns.id, campaignId));
  if (!campaign || campaign.status !== "active") throw new RefreshError("campaign_not_active");
  const [running] = await db
    .select({ id: campaignRefreshes.id })
    .from(campaignRefreshes)
    .where(and(eq(campaignRefreshes.campaignId, campaignId), eq(campaignRefreshes.status, "running")))
    .limit(1);
  if (running) return { refreshId: running.id, existing: true };
  const posts = await trackedPosts(db, campaignId);
  if (!posts.length) throw new RefreshError("no_posts_to_refresh");

  const platforms = [...new Set(posts.map((p) => p.platform))];
  const refreshId = newId();
  const now = Date.now();
  await db.batch([
    db.insert(campaignRefreshes).values({ id: refreshId, campaignId, trigger, platforms, done: [], failed: [], status: "running", requestedBy, startedAt: now }),
    db.update(campaigns).set({ lastRefreshAt: now, updatedAt: now }).where(eq(campaigns.id, campaignId)),
  ]);

  for (const platform of platforms) {
    const mine = posts.filter((p) => p.platform === platform);
    try {
      if (platform === "youtube") {
        // YouTube answers in seconds, so it runs inline
        const res = await fetchYouTubeVideos(env, mine.map((p) => p.platformPostId));
        if ("error" in res) throw new Error(res.error);
        await env.FILES.put(`raw/youtube/posts-${refreshId}.json`, JSON.stringify(res.raw), { httpMetadata: { contentType: "application/json" } });
        await applyResults(db, mine, youtubePostResults(res.videos, mine.map((p) => p.platformPostId)), "youtube_api");
        await markDone(env, refreshId, platform);
        continue;
      }
      const input = platform === "instagram" ? { directUrls: mine.map((p) => p.url), resultsType: "posts", resultsLimit: 1 } : { postURLs: mine.map((p) => p.url) };
      const actor = platform === "instagram" ? ACTORS.instagramPosts : ACTORS.tiktokPosts;
      const { localRunId, apifyRunId } = await startActor(env, actor, input, "posts", `${platform}: ${mine.length} campaign posts`);
      await env.ENRICH_QUEUE.send(
        { kind: "apify-poll", purpose: "posts", platform, localRunId, apifyRunId, startedAt: Date.now(), refreshId } satisfies ApifyPollMessage,
        { delaySeconds: 20 },
      );
    } catch (e) {
      await markFailed(env, refreshId, platform, errorMessage(e));
    }
  }
  await env.ENRICH_QUEUE.send({ kind: "campaign-refresh-timeout", refreshId } satisfies CampaignRefreshTimeoutMessage, { delaySeconds: REFRESH_TIMEOUT_S });
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
    await finishApifyRun(env, msg.localRunId, "POLL_FAILED", null, errorMessage(e));
    await markFailed(env, refreshId, msg.platform, errorMessage(e));
    return tryFinalize(env, refreshId);
  }

  if (state.status === "SUCCEEDED" && state.datasetId) {
    const items = await getDatasetItems(env, state.datasetId, 500);
    await env.FILES.put(`raw/apify/${msg.apifyRunId}.json`, JSON.stringify(items), { httpMetadata: { contentType: "application/json" } });
    await finishApifyRun(env, msg.localRunId, "SUCCEEDED", items.length, undefined, state.usageUsd);
    // Late results after a timeout still count: they are real data for the next digest
    const posts = await trackedPosts(db, refresh.campaignId, msg.platform);
    const results =
      msg.platform === "instagram"
        ? instagramPostResults(items, posts.map((p) => p.platformPostId))
        : tiktokPostResults(items, posts.map((p) => ({ postId: p.platformPostId, url: p.url })));
    await applyResults(db, posts, results, "apify");
    await markDone(env, refreshId, msg.platform);
    return tryFinalize(env, refreshId);
  }
  if ((state.status === "READY" || state.status === "RUNNING") && withinWindow) {
    return void (await env.ENRICH_QUEUE.send(msg, { delaySeconds: 15 }));
  }
  await finishApifyRun(env, msg.localRunId, state.status === "RUNNING" ? "POLL_TIMEOUT" : state.status, null, `Apify run ended as ${state.status}`, state.usageUsd);
  await markFailed(env, refreshId, msg.platform, `Apify run ended as ${state.status}`);
  return tryFinalize(env, refreshId);
}

// BR-CO-1: a post the source says is gone, or that goes missing twice in a row, is marked unavailable;
// its last metrics stay for the closing record. Nothing is back-filled.
async function applyResults(db: Db, posts: Tracked[], results: Map<string, PostResult>, source: "apify" | "youtube_api"): Promise<void> {
  const now = Date.now();
  const statements = [];
  for (const p of posts) {
    const r = results.get(p.platformPostId) ?? { status: "missing" };
    if (r.status === "ok") {
      statements.push(
        db.insert(contentMetrics).values({ id: newId(), contentId: p.contentId, ...r.metrics, source, fetchedAt: now }),
        db.update(campaignPosts).set({ misses: 0 }).where(eq(campaignPosts.id, p.id)),
        db.update(contentItems).set({ status: "available" }).where(eq(contentItems.id, p.contentId)),
      );
      continue;
    }
    const misses = p.misses + 1;
    const gone = r.status === "gone" || misses >= MISSES_TO_UNAVAILABLE;
    const reason = r.status === "gone" ? r.reason : "Not returned by the source in two refreshes in a row";
    statements.push(db.update(campaignPosts).set(gone ? { misses, unavailableAt: now, unavailableReason: reason } : { misses }).where(eq(campaignPosts.id, p.id)));
    if (gone) statements.push(db.update(contentItems).set({ status: "unavailable" }).where(eq(contentItems.id, p.contentId)));
  }
  if (statements.length) await db.batch([statements[0]!, ...statements.slice(1)]);
}

async function markDone(env: Env, refreshId: string, platform: string): Promise<void> {
  await env.DB.prepare("UPDATE campaign_refreshes SET done = json_insert(done, '$[#]', ?1) WHERE id = ?2").bind(platform, refreshId).run();
}

async function markFailed(env: Env, refreshId: string, platform: string, error: string): Promise<void> {
  await env.DB.prepare("UPDATE campaign_refreshes SET failed = json_insert(failed, '$[#]', json(?1)) WHERE id = ?2")
    .bind(JSON.stringify({ platform, error: error.slice(0, 200) }), refreshId)
    .run();
}

// Exactly once: the single statement that flips the refresh to done is the one that queues the digest
async function tryFinalize(env: Env, refreshId: string, force = false): Promise<void> {
  const row = await env.DB.prepare(
    `UPDATE campaign_refreshes SET status = 'done', finished_at = ?1
     WHERE id = ?2 AND status = 'running'
       AND (?3 = 1 OR json_array_length(done) + json_array_length(failed) >= json_array_length(platforms))
     RETURNING campaign_id`,
  )
    .bind(Date.now(), refreshId, force ? 1 : 0)
    .first<{ campaign_id: string }>();
  if (row) await env.ENRICH_QUEUE.send({ kind: "campaign-digest", campaignId: row.campaign_id, refreshId } satisfies CampaignDigestMessage);
}

export async function handleRefreshTimeout(env: Env, msg: CampaignRefreshTimeoutMessage): Promise<void> {
  const [r] = await getDb(env).select().from(campaignRefreshes).where(eq(campaignRefreshes.id, msg.refreshId));
  if (!r || r.status !== "running") return;
  const answered = new Set([...r.done, ...r.failed.map((f) => f.platform)]);
  for (const platform of r.platforms.filter((p) => !answered.has(p))) await markFailed(env, r.id, platform, "Timed out waiting for the source");
  await tryFinalize(env, r.id, true);
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
    try {
      if (!(await startCampaignRefresh(env, c.id, "schedule", "system:cron")).existing) started++;
    } catch (e) {
      if (!(e instanceof RefreshError)) throw e;
    }
  }
  return started;
}
