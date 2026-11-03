import { and, count, eq, inArray } from "drizzle-orm";
import { Hono, type Context } from "hono";
import { z } from "zod";
import { requireRole, type AppEnv } from "../../core/auth";
import { paidAction } from "../../core/limits";
import { getDb } from "../../core/db/client";
import { runs } from "../../core/db/schema";
import { newId } from "../../core/util";
import { allowlistView } from "./allowlist";
import { inputKey, MAX_ASSET_BYTES, safeFileName, sha256Hex, sniffAsset, TOKEN_RE } from "./assets";
import { dcoBriefSchema } from "./brief";
import { buildDcoPack } from "./pack";
import { createDcoRun, requeueSegment, requeueVisual, sweepStuckDco, type RequeueResult } from "./pipeline";
import { dcoAssets, dcoCopy, dcoEvents, dcoSegments, dcoVisuals } from "./schema";
import { listDcoRuns, loadDcoDetail, loadDcoRows } from "./view";

// Public by design and mounted before the Clerk check: fal fetches the base asset with no session. The token is
// 256 random bits, lives for two hours, and maps to exactly one stored base asset.
export const dcoPublicRoutes = new Hono<AppEnv>();

dcoPublicRoutes.get("/input/:token", async (c) => {
  const token = c.req.param("token");
  if (!TOKEN_RE.test(token)) return c.json({ error: "not_found" }, 404);
  const raw = await c.env.CONFIG.get(inputKey(token));
  if (!raw) return c.json({ error: "not_found" }, 404);
  let link: { r2Key: string; contentType: string };
  try {
    link = JSON.parse(raw) as { r2Key: string; contentType: string };
  } catch {
    return c.json({ error: "not_found" }, 404);
  }
  const obj = await c.env.FILES.get(link.r2Key);
  if (!obj) return c.json({ error: "not_found" }, 404);
  return imageResponse(obj.body, link.contentType);
});

export const dcoRoutes = new Hono<AppEnv>();

const issues = (e: z.ZodError) => e.issues.map((i) => ({ path: i.path.join("."), message: i.message }));
const decisionSchema = z.object({ decision: z.enum(["approve", "reject"]) });
const notFound = (c: Context<AppEnv>) => c.json({ error: "not_found" }, 404);
const originOf = (c: Context<AppEnv>) => new URL(c.req.url).origin;

// Stored images are served only to signed-in users, never cached by shared caches
function imageResponse(body: ReadableStream | null, contentType: string): Response {
  return new Response(body, {
    headers: { "Content-Type": contentType, "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" },
  });
}

// FR-DC-2 / AC-DC-2: the allowlist and its audit, readable by everyone who can open the tool
dcoRoutes.get("/allowlist", (c) => c.json(allowlistView()));

dcoRoutes.get("/runs", async (c) => c.json(await listDcoRuns(c.env)));

// FR-DC-1: brief, base asset and rights attestation in one request. Without the attestation nothing is created.
dcoRoutes.post("/runs", requireRole("admin", "member"), paidAction, async (c) => {
  const form = await c.req.formData().catch(() => null);
  if (!form) return c.json({ error: "invalid_request" }, 400);
  if (form.get("attest") !== "true") return c.json({ error: "rights_attestation_required" }, 400);
  let raw: unknown = null;
  try {
    raw = JSON.parse(String(form.get("brief") ?? ""));
  } catch {
    raw = null;
  }
  const parsed = dcoBriefSchema.safeParse(raw);
  if (!parsed.success) return c.json({ error: "invalid_brief", issues: issues(parsed.error) }, 400);
  const file = form.get("asset");
  if (!(file instanceof File)) return c.json({ error: "missing_asset" }, 400);
  if (file.size > MAX_ASSET_BYTES) return c.json({ error: "file_too_large" }, 413);
  const bytes = new Uint8Array(await file.arrayBuffer());
  const type = sniffAsset(bytes);
  if (!type) return c.json({ error: "unsupported_file_type" }, 415);
  const result = await createDcoRun(
    c.env,
    originOf(c),
    parsed.data,
    { bytes, fileName: safeFileName(file.name), type, sha256: await sha256Hex(bytes) },
    c.get("userId"),
  );
  return c.json(result, 201);
});

dcoRoutes.get("/runs/:id", async (c) => {
  const detail = await loadDcoDetail(c.env, c.req.param("id"));
  return detail ? c.json(detail) : notFound(c);
});

dcoRoutes.get("/runs/:id/asset", async (c) => {
  const [asset] = await getDb(c.env)
    .select()
    .from(dcoAssets)
    .where(eq(dcoAssets.runId, c.req.param("id")));
  if (!asset) return notFound(c);
  const obj = await c.env.FILES.get(asset.r2Key);
  return obj ? imageResponse(obj.body, asset.contentType) : notFound(c);
});

dcoRoutes.get("/runs/:id/visuals/:key/image", async (c) => {
  const [v] = await getDb(c.env)
    .select()
    .from(dcoVisuals)
    .where(and(eq(dcoVisuals.runId, c.req.param("id")), eq(dcoVisuals.planKey, c.req.param("key"))));
  if (!v || v.status !== "ready" || !v.r2Key) return notFound(c);
  const obj = await c.env.FILES.get(v.r2Key);
  return obj ? imageResponse(obj.body, v.contentType ?? "application/octet-stream") : notFound(c);
});

// Review actions need a draft job. They return an error response rather than throwing, so routes stay flat.
async function draftRun(c: Context<AppEnv>, id: string): Promise<{ error: Response } | { ok: true }> {
  const [run] = await getDb(c.env).select().from(runs).where(eq(runs.id, id));
  if (!run || run.product !== "dco") return { error: notFound(c) };
  if (run.status !== "draft") return { error: c.json({ error: "run_not_in_draft" }, 409) };
  return { ok: true };
}

async function logReview(c: Context<AppEnv>, runId: string, payload: Record<string, unknown>) {
  await getDb(c.env)
    .insert(dcoEvents)
    .values({ id: newId(), runId, kind: "review", payload, actor: c.get("userId"), createdAt: Date.now() });
}

// FR-DC-2 / HR-4: each visual is approved or rejected on its own
dcoRoutes.post("/runs/:id/visuals/:key/review", requireRole("admin", "member"), async (c) => {
  const id = c.req.param("id");
  const key = c.req.param("key");
  const body = decisionSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!body.success) return c.json({ error: "invalid_decision" }, 400);
  const gate = await draftRun(c, id);
  if ("error" in gate) return gate.error;
  const db = getDb(c.env);
  const [v] = await db
    .select()
    .from(dcoVisuals)
    .where(and(eq(dcoVisuals.runId, id), eq(dcoVisuals.planKey, key)));
  if (!v) return notFound(c);
  if (v.status !== "ready") return c.json({ error: "not_ready" }, 409);
  const reviewStatus = body.data.decision === "approve" ? "approved" : "rejected";
  const now = Date.now();
  await db
    .update(dcoVisuals)
    .set({ reviewStatus, reviewedBy: c.get("userId"), reviewedAt: now, updatedAt: now })
    .where(and(eq(dcoVisuals.runId, id), eq(dcoVisuals.planKey, key)));
  await logReview(c, id, { kind: "visual", planKey: key, decision: body.data.decision });
  return c.json({ ok: true });
});

dcoRoutes.post("/runs/:id/copy/:copyId/review", requireRole("admin", "member"), async (c) => {
  const id = c.req.param("id");
  const copyId = c.req.param("copyId");
  const body = decisionSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!body.success) return c.json({ error: "invalid_decision" }, 400);
  const gate = await draftRun(c, id);
  if ("error" in gate) return gate.error;
  const db = getDb(c.env);
  const [row] = await db
    .select()
    .from(dcoCopy)
    .where(and(eq(dcoCopy.runId, id), eq(dcoCopy.id, copyId)));
  if (!row) return notFound(c);
  const reviewStatus = body.data.decision === "approve" ? "approved" : "rejected";
  await db
    .update(dcoCopy)
    .set({ reviewStatus, reviewedBy: c.get("userId"), reviewedAt: Date.now() })
    .where(and(eq(dcoCopy.runId, id), eq(dcoCopy.id, copyId)));
  await logReview(c, id, { kind: "copy", copyId, segmentKey: row.segmentKey, decision: body.data.decision });
  return c.json({ ok: true });
});

// BR-DC-1: a failed slot is retried on its own; nothing else reruns
dcoRoutes.post("/runs/:id/visuals/:key/retry", requireRole("admin", "member"), paidAction, async (c) => {
  const result = await requeueVisual(c.env, originOf(c), c.req.param("id"), c.req.param("key"), c.get("userId"));
  return retryResponse(c, result);
});

dcoRoutes.post("/runs/:id/segments/:key/retry", requireRole("admin", "member"), paidAction, async (c) => {
  const result = await requeueSegment(c.env, c.req.param("id"), c.req.param("key"), c.get("userId"));
  return retryResponse(c, result);
});

// A refused queue send leaves the slot failed, so the retry button stays for the next attempt
function retryResponse(c: Context<AppEnv>, result: RequeueResult) {
  if (result === "ok") return c.json({ ok: true }, 202);
  if (result === "not_found") return notFound(c);
  if (result === "not_queued") return c.json({ error: "not_queued" }, 503);
  return c.json({ error: result }, 409);
}

// Moves stuck pending or generating slots to failed and settles their jobs. Same sweep as the scheduled run.
dcoRoutes.post("/admin/sweep", requireRole("admin"), async (c) => c.json({ moved: await sweepStuckDco(c.env, Date.now()) }));

// FR-CORE-22: a job is approved only when something is approved and nothing is still generating
dcoRoutes.post("/runs/:id/review", requireRole("admin", "member"), async (c) => {
  const id = c.req.param("id");
  const body = decisionSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!body.success) return c.json({ error: "invalid_decision" }, 400);
  const gate = await draftRun(c, id);
  if ("error" in gate) return gate.error;
  const db = getDb(c.env);
  if (body.data.decision === "approve") {
    const [open] = await db
      .select({ n: count() })
      .from(dcoVisuals)
      .where(and(eq(dcoVisuals.runId, id), inArray(dcoVisuals.status, ["pending", "generating"])));
    const [openCopy] = await db
      .select({ n: count() })
      .from(dcoSegments)
      .where(and(eq(dcoSegments.runId, id), inArray(dcoSegments.status, ["pending", "generating"])));
    if ((open?.n ?? 0) > 0 || (openCopy?.n ?? 0) > 0) return c.json({ error: "items_pending" }, 409);
    const [approved] = await db
      .select({ n: count() })
      .from(dcoVisuals)
      .where(and(eq(dcoVisuals.runId, id), eq(dcoVisuals.reviewStatus, "approved"), eq(dcoVisuals.status, "ready")));
    if ((approved?.n ?? 0) < 1) return c.json({ error: "no_approved_visual" }, 409);
  }
  const now = Date.now();
  const status = body.data.decision === "approve" ? "approved" : "rejected";
  await db.update(runs).set({ status, reviewedBy: c.get("userId"), reviewedAt: now }).where(eq(runs.id, id));
  await db.insert(dcoEvents).values({ id: newId(), runId: id, kind: "decision", payload: { decision: body.data.decision }, actor: c.get("userId"), createdAt: now });
  return c.json({ ok: true });
});

// FR-DC-5: the pack needs an approved job and at least one approved visual
dcoRoutes.get("/runs/:id/export.zip", async (c) => {
  const id = c.req.param("id");
  const rows = await loadDcoRows(getDb(c.env), id);
  if (!rows) return notFound(c);
  if (rows.run.status !== "approved") return c.json({ error: "export_requires_approval" }, 409);
  if (!rows.visuals.some((v) => v.reviewStatus === "approved" && v.status === "ready")) return c.json({ error: "no_approved_visual" }, 409);
  const pack = await buildDcoPack(c.env, rows, c.get("userId"));
  return new Response(pack.zip, {
    headers: {
      "Content-Type": "application/zip",
      "Content-Disposition": `attachment; filename="dco-pack-${id.slice(0, 8)}.zip"`,
      "Cache-Control": "private, no-store",
    },
  });
});
