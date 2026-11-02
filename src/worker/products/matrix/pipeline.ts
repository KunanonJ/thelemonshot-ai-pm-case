import { and, desc, eq, inArray, lt, or } from "drizzle-orm";
import { getDb, insertChunked, type Db } from "../../core/db/client";
import { briefs, contentItems, creators, deadLetters, runItems, runLogs, runs, statSnapshots, type Platform } from "../../core/db/schema";
import { errorMessage } from "../../core/env";
import { callJson } from "../../core/llm";
import { QueueUnavailable, type MatrixRunMessage } from "../../core/messages";
import { chunk, inputHash, newId, normaliseHandle } from "../../core/util";
import { findConflicts, matrixBriefSchema, normaliseRef, type MatrixBrief } from "./brief";
import { buildPrompt, llmJsonSchema, llmOutputSchema, PROMPT_VERSION, splitForContext, toLlmCandidate, validateScores } from "./contract";
import { computeFeatures, type CandidateInput, type SnapshotInput } from "./features";
import { rankCandidates, type Dims } from "./scoring";
import { RULES, SCORING_VERSION } from "./weights";

const DEDUPE_WINDOW_MS = 2 * 60_000;
const ID_CHUNK = 90;
// A delivery that claimed a run and then died is taken over after this, or at once by the message's next delivery
const CLAIM_LEASE_MS = 10 * 60_000;

// BR-CORE-3: what every role sees on a failed run. The raw error goes to the log and the operator-only dead letter.
export const RUN_FAILURE_TEXT = {
  unexpected: "Scoring stopped because of an unexpected error. Start a new run with the same brief.",
  not_queued: "The run couldn't be queued. Start it again.",
  stalled: "The run stopped before it finished. Start a new run with the same brief.",
} as const;
type RunFailure = keyof typeof RUN_FAILURE_TEXT;
// If the model leaves out more than this share of candidates, the whole run goes deterministic (BR-MX-2)
const MAX_MISSING_SHARE = 0.1;

type CreatorRow = typeof creators.$inferSelect;
type RunRow = typeof runs.$inferSelect;

// BR-CORE-4: an identical submission from the same person within two minutes returns the run already
// in flight; anything later is a new run, never an overwrite
export async function createMatrixRun(env: Env, brief: MatrixBrief, userId: string): Promise<{ runId: string; deduped: boolean }> {
  const db = getDb(env);
  const hash = await inputHash({ product: "matrix", brief });
  const [recent] = await db
    .select()
    .from(runs)
    .where(and(eq(runs.inputHash, hash), eq(runs.createdBy, userId), inArray(runs.status, ["queued", "running"])))
    .orderBy(desc(runs.createdAt))
    .limit(1);
  if (recent && Date.now() - recent.createdAt < DEDUPE_WINDOW_MS) return { runId: recent.id, deduped: true };

  const now = Date.now();
  const briefId = newId();
  const runId = newId();
  const conflicts = findConflicts(brief);
  await db.batch([
    db.insert(briefs).values({ id: briefId, product: "matrix", fields: brief, inputHash: hash, createdBy: userId, createdAt: now }),
    db.insert(runs).values({ id: runId, product: "matrix", briefId, status: "queued", inputHash: hash, flags: { conflicts }, createdBy: userId, createdAt: now }),
    db.insert(runLogs).values({
      id: newId(),
      runId,
      kind: "inputs",
      payload: { brief, conflicts, scoringVersion: SCORING_VERSION, promptVersion: PROMPT_VERSION },
      actor: userId,
      createdAt: now,
    }),
  ]);
  try {
    await env.ENRICH_QUEUE.send({ kind: "matrix-run", runId } satisfies MatrixRunMessage);
  } catch (e) {
    // Nothing would ever score it, so the run fails now instead of showing "Queued" forever (and isn't deduped onto)
    await failRun(db, runId, "not_queued", errorMessage(e));
    throw new QueueUnavailable(e);
  }
  return { runId, deduped: false };
}

// One delivery at a time scores a run. A claim is a single guarded UPDATE, so two deliveries can't both pass it.
// A running run is taken over by the next delivery of its message (the earlier one threw or died) or once the
// lease has passed; the takeover starts clean.
export async function executeMatrixRun(env: Env, runId: string, delivery = 1): Promise<void> {
  const db = getDb(env);
  const now = Date.now();
  const claimed = await env.DB.prepare(
    `UPDATE runs SET status = 'running', started_at = ?2
     WHERE id = ?1 AND product = 'matrix'
       AND (status = 'queued' OR (status = 'running' AND (?3 > 1 OR started_at < ?4)))
     RETURNING id`,
  )
    .bind(runId, now, delivery, now - CLAIM_LEASE_MS)
    .first<{ id: string }>();
  if (!claimed) return; // finished, failed, or being scored by another delivery
  const [run] = await db.select().from(runs).where(eq(runs.id, runId));
  if (!run) return;
  try {
    // Rows a dead delivery left behind; a fresh run has none
    await db.batch([db.delete(runItems).where(eq(runItems.runId, runId)), db.delete(deadLetters).where(and(eq(deadLetters.runId, runId), eq(deadLetters.kind, "run")))]);
    const [briefRow] = await db.select().from(briefs).where(eq(briefs.id, run.briefId!));
    await scoreRun(env, db, run, matrixBriefSchema.parse(briefRow!.fields));
  } catch (e) {
    console.error("matrix run failed", { runId, delivery, error: errorMessage(e), stack: e instanceof Error ? e.stack : undefined });
    // If this write fails too, the message is retried and the next delivery takes the run over
    await failRun(db, runId, "unexpected", errorMessage(e));
  }
}

// Only a run still queued or running is failed; the dead letter keeps the raw error for the operator
async function failRun(db: Db, runId: string, code: RunFailure, detail: string): Promise<void> {
  const now = Date.now();
  const [run] = await db.select({ status: runs.status, flags: runs.flags }).from(runs).where(eq(runs.id, runId));
  if (!run || (run.status !== "queued" && run.status !== "running")) return;
  await db.batch([
    db
      .update(runs)
      .set({ status: "failed", error: RUN_FAILURE_TEXT[code], flags: { ...run.flags, failure: code }, finishedAt: now })
      .where(and(eq(runs.id, runId), inArray(runs.status, ["queued", "running"]))),
    db.insert(deadLetters).values({ id: newId(), kind: "run", runId, reason: "Run failed", detail: { code, error: detail.slice(0, 300) }, createdAt: now }),
  ]);
}

// The queue's last delivery of a matrix-run message failed (queue.ts)
export async function failMatrixRun(env: Env, runId: string): Promise<void> {
  await failRun(getDb(env), runId, "unexpected", "The message failed on every delivery");
}

// §7.7: a run whose message never arrived, or whose deliveries all died, fails visibly (sweeper.ts)
export async function sweepStuckMatrixRuns(env: Env, cutoff: number): Promise<number> {
  const db = getDb(env);
  const stuck = await db
    .select({ id: runs.id })
    .from(runs)
    .where(and(eq(runs.product, "matrix"), or(and(eq(runs.status, "queued"), lt(runs.createdAt, cutoff)), and(eq(runs.status, "running"), lt(runs.startedAt, cutoff)))));
  for (const r of stuck) await failRun(db, r.id, "stalled", "Swept: no delivery finished the run");
  return stuck.length;
}

async function scoreRun(env: Env, db: Db, run: RunRow, brief: MatrixBrief): Promise<void> {
  const now = Date.now();
  const excludeRefs = new Set(brief.mustExclude.map(normaliseRef));
  // Must-exclude wins over must-include (FR-MX-1)
  const includeRefs = new Set(brief.mustInclude.map(normaliseRef).filter((r) => !excludeRefs.has(r)));
  const matches = (c: CreatorRow, refs: Set<string>) =>
    refs.has(c.id) || [c.instagram, c.tiktok, c.youtube].some((h) => h && refs.has(normaliseHandle(h)));

  // FR-MX-3: active creators tagged with the category and holding a handle on a requested platform,
  // freshest data first. Platform names are schema-validated enum values, so they're safe to inline.
  const platformClause = brief.platforms.map((p) => `c.${p} IS NOT NULL`).join(" OR ");
  const { results: poolRows } = await env.DB.prepare(
    `SELECT c.id FROM creators c
     WHERE c.active = 1
       AND EXISTS (SELECT 1 FROM json_each(c.categories) WHERE json_each.value = ?1)
       AND (${platformClause})
     ORDER BY (SELECT MAX(s.fetched_at) FROM stat_snapshots s WHERE s.creator_id = c.id) DESC NULLS LAST, c.id`,
  )
    .bind(brief.productCategory)
    .all<{ id: string }>();

  const refs = [...includeRefs, ...excludeRefs];
  const referenced = refs.length
    ? await db
        .select()
        .from(creators)
        .where(or(inArray(creators.id, refs), inArray(creators.instagram, refs), inArray(creators.tiktok, refs), inArray(creators.youtube, refs)))
    : [];
  const includeIds = referenced.filter((c) => matches(c, includeRefs) && !matches(c, excludeRefs)).map((c) => c.id);
  const excluded = new Set(referenced.filter((c) => matches(c, excludeRefs)).map((c) => c.id));
  const ordered = [...new Set([...includeIds, ...poolRows.map((r) => r.id)])].filter((id) => !excluded.has(id));
  const candidateIds = ordered.slice(0, Math.max(RULES.candidateCap, includeIds.length));
  const thinPool = candidateIds.length < RULES.thinPool;

  const creatorRows = await selectIn(db, candidateIds, (part) => db.select().from(creators).where(inArray(creators.id, part)));
  const creatorById = new Map(creatorRows.map((c) => [c.id, c]));

  // Latest snapshot per platform, and a few recent captions, for each candidate
  const snapshots = await selectIn(db, candidateIds, (part) =>
    db.select().from(statSnapshots).where(inArray(statSnapshots.creatorId, part)).orderBy(desc(statSnapshots.fetchedAt)),
  );
  const latest = new Map<string, SnapshotInput[]>();
  const seen = new Set<string>();
  for (const s of snapshots) {
    const key = `${s.creatorId}:${s.platform}`;
    if (seen.has(key)) continue;
    seen.add(key);
    latest.set(s.creatorId, [
      ...(latest.get(s.creatorId) ?? []),
      { platform: s.platform, followers: s.followers, engagementRate: s.engagementRate, medianViews: s.medianViews, topHashtags: s.topHashtags, fetchedAt: s.fetchedAt },
    ]);
  }
  const captionRows = await selectIn(db, candidateIds, (part) =>
    db
      .select({ creatorId: contentItems.creatorId, platform: contentItems.platform, caption: contentItems.caption })
      .from(contentItems)
      .where(and(inArray(contentItems.creatorId, part), inArray(contentItems.platform, brief.platforms)))
      .orderBy(desc(contentItems.postedAt)),
  );
  const captions = new Map<string, string[]>();
  for (const r of captionRows) if (r.caption) captions.set(r.creatorId, [...(captions.get(r.creatorId) ?? []), r.caption]);

  const inputs: CandidateInput[] = candidateIds.flatMap((id) => {
    const c = creatorById.get(id);
    return c ? [{ creatorId: id, categories: c.categories, historyScore: c.historyScore, snapshots: latest.get(id) ?? [] }] : [];
  });
  const features = computeFeatures(inputs, brief, now);
  const usable = features.filter((f) => f.usable);

  // One call for all candidates (BR-MX-1), split in two only if the payload is too large
  const llmCandidates = usable.map((f) => {
    const c = creatorById.get(f.creatorId)!;
    return toLlmCandidate(f, { displayName: c.displayName, categories: c.categories, handles: { instagram: c.instagram, tiktok: c.tiktok, youtube: c.youtube } }, captions.get(f.creatorId) ?? []);
  });
  const parts = llmCandidates.length ? splitForContext(llmCandidates) : [];
  let dims: Map<string, Dims> | null = new Map();
  const rationales = new Map<string, string>();
  const llmFlags = new Map<string, string[]>();
  let llmFailure: string | null = llmCandidates.length ? null : "no_candidates";
  let model: string | null = null;
  for (const part of parts) {
    const { system, user } = buildPrompt(brief, part);
    const res = await callJson(env, {
      product: "matrix",
      promptVersion: PROMPT_VERSION,
      system,
      user,
      schema: llmOutputSchema,
      jsonSchema: llmJsonSchema,
      runId: run.id,
      maxTokens: 12_000,
    });
    model = res.model;
    if (!res.ok) {
      llmFailure = res.reason;
      break;
    }
    const v = validateScores(part.map((c) => c.id), res.data.scores);
    if (v.missing.length > Math.floor(part.length * MAX_MISSING_SHARE)) {
      llmFailure = "incomplete_output";
      break;
    }
    v.dims.forEach((d, id) => dims!.set(id, d));
    v.rationales.forEach((r, id) => rationales.set(id, r));
    v.flags.forEach((f, id) => llmFlags.set(id, f));
  }
  // BR-MX-2: any LLM failure means deterministic scores for the whole run, every row flagged; the run still ships
  if (llmFailure) {
    dims = null;
    rationales.clear();
    llmFlags.clear();
  }

  const scored = rankCandidates({ features, dims, llmFlags, objective: brief.objective, mustInclude: new Set(includeIds) });
  const featuresById = new Map(features.map((f) => [f.creatorId, f]));
  await insertChunked(
    db,
    runItems,
    scored.map((r) => {
      const f = featuresById.get(r.creatorId)!;
      return {
        id: newId(),
        runId: run.id,
        creatorId: r.creatorId,
        rank: r.rank,
        composite: r.composite,
        components: r.components,
        dims: r.dims,
        features: f as unknown as Record<string, unknown>,
        rationale: rationales.get(r.creatorId) ?? null,
        flags: r.flags,
        completeness: f.completeness,
        stalenessDays: f.stalenessDays,
        recommended: r.recommended,
        finalPick: r.recommended,
        replacesCreatorId: null,
        excludedReason: r.excludedReason,
      };
    }),
  );

  // FR-MX-8: creators with no usable data are listed with the reason, never silently dropped
  const noData = scored.filter((r) => r.excludedReason === "no_data");
  await insertChunked(
    db,
    deadLetters,
    noData.map((r) => ({
      id: newId(),
      kind: "run" as const,
      creatorId: r.creatorId,
      runId: run.id,
      reason: "No usable data on the requested platforms",
      detail: { platforms: brief.platforms },
      createdAt: Date.now(),
    })),
  );

  const flags = {
    ...(run.flags ?? {}),
    poolSize: poolRows.length,
    candidates: candidateIds.length,
    thinPool,
    excludedByBrief: excluded.size,
    safetyExcluded: scored.filter((r) => r.excludedReason === "safety_excluded").length,
    noData: noData.length,
    shortlisted: scored.filter((r) => r.recommended).length,
    llmUnavailable: llmFailure !== null,
    llmFailure,
    split: parts.length > 1,
    sampleData: creatorRows.some((c) => c.isSample),
  };
  await db.batch([
    db.insert(runLogs).values({ id: newId(), runId: run.id, kind: "candidates", payload: { candidateIds, excluded: [...excluded], includeIds, thinPool }, actor: "system", createdAt: Date.now() }),
    db.insert(runLogs).values({ id: newId(), runId: run.id, kind: "llm", payload: { model, parts: parts.length, failure: llmFailure, promptVersion: PROMPT_VERSION }, actor: "system", createdAt: Date.now() }),
    db.insert(runLogs).values({
      id: newId(),
      runId: run.id,
      kind: "scores",
      payload: { scoringVersion: SCORING_VERSION, recommended: scored.filter((r) => r.recommended).map((r) => ({ creatorId: r.creatorId, rank: r.rank, composite: r.composite })) },
      actor: "system",
      createdAt: Date.now(),
    }),
    db.update(runs).set({ status: "draft", flags, finishedAt: Date.now() }).where(eq(runs.id, run.id)),
  ]);
}

async function selectIn<T>(_db: Db, ids: string[], query: (part: string[]) => Promise<T[]>): Promise<T[]> {
  const out: T[] = [];
  for (const part of chunk(ids, ID_CHUNK)) if (part.length) out.push(...(await query(part)));
  return out;
}
