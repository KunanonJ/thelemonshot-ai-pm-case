import { and, desc, eq, inArray } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import { requireRole, type AppEnv } from "../../core/auth";
import { getDb } from "../../core/db/client";
import { briefs, creators, runItems, runLogs, runs } from "../../core/db/schema";
import { newId } from "../../core/util";
import { findConflicts, matrixBriefSchema } from "./brief";
import { toCsv } from "./export";
import { createMatrixRun, RUN_FAILURE_TEXT } from "./pipeline";
import { COMPONENT_INFO, RULES, SCORING_VERSION, WEIGHT_PROFILES } from "./weights";

export const matrixRoutes = new Hono<AppEnv>();

// BR-CORE-3: a failed run shows its fixed sentence; runs failed before the sentences existed show the general one
function withPublicError<T extends { status: string; error: string | null; flags: Record<string, unknown> }>(run: T): T {
  if (run.status !== "failed") return run;
  const code = run.flags.failure as keyof typeof RUN_FAILURE_TEXT | undefined;
  return { ...run, error: (code && RUN_FAILURE_TEXT[code]) ?? RUN_FAILURE_TEXT.unexpected };
}

// "How scoring works" (FR-MX-2): no black box
matrixRoutes.get("/scoring", (c) => c.json({ version: SCORING_VERSION, weights: WEIGHT_PROFILES, components: COMPONENT_INFO, rules: RULES }));

matrixRoutes.get("/categories", async (c) => {
  const { results } = await c.env.DB.prepare(
    `SELECT json_each.value AS category, COUNT(*) AS creators FROM creators, json_each(creators.categories)
     WHERE creators.active = 1 GROUP BY json_each.value ORDER BY creators DESC`,
  ).all<{ category: string; creators: number }>();
  return c.json(results);
});

// AC-MX-2: conflicts are shown before a run starts
matrixRoutes.post("/validate", async (c) => {
  const parsed = matrixBriefSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) return c.json({ ok: false, errors: parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })) }, 400);
  return c.json({ ok: true, conflicts: findConflicts(parsed.data) });
});

matrixRoutes.post("/runs", requireRole("admin", "member"), async (c) => {
  const parsed = matrixBriefSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) return c.json({ error: "invalid_brief", issues: parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })) }, 400);
  return c.json(await createMatrixRun(c.env, parsed.data, c.get("userId")), 201);
});

matrixRoutes.get("/runs", async (c) => {
  const db = getDb(c.env);
  const rows = await db
    .select({ run: runs, fields: briefs.fields })
    .from(runs)
    .leftJoin(briefs, eq(runs.briefId, briefs.id))
    .where(eq(runs.product, "matrix"))
    .orderBy(desc(runs.createdAt))
    .limit(50);
  return c.json(rows.map((r) => ({ ...withPublicError(r.run), brief: r.fields })));
});

matrixRoutes.get("/runs/:id", async (c) => {
  const db = getDb(c.env);
  const id = c.req.param("id");
  const [row] = await db.select({ run: runs, fields: briefs.fields }).from(runs).leftJoin(briefs, eq(runs.briefId, briefs.id)).where(eq(runs.id, id));
  if (!row) return c.json({ error: "not_found" }, 404);
  const items = await db
    .select({
      item: runItems,
      creator: {
        displayName: creators.displayName,
        instagram: creators.instagram,
        tiktok: creators.tiktok,
        youtube: creators.youtube,
        isSample: creators.isSample,
        categories: creators.categories,
      },
    })
    .from(runItems)
    .innerJoin(creators, eq(runItems.creatorId, creators.id))
    .where(eq(runItems.runId, id));
  const logs = await db
    .select()
    .from(runLogs)
    .where(and(eq(runLogs.runId, id), inArray(runLogs.kind, ["override", "decision", "export"])))
    .orderBy(runLogs.createdAt);
  return c.json({ ...withPublicError(row.run), brief: row.fields, items: items.map((i) => ({ ...i.item, creator: i.creator })), logs });
});

// BR-MX-4 / FR-CORE-23: swap a shortlisted creator for an unranked one. Scores never change; only the
// final pick list moves, and the original recommendation stays on record.
const overrideSchema = z.object({ replaceCreatorId: z.string().min(1), withCreatorId: z.string().min(1) });

matrixRoutes.post("/runs/:id/override", requireRole("admin", "member"), async (c) => {
  const db = getDb(c.env);
  const id = c.req.param("id");
  const body = overrideSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!body.success) return c.json({ error: "invalid_override" }, 400);
  const [run] = await db.select().from(runs).where(eq(runs.id, id));
  if (!run) return c.json({ error: "not_found" }, 404);
  if (run.status !== "draft") return c.json({ error: "run_not_in_draft" }, 409);

  const rows = await db
    .select()
    .from(runItems)
    .where(and(eq(runItems.runId, id), inArray(runItems.creatorId, [body.data.replaceCreatorId, body.data.withCreatorId])));
  const out = rows.find((r) => r.creatorId === body.data.replaceCreatorId);
  const into = rows.find((r) => r.creatorId === body.data.withCreatorId);
  if (!out?.finalPick) return c.json({ error: "not_a_current_pick" }, 409);
  if (!into || into.finalPick || into.excludedReason) return c.json({ error: "replacement_not_available" }, 409);

  await db.batch([
    db.update(runItems).set({ finalPick: false }).where(eq(runItems.id, out.id)),
    db.update(runItems).set({ finalPick: true, replacesCreatorId: out.creatorId }).where(eq(runItems.id, into.id)),
    db.insert(runLogs).values({
      id: newId(),
      runId: id,
      kind: "override",
      payload: {
        replaced: { creatorId: out.creatorId, rank: out.rank, composite: out.composite, recommended: out.recommended },
        with: { creatorId: into.creatorId, composite: into.composite },
      },
      actor: c.get("userId"),
      createdAt: Date.now(),
    }),
  ]);
  return c.json({ ok: true });
});

// FR-CORE-22: a human moves the draft to approved or rejected
const reviewSchema = z.object({ decision: z.enum(["approve", "reject"]) });

matrixRoutes.post("/runs/:id/review", requireRole("admin", "member"), async (c) => {
  const db = getDb(c.env);
  const id = c.req.param("id");
  const body = reviewSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!body.success) return c.json({ error: "invalid_decision" }, 400);
  const [run] = await db.select().from(runs).where(eq(runs.id, id));
  if (!run) return c.json({ error: "not_found" }, 404);
  if (run.status !== "draft") return c.json({ error: "run_not_in_draft" }, 409);

  const items = await db.select().from(runItems).where(eq(runItems.runId, id));
  const now = Date.now();
  await db.batch([
    db
      .update(runs)
      .set({ status: body.data.decision === "approve" ? "approved" : "rejected", reviewedBy: c.get("userId"), reviewedAt: now })
      .where(eq(runs.id, id)),
    db.insert(runLogs).values({
      id: newId(),
      runId: id,
      kind: "decision",
      payload: {
        decision: body.data.decision,
        recommended: items.filter((i) => i.recommended).map((i) => i.creatorId),
        finalPicks: items.filter((i) => i.finalPick).map((i) => i.creatorId),
      },
      actor: c.get("userId"),
      createdAt: now,
    }),
  ]);
  return c.json({ ok: true });
});

// FR-MX-9: export only after approval, carrying the run ID and the sample-data label
matrixRoutes.get("/runs/:id/export.csv", async (c) => {
  const db = getDb(c.env);
  const id = c.req.param("id");
  const [run] = await db.select().from(runs).where(eq(runs.id, id));
  if (!run) return c.json({ error: "not_found" }, 404);
  if (run.status !== "approved") return c.json({ error: "export_requires_approval" }, 409);
  const items = await db
    .select({ item: runItems, creator: creators })
    .from(runItems)
    .innerJoin(creators, eq(runItems.creatorId, creators.id))
    .where(and(eq(runItems.runId, id), eq(runItems.finalPick, true)));
  await db.insert(runLogs).values({ id: newId(), runId: id, kind: "export", payload: { format: "csv", rows: items.length }, actor: c.get("userId"), createdAt: Date.now() });
  return new Response(toCsv(run, items), {
    headers: { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": `attachment; filename="matrix-${id.slice(0, 8)}.csv"` },
  });
});
