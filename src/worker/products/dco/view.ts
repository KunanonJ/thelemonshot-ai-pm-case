import { and, asc, count, desc, eq, inArray } from "drizzle-orm";
import { getDb, type Db } from "../../core/db/client";
import { briefs, runs } from "../../core/db/schema";
import { dcoBriefSchema } from "./brief";
import { dcoAssets, dcoCopy, dcoEvents, dcoSegments, dcoVisuals } from "./schema";

// Reads one job's rows. The raw rows keep internal R2 keys; the views below are what the API returns.
export async function loadDcoRows(db: Db, runId: string) {
  const [run] = await db.select().from(runs).where(eq(runs.id, runId));
  if (!run || run.product !== "dco" || !run.briefId) return null;
  const [briefRow] = await db.select().from(briefs).where(eq(briefs.id, run.briefId));
  if (!briefRow) return null;
  const [asset] = await db.select().from(dcoAssets).where(eq(dcoAssets.runId, runId));
  const segments = await db.select().from(dcoSegments).where(eq(dcoSegments.runId, runId)).orderBy(asc(dcoSegments.position));
  const copy = await db.select().from(dcoCopy).where(eq(dcoCopy.runId, runId)).orderBy(asc(dcoCopy.segmentKey), asc(dcoCopy.position));
  const visuals = await db.select().from(dcoVisuals).where(eq(dcoVisuals.runId, runId)).orderBy(asc(dcoVisuals.position));
  const events = await db.select().from(dcoEvents).where(eq(dcoEvents.runId, runId)).orderBy(desc(dcoEvents.createdAt)).limit(50);
  const [safety] = await db
    .select({ n: count() })
    .from(dcoEvents)
    .where(and(eq(dcoEvents.runId, runId), eq(dcoEvents.kind, "safety")));
  return {
    run,
    brief: dcoBriefSchema.parse(briefRow.fields),
    asset: asset ?? null,
    segments,
    copy,
    visuals,
    events,
    safetyDiscarded: safety?.n ?? 0,
  };
}

export type DcoRows = NonNullable<Awaited<ReturnType<typeof loadDcoRows>>>;

export function toDetail(rows: DcoRows) {
  const { run, brief, asset, segments, copy, visuals, events, safetyDiscarded } = rows;
  const approvedVisuals = visuals.filter((v) => v.reviewStatus === "approved" && v.status === "ready").length;
  return {
    id: run.id,
    status: run.status,
    createdAt: run.createdAt,
    reviewedAt: run.reviewedAt,
    reviewedBy: run.reviewedBy,
    brief,
    asset: asset
      ? {
          fileName: asset.fileName,
          contentType: asset.contentType,
          bytes: asset.bytes,
          sha256: asset.sha256,
          uploadedBy: asset.uploadedBy,
          uploadedAt: asset.uploadedAt,
          rightsAttestedBy: asset.rightsAttestedBy,
          rightsAttestedAt: asset.rightsAttestedAt,
        }
      : null,
    segments: segments.map((s) => ({
      key: s.segmentKey,
      name: s.name,
      note: s.note,
      status: s.status,
      error: s.error,
      copyCount: copy.filter((c) => c.segmentKey === s.segmentKey).length,
    })),
    copy: copy.map((c) => ({
      id: c.id,
      segmentKey: c.segmentKey,
      position: c.position,
      headline: c.headline,
      hookLine: c.hookLine,
      caption: c.caption,
      cta: c.cta,
      flags: c.flags,
      reviewStatus: c.reviewStatus,
      reviewedBy: c.reviewedBy,
      reviewedAt: c.reviewedAt,
      model: c.model,
      promptVersion: c.promptVersion,
      createdAt: c.createdAt,
    })),
    visuals: visuals.map((v) => ({
      key: v.planKey,
      position: v.position,
      kind: v.kind,
      label: v.label,
      segmentKey: v.segmentKey,
      format: v.format,
      modelId: v.modelId,
      status: v.status,
      error: v.error,
      attempts: v.attempts,
      reviewStatus: v.reviewStatus,
      reviewedBy: v.reviewedBy,
      reviewedAt: v.reviewedAt,
      bytes: v.bytes,
      contentType: v.contentType,
      provenance: v.provenance,
      hasImage: v.status === "ready" && Boolean(v.r2Key),
    })),
    safetyDiscarded,
    approvedVisuals,
    exportable: run.status === "approved" && approvedVisuals > 0,
    events: events.map((e) => ({ id: e.id, kind: e.kind, payload: e.payload, actor: e.actor, createdAt: e.createdAt })),
  };
}

export type DcoDetailView = ReturnType<typeof toDetail>;

export async function loadDcoDetail(env: Env, runId: string): Promise<DcoDetailView | null> {
  const rows = await loadDcoRows(getDb(env), runId);
  return rows ? toDetail(rows) : null;
}

// Job list for the home page: progress comes from the item rows, so a run in progress shows what is left
export async function listDcoRuns(env: Env) {
  const db = getDb(env);
  const rows = await db
    .select({ run: runs, fields: briefs.fields })
    .from(runs)
    .leftJoin(briefs, eq(runs.briefId, briefs.id))
    .where(eq(runs.product, "dco"))
    .orderBy(desc(runs.createdAt))
    .limit(50);
  const ids = rows.map((r) => r.run.id);
  const visuals = ids.length ? await db.select().from(dcoVisuals).where(inArray(dcoVisuals.runId, ids)) : [];
  const segments = ids.length ? await db.select().from(dcoSegments).where(inArray(dcoSegments.runId, ids)) : [];
  return rows.map(({ run, fields }) => {
    const v = visuals.filter((x) => x.runId === run.id);
    const s = segments.filter((x) => x.runId === run.id);
    const parsed = dcoBriefSchema.safeParse(fields);
    return {
      id: run.id,
      status: run.status,
      createdAt: run.createdAt,
      reviewedAt: run.reviewedAt,
      brief: parsed.success ? parsed.data : null,
      progress: {
        visualsTotal: v.length,
        visualsReady: v.filter((x) => x.status === "ready").length,
        visualsFailed: v.filter((x) => x.status === "failed").length,
        visualsPending: v.filter((x) => x.status === "pending" || x.status === "generating").length,
        copyReady: s.filter((x) => x.status === "ready").length,
        copyFailed: s.filter((x) => x.status === "failed").length,
        copyPending: s.filter((x) => x.status === "pending" || x.status === "generating").length,
        approvedVisuals: v.filter((x) => x.reviewStatus === "approved" && x.status === "ready").length,
      },
    };
  });
}
