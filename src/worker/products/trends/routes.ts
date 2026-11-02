import { and, desc, eq, inArray } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import { requireRole, type AppEnv } from "../../core/auth";
import { getDb } from "../../core/db/client";
import { apifyRuns, runLogs, runs } from "../../core/db/schema";
import { errorMessage } from "../../core/env";
import { newId } from "../../core/util";
import { failedTermText } from "./failures";
import { startTrendPull, sweepStuckTrends, TrendInputError } from "./pipeline";
import { trendAttachments, trendBriefs, trendPullTerms, trendPulls, trendWatchlist, TREND_PLATFORMS } from "./schema";
import { MAX_POST_CAP, MAX_TERMS_PER_PULL, termInputSchema, termKey } from "./terms";

// ② Trend Monitoring API. Watchlists (FR-TM-1), pulls, briefs (FR-TM-2 to FR-TM-4) and the review gate (FR-CORE-22).
export const trendRoutes = new Hono<AppEnv>();

// Returned with every payload, so no screen can present pulled numbers as platform-wide
export const TREND_SCOPE =
  "Within-sample signals: every figure describes the public posts pulled in a run, not the platform as a whole. A brief is a draft until a planner approves it.";

const issues = (e: z.ZodError) => e.issues.map((i) => ({ path: i.path.join("."), message: i.message }));
const sumUsd = (rows: { usageUsd: number | null }[]) => {
  const values = rows.flatMap((r) => (r.usageUsd === null ? [] : [r.usageUsd]));
  return values.length ? Math.round(values.reduce((a, b) => a + b, 0) * 10_000) / 10_000 : null;
};

trendRoutes.get("/watchlist", async (c) => {
  const rows = await getDb(c.env).select().from(trendWatchlist).orderBy(desc(trendWatchlist.createdAt));
  return c.json({ scope: TREND_SCOPE, terms: rows });
});

trendRoutes.post("/watchlist", requireRole("admin", "member"), async (c) => {
  const parsed = termInputSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) return c.json({ error: "invalid_term", issues: issues(parsed.error) }, 400);
  const input = parsed.data;
  const now = Date.now();
  const id = newId();
  try {
    await getDb(c.env)
      .insert(trendWatchlist)
      .values({
        id,
        term: input.term.trim().replace(/^#+/, ""),
        termKey: termKey(input.term),
        kind: input.kind,
        platforms: [...new Set(input.platforms)],
        category: input.category,
        postCap: input.postCap,
        active: true,
        createdBy: c.get("userId"),
        createdAt: now,
        updatedAt: now,
      });
  } catch (e) {
    if (/UNIQUE/i.test(errorMessage(e))) return c.json({ error: "term_exists" }, 409);
    throw e;
  }
  return c.json({ id }, 201);
});

const patchSchema = z.object({
  active: z.boolean().optional(),
  category: z.string().trim().min(1).max(60).optional(),
  postCap: z.number().int().min(1).max(MAX_POST_CAP).optional(),
  platforms: z.array(z.enum(TREND_PLATFORMS)).min(1).max(2).optional(),
});

trendRoutes.patch("/watchlist/:id", requireRole("admin", "member"), async (c) => {
  const body = patchSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!body.success) return c.json({ error: "invalid_term", issues: issues(body.error) }, 400);
  const db = getDb(c.env);
  const id = c.req.param("id");
  const [row] = await db.select({ id: trendWatchlist.id }).from(trendWatchlist).where(eq(trendWatchlist.id, id));
  if (!row) return c.json({ error: "not_found" }, 404);
  await db
    .update(trendWatchlist)
    .set({ ...body.data, platforms: body.data.platforms ? [...new Set(body.data.platforms)] : undefined, updatedAt: Date.now() })
    .where(eq(trendWatchlist.id, id));
  return c.json({ ok: true });
});

// Deactivates rather than deletes, so the pull history of a term stays readable
trendRoutes.delete("/watchlist/:id", requireRole("admin", "member"), async (c) => {
  const db = getDb(c.env);
  const id = c.req.param("id");
  const [row] = await db.select({ id: trendWatchlist.id }).from(trendWatchlist).where(eq(trendWatchlist.id, id));
  if (!row) return c.json({ error: "not_found" }, 404);
  await db.update(trendWatchlist).set({ active: false, updatedAt: Date.now() }).where(eq(trendWatchlist.id, id));
  return c.json({ ok: true });
});

const pullSchema = z.object({ termIds: z.array(z.string().min(1)).max(MAX_TERMS_PER_PULL).optional() });

// FR-TM-1: a pull over the active terms, or over the chosen ones. Returns at once; the brief lands in the run list.
trendRoutes.post("/pulls", requireRole("admin", "member"), async (c) => {
  const body = pullSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!body.success) return c.json({ error: "invalid_request" }, 400);
  try {
    const started = await startTrendPull(c.env, c.get("userId"), body.data.termIds ?? null);
    return c.json(started, started.deduped ? 200 : 202);
  } catch (e) {
    if (e instanceof TrendInputError) return c.json({ error: e.message }, e.message === "too_many_terms" ? 400 : 409);
    throw e;
  }
});

// Pull history: every trend run with its terms, unique posts, themes and what the pulls cost
trendRoutes.get("/runs", async (c) => {
  const db = getDb(c.env);
  const rows = await db
    .select({ run: runs, pull: trendPulls, brief: trendBriefs })
    .from(runs)
    .innerJoin(trendPulls, eq(trendPulls.runId, runs.id))
    .leftJoin(trendBriefs, eq(trendBriefs.runId, runs.id))
    .where(eq(runs.product, "trends"))
    .orderBy(desc(runs.createdAt))
    .limit(50);
  const pullIds = rows.map((r) => r.pull.id);
  const terms = pullIds.length ? await db.select().from(trendPullTerms).where(inArray(trendPullTerms.pullId, pullIds)) : [];
  return c.json({
    scope: TREND_SCOPE,
    runs: rows.map(({ run, pull, brief }) => {
      const mine = terms.filter((t) => t.pullId === pull.id);
      return {
        runId: run.id,
        status: run.status,
        pullStatus: pull.status,
        error: run.error,
        createdAt: run.createdAt,
        finishedAt: run.finishedAt,
        reviewedAt: run.reviewedAt,
        labels: [...new Set(mine.map((t) => t.label))],
        termRuns: mine.length,
        failedRuns: mine.filter((t) => t.status === "failed").length,
        uniquePosts: brief?.sample.uniquePosts ?? null,
        themes: brief ? brief.themes.length : null,
        weakThemes: brief ? brief.themes.filter((t) => t.weakSignal).length : null,
        usageUsd: sumUsd(mine),
      };
    }),
  });
});

// One brief with its per-term runs, cost, sources, log and the proposals it is attached to
trendRoutes.get("/runs/:id", async (c) => {
  const db = getDb(c.env);
  const id = c.req.param("id");
  const [row] = await db
    .select({ run: runs, pull: trendPulls, brief: trendBriefs })
    .from(runs)
    .innerJoin(trendPulls, eq(trendPulls.runId, runs.id))
    .leftJoin(trendBriefs, eq(trendBriefs.runId, runs.id))
    .where(and(eq(runs.id, id), eq(runs.product, "trends")));
  if (!row) return c.json({ error: "not_found" }, 404);
  const terms = await db
    .select({ term: trendPullTerms, apify: apifyRuns })
    .from(trendPullTerms)
    .leftJoin(apifyRuns, eq(trendPullTerms.localRunId, apifyRuns.id))
    .where(eq(trendPullTerms.pullId, row.pull.id))
    .orderBy(trendPullTerms.createdAt);
  const logs = await db
    .select()
    .from(runLogs)
    .where(eq(runLogs.runId, id))
    .orderBy(runLogs.createdAt);
  const attached = await db.select({ proposalRunId: trendAttachments.proposalRunId }).from(trendAttachments).where(eq(trendAttachments.trendRunId, id));
  return c.json({
    scope: TREND_SCOPE,
    runId: row.run.id,
    status: row.run.status,
    pullStatus: row.pull.status,
    // The run's plain reason when it ended without a brief; raw text never reaches this response
    error: row.run.error,
    createdAt: row.run.createdAt,
    finishedAt: row.run.finishedAt,
    reviewedAt: row.run.reviewedAt,
    reviewedBy: row.run.reviewedBy,
    createdBy: row.run.createdBy,
    flags: row.run.flags,
    terms: terms.map(({ term, apify }) => ({
      id: term.id,
      label: term.label,
      category: term.category,
      kind: term.kind,
      platform: term.platform,
      status: term.status,
      postCap: term.postCap,
      postCount: term.postCount,
      itemCount: term.itemCount,
      usageUsd: term.usageUsd,
      note: term.note,
      error: term.status === "failed" ? failedTermText(term.error) : null,
      apifyStatus: apify?.status ?? null,
      apifyRunId: term.apifyRunId,
      finishedAt: term.finishedAt,
    })),
    usageUsd: sumUsd(terms.map((t) => t.term)),
    brief: row.brief && {
      runId: row.brief.runId,
      promptVersion: row.brief.promptVersion,
      createdAt: row.brief.createdAt,
      sample: row.brief.sample,
      themes: row.brief.themes,
      exemplars: row.brief.exemplars,
      sources: row.brief.sources,
      flags: row.brief.flags,
    },
    logs,
    attachedProposals: attached.map((a) => a.proposalRunId),
  });
});

// FR-CORE-22: a brief is a draft until a planner approves or rejects it
const reviewSchema = z.object({ decision: z.enum(["approve", "reject"]) });

trendRoutes.post("/runs/:id/review", requireRole("admin", "member"), async (c) => {
  const db = getDb(c.env);
  const runId = c.req.param("id");
  const body = reviewSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!body.success) return c.json({ error: "invalid_decision" }, 400);
  const [run] = await db.select().from(runs).where(eq(runs.id, runId));
  if (!run || run.product !== "trends") return c.json({ error: "not_found" }, 404);
  if (run.status !== "draft") return c.json({ error: "run_not_in_draft" }, 409);
  const now = Date.now();
  await db.batch([
    db
      .update(runs)
      .set({ status: body.data.decision === "approve" ? "approved" : "rejected", reviewedBy: c.get("userId"), reviewedAt: now })
      .where(eq(runs.id, runId)),
    db.insert(runLogs).values({ id: newId(), runId, kind: "decision", payload: { decision: body.data.decision }, actor: c.get("userId"), createdAt: now }),
  ]);
  return c.json({ ok: true });
});

// The same backstop the cron runs every 10 minutes, on demand. Returns how many stuck items it moved.
trendRoutes.post("/admin/sweep", requireRole("admin"), async (c) => c.json({ moved: await sweepStuckTrends(c.env, Date.now()) }));