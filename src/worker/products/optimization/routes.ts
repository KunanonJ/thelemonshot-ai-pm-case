import { and, desc, eq, inArray } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import { requireRole, type AppEnv } from "../../core/auth";
import { paidAction } from "../../core/limits";
import { getDb, insertChunked } from "../../core/db/client";
import { briefs, campaignActions, campaignDigests, campaignPosts, campaignRefreshes, campaigns, contentItems, creators, runLogs, runs } from "../../core/db/schema";
import { requestEnrichment } from "../../core/enrichment/service";
import { errorMessage } from "../../core/env";
import { newId } from "../../core/util";
import { campaignSchema, endOfDay, resolvePosts, startOfDay } from "./campaign";
import { closeCampaign, closePreview } from "./closing";
import { HISTORY_VERSION, OUTCOME_VERSION } from "./deltas";
import { loadDeltas, plainFailures } from "./digest";
import { MANUAL_COOLDOWN_MS, RefreshError, startCampaignRefresh } from "./refresh";

export const campaignRoutes = new Hono<AppEnv>();

// HR-2: shown on every ③ surface and returned with every payload
export const SCOPE = "Organic performance scope: public post metrics only. No ad-account data and no paid-media advice.";

campaignRoutes.get("/", async (c) => {
  const db = getDb(c.env);
  const rows = await db.select().from(campaigns).orderBy(desc(campaigns.createdAt)).limit(50);
  const ids = rows.map((r) => r.id);
  const posts = ids.length ? await db.select({ campaignId: campaignPosts.campaignId, unavailableAt: campaignPosts.unavailableAt }).from(campaignPosts).where(inArray(campaignPosts.campaignId, ids)) : [];
  const digests = ids.length
    ? await db
        .select({ campaignId: campaignDigests.campaignId, runId: campaignDigests.runId, createdAt: campaignDigests.createdAt, status: runs.status })
        .from(campaignDigests)
        .innerJoin(runs, eq(campaignDigests.runId, runs.id))
        .where(inArray(campaignDigests.campaignId, ids))
        .orderBy(desc(campaignDigests.createdAt))
    : [];
  return c.json({
    scope: SCOPE,
    campaigns: rows.map((r) => ({
      ...r,
      posts: posts.filter((p) => p.campaignId === r.id).length,
      unavailable: posts.filter((p) => p.campaignId === r.id && p.unavailableAt).length,
      latestDigest: digests.find((d) => d.campaignId === r.id) ?? null,
    })),
  });
});

// FR-CO-1: registration resolves every post to a creator, or creates a stub creator flagged for enrichment
campaignRoutes.post("/", requireRole("admin", "member"), paidAction, async (c) => {
  const parsed = campaignSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) return c.json({ error: "invalid_campaign", issues: parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })) }, 400);
  const db = getDb(c.env);
  const input = parsed.data;
  if (input.matrixRunId) {
    const [m] = await db.select({ product: runs.product }).from(runs).where(eq(runs.id, input.matrixRunId));
    if (m?.product !== "matrix") return c.json({ error: "unknown_shortlist" }, 400);
  }
  const userId = c.get("userId");
  const { resolved, stubs, problems } = await resolvePosts(db, input.posts, userId);
  if (problems.length) return c.json({ error: "invalid_posts", problems }, 400);

  const now = Date.now();
  const campaignId = newId();
  await insertChunked(db, creators, stubs);
  await insertChunked(
    db,
    contentItems,
    resolved.map((p) => ({ id: p.contentId, creatorId: p.creatorId, platform: p.platform, platformPostId: p.platformPostId, url: p.url, status: "available" as const, firstSeenAt: now })),
  );
  await db.insert(campaigns).values({
    id: campaignId,
    name: input.name,
    brand: input.brand,
    matrixRunId: input.matrixRunId ?? null,
    startsAt: startOfDay(input.startsOn),
    endsAt: endOfDay(input.endsOn),
    status: "active",
    createdBy: userId,
    createdAt: now,
    updatedAt: now,
  });
  await insertChunked(
    db,
    campaignPosts,
    resolved.map((p) => ({
      id: newId(),
      campaignId,
      creatorId: p.creatorId,
      contentId: p.contentId,
      platform: p.platform,
      url: p.url,
      baselineViews: p.baselineViews,
      baselineEngagementRate: p.baselineEngagementRate,
      misses: 0,
      addedAt: now,
    })),
  );
  // Stubs get a profile snapshot (Instagram engagement needs followers); the posts get their first numbers
  if (stubs.length) await requestEnrichment(c.env, stubs.map((s) => s.id), "add", userId);
  // The campaign exists either way; a first refresh that can't start is logged, and the cron or a manual refresh follows
  await startCampaignRefresh(c.env, campaignId, "registration", userId).catch((e) => {
    if (!(e instanceof RefreshError)) console.error("first refresh not started", { campaignId, error: errorMessage(e) });
  });
  return c.json({ campaignId, stubs: stubs.length }, 201);
});

campaignRoutes.get("/:id", async (c) => {
  const db = getDb(c.env);
  const id = c.req.param("id");
  const [campaign] = await db.select().from(campaigns).where(eq(campaigns.id, id));
  if (!campaign) return c.json({ error: "not_found" }, 404);
  const { deltas, sampleData } = await loadDeltas(db, id, Date.now());
  const refreshes = await db.select().from(campaignRefreshes).where(eq(campaignRefreshes.campaignId, id)).orderBy(desc(campaignRefreshes.startedAt)).limit(10);
  const digests = await db
    .select({ runId: campaignDigests.runId, createdAt: campaignDigests.createdAt, flags: campaignDigests.flags, deltas: campaignDigests.deltas, status: runs.status, reviewedAt: runs.reviewedAt })
    .from(campaignDigests)
    .innerJoin(runs, eq(campaignDigests.runId, runs.id))
    .where(eq(campaignDigests.campaignId, id))
    .orderBy(desc(campaignDigests.createdAt));
  const actions = await db.select().from(campaignActions).where(eq(campaignActions.campaignId, id)).orderBy(desc(campaignActions.createdAt));
  const matrix = campaign.matrixRunId
    ? (
        await db
          .select({ id: runs.id, status: runs.status, fields: briefs.fields })
          .from(runs)
          .leftJoin(briefs, eq(runs.briefId, briefs.id))
          .where(eq(runs.id, campaign.matrixRunId))
      )[0]
    : undefined;
  return c.json({
    ...campaign,
    scope: SCOPE,
    sampleData,
    deltas,
    matrixRun: matrix ? { id: matrix.id, status: matrix.status, brand: (matrix.fields as { brand?: string } | null)?.brand ?? null } : null,
    refreshes: refreshes.map((r) => ({ ...r, failed: plainFailures(r.failed) })),
    digests: digests.map(({ deltas: d, ...rest }) => ({ ...rest, verdict: (d as { verdict?: unknown }).verdict ?? null })),
    actions,
  });
});

campaignRoutes.post("/:id/refresh", requireRole("admin", "member"), paidAction, async (c) => {
  const db = getDb(c.env);
  const id = c.req.param("id");
  const [campaign] = await db.select().from(campaigns).where(eq(campaigns.id, id));
  if (!campaign) return c.json({ error: "not_found" }, 404);
  // A manual refresh costs actor runs, so it's spaced out
  if (campaign.lastRefreshAt && Date.now() - campaign.lastRefreshAt < MANUAL_COOLDOWN_MS) return c.json({ error: "refresh_cooldown" }, 429);
  try {
    return c.json(await startCampaignRefresh(c.env, id, "manual", c.get("userId")), 202);
  } catch (e) {
    if (e instanceof RefreshError) return c.json({ error: e.message }, 409);
    throw e;
  }
});

campaignRoutes.get("/:id/digests/:runId", async (c) => {
  const db = getDb(c.env);
  const [row] = await db
    .select({ digest: campaignDigests, run: runs })
    .from(campaignDigests)
    .innerJoin(runs, eq(campaignDigests.runId, runs.id))
    .where(and(eq(campaignDigests.runId, c.req.param("runId")), eq(campaignDigests.campaignId, c.req.param("id"))));
  if (!row) return c.json({ error: "not_found" }, 404);
  const actions = await db.select().from(campaignActions).where(eq(campaignActions.digestRunId, row.digest.runId)).orderBy(campaignActions.createdAt);
  const freshness = row.digest.freshness as { failed?: { platform: string; error: string; code?: string }[] };
  return c.json({ ...row.digest, freshness: { ...freshness, failed: plainFailures(freshness.failed ?? []) }, scope: SCOPE, status: row.run.status, reviewedAt: row.run.reviewedAt, reviewedBy: row.run.reviewedBy, llmFailure: (row.run.flags as { llmFailure?: string | null }).llmFailure ?? null, actions });
});

// FR-CORE-22: a digest is a draft until a planner approves or rejects it
const reviewSchema = z.object({ decision: z.enum(["approve", "reject"]) });

campaignRoutes.post("/:id/digests/:runId/review", requireRole("admin", "member"), async (c) => {
  const db = getDb(c.env);
  const runId = c.req.param("runId");
  const body = reviewSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!body.success) return c.json({ error: "invalid_decision" }, 400);
  const [run] = await db.select().from(runs).where(eq(runs.id, runId));
  if (!run || run.product !== "optimization") return c.json({ error: "not_found" }, 404);
  if (run.status !== "draft") return c.json({ error: "run_not_in_draft" }, 409);
  const now = Date.now();
  await db.batch([
    db.update(runs).set({ status: body.data.decision === "approve" ? "approved" : "rejected", reviewedBy: c.get("userId"), reviewedAt: now }).where(eq(runs.id, runId)),
    db.insert(runLogs).values({ id: newId(), runId, kind: "decision", payload: { decision: body.data.decision }, actor: c.get("userId"), createdAt: now }),
  ]);
  return c.json({ ok: true });
});

// FR-CO-6: a note or action against a recommendation, kept with the campaign record
const actionSchema = z.object({
  digestRunId: z.string().min(1).optional(),
  recommendation: z.number().int().min(0).max(20).optional(),
  note: z.string().trim().min(1).max(500),
});

campaignRoutes.post("/:id/actions", requireRole("admin", "member"), async (c) => {
  const db = getDb(c.env);
  const id = c.req.param("id");
  const body = actionSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!body.success) return c.json({ error: "invalid_action" }, 400);
  const [campaign] = await db.select({ id: campaigns.id }).from(campaigns).where(eq(campaigns.id, id));
  if (!campaign) return c.json({ error: "not_found" }, 404);
  await db.insert(campaignActions).values({
    id: newId(),
    campaignId: id,
    digestRunId: body.data.digestRunId ?? null,
    recommendation: body.data.recommendation ?? null,
    note: body.data.note,
    actor: c.get("userId"),
    createdAt: Date.now(),
  });
  return c.json({ ok: true }, 201);
});

// FR-CO-7: the planner sees exactly what will be written back before confirming it
campaignRoutes.get("/:id/close-preview", async (c) => {
  const db = getDb(c.env);
  const [campaign] = await db.select({ id: campaigns.id }).from(campaigns).where(eq(campaigns.id, c.req.param("id")));
  if (!campaign) return c.json({ error: "not_found" }, 404);
  return c.json({ ...(await closePreview(db, campaign.id)), outcomeVersion: OUTCOME_VERSION, historyVersion: HISTORY_VERSION });
});

campaignRoutes.post("/:id/close", requireRole("admin", "member"), async (c) => {
  const body = z.object({ hash: z.string().min(1) }).safeParse(await c.req.json().catch(() => ({})));
  if (!body.success) return c.json({ error: "invalid_request" }, 400);
  const result = await closeCampaign(c.env, c.req.param("id"), c.get("userId"), body.data.hash);
  if ("error" in result) return c.json(result, result.error === "not_found" ? 404 : 409);
  return c.json(result);
});

// Written-back campaigns are never deleted, only archived (FR-CO-7)
campaignRoutes.post("/:id/archive", requireRole("admin", "member"), async (c) => {
  const db = getDb(c.env);
  const id = c.req.param("id");
  const [campaign] = await db.select().from(campaigns).where(eq(campaigns.id, id));
  if (!campaign) return c.json({ error: "not_found" }, 404);
  if (campaign.status !== "closed") return c.json({ error: "close_before_archiving" }, 409);
  await db.update(campaigns).set({ status: "archived", updatedAt: Date.now() }).where(eq(campaigns.id, id));
  return c.json({ ok: true });
});
