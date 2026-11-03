import { and, count, desc, eq, inArray, lt, or, sql } from "drizzle-orm";
import type { BatchItem } from "drizzle-orm/batch";
import type { AnySQLiteColumn, SQLiteTable } from "drizzle-orm/sqlite-core";
import { getDb, insertChunked, type Db } from "../../core/db/client";
import { briefs, runs } from "../../core/db/schema";
import { errorMessage } from "../../core/env";
import { allowedFigures } from "../../core/figures";
import { callJson, isWorkersAiModel } from "../../core/llm";
import type { DcoCopyMessage, DcoVisualMessage, DcoVisualPollMessage } from "../../core/messages";
import { inputHash, newId } from "../../core/util";
import { assertAllowed } from "./allowlist";
import { mintInputLink, sha256Hex, type AssetType } from "./assets";
import { briefTexts, dcoBriefSchema, type DcoBrief } from "./brief";
import { buildCopyPrompt, copyJsonSchema, copyOutputSchema, DCO_COPY_PROMPT_VERSION, guardCopyOption, type CopyOption } from "./copy";
import { downloadFalImage, FalError, readFalResult, readFalStatus, submitToFal, type FalFailure } from "./fal";
import { DCO_EVENT_KINDS, dcoAssets, dcoCopy, dcoEvents, dcoSegments, dcoVisuals, type DcoProvenance } from "./schema";
import { editWithWorkersAi } from "./workers-image";
import { DCO_VISUAL_PROMPT_VERSION, falInput, isSafetyErrorType, isSafetyFlagged, outputImages, outputSeed, planFor, VISUAL_PLAN, type VisualPlan } from "./visuals";

const DEDUPE_WINDOW_MS = 2 * 60_000;
// A status read every 5 seconds, for at most 10 minutes per visual
export const POLL_SECONDS = 5;
export const MAX_POLLS = 120;
// A claim whose worker stopped without writing again can be taken over once it is this old. It must outlast the
// slowest normal step (a copy call with its retries, or the whole poll window), so two workers never hold one slot.
export const CLAIM_LEASE_MS = 15 * 60_000;
// sweepStuckDco moves any slot still pending or generating this long after its last change to failed
export const STUCK_MS = 20 * 60_000;
const OPEN_STATUSES = ["pending", "generating"] as const;
const D1_MAX_PARAMS = 100;

export const SAFETY_TEXT = "The provider's safety filter discarded this result. It was not shown and can be retried.";

// Plain words for the planner. Provider detail goes to the console and llm_calls, never to the screen (BR-CORE-3).
const VISUAL_FAILURE: Record<FalFailure | "provider_error" | "unexpected", string> = {
  not_configured: "The image service isn't configured yet",
  submit_failed: "The image service didn't accept the request",
  status_failed: "The image service status couldn't be read",
  result_failed: "The image service's answer couldn't be read",
  untrusted_url: "The image service answered with an address this tool doesn't trust",
  download_failed: "The generated image couldn't be downloaded",
  not_an_image: "The image service's file wasn't a PNG, JPEG or WebP image",
  provider_error: "The image service returned an error",
  unexpected: "Something went wrong while generating this visual",
};

const COPY_FAILURE: Record<string, string> = {
  not_configured: "The copy model isn't configured yet",
  forced_failure: "Model failure is switched on for testing",
  http_error: "The copy model returned an error",
  invalid_json: "The copy model's answer wasn't valid JSON",
  schema_mismatch: "The copy model's answer didn't match the copy format",
  timeout: "The copy model took too long to answer",
  network: "The copy model couldn't be reached",
  unexpected: "Something went wrong while writing copy for this segment",
};

// Failures that come from the queue, the sweep or the retry limit. Raw detail goes to the console only.
export const QUEUE_FAILURE_TEXT = "This step couldn't be queued. Retry it to try again.";
export const NEVER_STARTED_TEXT = "This step never started. Retry it to try again.";
export const TOO_LONG_TEXT = "This step took too long and was stopped. Retry it to try again.";
export const COPY_RETRIES_TEXT = "Writing copy for this segment failed after several attempts. Retry it to try again.";
export const VISUAL_RETRIES_TEXT = "Making this visual failed after several attempts. Retry it to try again.";

// Retry is allowed until the review is over: a job that is queued, running, a draft or failed can take it
const RETRY_STATES: readonly string[] = ["queued", "running", "draft", "failed"];

export const segmentKeyAt = (index: number) => `s${index + 1}`;

type DcoEventKind = (typeof DCO_EVENT_KINDS)[number];
type VisualRow = typeof dcoVisuals.$inferSelect;
// A slot that the handlers, the queue hook and the sweep move between states
type Slot = { kind: "copy"; segmentKey: string } | { kind: "visual"; planKey: string };
type Outbound = { slot: Slot; msg: DcoCopyMessage | DcoVisualMessage };

const slotLabel = (slot: Slot) => (slot.kind === "copy" ? `copy ${slot.segmentKey}` : `visual ${slot.planKey}`);

async function recordEvent(db: Db, runId: string, kind: DcoEventKind, payload: Record<string, unknown>, actor: string): Promise<void> {
  await db.insert(dcoEvents).values({ id: newId(), runId, kind, payload, actor, createdAt: Date.now() });
}

async function markRunning(db: Db, runId: string): Promise<void> {
  await db
    .update(runs)
    .set({ status: "running", startedAt: Date.now() })
    .where(and(eq(runs.id, runId), eq(runs.status, "queued")));
}

// Once every visual and segment has settled, the job becomes a draft for review (FR-CORE-22), or failed if nothing
// at all could be produced. One failed provider never fails the whole job (BR-DC-1).
export async function settleRun(env: Env, runId: string): Promise<void> {
  const db = getDb(env);
  const [run] = await db.select().from(runs).where(eq(runs.id, runId));
  if (!run || (run.status !== "queued" && run.status !== "running")) return;
  const [openVisuals] = await db
    .select({ n: count() })
    .from(dcoVisuals)
    .where(and(eq(dcoVisuals.runId, runId), inArray(dcoVisuals.status, [...OPEN_STATUSES])));
  const [openSegments] = await db
    .select({ n: count() })
    .from(dcoSegments)
    .where(and(eq(dcoSegments.runId, runId), inArray(dcoSegments.status, [...OPEN_STATUSES])));
  if ((openVisuals?.n ?? 0) > 0 || (openSegments?.n ?? 0) > 0) return;
  const [readyVisuals] = await db
    .select({ n: count() })
    .from(dcoVisuals)
    .where(and(eq(dcoVisuals.runId, runId), eq(dcoVisuals.status, "ready")));
  const [readyCopy] = await db.select({ n: count() }).from(dcoCopy).where(eq(dcoCopy.runId, runId));
  const produced = (readyVisuals?.n ?? 0) + (readyCopy?.n ?? 0) > 0;
  await db
    .update(runs)
    .set({ status: produced ? "draft" : "failed", finishedAt: Date.now() })
    .where(and(eq(runs.id, runId), inArray(runs.status, ["queued", "running"])));
}

// D1 allows at most 100 bound parameters per statement, so a bulk insert is split by column count. The statements
// are returned rather than run, so they can share one atomic batch with the rest of a job's writes.
export function insertStatements<T extends SQLiteTable>(db: Db, table: T, rows: T["$inferInsert"][]): BatchItem<"sqlite">[] {
  if (rows.length === 0) return [];
  const columns = Object.keys(rows[0] as object).length;
  const size = Math.max(1, Math.floor(D1_MAX_PARAMS / columns));
  const out: BatchItem<"sqlite">[] = [];
  for (let i = 0; i < rows.length; i += size) out.push(db.insert(table).values(rows.slice(i, i + size)));
  return out;
}

// One D1 batch is a transaction: every statement lands or none does
async function runBatch(db: Db, statements: BatchItem<"sqlite">[]): Promise<void> {
  const [first, ...rest] = statements;
  if (!first) return;
  await db.batch([first, ...rest]);
}

// Sends each item on its own and returns the ones whose send threw. One refused send never stops the others.
export async function sendEach<T>(items: T[], send: (item: T) => Promise<unknown>): Promise<{ item: T; error: string }[]> {
  const unsent: { item: T; error: string }[] = [];
  for (const item of items) {
    try {
      await send(item);
    } catch (e) {
      unsent.push({ item, error: errorMessage(e) });
    }
  }
  return unsent;
}

// Queues the messages and returns the slots whose message could not be sent, so they can be marked retryable
async function queueSlots(env: Env, runId: string, outbound: Outbound[]): Promise<Slot[]> {
  const unsent = await sendEach(outbound, (o) => env.ENRICH_QUEUE.send(o.msg));
  for (const u of unsent) console.error("dco queue send failed", runId, slotLabel(u.item.slot), u.error);
  return unsent.map((u) => u.item.slot);
}

// A slot can be claimed while pending, or while generating under a claim older than the lease (its worker is gone)
const claimable = (status: AnySQLiteColumn, updatedAt: AnySQLiteColumn, now: number) =>
  or(eq(status, "pending"), and(eq(status, "generating"), lt(updatedAt, now - CLAIM_LEASE_MS)));

// Moves open slots (pending or generating) to failed with plain text, records one event per slot that changed, then
// settles the job. A slot that already finished is left alone, so calling this again changes nothing.
async function failSlots(env: Env, runId: string, slots: Slot[], text: string, reason: string, extra: Record<string, unknown> = {}): Promise<void> {
  const db = getDb(env);
  const now = Date.now();
  for (const slot of slots) {
    if (slot.kind === "copy") {
      const [changed] = await db
        .update(dcoSegments)
        .set({ status: "failed", error: text, updatedAt: now })
        .where(and(eq(dcoSegments.runId, runId), eq(dcoSegments.segmentKey, slot.segmentKey), inArray(dcoSegments.status, [...OPEN_STATUSES])))
        .returning({ key: dcoSegments.segmentKey });
      if (changed) await recordEvent(db, runId, "copy", { segmentKey: slot.segmentKey, stage: "failed", reason, ...extra }, "system");
    } else {
      const [changed] = await db
        .update(dcoVisuals)
        .set({ status: "failed", error: text, updatedAt: now })
        .where(and(eq(dcoVisuals.runId, runId), eq(dcoVisuals.planKey, slot.planKey), inArray(dcoVisuals.status, [...OPEN_STATUSES])))
        .returning({ modelId: dcoVisuals.modelId });
      if (changed) await recordEvent(db, runId, "visual", { planKey: slot.planKey, modelId: changed.modelId, stage: "failed", error: text, reason }, "system");
    }
  }
  await settleRun(env, runId);
}

export type NewDcoAsset = { bytes: Uint8Array; fileName: string; type: AssetType; sha256: string };

// Creates the job and its slots, stores the base asset in R2, and queues one copy call per segment and one
// provider call per visual slot. The same brief and asset from the same person within two minutes returns the
// run that is already drafting (BR-CORE-4).
export async function createDcoRun(env: Env, origin: string, brief: DcoBrief, asset: NewDcoAsset, userId: string): Promise<{ runId: string; deduped: boolean }> {
  const db = getDb(env);
  const hash = await inputHash({ product: "dco", brief, assetSha256: asset.sha256 });
  const [recent] = await db
    .select()
    .from(runs)
    .where(and(eq(runs.inputHash, hash), eq(runs.createdBy, userId), inArray(runs.status, ["queued", "running"])))
    .orderBy(desc(runs.createdAt))
    .limit(1);
  if (recent && Date.now() - recent.createdAt < DEDUPE_WINDOW_MS) return { runId: recent.id, deduped: true };

  const runId = newId();
  const briefId = newId();
  const now = Date.now();
  const assetKey = `dco/${runId}/base.${asset.type.ext}`;
  await env.FILES.put(assetKey, asset.bytes, { httpMetadata: { contentType: asset.type.contentType } });

  const segments = brief.segments.map((s, i) => ({
    id: newId(),
    runId,
    segmentKey: segmentKeyAt(i),
    position: i,
    name: s.name,
    note: s.note || null,
    status: "pending" as const,
    error: null,
    updatedAt: now,
  }));
  // Visual slots target audience segments in turn, so every segment has visuals to pair with its copy
  const visuals = VISUAL_PLAN.map((plan, i) => ({
    id: newId(),
    runId,
    planKey: plan.key,
    position: i,
    kind: plan.kind,
    label: plan.label,
    segmentKey: segmentKeyAt(i % segments.length),
    format: plan.format,
    modelId: plan.modelId,
    status: "pending" as const,
    attempts: 0,
    error: null,
    falRequestId: null,
    statusUrl: null,
    responseUrl: null,
    submittedAt: null,
    r2Key: null,
    contentType: null,
    bytes: null,
    provenance: null,
    reviewStatus: "draft" as const,
    reviewedBy: null,
    reviewedAt: null,
    updatedAt: now,
  }));

  // The job, its inputs and every slot land in one batch, so a job never exists with slots missing
  await runBatch(db, [
    db.insert(briefs).values({ id: briefId, product: "dco", fields: brief, inputHash: hash, createdBy: userId, createdAt: now }),
    db.insert(runs).values({
      id: runId,
      product: "dco",
      briefId,
      status: "queued",
      inputHash: hash,
      flags: { copyPerSegment: brief.copyPerSegment, segments: segments.length, visualSlots: visuals.length },
      createdBy: userId,
      createdAt: now,
    }),
    db.insert(dcoAssets).values({
      id: newId(),
      runId,
      r2Key: assetKey,
      fileName: asset.fileName,
      contentType: asset.type.contentType,
      bytes: asset.bytes.byteLength,
      sha256: asset.sha256,
      uploadedBy: userId,
      uploadedAt: now,
      rightsAttestedBy: userId,
      rightsAttestedAt: now,
    }),
    db.insert(dcoEvents).values({
      id: newId(),
      runId,
      kind: "intake",
      payload: { fileName: asset.fileName, contentType: asset.type.contentType, bytes: asset.bytes.byteLength, sha256: asset.sha256, segments: segments.length, copyPerSegment: brief.copyPerSegment },
      actor: userId,
      createdAt: now,
    }),
    ...insertStatements(db, dcoSegments, segments),
    ...insertStatements(db, dcoVisuals, visuals),
  ]);

  const outbound: Outbound[] = [
    ...segments.map((seg): Outbound => ({
      slot: { kind: "copy", segmentKey: seg.segmentKey },
      msg: { kind: "dco-copy", runId, segmentKey: seg.segmentKey, requestedBy: userId },
    })),
    ...visuals.map((v): Outbound => ({
      slot: { kind: "visual", planKey: v.planKey },
      msg: { kind: "dco-visual", runId, planKey: v.planKey, origin, requestedBy: userId },
    })),
  ];
  const unsent = await queueSlots(env, runId, outbound);
  if (unsent.length) await failSlots(env, runId, unsent, QUEUE_FAILURE_TEXT, "queue");
  return { runId, deduped: false };
}

// FR-DC-3: one call per segment, each with its own failure. A failed segment keeps the others. Any throw after the
// claim lands the segment in failed, so nothing is left generating.
export async function handleDcoCopy(env: Env, msg: DcoCopyMessage): Promise<void> {
  const db = getDb(env);
  const [run] = await db.select().from(runs).where(eq(runs.id, msg.runId));
  if (!run || run.product !== "dco" || !run.briefId) return;
  const now = Date.now();
  const claimed = await db
    .update(dcoSegments)
    .set({ status: "generating", error: null, updatedAt: now })
    .where(and(eq(dcoSegments.runId, run.id), eq(dcoSegments.segmentKey, msg.segmentKey), claimable(dcoSegments.status, dcoSegments.updatedAt, now)))
    .returning();
  const segment = claimed[0];
  if (!segment) {
    await settleRun(env, run.id);
    return;
  }
  try {
    await markRunning(db, run.id);
    await writeCopy(env, run.id, run.briefId, msg.segmentKey, segment);
  } catch (e) {
    console.error("dco copy failed", run.id, msg.segmentKey, errorMessage(e));
    await failSlots(env, run.id, [{ kind: "copy", segmentKey: msg.segmentKey }], COPY_FAILURE.unexpected!, "unexpected");
  }
}

// One copy call for one segment. Its rows and the ready mark are written in one batch.
async function writeCopy(env: Env, runId: string, briefId: string, segmentKey: string, segment: { name: string; note: string | null }): Promise<void> {
  const db = getDb(env);
  const [briefRow] = await db.select().from(briefs).where(eq(briefs.id, briefId));
  if (!briefRow) throw new Error("brief missing");
  const brief = dcoBriefSchema.parse(briefRow.fields);
  const count = brief.copyPerSegment;
  const prompt = buildCopyPrompt(brief, { name: segment.name, note: segment.note }, count);
  const res = await callJson(env, {
    product: "dco",
    promptVersion: DCO_COPY_PROMPT_VERSION,
    system: prompt.system,
    user: prompt.user,
    schema: copyOutputSchema,
    jsonSchema: copyJsonSchema(),
    runId,
    maxTokens: 600 + 450 * count,
  });

  if (!res.ok) {
    await failSlots(env, runId, [{ kind: "copy", segmentKey }], COPY_FAILURE[res.reason] ?? COPY_FAILURE.unexpected!, res.reason, { model: res.model });
    return;
  }

  // FR-DC-3 / HR-3: the figure and placeholder guards run after schema validation and before anything is stored
  const allowed = allowedFigures([], briefTexts(brief));
  const options: CopyOption[] = res.data.options.slice(0, count);
  const now = Date.now();
  const rows = options.map((option, i) => {
    const guarded = guardCopyOption(option, allowed, brief.prohibitedClaims);
    const flags = [...guarded.flags, ...(options.length < count ? [`fewer_options:${options.length}`] : [])];
    return {
      id: newId(),
      runId,
      segmentKey,
      position: i + 1,
      headline: guarded.option.headline,
      hookLine: guarded.option.hookLine,
      caption: guarded.option.caption,
      cta: guarded.option.cta,
      flags,
      model: res.model,
      promptVersion: DCO_COPY_PROMPT_VERSION,
      reviewStatus: "draft" as const,
      reviewedBy: null,
      reviewedAt: null,
      createdAt: now,
    };
  });
  await runBatch(db, [
    ...insertStatements(db, dcoCopy, rows),
    db
      .update(dcoSegments)
      .set({ status: "ready", error: null, updatedAt: now })
      .where(and(eq(dcoSegments.runId, runId), eq(dcoSegments.segmentKey, segmentKey), eq(dcoSegments.status, "generating"))),
  ]);
  await recordEvent(db, runId, "copy", { segmentKey, stage: "ready", options: rows.length, model: res.model }, "system");
  await settleRun(env, runId);
}

// BR-DC-2: the result is dropped before it is downloaded or stored. Only the count and the request id remain.
async function discardForSafety(env: Env, runId: string, row: { planKey: string; modelId: string; falRequestId: string | null }): Promise<void> {
  const db = getDb(env);
  await db
    .update(dcoVisuals)
    .set({ status: "failed", error: SAFETY_TEXT, updatedAt: Date.now() })
    .where(and(eq(dcoVisuals.runId, runId), eq(dcoVisuals.planKey, row.planKey), inArray(dcoVisuals.status, [...OPEN_STATUSES])));
  await recordEvent(db, runId, "safety", { planKey: row.planKey, modelId: row.modelId, falRequestId: row.falRequestId, stage: "discarded" }, "system");
  await settleRun(env, runId);
}

// FR-DC-2: makes one allowlisted request for a visual slot. A Workers AI model answers in the same call, so the image
// is stored at once; a fal model is submitted and polled, reaching the base asset through a short-lived link minted
// here (FR-DC-1). Nothing but the product photo and the fixed prompt leaves the Worker.
export async function handleDcoVisual(env: Env, msg: DcoVisualMessage): Promise<void> {
  const db = getDb(env);
  const plan = planFor(msg.planKey);
  const [run] = await db.select().from(runs).where(eq(runs.id, msg.runId));
  if (!plan || !run || run.product !== "dco") return;
  const now = Date.now();
  const claimed = await db
    .update(dcoVisuals)
    .set({ status: "generating", error: null, attempts: sql`${dcoVisuals.attempts} + 1`, updatedAt: now })
    .where(and(eq(dcoVisuals.runId, run.id), eq(dcoVisuals.planKey, plan.key), claimable(dcoVisuals.status, dcoVisuals.updatedAt, now)))
    .returning();
  if (!claimed[0]) {
    await settleRun(env, run.id);
    return;
  }
  try {
    await markRunning(db, run.id);
    assertAllowed(plan.modelId);
    const [asset] = await db.select().from(dcoAssets).where(eq(dcoAssets.runId, run.id));
    if (!asset) throw new Error("base asset missing");
    if (isWorkersAiModel(plan.modelId)) {
      const file = await env.FILES.get(asset.r2Key);
      if (!file) throw new Error("base asset file missing");
      const submittedAt = Date.now();
      await db.update(dcoVisuals).set({ submittedAt, updatedAt: submittedAt }).where(and(eq(dcoVisuals.runId, run.id), eq(dcoVisuals.planKey, plan.key)));
      await recordEvent(db, run.id, "visual", { planKey: plan.key, modelId: plan.modelId, stage: "submitted" }, "system");
      const image = await editWithWorkersAi(env, plan, { bytes: new Uint8Array(await file.arrayBuffer()), contentType: asset.contentType });
      await storeVisual(env, run.id, plan, { ...claimed[0], submittedAt }, null, image);
      return;
    }
    const link = await mintInputLink(env, msg.origin, asset);
    const sub = await submitToFal(env, plan.modelId, falInput(plan, link));
    const submittedAt = Date.now();
    await db
      .update(dcoVisuals)
      .set({ falRequestId: sub.requestId, statusUrl: sub.statusUrl, responseUrl: sub.responseUrl, submittedAt, updatedAt: submittedAt })
      .where(and(eq(dcoVisuals.runId, run.id), eq(dcoVisuals.planKey, plan.key)));
    await recordEvent(db, run.id, "visual", { planKey: plan.key, modelId: plan.modelId, falRequestId: sub.requestId, stage: "submitted" }, "system");
    const pollMsg: DcoVisualPollMessage = { kind: "dco-visual-poll", runId: run.id, planKey: plan.key, polls: 0 };
    await env.ENRICH_QUEUE.send(pollMsg, { delaySeconds: POLL_SECONDS });
  } catch (e) {
    // BR-DC-1: the slot shows a retry state; copy and the other visuals carry on
    console.error("dco visual submit failed", run.id, plan.key, errorMessage(e));
    const text = e instanceof FalError ? VISUAL_FAILURE[e.reason] : VISUAL_FAILURE.unexpected;
    await failSlots(env, run.id, [{ kind: "visual", planKey: plan.key }], text, e instanceof FalError ? e.reason : "unexpected");
  }
}

// Reads the provider's status until the request completes, then stores the image if the safety filter passed it.
// Once the slot is claimed, a throw anywhere in the chain ends it in failed, never generating.
export async function handleDcoVisualPoll(env: Env, msg: DcoVisualPollMessage): Promise<void> {
  const db = getDb(env);
  const [row] = await db
    .select()
    .from(dcoVisuals)
    .where(and(eq(dcoVisuals.runId, msg.runId), eq(dcoVisuals.planKey, msg.planKey)));
  if (!row) return;
  const [run] = await db.select().from(runs).where(eq(runs.id, msg.runId));
  if (!run) return;
  if (row.status !== "generating") {
    await settleRun(env, run.id);
    return;
  }
  if (!row.statusUrl || !row.responseUrl || !row.falRequestId) {
    // A poll is queued only after the submit stored these, so a generating row without them can never finish
    await failSlots(env, run.id, [{ kind: "visual", planKey: row.planKey }], VISUAL_FAILURE.unexpected, "unexpected");
    return;
  }
  const slot: Slot = { kind: "visual", planKey: row.planKey };
  try {
    const plan = planFor(row.planKey);
    const again = async (): Promise<void> => {
      if (msg.polls + 1 >= MAX_POLLS) {
        await failSlots(env, run.id, [slot], "The image service took too long to answer", "timeout");
        return;
      }
      const next: DcoVisualPollMessage = { ...msg, polls: msg.polls + 1 };
      await env.ENRICH_QUEUE.send(next, { delaySeconds: POLL_SECONDS });
    };

    let status: Awaited<ReturnType<typeof readFalStatus>>;
    try {
      status = await readFalStatus(env, row.statusUrl);
    } catch (e) {
      console.error("dco visual status failed", run.id, row.planKey, errorMessage(e));
      return again();
    }
    if (status.status !== "COMPLETED") return again();
    if (status.error) {
      if (isSafetyErrorType(status.errorType)) return discardForSafety(env, run.id, row);
      console.error("dco visual provider error", run.id, row.planKey, status.errorType ?? "unknown");
      return failSlots(env, run.id, [slot], VISUAL_FAILURE.provider_error, "provider_error");
    }

    let output: unknown;
    try {
      output = await readFalResult(env, row.responseUrl);
    } catch (e) {
      console.error("dco visual result failed", run.id, row.planKey, errorMessage(e));
      return failSlots(env, run.id, [slot], VISUAL_FAILURE.result_failed, "result_failed");
    }
    if (isSafetyFlagged(output)) return discardForSafety(env, run.id, row);

    const image = outputImages(output)[0];
    if (!image || !plan) return failSlots(env, run.id, [slot], "The image service returned no image", "no_image");
    let file: Awaited<ReturnType<typeof downloadFalImage>>;
    try {
      file = await downloadFalImage(image.url);
    } catch (e) {
      console.error("dco visual download failed", run.id, row.planKey, errorMessage(e));
      const text = e instanceof FalError ? VISUAL_FAILURE[e.reason] : VISUAL_FAILURE.unexpected;
      return failSlots(env, run.id, [slot], text, e instanceof FalError ? e.reason : "unexpected");
    }
    await storeVisual(env, run.id, plan, row, output, file);
  } catch (e) {
    console.error("dco visual poll failed", run.id, row.planKey, errorMessage(e));
    await failSlots(env, run.id, [slot], VISUAL_FAILURE.unexpected, "unexpected");
  }
}

// Writes a downloaded image and its provenance, then marks the slot ready. Only a slot still generating is updated.
async function storeVisual(env: Env, runId: string, plan: VisualPlan, row: VisualRow, output: unknown, file: { bytes: Uint8Array; type: AssetType }): Promise<void> {
  const db = getDb(env);
  const falRequestId = row.falRequestId ?? "";
  const [asset] = await db.select().from(dcoAssets).where(eq(dcoAssets.runId, runId));
  const completedAt = Date.now();
  const provenance: DcoProvenance = {
    jobId: runId,
    planKey: plan.key,
    modelId: plan.modelId,
    format: plan.format,
    prompt: plan.prompt,
    negativePrompt: plan.negativePrompt,
    seed: outputSeed(output),
    falRequestId,
    inputSha256: asset?.sha256 ?? "",
    outputSha256: await sha256Hex(file.bytes),
    outputBytes: file.bytes.byteLength,
    contentType: file.type.contentType,
    promptVersion: DCO_VISUAL_PROMPT_VERSION,
    submittedAt: row.submittedAt ?? completedAt,
    completedAt,
  };
  const r2Key = `dco/${runId}/visuals/${plan.key}.${file.type.ext}`;
  await env.FILES.put(r2Key, file.bytes, { httpMetadata: { contentType: file.type.contentType } });
  // FR-DC-4: the provenance sits beside the image as well as in the row
  await env.FILES.put(`dco/${runId}/visuals/${plan.key}.provenance.json`, JSON.stringify(provenance, null, 2), {
    httpMetadata: { contentType: "application/json" },
  });
  const stored = await db
    .update(dcoVisuals)
    .set({ status: "ready", error: null, r2Key, contentType: file.type.contentType, bytes: file.bytes.byteLength, provenance, updatedAt: completedAt })
    .where(and(eq(dcoVisuals.runId, runId), eq(dcoVisuals.planKey, plan.key), eq(dcoVisuals.status, "generating")))
    .returning({ key: dcoVisuals.planKey });
  if (stored.length) await recordEvent(db, runId, "visual", { planKey: plan.key, modelId: plan.modelId, falRequestId, stage: "ready" }, "system");
  await settleRun(env, runId);
}

export type RequeueResult = "ok" | "not_found" | "not_failed" | "run_not_in_draft" | "not_queued";

// Retry for a failed visual slot. Allowed while the job is a draft, or failed with nothing to review.
// The consumer only claims a pending slot, so the slot and the job move first and the message follows. If the send
// is refused, the slot goes back to failed, so the retry stays available.
export async function requeueVisual(env: Env, origin: string, runId: string, planKey: string, actor: string): Promise<RequeueResult> {
  const db = getDb(env);
  const [run] = await db.select().from(runs).where(eq(runs.id, runId));
  if (!run || run.product !== "dco") return "not_found";
  const [row] = await db
    .select()
    .from(dcoVisuals)
    .where(and(eq(dcoVisuals.runId, runId), eq(dcoVisuals.planKey, planKey)));
  if (!row) return "not_found";
  if (row.status !== "failed") return "not_failed";
  if (!RETRY_STATES.includes(run.status)) return "run_not_in_draft";
  const flipped = await db
    .update(dcoVisuals)
    .set({ status: "pending", error: null, updatedAt: Date.now() })
    .where(and(eq(dcoVisuals.runId, runId), eq(dcoVisuals.planKey, planKey), eq(dcoVisuals.status, "failed")))
    .returning({ key: dcoVisuals.planKey });
  if (flipped.length === 0) return "not_failed";
  await db
    .update(runs)
    .set({ status: "running", finishedAt: null })
    .where(and(eq(runs.id, runId), inArray(runs.status, ["draft", "failed"])));
  await recordEvent(db, runId, "retry", { kind: "visual", planKey }, actor);
  const msg: DcoVisualMessage = { kind: "dco-visual", runId, planKey, origin, requestedBy: actor };
  const unsent = await queueSlots(env, runId, [{ slot: { kind: "visual", planKey }, msg }]);
  if (unsent.length) {
    await failSlots(env, runId, unsent, QUEUE_FAILURE_TEXT, "queue");
    return "not_queued";
  }
  return "ok";
}

// Retry for a failed copy segment. Same order as requeueVisual: the slot and the job move first, then the send.
export async function requeueSegment(env: Env, runId: string, segmentKey: string, actor: string): Promise<RequeueResult> {
  const db = getDb(env);
  const [run] = await db.select().from(runs).where(eq(runs.id, runId));
  if (!run || run.product !== "dco") return "not_found";
  const [row] = await db
    .select()
    .from(dcoSegments)
    .where(and(eq(dcoSegments.runId, runId), eq(dcoSegments.segmentKey, segmentKey)));
  if (!row) return "not_found";
  if (row.status !== "failed") return "not_failed";
  if (!RETRY_STATES.includes(run.status)) return "run_not_in_draft";
  const flipped = await db
    .update(dcoSegments)
    .set({ status: "pending", error: null, updatedAt: Date.now() })
    .where(and(eq(dcoSegments.runId, runId), eq(dcoSegments.segmentKey, segmentKey), eq(dcoSegments.status, "failed")))
    .returning({ key: dcoSegments.segmentKey });
  if (flipped.length === 0) return "not_failed";
  await db
    .update(runs)
    .set({ status: "running", finishedAt: null })
    .where(and(eq(runs.id, runId), inArray(runs.status, ["draft", "failed"])));
  await recordEvent(db, runId, "retry", { kind: "segment", segmentKey }, actor);
  const msg: DcoCopyMessage = { kind: "dco-copy", runId, segmentKey, requestedBy: actor };
  const unsent = await queueSlots(env, runId, [{ slot: { kind: "copy", segmentKey }, msg }]);
  if (unsent.length) {
    await failSlots(env, runId, unsent, QUEUE_FAILURE_TEXT, "queue");
    return "not_queued";
  }
  return "ok";
}

// Called by the queue consumer once a DCO message has failed its last delivery. It moves the slot the message owned
// to failed with plain text and settles the job. Safe to call twice, and it never throws.
export async function onDcoMessageFailed(env: Env, msg: DcoCopyMessage | DcoVisualMessage | DcoVisualPollMessage, reason: string): Promise<void> {
  try {
    console.error(`dco ${msg.kind} gave up after its last delivery`, msg.runId, reason);
    if (msg.kind === "dco-copy") {
      await failSlots(env, msg.runId, [{ kind: "copy", segmentKey: msg.segmentKey }], COPY_RETRIES_TEXT, "delivery");
    } else {
      await failSlots(env, msg.runId, [{ kind: "visual", planKey: msg.planKey }], VISUAL_RETRIES_TEXT, "delivery");
    }
  } catch (e) {
    console.error("dco could not record a message that gave up", msg.kind, msg.runId, errorMessage(e));
  }
}

// Moves any slot left pending or generating for STUCK_MS to failed (retryable), then settles every job still queued
// or running, which catches a job whose final settle was lost. Idempotent: a second call moves nothing.
// Returns the number of slots moved.
export async function sweepStuckDco(env: Env, now: number): Promise<number> {
  const db = getDb(env);
  const cutoff = now - STUCK_MS;
  const copyNever = await db
    .update(dcoSegments)
    .set({ status: "failed", error: NEVER_STARTED_TEXT, updatedAt: now })
    .where(and(eq(dcoSegments.status, "pending"), lt(dcoSegments.updatedAt, cutoff)))
    .returning({ runId: dcoSegments.runId, segmentKey: dcoSegments.segmentKey });
  const copyLong = await db
    .update(dcoSegments)
    .set({ status: "failed", error: TOO_LONG_TEXT, updatedAt: now })
    .where(and(eq(dcoSegments.status, "generating"), lt(dcoSegments.updatedAt, cutoff)))
    .returning({ runId: dcoSegments.runId, segmentKey: dcoSegments.segmentKey });
  const visualNever = await db
    .update(dcoVisuals)
    .set({ status: "failed", error: NEVER_STARTED_TEXT, updatedAt: now })
    .where(and(eq(dcoVisuals.status, "pending"), lt(dcoVisuals.updatedAt, cutoff)))
    .returning({ runId: dcoVisuals.runId, planKey: dcoVisuals.planKey });
  const visualLong = await db
    .update(dcoVisuals)
    .set({ status: "failed", error: TOO_LONG_TEXT, updatedAt: now })
    .where(and(eq(dcoVisuals.status, "generating"), lt(dcoVisuals.updatedAt, cutoff)))
    .returning({ runId: dcoVisuals.runId, planKey: dcoVisuals.planKey });

  const event = (kind: DcoEventKind, runId: string, payload: Record<string, unknown>) => ({
    id: newId(),
    runId,
    kind,
    payload: { ...payload, stage: "failed", reason: "swept" },
    actor: "system",
    createdAt: now,
  });
  await insertChunked(db, dcoEvents, [
    ...copyNever.map((r) => event("copy", r.runId, { segmentKey: r.segmentKey })),
    ...copyLong.map((r) => event("copy", r.runId, { segmentKey: r.segmentKey })),
    ...visualNever.map((r) => event("visual", r.runId, { planKey: r.planKey })),
    ...visualLong.map((r) => event("visual", r.runId, { planKey: r.planKey })),
  ]);

  const jobs = await db
    .select({ id: runs.id })
    .from(runs)
    .where(and(eq(runs.product, "dco"), inArray(runs.status, ["queued", "running"])));
  for (const job of jobs) await settleRun(env, job.id);
  return copyNever.length + copyLong.length + visualNever.length + visualLong.length;
}

// Exported for the unit tests: the texts a signed-in user can see on a failed slot
export const USER_FAILURE_TEXTS: readonly string[] = [
  QUEUE_FAILURE_TEXT,
  NEVER_STARTED_TEXT,
  TOO_LONG_TEXT,
  COPY_RETRIES_TEXT,
  VISUAL_RETRIES_TEXT,
  SAFETY_TEXT,
];
