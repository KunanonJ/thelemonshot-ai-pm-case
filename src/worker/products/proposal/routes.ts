import { and, desc, eq, inArray } from "drizzle-orm";
import { Hono, type Context } from "hono";
import { z } from "zod";
import { requireRole, type AppEnv } from "../../core/auth";
import { getDb } from "../../core/db/client";
import { briefs, proposalSections, proposalVersions, runLogs, runs } from "../../core/db/schema";
import { errorMessage } from "../../core/env";
import { newId } from "../../core/util";
import { proposalBriefSchema } from "./brief";
import { PROMPT_VERSION } from "./contract";
import { loadProposalDoc, type ProposalDoc } from "./document";
import { ATTACHABLE_STATUSES } from "./evidence";
import { lintContent } from "./guard";
import { cite, createProposalRun, MAX_ALTERNATIVES, ProposalInputError, proposalFlags, saveVersions, sectionMessage } from "./pipeline";
import { renderProposalHtml } from "./render-html";
import { buildProposalPptx } from "./render-pptx";
import { budgetLine, CONTENT_SCHEMAS, FIELD_SPECS, SECTION_KEYS, TEMPLATES, timelineLine, type SectionKey } from "./templates";

export const proposalRoutes = new Hono<AppEnv>();

const issues = (e: z.ZodError) => e.issues.map((i) => ({ path: i.path.join("."), message: i.message }));
const asSectionKey = (k: string): SectionKey | null => ((SECTION_KEYS as readonly string[]).includes(k) ? (k as SectionKey) : null);

// FR-CP-1: templates and the structured editor's field definitions
proposalRoutes.get("/templates", (c) =>
  c.json({
    templates: Object.values(TEMPLATES).map((t) => ({ id: t.id, name: t.name, description: t.description, requiredFields: t.requiredFields, sections: t.sections.map(({ key, title }) => ({ key, title })) })),
    fields: FIELD_SPECS,
    maxAlternatives: MAX_ALTERNATIVES,
    promptVersion: PROMPT_VERSION,
  }),
);

// Matrix shortlists a proposal can cite (FR-CP-2)
proposalRoutes.get("/shortlists", async (c) => {
  const db = getDb(c.env);
  const rows = await db
    .select({ run: runs, fields: briefs.fields })
    .from(runs)
    .leftJoin(briefs, eq(runs.briefId, briefs.id))
    .where(and(eq(runs.product, "matrix"), inArray(runs.status, [...ATTACHABLE_STATUSES])))
    .orderBy(desc(runs.createdAt))
    .limit(50);
  return c.json(
    rows.map(({ run, fields }) => ({
      id: run.id,
      status: run.status,
      createdAt: run.createdAt,
      reviewedAt: run.reviewedAt,
      brief: fields,
      shortlisted: (run.flags as { shortlisted?: number }).shortlisted ?? null,
      sampleData: (run.flags as { sampleData?: boolean }).sampleData ?? false,
    })),
  );
});

proposalRoutes.post("/runs", requireRole("admin", "member"), async (c) => {
  const parsed = proposalBriefSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) return c.json({ error: "invalid_brief", issues: issues(parsed.error) }, 400);
  try {
    return c.json(await createProposalRun(c.env, parsed.data, c.get("userId")), 201);
  } catch (e) {
    if (e instanceof ProposalInputError) return c.json({ error: e.message }, 409);
    throw e;
  }
});

proposalRoutes.get("/runs", async (c) => {
  const db = getDb(c.env);
  const rows = await db
    .select({ run: runs, fields: briefs.fields })
    .from(runs)
    .leftJoin(briefs, eq(runs.briefId, briefs.id))
    .where(eq(runs.product, "proposal"))
    .orderBy(desc(runs.createdAt))
    .limit(50);
  const ids = rows.map((r) => r.run.id);
  const sections = ids.length ? await db.select({ runId: proposalSections.runId, status: proposalSections.status }).from(proposalSections).where(inArray(proposalSections.runId, ids)) : [];
  return c.json(
    rows.map(({ run, fields }) => {
      const mine = sections.filter((s) => s.runId === run.id);
      return {
        ...run,
        brief: fields,
        progress: { total: mine.length, ready: mine.filter((s) => s.status === "ready").length, failed: mine.filter((s) => s.status === "failed").length },
      };
    }),
  );
});

proposalRoutes.get("/runs/:id", async (c) => {
  const db = getDb(c.env);
  const doc = await loadProposalDoc(db, c.req.param("id"));
  if (!doc) return c.json({ error: "not_found" }, 404);
  const logs = await db
    .select()
    .from(runLogs)
    .where(and(eq(runLogs.runId, doc.run.id), inArray(runLogs.kind, ["section", "attach", "decision", "export"])))
    .orderBy(runLogs.createdAt);
  return c.json({ ...view(doc), logs });
});

function view(doc: ProposalDoc) {
  return {
    ...doc.run,
    brief: doc.brief,
    template: { id: doc.template.id, name: doc.template.name, description: doc.template.description },
    sections: doc.sections.map((s) => ({
      key: s.key,
      title: s.title,
      status: s.status,
      error: s.error,
      versionCount: s.versionCount,
      current: s.current && {
        id: s.current.id,
        version: s.current.version,
        origin: s.current.origin,
        content: s.current.content,
        flags: s.current.flags,
        note: s.current.note,
        createdAt: s.current.createdAt,
        createdBy: s.current.createdBy,
      },
    })),
    shortlist: doc.shortlist && {
      id: doc.shortlist.run.id,
      status: doc.shortlist.run.status,
      reviewedAt: doc.shortlist.run.reviewedAt,
      brief: doc.shortlist.brief,
      picks: doc.shortlist.picks.map((p) => p.creatorId),
    },
    evidence: doc.evidence,
    assumptions: doc.assumptions,
    sampleData: doc.sampleData,
  };
}

// AC-CP-3: every version of a section, newest first
proposalRoutes.get("/runs/:id/sections/:key/versions", async (c) => {
  const key = asSectionKey(c.req.param("key"));
  if (!key) return c.json({ error: "not_found" }, 404);
  const db = getDb(c.env);
  const id = c.req.param("id");
  const [section] = await db.select().from(proposalSections).where(and(eq(proposalSections.runId, id), eq(proposalSections.sectionKey, key)));
  if (!section) return c.json({ error: "not_found" }, 404);
  const versions = await db
    .select()
    .from(proposalVersions)
    .where(and(eq(proposalVersions.runId, id), eq(proposalVersions.sectionKey, key)))
    .orderBy(desc(proposalVersions.version));
  return c.json(versions.map((v) => ({ ...v, isCurrent: v.id === section.currentVersionId })));
});

// Loads the run for a section change and refuses anything but an idle section on a draft
async function editable(c: Context<AppEnv>, key: SectionKey | null) {
  if (!key) return { error: c.json({ error: "not_found" }, 404) };
  const db = getDb(c.env);
  const doc = await loadProposalDoc(db, c.req.param("id")!);
  if (!doc) return { error: c.json({ error: "not_found" }, 404) };
  if (doc.run.status !== "draft") return { error: c.json({ error: "run_not_in_draft" }, 409) };
  const section = doc.sections.find((s) => s.key === key)!;
  if (section.status === "generating" || section.status === "pending") return { error: c.json({ error: "section_busy" }, 409) };
  return { db, doc, section, key };
}

async function logSection(c: Context<AppEnv>, runId: string, payload: Record<string, unknown>) {
  await getDb(c.env).insert(runLogs).values({ id: newId(), runId, kind: "section", payload, actor: c.get("userId"), createdAt: Date.now() });
}

// FR-CP-4: a planner's edit is a new version; nothing is overwritten
const editSchema = z.object({ content: z.record(z.string(), z.unknown()) });

proposalRoutes.post("/runs/:id/sections/:key/edit", requireRole("admin", "member"), async (c) => {
  const ctx = await editable(c, asSectionKey(c.req.param("key")));
  if ("error" in ctx) return ctx.error;
  const { db, doc, key } = ctx;
  const body = editSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!body.success) return c.json({ error: "invalid_content" }, 400);
  const parsed = CONTENT_SCHEMAS[key].safeParse(body.data.content);
  if (!parsed.success) return c.json({ error: "invalid_content", issues: issues(parsed.error) }, 400);

  let content = parsed.data as Record<string, unknown>;
  let citations: ReturnType<typeof cite> = [];
  // Budget and timeline always come from the brief (FR-CP-3)
  if (key === "phased_plan") content = { ...content, budget: budgetLine(doc.brief), timeline: timelineLine(doc.brief) };
  if (key === "creator_strategy") {
    if (!doc.shortlist) return c.json({ error: "no_shortlist" }, 409);
    const listed = (content.creators as { creatorId: string }[]).map((cr) => cr.creatorId);
    if (listed.some((creatorId) => !doc.evidence[creatorId])) return c.json({ error: "creator_not_in_shortlist" }, 400);
    citations = cite(content, doc.shortlist);
  }
  try {
    const [versionId] = await saveVersions(db, doc.run.id, key, [{ origin: "edited", content, citations, flags: lintContent(content, doc.brief.mustAvoid), note: null }], {
      status: "ready",
      actor: c.get("userId"),
      promptVersion: null,
    });
    await logSection(c, doc.run.id, { section: key, action: "edit", versionId });
  } catch (e) {
    if (/UNIQUE/i.test(errorMessage(e))) return c.json({ error: "version_conflict" }, 409);
    throw e;
  }
  return c.json({ ok: true });
});

// FR-CP-4: regenerate one section, optionally as several alternatives, without touching the others
const regenerateSchema = z.object({
  alternatives: z.number().int().min(1).max(MAX_ALTERNATIVES).default(1),
  instruction: z.string().trim().max(300).optional(),
});

proposalRoutes.post("/runs/:id/sections/:key/regenerate", requireRole("admin", "member"), async (c) => {
  const ctx = await editable(c, asSectionKey(c.req.param("key")));
  if ("error" in ctx) return ctx.error;
  const { db, doc, key } = ctx;
  const body = regenerateSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!body.success) return c.json({ error: "invalid_request" }, 400);
  if (key === "creator_strategy" && !doc.flags.shortlist) return c.json({ error: "no_shortlist" }, 409);
  await db
    .update(proposalSections)
    .set({ status: "generating", error: null, updatedAt: Date.now() })
    .where(and(eq(proposalSections.runId, doc.run.id), eq(proposalSections.sectionKey, key)));
  await logSection(c, doc.run.id, { section: key, action: "regenerate", alternatives: body.data.alternatives, instruction: body.data.instruction ?? null });
  await c.env.ENRICH_QUEUE.send(
    sectionMessage(doc.run.id, key, "regenerate", c.get("userId"), { alternatives: body.data.alternatives, ...(body.data.instruction ? { instruction: body.data.instruction } : {}) }),
  );
  return c.json({ ok: true }, 202);
});

// Switch the current version to any earlier one; the history stays as it is
const useSchema = z.object({ versionId: z.string().min(1) });

proposalRoutes.post("/runs/:id/sections/:key/use", requireRole("admin", "member"), async (c) => {
  const ctx = await editable(c, asSectionKey(c.req.param("key")));
  if ("error" in ctx) return ctx.error;
  const { db, doc, key } = ctx;
  const body = useSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!body.success) return c.json({ error: "invalid_request" }, 400);
  const [v] = await db
    .select()
    .from(proposalVersions)
    .where(and(eq(proposalVersions.id, body.data.versionId), eq(proposalVersions.runId, doc.run.id), eq(proposalVersions.sectionKey, key)));
  if (!v) return c.json({ error: "not_found" }, 404);
  const template = v.origin === "template";
  await db
    .update(proposalSections)
    .set({
      currentVersionId: v.id,
      status: template ? "failed" : "ready",
      error: template ? "The template draft needs an edit or a retry before approval" : null,
      updatedAt: Date.now(),
    })
    .where(and(eq(proposalSections.runId, doc.run.id), eq(proposalSections.sectionKey, key)));
  await logSection(c, doc.run.id, { section: key, action: "use_version", versionId: v.id, version: v.version });
  return c.json({ ok: true });
});

// BR-CP-1: a proposal drafted without a shortlist can get one later; only the creator section is redrafted
const attachSchema = z.object({ matrixRunId: z.string().min(1) });

proposalRoutes.post("/runs/:id/attach", requireRole("admin", "member"), async (c) => {
  const ctx = await editable(c, "creator_strategy");
  if ("error" in ctx) return ctx.error;
  const { db, doc } = ctx;
  const body = attachSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!body.success) return c.json({ error: "invalid_request" }, 400);
  if (doc.flags.shortlist) return c.json({ error: "shortlist_already_attached" }, 409);
  const [m] = await db.select().from(runs).where(eq(runs.id, body.data.matrixRunId));
  if (!m || m.product !== "matrix" || !(ATTACHABLE_STATUSES as readonly string[]).includes(m.status)) return c.json({ error: "shortlist_not_attachable" }, 409);

  const now = Date.now();
  await db.batch([
    db
      .update(runs)
      .set({ flags: { ...proposalFlags(doc.run), shortlist: { matrixRunId: m.id, mode: "attached" } } })
      .where(eq(runs.id, doc.run.id)),
    db
      .update(proposalSections)
      .set({ status: "generating", error: null, updatedAt: now })
      .where(and(eq(proposalSections.runId, doc.run.id), eq(proposalSections.sectionKey, "creator_strategy"))),
    db.insert(runLogs).values({ id: newId(), runId: doc.run.id, kind: "attach", payload: { matrixRunId: m.id, status: m.status }, actor: c.get("userId"), createdAt: now }),
  ]);
  await c.env.ENRICH_QUEUE.send(sectionMessage(doc.run.id, "creator_strategy", "regenerate", c.get("userId")));
  return c.json({ ok: true }, 202);
});

// FR-CORE-22: approval needs every section settled and, when creators are cited, an approved shortlist
const reviewSchema = z.object({ decision: z.enum(["approve", "reject"]) });

proposalRoutes.post("/runs/:id/review", requireRole("admin", "member"), async (c) => {
  const db = getDb(c.env);
  const doc = await loadProposalDoc(db, c.req.param("id"));
  if (!doc) return c.json({ error: "not_found" }, 404);
  const body = reviewSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!body.success) return c.json({ error: "invalid_decision" }, 400);
  if (doc.run.status !== "draft") return c.json({ error: "run_not_in_draft" }, 409);
  if (body.data.decision === "approve") {
    const unsettled = doc.sections.filter((s) => s.status !== "ready").map((s) => s.key);
    if (unsettled.length) return c.json({ error: "sections_not_ready", sections: unsettled }, 409);
    if (doc.flags.shortlist && doc.shortlist?.run.status !== "approved") return c.json({ error: "shortlist_not_approved" }, 409);
  }
  const now = Date.now();
  await db.batch([
    db
      .update(runs)
      .set({ status: body.data.decision === "approve" ? "approved" : "rejected", reviewedBy: c.get("userId"), reviewedAt: now })
      .where(eq(runs.id, doc.run.id)),
    db.insert(runLogs).values({
      id: newId(),
      runId: doc.run.id,
      kind: "decision",
      // The exact version of each section that was approved
      payload: { decision: body.data.decision, versions: Object.fromEntries(doc.sections.map((s) => [s.key, s.current ? { id: s.current.id, version: s.current.version } : null])) },
      actor: c.get("userId"),
      createdAt: now,
    }),
  ]);
  return c.json({ ok: true });
});

// A draft can be previewed at any time; it says it is a draft
proposalRoutes.get("/runs/:id/preview.html", async (c) => {
  const doc = await loadProposalDoc(getDb(c.env), c.req.param("id"));
  if (!doc) return c.json({ error: "not_found" }, 404);
  return c.html(renderProposalHtml(doc, { draft: doc.run.status !== "approved" }));
});

// FR-CP-6: exports need approval, are stored in R2 under the run ID and are built once (approved content is frozen)
const EXPORTS = {
  html: { contentType: "text/html; charset=utf-8" },
  pptx: { contentType: "application/vnd.openxmlformats-officedocument.presentationml.presentation" },
} as const;

async function exportFile(c: Context<AppEnv>, format: keyof typeof EXPORTS) {
  const db = getDb(c.env);
  const id = c.req.param("id")!;
  const [run] = await db.select().from(runs).where(eq(runs.id, id));
  if (!run || run.product !== "proposal") return c.json({ error: "not_found" }, 404);
  if (run.status !== "approved") return c.json({ error: "export_requires_approval" }, 409);
  const r2Key = `exports/proposal/${id}/proposal.${format}`;
  let data: ArrayBuffer | Uint8Array;
  const stored = await c.env.FILES.get(r2Key);
  if (stored) {
    data = await stored.arrayBuffer();
  } else {
    const doc = (await loadProposalDoc(db, id))!;
    data = format === "html" ? new TextEncoder().encode(renderProposalHtml(doc, { draft: false })) : await buildProposalPptx(doc);
    await c.env.FILES.put(r2Key, data, { httpMetadata: { contentType: EXPORTS[format].contentType } });
  }
  await db.insert(runLogs).values({ id: newId(), runId: id, kind: "export", payload: { format, r2Key, bytes: data.byteLength }, actor: c.get("userId"), createdAt: Date.now() });
  return new Response(data, {
    headers: { "Content-Type": EXPORTS[format].contentType, "Content-Disposition": `attachment; filename="proposal-${id.slice(0, 8)}.${format}"` },
  });
}

proposalRoutes.get("/runs/:id/export.html", (c) => exportFile(c, "html"));
proposalRoutes.get("/runs/:id/export.pptx", (c) => exportFile(c, "pptx"));
