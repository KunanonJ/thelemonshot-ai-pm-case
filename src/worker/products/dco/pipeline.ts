import { and, count, desc, eq, inArray, sql } from "drizzle-orm";
import { getDb, insertChunked, type Db } from "../../core/db/client";
import { briefs, runs } from "../../core/db/schema";
import { errorMessage } from "../../core/env";
import { allowedFigures } from "../../core/figures";
import { callJson } from "../../core/llm";
import type { DcoCopyMessage, DcoVisualMessage, DcoVisualPollMessage } from "../../core/messages";
import { inputHash, newId } from "../../core/util";
import { assertAllowed } from "./allowlist";
import { mintInputLink, sha256Hex, type AssetType } from "./assets";
import { briefTexts, dcoBriefSchema, type DcoBrief } from "./brief";
import { buildCopyPrompt, copyJsonSchema, copyOutputSchema, DCO_COPY_PROMPT_VERSION, guardCopyOption, type CopyOption } from "./copy";
import { downloadFalImage, FalError, readFalResult, readFalStatus, submitToFal, type FalFailure } from "./fal";
import { DCO_EVENT_KINDS, dcoAssets, dcoCopy, dcoEvents, dcoSegments, dcoVisuals, type DcoProvenance } from "./schema";
import { DCO_VISUAL_PROMPT_VERSION, falInput, isSafetyErrorType, isSafetyFlagged, outputImages, outputSeed, planFor, VISUAL_PLAN } from "./visuals";

const DEDUPE_WINDOW_MS = 2 * 60_000;
// A status read every 5 seconds, for at most 10 minutes per visual
export const POLL_SECONDS = 5;
export const MAX_POLLS = 120;

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

// Retry is allowed until the review is over: a job that is queued, running, a draft or failed can take it
const RETRY_STATES: readonly string[] = ["queued", "running", "draft", "failed"];

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

export const segmentKeyAt = (index: number) => `s${index + 1}`;

type DcoEventKind = (typeof DCO_EVENT_KINDS)[number];

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
    .where(and(eq(dcoVisuals.runId, runId), inArray(dcoVisuals.status, ["pending", "generating"])));
  const [openSegments] = await db
    .select({ n: count() })
    .from(dcoSegments)
    .where(and(eq(dcoSegments.runId, runId), inArray(dcoSegments.status, ["pending", "generating"])));
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

  await db.batch([
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
  ]);
  await insertChunked(db, dcoSegments, segments);
  await insertChunked(db, dcoVisuals, visuals);

  for (const seg of segments) {
    const msg: DcoCopyMessage = { kind: "dco-copy", runId, segmentKey: seg.segmentKey, requestedBy: userId };
    await env.ENRICH_QUEUE.send(msg);
  }
  for (const v of visuals) {
    const msg: DcoVisualMessage = { kind: "dco-visual", runId, planKey: v.planKey, origin, requestedBy: userId };
    await env.ENRICH_QUEUE.send(msg);
  }
  return { runId, deduped: false };
}

// FR-DC-3: one call per segment, each with its own failure. A failed segment keeps the others.
export async function handleDcoCopy(env: Env, msg: DcoCopyMessage): Promise<void> {
  const db = getDb(env);
  const [run] = await db.select().from(runs).where(eq(runs.id, msg.runId));
  if (!run || run.product !== "dco" || !run.briefId) return;
  const claimed = await db
    .update(dcoSegments)
    .set({ status: "generating", error: null, updatedAt: Date.now() })
    .where(and(eq(dcoSegments.runId, run.id), eq(dcoSegments.segmentKey, msg.segmentKey), eq(dcoSegments.status, "pending")))
    .returning();
  const segment = claimed[0];
  if (!segment) return;
  await markRunning(db, run.id);

  const [briefRow] = await db.select().from(briefs).where(eq(briefs.id, run.briefId));
  const brief = dcoBriefSchema.parse(briefRow!.fields);
  const count = brief.copyPerSegment;
  const prompt = buildCopyPrompt(brief, { name: segment.name, note: segment.note }, count);
  const res = await callJson(env, {
    product: "dco",
    promptVersion: DCO_COPY_PROMPT_VERSION,
    system: prompt.system,
    user: prompt.user,
    schema: copyOutputSchema,
    jsonSchema: copyJsonSchema(),
    runId: run.id,
    maxTokens: 600 + 450 * count,
  });

  if (!res.ok) {
    await db
      .update(dcoSegments)
      .set({ status: "failed", error: COPY_FAILURE[res.reason] ?? COPY_FAILURE.unexpected!, updatedAt: Date.now() })
      .where(and(eq(dcoSegments.runId, run.id), eq(dcoSegments.segmentKey, msg.segmentKey)));
    await recordEvent(db, run.id, "copy", { segmentKey: msg.segmentKey, stage: "failed", reason: res.reason, model: res.model }, "system");
    await settleRun(env, run.id);
    return;
  }

  // FR-DC-3 / HR-3: the figure and placeholder guards run after schema validation and before anything is stored
  const allowed = allowedFigures([], briefTexts(brief));
  const options: CopyOption[] = res.data.options.slice(0, count);
  const rows = options.map((option, i) => {
    const guarded = guardCopyOption(option, allowed, brief.prohibitedClaims);
    const flags = [...guarded.flags, ...(options.length < count ? [`fewer_options:${options.length}`] : [])];
    return {
      id: newId(),
      runId: run.id,
      segmentKey: msg.segmentKey,
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
      createdAt: Date.now(),
    };
  });
  await insertChunked(db, dcoCopy, rows);
  await db
    .update(dcoSegments)
    .set({ status: "ready", error: null, updatedAt: Date.now() })
    .where(and(eq(dcoSegments.runId, run.id), eq(dcoSegments.segmentKey, msg.segmentKey)));
  await recordEvent(db, run.id, "copy", { segmentKey: msg.segmentKey, stage: "ready", options: rows.length, model: res.model }, "system");
  await settleRun(env, run.id);
}

async function failVisual(db: Db, runId: string, planKey: string, modelId: string, error: string): Promise<void> {
  await db
    .update(dcoVisuals)
    .set({ status: "failed", error, updatedAt: Date.now() })
    .where(and(eq(dcoVisuals.runId, runId), eq(dcoVisuals.planKey, planKey)));
  await recordEvent(db, runId, "visual", { planKey, modelId, stage: "failed", error }, "system");
}

// BR-DC-2: the result is dropped before it is downloaded or stored. Only the count and the request id remain.
async function discardForSafety(env: Env, db: Db, runId: string, row: { planKey: string; modelId: string; falRequestId: string | null }): Promise<void> {
  await db
    .update(dcoVisuals)
    .set({ status: "failed", error: SAFETY_TEXT, updatedAt: Date.now() })
    .where(and(eq(dcoVisuals.runId, runId), eq(dcoVisuals.planKey, row.planKey)));
  await recordEvent(db, runId, "safety", { planKey: row.planKey, modelId: row.modelId, falRequestId: row.falRequestId, stage: "discarded" }, "system");
  await settleRun(env, runId);
}

// FR-DC-2: submits one allowlisted request for a visual slot and queues the polls. The base asset is reached
// through a short-lived link minted here (FR-DC-1); nothing else leaves the Worker.
export async function handleDcoVisual(env: Env, msg: DcoVisualMessage): Promise<void> {
  const db = getDb(env);
  const plan = planFor(msg.planKey);
  const [run] = await db.select().from(runs).where(eq(runs.id, msg.runId));
  if (!plan || !run || run.product !== "dco") return;
  const claimed = await db
    .update(dcoVisuals)
    .set({ status: "generating", error: null, attempts: sql`${dcoVisuals.attempts} + 1`, updatedAt: Date.now() })
    .where(and(eq(dcoVisuals.runId, run.id), eq(dcoVisuals.planKey, plan.key), eq(dcoVisuals.status, "pending")))
    .returning();
  if (!claimed[0]) return;
  await markRunning(db, run.id);

  try {
    assertAllowed(plan.modelId);
    const [asset] = await db.select().from(dcoAssets).where(eq(dcoAssets.runId, run.id));
    if (!asset) throw new Error("base asset missing");
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
    console.error("dco visual submit failed", plan.key, errorMessage(e));
    await failVisual(db, run.id, plan.key, plan.modelId, e instanceof FalError ? VISUAL_FAILURE[e.reason] : VISUAL_FAILURE.unexpected);
    await settleRun(env, run.id);
  }
}

// Reads the provider's status until the request completes, then stores the image if the safety filter passed it
export async function handleDcoVisualPoll(env: Env, msg: DcoVisualPollMessage): Promise<void> {
  const db = getDb(env);
  const [row] = await db
    .select()
    .from(dcoVisuals)
    .where(and(eq(dcoVisuals.runId, msg.runId), eq(dcoVisuals.planKey, msg.planKey)));
  if (!row || row.status !== "generating" || !row.statusUrl || !row.responseUrl || !row.falRequestId) return;
  const [run] = await db.select().from(runs).where(eq(runs.id, msg.runId));
  if (!run) return;
  const plan = planFor(row.planKey);

  const again = async (): Promise<void> => {
    if (msg.polls + 1 >= MAX_POLLS) {
      await failVisual(db, run.id, row.planKey, row.modelId, "The image service took too long to answer");
      await settleRun(env, run.id);
      return;
    }
    const next: DcoVisualPollMessage = { ...msg, polls: msg.polls + 1 };
    await env.ENRICH_QUEUE.send(next, { delaySeconds: POLL_SECONDS });
  };

  let status: Awaited<ReturnType<typeof readFalStatus>>;
  try {
    status = await readFalStatus(env, row.statusUrl);
  } catch (e) {
    console.error("dco visual status failed", row.planKey, errorMessage(e));
    return again();
  }
  if (status.status !== "COMPLETED") return again();

  if (status.error) {
    if (isSafetyErrorType(status.errorType)) return discardForSafety(env, db, run.id, row);
    console.error("dco visual provider error", row.planKey, status.errorType ?? "unknown");
    await failVisual(db, run.id, row.planKey, row.modelId, VISUAL_FAILURE.provider_error);
    await settleRun(env, run.id);
    return;
  }

  let output: unknown;
  try {
    output = await readFalResult(env, row.responseUrl);
  } catch (e) {
    console.error("dco visual result failed", row.planKey, errorMessage(e));
    await failVisual(db, run.id, row.planKey, row.modelId, VISUAL_FAILURE.result_failed);
    await settleRun(env, run.id);
    return;
  }
  if (isSafetyFlagged(output)) return discardForSafety(env, db, run.id, row);

  const image = outputImages(output)[0];
  if (!image || !plan) {
    await failVisual(db, run.id, row.planKey, row.modelId, "The image service returned no image");
    await settleRun(env, run.id);
    return;
  }
  let file: Awaited<ReturnType<typeof downloadFalImage>>;
  try {
    file = await downloadFalImage(image.url);
  } catch (e) {
    console.error("dco visual download failed", row.planKey, errorMessage(e));
    await failVisual(db, run.id, row.planKey, row.modelId, e instanceof FalError ? VISUAL_FAILURE[e.reason] : VISUAL_FAILURE.unexpected);
    await settleRun(env, run.id);
    return;
  }

  const [asset] = await db.select().from(dcoAssets).where(eq(dcoAssets.runId, run.id));
  const completedAt = Date.now();
  const provenance: DcoProvenance = {
    jobId: run.id,
    planKey: plan.key,
    modelId: plan.modelId,
    format: plan.format,
    prompt: plan.prompt,
    negativePrompt: plan.negativePrompt,
    seed: outputSeed(output),
    falRequestId: row.falRequestId,
    inputSha256: asset?.sha256 ?? "",
    outputSha256: await sha256Hex(file.bytes),
    outputBytes: file.bytes.byteLength,
    contentType: file.type.contentType,
    promptVersion: DCO_VISUAL_PROMPT_VERSION,
    submittedAt: row.submittedAt ?? completedAt,
    completedAt,
  };
  const r2Key = `dco/${run.id}/visuals/${plan.key}.${file.type.ext}`;
  await env.FILES.put(r2Key, file.bytes, { httpMetadata: { contentType: file.type.contentType } });
  // FR-DC-4: the provenance sits beside the image as well as in the row
  await env.FILES.put(`dco/${run.id}/visuals/${plan.key}.provenance.json`, JSON.stringify(provenance, null, 2), {
    httpMetadata: { contentType: "application/json" },
  });
  await db
    .update(dcoVisuals)
    .set({ status: "ready", error: null, r2Key, contentType: file.type.contentType, bytes: file.bytes.byteLength, provenance, updatedAt: completedAt })
    .where(and(eq(dcoVisuals.runId, run.id), eq(dcoVisuals.planKey, plan.key)));
  await recordEvent(db, run.id, "visual", { planKey: plan.key, modelId: plan.modelId, falRequestId: row.falRequestId, stage: "ready" }, "system");
  await settleRun(env, run.id);
}

export type RequeueResult = "ok" | "not_found" | "not_failed" | "run_not_in_draft";

// Retry for a failed visual slot. Allowed while the job is a draft, or failed with nothing to review.
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
  await db
    .update(dcoVisuals)
    .set({ status: "pending", error: null, updatedAt: Date.now() })
    .where(and(eq(dcoVisuals.runId, runId), eq(dcoVisuals.planKey, planKey), eq(dcoVisuals.status, "failed")));
  await db
    .update(runs)
    .set({ status: "running", finishedAt: null })
    .where(and(eq(runs.id, runId), inArray(runs.status, ["draft", "failed"])));
  await recordEvent(db, runId, "retry", { kind: "visual", planKey }, actor);
  const msg: DcoVisualMessage = { kind: "dco-visual", runId, planKey, origin, requestedBy: actor };
  await env.ENRICH_QUEUE.send(msg);
  return "ok";
}

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
  await db
    .update(dcoSegments)
    .set({ status: "pending", error: null, updatedAt: Date.now() })
    .where(and(eq(dcoSegments.runId, runId), eq(dcoSegments.segmentKey, segmentKey), eq(dcoSegments.status, "failed")));
  await db
    .update(runs)
    .set({ status: "running", finishedAt: null })
    .where(and(eq(runs.id, runId), inArray(runs.status, ["draft", "failed"])));
  await recordEvent(db, runId, "retry", { kind: "segment", segmentKey }, actor);
  const msg: DcoCopyMessage = { kind: "dco-copy", runId, segmentKey, requestedBy: actor };
  await env.ENRICH_QUEUE.send(msg);
  return "ok";
}
