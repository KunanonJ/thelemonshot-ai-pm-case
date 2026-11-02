import { and, desc, eq, inArray } from "drizzle-orm";
import { getDb, type Db } from "../../core/db/client";
import { campaignDigests, campaignPosts, campaignRefreshes, campaigns, contentMetrics, creators, runLogs, runs, statSnapshots } from "../../core/db/schema";
import { callJson } from "../../core/llm";
import type { CampaignDigestMessage } from "../../core/messages";
import { inputHash, newId } from "../../core/util";
import { buildDigestPrompt, DIGEST_PROMPT_VERSION, narrativeJsonSchema, narrativeSchema, validateNarrative, type Narrative } from "./contract";
import { computeDeltas, DELTAS_VERSION, type DigestDeltas, type TrackedPostInput } from "./deltas";

// The current state of every tracked post, from content_items snapshots only (AC-CO-1)
export async function loadDeltas(db: Db, campaignId: string, now: number): Promise<{ deltas: DigestDeltas; sampleData: boolean }> {
  const rows = await db
    .select({ post: campaignPosts, creator: { id: creators.id, displayName: creators.displayName, isSample: creators.isSample } })
    .from(campaignPosts)
    .innerJoin(creators, eq(campaignPosts.creatorId, creators.id))
    .where(eq(campaignPosts.campaignId, campaignId));
  const contentIds = rows.map((r) => r.post.contentId);
  const metrics = contentIds.length ? await db.select().from(contentMetrics).where(inArray(contentMetrics.contentId, contentIds)).orderBy(contentMetrics.fetchedAt) : [];
  // Instagram engagement is measured against followers, from the creator's latest profile snapshot
  const igCreators = [...new Set(rows.filter((r) => r.post.platform === "instagram").map((r) => r.creator.id))];
  const snaps = igCreators.length
    ? await db
        .select({ creatorId: statSnapshots.creatorId, followers: statSnapshots.followers })
        .from(statSnapshots)
        .where(and(inArray(statSnapshots.creatorId, igCreators), eq(statSnapshots.platform, "instagram")))
        .orderBy(desc(statSnapshots.fetchedAt))
    : [];
  const followers = new Map<string, number | null>();
  for (const s of snaps) if (!followers.has(s.creatorId)) followers.set(s.creatorId, s.followers);

  const inputs: TrackedPostInput[] = rows.map(({ post, creator }) => ({
    postId: post.id,
    creatorId: creator.id,
    creatorName: creator.displayName,
    platform: post.platform,
    url: post.url,
    baselineViews: post.baselineViews,
    baselineEr: post.baselineEngagementRate,
    followers: post.platform === "instagram" ? (followers.get(creator.id) ?? null) : null,
    history: metrics
      .filter((m) => m.contentId === post.contentId)
      .map((m) => ({ views: m.views, likes: m.likes, comments: m.comments, shares: m.shares, fetchedAt: m.fetchedAt })),
    state: post.unavailableAt ? "unavailable" : post.misses > 0 ? "missing" : "tracking",
    unavailableReason: post.unavailableReason,
  }));
  return { deltas: computeDeltas(inputs, now), sampleData: rows.some((r) => r.creator.isSample) };
}

// FR-CO-4 footer: when each source last returned data for this campaign, and what failed this time
async function freshnessOf(env: Env, campaignId: string, refresh: typeof campaignRefreshes.$inferSelect | undefined) {
  const { results } = await env.DB.prepare(
      `SELECT ci.platform AS platform, MAX(cm.fetched_at) AS last
       FROM campaign_posts cp JOIN content_items ci ON ci.id = cp.content_id JOIN content_metrics cm ON cm.content_id = cp.content_id
       WHERE cp.campaign_id = ?1 GROUP BY ci.platform`,
    )
    .bind(campaignId)
    .all<{ platform: string; last: number }>();
  return {
    refreshStartedAt: refresh?.startedAt ?? null,
    refreshFinishedAt: refresh?.finishedAt ?? null,
    lastData: Object.fromEntries(results.map((r) => [r.platform, r.last])),
    failed: refresh?.failed ?? [],
  };
}

export async function handleCampaignDigest(env: Env, msg: CampaignDigestMessage): Promise<void> {
  const db = getDb(env);
  const [existing] = await db.select({ runId: campaignDigests.runId }).from(campaignDigests).where(eq(campaignDigests.refreshId, msg.refreshId)).limit(1);
  if (existing) return; // a redelivered message changes nothing (NFR-2)
  const [campaign] = await db.select().from(campaigns).where(eq(campaigns.id, msg.campaignId));
  if (!campaign) return;
  const [refresh] = await db.select().from(campaignRefreshes).where(eq(campaignRefreshes.id, msg.refreshId));

  const now = Date.now();
  const { deltas, sampleData } = await loadDeltas(db, campaign.id, now);
  const freshness = await freshnessOf(env, campaign.id, refresh);
  const runId = newId();
  const flagsBase = { kind: "digest", campaignId: campaign.id, refreshId: msg.refreshId };
  await db.batch([
    db.insert(runs).values({
      id: runId,
      product: "optimization",
      status: "running",
      inputHash: await inputHash(flagsBase),
      flags: flagsBase,
      createdBy: refresh?.requestedBy ?? "system",
      createdAt: now,
      startedAt: now,
    }),
    db.insert(runLogs).values({
      id: newId(),
      runId,
      kind: "inputs",
      payload: { ...flagsBase, deltasVersion: DELTAS_VERSION, posts: deltas.posts.length, freshness },
      actor: "system",
      createdAt: now,
    }),
  ]);

  // AC-CO-4: the narrative is the only part that needs the model; without it the digest still ships
  let narrative: Narrative | null = null;
  let flags: string[] = [];
  let failure: string | null = null;
  let model: string | null = null;
  if (deltas.verdict.kind === "no_data") {
    failure = "no_data";
  } else {
    const prompt = buildDigestPrompt({ name: campaign.name, brand: campaign.brand }, deltas);
    const res = await callJson(env, {
      product: "optimization",
      promptVersion: DIGEST_PROMPT_VERSION,
      system: prompt.system,
      user: prompt.user,
      schema: narrativeSchema,
      jsonSchema: narrativeJsonSchema(),
      runId,
      maxTokens: 4_000,
    });
    model = res.model;
    if (res.ok) ({ narrative, flags } = validateNarrative(res.data, deltas));
    else failure = res.reason;
  }
  if (!narrative) flags.push("narrative_unavailable");
  if (deltas.unavailable.length) flags.push(`posts_unavailable:${deltas.unavailable.length}`);
  if (freshness.failed.length) flags.push(`sources_failed:${freshness.failed.length}`);

  await db.batch([
    db.insert(campaignDigests).values({
      runId,
      campaignId: campaign.id,
      refreshId: msg.refreshId,
      deltas: deltas as unknown as Record<string, unknown>,
      narrative: narrative as unknown as Record<string, unknown> | null,
      freshness,
      flags,
      createdAt: Date.now(),
    }),
    db.insert(runLogs).values({ id: newId(), runId, kind: "llm", payload: { model, failure, promptVersion: DIGEST_PROMPT_VERSION }, actor: "system", createdAt: Date.now() }),
    db.update(runs).set({ status: "draft", finishedAt: Date.now(), flags: { ...flagsBase, llmFailure: failure, sampleData } }).where(eq(runs.id, runId)),
    db.update(campaignRefreshes).set({ digestRunId: runId }).where(eq(campaignRefreshes.id, msg.refreshId)),
  ]);
}
