import { and, desc, eq, inArray, lt } from "drizzle-orm";
import { chunk, inputHash, newId } from "../../core/util";
import { getDb, insertChunked } from "../../core/db/client";
import { deadLetters, runLogs, runs } from "../../core/db/schema";
import { finishApifyRun, getActorRun, getDatasetItems, startActor } from "../../core/enrichment/apify";
import { errorMessage } from "../../core/env";
import { SAMPLE_TERM_NOTE, sampleSourcesOn, sampleTrendPosts } from "../../core/enrichment/sample";
import { callJson } from "../../core/llm";
import type { TrendBriefMessage, TrendPollMessage, TrendPullTimeoutMessage } from "../../core/messages";
import { buildTrendBrief, type BriefBuild, type TermRow } from "./brief";
import { applyThemeNarrative, buildThemePrompt, TREND_PROMPT_VERSION, themeNarrativeJsonSchema, themeNarrativeSchema } from "./contract";
import { dedupePosts, type TrendHit, type UniquePost } from "./dedupe";
import { actorNote, RUN_FAILURE_TEXT, type TermFailureCode } from "./failures";
import type { TrendTheme } from "./model";
import { parseItems, type ParsedPost } from "./parse";
import { trendBriefs, trendPullHits, trendPullTerms, trendPosts, trendPulls, trendWatchlist } from "./schema";
import { actorRequest, displayLabel, MAX_TERMS_PER_PULL, watchTokens } from "./terms";
import { searchYouTubeTrend, YT_TREND_NOTE } from "./youtube";

// ② Trend Monitoring pipeline: one Apify run per watched term and platform (FR-TM-1), polled from the queue,
// deduplicated by platform post ID, then one brief per pull (FR-TM-2 to FR-TM-4, BR-TM-1, BR-TM-2).
// Every step leaves its term, pull or run in a visible state. The two hooks at the end settle what the queue gives up
// on, and the sweep settles what the queue lost.

const DEDUPE_WINDOW_MS = 2 * 60_000; // BR-CORE-4: an identical request from the same person while it runs returns that run
const APIFY_POLL_LIMIT_MS = 5 * 60_000; // FR-CORE-13
const FIRST_POLL_S = 10;
const RETRY_POLL_S = 15;
const PULL_TIMEOUT_S = 8 * 60; // as the ③ refresh timeout
// The sweep's limits. A pull still running this long after it started has lost its timeout (the timeout is 8 minutes).
// A settled pull with no brief this long after its last term finished has lost its brief.
const STUCK_PULL_MS = 20 * 60_000;
const STUCK_BRIEF_MS = 5 * 60_000;
const ITEM_LIMIT = 200; // dataset items read per term; the term's cap is applied after parsing
const UPSERT_CHUNK = 20;
const ID_QUERY_CHUNK = 80; // D1 allows 100 bound parameters per statement

type PullTermRow = typeof trendPullTerms.$inferSelect;
type PullRow = typeof trendPulls.$inferSelect;
type RunRow = typeof runs.$inferSelect;

export class TrendInputError extends Error {}

export type PullStart = { runId: string; pullId: string; deduped: boolean; started: number; failedToStart: number; terms: number };

// What failing a term needs: its pull, and its own Apify run when one was started
type TermRef = { id: string; pullId: string; localRunId: string | null };

// A settled pull with the deduplicated posts a brief is built from
type BriefInput = { pull: PullRow; run: RunRow; terms: PullTermRow[]; posts: UniquePost[]; hitCount: number; duplicatesRemoved: number };

// A brief before it is saved: the deterministic build, the theme names (the model's, or the deterministic ones), and flags
type ComposedBrief = { built: BriefBuild; themes: TrendTheme[]; flags: string[]; model: string | null; llmFailure: string | null };

export async function startTrendPull(env: Env, requestedBy: string, termIds: string[] | null): Promise<PullStart> {
  const db = getDb(env);
  const active = await db.select().from(trendWatchlist).where(eq(trendWatchlist.active, true));
  const chosen = termIds ? active.filter((t) => termIds.includes(t.id)) : active;
  if (chosen.length === 0) throw new TrendInputError("no_active_terms");
  if (chosen.length > MAX_TERMS_PER_PULL) throw new TrendInputError("too_many_terms");
  const plan = chosen.flatMap((term) => term.platforms.map((platform) => ({ term, platform })));

  const hash = await inputHash({ product: "trends", plan: plan.map((p) => `${p.platform}:${p.term.kind}:${p.term.termKey}:${p.term.category}:${p.term.postCap}`).sort() });
  const [recent] = await db
    .select()
    .from(runs)
    .where(and(eq(runs.inputHash, hash), eq(runs.createdBy, requestedBy), inArray(runs.status, ["queued", "running"])))
    .orderBy(desc(runs.createdAt))
    .limit(1);
  if (recent && Date.now() - recent.createdAt < DEDUPE_WINDOW_MS) {
    const [pull] = await db.select().from(trendPulls).where(eq(trendPulls.runId, recent.id));
    return { runId: recent.id, pullId: pull?.id ?? "", deduped: true, started: 0, failedToStart: 0, terms: chosen.length };
  }

  const now = Date.now();
  const runId = newId();
  const pullId = newId();
  // While an admin has sample sources on, each Apify term gets invented posts instead of a run (core/enrichment/sample.ts).
  // YouTube terms are always live: the YouTube Data API is free, so it never needs a stand-in.
  const sample = await sampleSourcesOn(env);
  const sampleData = sample && plan.some((p) => p.platform !== "youtube");
  const rows = plan.map(({ term, platform }) => ({
    id: newId(),
    pullId,
    watchlistId: term.id,
    label: displayLabel(term.kind, term.term),
    term: term.term,
    kind: term.kind,
    category: term.category,
    platform,
    postCap: term.postCap,
    status: "running" as const,
    createdAt: now,
  }));
  // The run, its pull, the log and every term row land in one batch, before any actor starts, so no term is missing later
  const writes = [
    db.insert(runs).values({
      id: runId,
      product: "trends",
      status: "running",
      inputHash: hash,
      flags: { kind: "pull", terms: chosen.map((t) => displayLabel(t.kind, t.term)), platforms: [...new Set(plan.map((p) => p.platform))], ...(sampleData ? { sampleData: true } : {}) },
      createdBy: requestedBy,
      createdAt: now,
      startedAt: now,
    }),
    db.insert(trendPulls).values({ id: pullId, runId, status: "running", termIds: chosen.map((t) => t.id), requestedBy, startedAt: now }),
    db.insert(runLogs).values({
      id: newId(),
      runId,
      kind: "inputs",
      payload: { terms: rows.map((r) => ({ label: r.label, platform: r.platform, category: r.category, postCap: r.postCap })) },
      actor: requestedBy,
      createdAt: now,
    }),
    ...rows.map((row) => db.insert(trendPullTerms).values(row)),
  ];
  const [first, ...rest] = writes;
  await db.batch([first!, ...rest]);

  // The timeout is queued before any actor starts. Without it nothing would ever settle these terms, so none is started
  if (!(await queuePullTimeout(env, pullId))) {
    await db
      .update(trendPullTerms)
      .set({ status: "failed", error: "start_failed", finishedAt: Date.now() })
      .where(and(eq(trendPullTerms.pullId, pullId), eq(trendPullTerms.status, "running")));
    await settlePull(env, pullId);
    return { runId, pullId, deduped: false, started: 0, failedToStart: rows.length, terms: rows.length };
  }

  let started = 0;
  let failedToStart = 0;
  let apifyStarted = 0;
  for (const row of rows) {
    if (row.platform === "youtube") {
      if (await pullYouTubeTerm(env, row)) started++;
      else failedToStart++;
      continue;
    }
    if (sample) {
      const posts = sampleTrendPosts({ term: row.term, category: row.category }, row.platform, row.postCap, Date.now());
      await saveHits(env, row, posts);
      await db
        .update(trendPullTerms)
        .set({ status: "ok", itemCount: posts.length, postCount: posts.length, usageUsd: 0, note: SAMPLE_TERM_NOTE, error: null, finishedAt: Date.now() })
        .where(and(eq(trendPullTerms.id, row.id), eq(trendPullTerms.status, "running")));
      started++;
      continue;
    }
    const req = actorRequest(row.platform as Exclude<typeof row.platform, "youtube">, row.kind, row.term, row.postCap);
    let localRunId: string | null = null;
    try {
      const actorRun = await startActor(env, req.actor, req.input, "trends", req.summary);
      localRunId = actorRun.localRunId;
      await db.update(trendPullTerms).set({ localRunId, apifyRunId: actorRun.apifyRunId }).where(eq(trendPullTerms.id, row.id));
      await env.ENRICH_QUEUE.send(
        { kind: "trend-poll", pullId, pullTermId: row.id, platform: row.platform, localRunId, apifyRunId: actorRun.apifyRunId, startedAt: Date.now() } satisfies TrendPollMessage,
        { delaySeconds: FIRST_POLL_S },
      );
      started++;
      apifyStarted++;
    } catch (e) {
      failedToStart++;
      console.error("trend search did not start", req.summary, errorMessage(e));
      await guarded("trend term could not be marked failed", () => failTerm(env, { id: row.id, pullId, localRunId }, "start_failed", "START_FAILED", errorMessage(e)));
    }
  }
  // Only Apify terms settle later, from their polls; with none running, the pull settles now
  if (apifyStarted === 0) await settlePull(env, pullId);
  return { runId, pullId, deduped: false, started, failedToStart, terms: rows.length };
}

// One YouTube term, start to finish. True when its posts were saved; a failure is recorded on the term
async function pullYouTubeTerm(env: Env, row: Pick<PullTermRow, "id" | "pullId" | "platform" | "kind" | "term" | "postCap">): Promise<boolean> {
  const ref = { id: row.id, pullId: row.pullId, localRunId: null };
  try {
    const res = await searchYouTubeTrend(env, row.kind, row.term, row.postCap);
    if ("error" in res) {
      await guarded("trend term could not be marked failed", () => failTerm(env, ref, res.error, "FAILED", res.detail));
      return false;
    }
    await saveHits(env, row, res.posts);
    await getDb(env)
      .update(trendPullTerms)
      .set({ status: "ok", itemCount: res.posts.length, postCount: res.posts.length, usageUsd: 0, note: YT_TREND_NOTE, error: null, finishedAt: Date.now() })
      .where(and(eq(trendPullTerms.id, row.id), eq(trendPullTerms.status, "running")));
    return true;
  } catch (e) {
    await guarded("trend term could not be marked failed", () => failTerm(env, ref, "unexpected", "FAILED", errorMessage(e)));
    return false;
  }
}

async function queuePullTimeout(env: Env, pullId: string): Promise<boolean> {
  try {
    await env.ENRICH_QUEUE.send({ kind: "trend-pull-timeout", pullId } satisfies TrendPullTimeoutMessage, { delaySeconds: PULL_TIMEOUT_S });
    return true;
  } catch (e) {
    console.error("trend pull timeout could not be queued", errorMessage(e));
    return false;
  }
}

// A side step that must not stop its caller. Its failure is logged, and the sweep covers whatever it leaves open
async function guarded(label: string, step: () => Promise<unknown>): Promise<void> {
  try {
    await step();
  } catch (e) {
    console.error(label, errorMessage(e));
  }
}

// Exactly once: the single statement that moves the pull to "building" is the one that queues the brief. When the queue
// refuses the brief, the pull stays building, and the sweep writes its brief (sweepStuckTrends).
export async function settlePull(env: Env, pullId: string): Promise<void> {
  const open = await env.DB.prepare("SELECT COUNT(*) AS n FROM trend_pull_terms WHERE pull_id = ?1 AND status = 'running'").bind(pullId).first<{ n: number }>();
  if (!open || open.n > 0) return;
  const claimed = await env.DB.prepare("UPDATE trend_pulls SET status = 'building' WHERE id = ?1 AND status = 'running' RETURNING id")
    .bind(pullId)
    .first<{ id: string }>();
  if (!claimed) return;
  await guarded("trend brief could not be queued, so the sweep will write it", () =>
    env.ENRICH_QUEUE.send({ kind: "trend-brief", pullId } satisfies TrendBriefMessage),
  );
}

// Only a running term can fail, so a late answer never overwrites a result that already landed. The code is what the
// planner reads; the operator note (raw text) goes to the log and to the Apify run's error.
async function failTerm(env: Env, term: TermRef, code: TermFailureCode, apifyStatus: string, operatorNote: string): Promise<void> {
  const db = getDb(env);
  const failed = await db
    .update(trendPullTerms)
    .set({ status: "failed", error: code, finishedAt: Date.now() })
    .where(and(eq(trendPullTerms.id, term.id), eq(trendPullTerms.status, "running")))
    .returning({ id: trendPullTerms.id });
  if (failed.length) {
    console.error(`trend term ${term.id} failed (${code}): ${operatorNote}`);
    if (term.localRunId) await finishApifyRun(env, term.localRunId, apifyStatus, null, operatorNote);
  }
  await settlePull(env, term.pullId);
}

export async function handleTrendPoll(env: Env, msg: TrendPollMessage): Promise<void> {
  const db = getDb(env);
  const [term] = await db.select().from(trendPullTerms).where(eq(trendPullTerms.id, msg.pullTermId));
  if (!term) return;
  // A retry after the term's result has landed still settles its pull, in case the first attempt stopped there
  if (term.status !== "running") return settlePull(env, term.pullId);
  const withinWindow = Date.now() - msg.startedAt < APIFY_POLL_LIMIT_MS;
  let state;
  try {
    state = await getActorRun(env, msg.apifyRunId, 50);
  } catch (e) {
    if (withinWindow) return void (await env.ENRICH_QUEUE.send(msg, { delaySeconds: RETRY_POLL_S }));
    return failTerm(env, term, "poll_failed", "POLL_FAILED", errorMessage(e));
  }

  if (state.status === "SUCCEEDED" && state.datasetId) {
    const items = await getDatasetItems(env, state.datasetId, ITEM_LIMIT);
    await env.FILES.put(`raw/trends/${msg.apifyRunId}.json`, JSON.stringify(items), { httpMetadata: { contentType: "application/json" } });
    const parsed = parseItems(term.platform, items);
    const kept = uniqueByPlatformId(parsed.posts).slice(0, term.postCap);
    await saveHits(env, term, kept);
    await db
      .update(trendPullTerms)
      .set({
        status: "ok",
        itemCount: items.length,
        postCount: kept.length,
        usageUsd: state.usageUsd,
        note: actorNote(parsed.errorCodes),
        error: null,
        finishedAt: Date.now(),
      })
      .where(and(eq(trendPullTerms.id, term.id), eq(trendPullTerms.status, "running")));
    // The actor's own error codes stay with the operator; the term's note says the same thing in plain words
    const operatorNote = parsed.errorCodes.length ? `Actor error items: ${parsed.errorCodes.join(", ")}` : undefined;
    await finishApifyRun(env, msg.localRunId, "SUCCEEDED", items.length, operatorNote, state.usageUsd);
    return settlePull(env, term.pullId);
  }
  if (state.status === "SUCCEEDED") return failTerm(env, term, "no_dataset", "NO_DATASET", "Apify run finished without a dataset");
  if ((state.status === "READY" || state.status === "RUNNING") && withinWindow) {
    return void (await env.ENRICH_QUEUE.send(msg, { delaySeconds: RETRY_POLL_S }));
  }
  if (state.status === "READY" || state.status === "RUNNING") {
    return failTerm(env, term, "poll_timeout", "POLL_TIMEOUT", `Apify run was still ${state.status} at the poll limit`);
  }
  return failTerm(env, term, "run_ended", state.status, `Apify run ended as ${state.status}`);
}

// A pull that never answers is failed term by term, so the brief still ships with the sources that did answer
export async function handleTrendPullTimeout(env: Env, msg: TrendPullTimeoutMessage): Promise<void> {
  const open = await getDb(env)
    .select()
    .from(trendPullTerms)
    .where(and(eq(trendPullTerms.pullId, msg.pullId), eq(trendPullTerms.status, "running")));
  for (const term of open) await failTerm(env, term, "pull_timeout", "POLL_TIMEOUT", "Timed out waiting for Apify");
  await settlePull(env, msg.pullId);
}

function uniqueByPlatformId(posts: ParsedPost[]): ParsedPost[] {
  return [...new Map(posts.map((p) => [p.platformPostId, p])).values()];
}

// Posts are shared across pulls: upsert by platform post ID, then link each term's hits to the stored row
async function saveHits(env: Env, term: Pick<PullTermRow, "id" | "pullId" | "platform">, posts: ParsedPost[]): Promise<void> {
  if (!posts.length) return;
  const db = getDb(env);
  const now = Date.now();
  const upserts = posts.map((p) =>
    db
      .insert(trendPosts)
      .values({
        id: newId(),
        platform: p.platform,
        platformPostId: p.platformPostId,
        url: p.url,
        handle: p.handle,
        caption: p.caption,
        hashtags: p.hashtags,
        postedAt: p.postedAt,
        likes: p.likes,
        comments: p.comments,
        views: p.views,
        shares: p.shares,
        firstSeenAt: now,
        lastSeenAt: now,
      })
      .onConflictDoUpdate({
        target: [trendPosts.platform, trendPosts.platformPostId],
        set: {
          url: p.url,
          handle: p.handle,
          caption: p.caption,
          hashtags: p.hashtags,
          postedAt: p.postedAt,
          likes: p.likes,
          comments: p.comments,
          views: p.views,
          shares: p.shares,
          lastSeenAt: now,
        },
      }),
  );
  for (const part of chunk(upserts, UPSERT_CHUNK)) {
    const [first, ...rest] = part;
    await db.batch([first!, ...rest]);
  }

  // Read the IDs back, so two terms that found the same post at the same time still point at one row
  const idByKey = new Map<string, string>();
  for (const part of chunk(posts.map((p) => p.platformPostId), ID_QUERY_CHUNK)) {
    const rows = await db
      .select({ id: trendPosts.id, platformPostId: trendPosts.platformPostId })
      .from(trendPosts)
      .where(and(eq(trendPosts.platform, term.platform), inArray(trendPosts.platformPostId, part)));
    for (const r of rows) idByKey.set(r.platformPostId, r.id);
  }
  const hits = posts.flatMap((p) => {
    const postId = idByKey.get(p.platformPostId);
    return postId ? [{ pullTermId: term.id, pullId: term.pullId, postId, likes: p.likes, comments: p.comments, views: p.views, shares: p.shares }] : [];
  });
  await insertChunked(db, trendPullHits, hits);
}

// ---- Brief ----

// The settled pull and its run, with the hits deduplicated. Null when the pull is not waiting for a brief, so every writer
// can run again and change nothing (the brief row is keyed by run, and each status only moves from the state it expects).
async function loadBriefInput(env: Env, pullId: string): Promise<BriefInput | null> {
  const db = getDb(env);
  const [pull] = await db.select().from(trendPulls).where(eq(trendPulls.id, pullId));
  if (!pull || pull.status !== "building") return null;
  const [run] = await db.select().from(runs).where(eq(runs.id, pull.runId));
  if (!run) return null;

  const terms = await db.select().from(trendPullTerms).where(eq(trendPullTerms.pullId, pull.id));
  const termById = new Map(terms.map((t) => [t.id, t]));
  const hitRows = await db
    .select({ hit: trendPullHits, post: trendPosts })
    .from(trendPullHits)
    .innerJoin(trendPosts, eq(trendPullHits.postId, trendPosts.id))
    .where(eq(trendPullHits.pullId, pull.id));
  const hits: TrendHit[] = hitRows.flatMap(({ hit, post }) => {
    const term = termById.get(hit.pullTermId);
    if (!term) return [];
    const parsed: ParsedPost = {
      platform: post.platform,
      platformPostId: post.platformPostId,
      url: post.url,
      handle: post.handle,
      caption: post.caption,
      hashtags: post.hashtags,
      postedAt: post.postedAt,
      // The metrics this pull saw, not the latest ones stored for the post
      likes: hit.likes,
      comments: hit.comments,
      views: hit.views,
      shares: hit.shares,
    };
    return [{ pullTermId: term.id, label: term.label, category: term.category, postRowId: post.id, post: parsed }];
  });
  const { posts, duplicatesRemoved } = dedupePosts(hits);
  return { pull, run, terms, posts, hitCount: hits.length, duplicatesRemoved };
}

// The deterministic brief first (themes, numbers, sources); then the model names the themes when asked. A model that
// fails leaves the deterministic names in place and flags narrative_unavailable (FR-CORE-16).
async function composeBrief(env: Env, input: BriefInput, useModel: boolean): Promise<ComposedBrief> {
  const termRows: TermRow[] = input.terms.map((t) => ({
    id: t.id,
    label: t.label,
    category: t.category,
    platform: t.platform,
    status: t.status,
    postCount: t.postCount,
    note: t.note,
    error: t.error,
  }));
  const watched = [...new Set(input.terms.flatMap((t) => watchTokens(t.kind, t.term)))];
  const built = buildTrendBrief({ terms: termRows, posts: input.posts, hits: input.hitCount, duplicatesRemoved: input.duplicatesRemoved, watched });

  const flags = [...built.flags];
  let themes = built.themes;
  let model: string | null = null;
  let llmFailure: string | null = null;
  if (themes.length) {
    if (!useModel) {
      llmFailure = "not_attempted";
      flags.push("narrative_unavailable");
    } else {
      try {
        const prompt = buildThemePrompt({ terms: termRows, uniquePosts: input.posts.length, themes, posts: input.posts });
        const res = await callJson(env, {
          product: "trends",
          promptVersion: TREND_PROMPT_VERSION,
          system: prompt.system,
          user: prompt.user,
          schema: themeNarrativeSchema,
          jsonSchema: themeNarrativeJsonSchema(),
          runId: input.run.id,
          maxTokens: 3_000,
        });
        model = res.model;
        if (res.ok) {
          const applied = applyThemeNarrative(themes, res.data, prompt.figures);
          themes = applied.themes;
          flags.push(...applied.flags);
        } else {
          llmFailure = res.reason;
          flags.push("narrative_unavailable");
        }
      } catch (e) {
        // callJson is meant not to throw. If it ever does, the brief still ships with the deterministic names
        console.error("trend theme naming threw", errorMessage(e));
        llmFailure = "unexpected";
        flags.push("narrative_unavailable");
      }
    }
  }
  return { built, themes, flags, model, llmFailure };
}

// One batch writes the brief, moves the run to draft and closes the pull. The brief row conflicts are ignored, so a second
// writer adds nothing it has not already written.
async function saveBrief(env: Env, input: BriefInput, c: ComposedBrief): Promise<void> {
  const db = getDb(env);
  const now = Date.now();
  const { pull, run } = input;
  const log = c.model || c.llmFailure
    ? [
        db.insert(runLogs).values({
          id: newId(),
          runId: run.id,
          kind: "llm",
          payload: { model: c.model, failure: c.llmFailure, promptVersion: TREND_PROMPT_VERSION, themes: c.themes.length },
          actor: "system",
          createdAt: now,
        }),
      ]
    : [];
  const writes = [
    db
      .insert(trendBriefs)
      .values({
        runId: run.id,
        pullId: pull.id,
        sample: c.built.sample,
        themes: c.themes,
        exemplars: c.built.exemplars,
        sources: c.built.sources,
        flags: c.flags,
        promptVersion: TREND_PROMPT_VERSION,
        createdAt: now,
      })
      .onConflictDoNothing(),
    db
      .update(runs)
      // Real pulls are real public posts, not sample data; a pull from the sample source keeps its label
      .set({ status: "draft", finishedAt: now, flags: { ...(run.flags as Record<string, unknown>), llmFailure: c.llmFailure, sampleData: (run.flags as { sampleData?: unknown } | null)?.sampleData === true } })
      .where(and(eq(runs.id, run.id), eq(runs.status, "running"))),
    db.update(trendPulls).set({ status: "done", finishedAt: now }).where(and(eq(trendPulls.id, pull.id), eq(trendPulls.status, "building"))),
    ...log,
  ];
  const [first, ...rest] = writes;
  await db.batch([first!, ...rest]);
}

// A run that cannot be finished ends with a plain reason, and its pull closes so nothing re-drives it. The pull closes
// first: if the run update then fails, the sweep finds a run with no live pull and ends it there.
async function failRun(env: Env, runId: string, reason: string): Promise<boolean> {
  const db = getDb(env);
  const now = Date.now();
  await db
    .update(trendPulls)
    .set({ status: "done", finishedAt: now })
    .where(and(eq(trendPulls.runId, runId), inArray(trendPulls.status, ["running", "building"])));
  const changed = await db
    .update(runs)
    .set({ status: "failed", error: reason, finishedAt: now })
    .where(and(eq(runs.id, runId), inArray(runs.status, ["queued", "running"])))
    .returning({ id: runs.id });
  if (changed.length === 0) return false;
  await db.insert(deadLetters).values({ id: newId(), kind: "run", runId, reason, detail: {}, createdAt: now });
  return true;
}

// Writes a settled pull's brief and closes the pull, or ends the run when the brief cannot be built. False when the pull
// was not waiting for a brief. Database errors are thrown, so the queue retries them.
async function settleBrief(env: Env, pullId: string, useModel: boolean): Promise<boolean> {
  const input = await loadBriefInput(env, pullId);
  if (!input) return false;
  let composed: ComposedBrief;
  try {
    composed = await composeBrief(env, input, useModel);
  } catch (e) {
    // The deterministic build itself failed. Running it again gives the same failure, so the run ends with a plain reason
    console.error("trend brief could not be built", pullId, errorMessage(e));
    await failRun(env, input.run.id, RUN_FAILURE_TEXT.brief);
    return true;
  }
  await saveBrief(env, input, composed);
  return true;
}

// The brief that ships when the model path could not finish: deterministic, flagged narrative_unavailable. If even that
// cannot be written, the run ends with a plain reason. Never throws.
async function briefFallback(env: Env, pullId: string): Promise<boolean> {
  try {
    return await settleBrief(env, pullId, false);
  } catch (e) {
    console.error("trend brief could not be written without the model", pullId, errorMessage(e));
  }
  try {
    const [pull] = await getDb(env).select().from(trendPulls).where(eq(trendPulls.id, pullId));
    if (!pull || pull.status !== "building") return false;
    return await failRun(env, pull.runId, RUN_FAILURE_TEXT.brief);
  } catch (e) {
    console.error("trend run could not be ended", pullId, errorMessage(e));
    return false;
  }
}

// The sweep's way to write a brief in place: with the model, then without it, then as a failed run. Never throws.
async function driveBrief(env: Env, pullId: string): Promise<boolean> {
  try {
    return await settleBrief(env, pullId, true);
  } catch (e) {
    console.error("trend brief with the model could not be written, retrying without it", pullId, errorMessage(e));
    return briefFallback(env, pullId);
  }
}

// Brief for a settled pull (FR-CORE-16). A failed model call ships the deterministic brief flagged narrative_unavailable,
// and a brief that cannot be built ends its run with a plain reason. Database errors are thrown, so the queue retries them.
export async function handleTrendBrief(env: Env, msg: TrendBriefMessage): Promise<void> {
  await settleBrief(env, msg.pullId, true);
}

// Called once a queue message has used its last delivery. It moves what the message owned to a visible end state: a failed
// term, a timed-out pull, or a brief without the model. It never throws; the sweep covers whatever it cannot reach.
export async function onTrendMessageFailed(env: Env, msg: TrendPollMessage | TrendPullTimeoutMessage | TrendBriefMessage, reason: string): Promise<void> {
  console.error(`trend message ${msg.kind} failed for good`, reason);
  try {
    if (msg.kind === "trend-poll") {
      const [term] = await getDb(env).select().from(trendPullTerms).where(eq(trendPullTerms.id, msg.pullTermId));
      if (!term) return;
      if (term.status === "running") await failTerm(env, term, "unexpected", "POLL_FAILED", reason);
      else await settlePull(env, term.pullId);
    } else if (msg.kind === "trend-pull-timeout") {
      await handleTrendPullTimeout(env, msg);
    } else {
      await briefFallback(env, msg.pullId);
    }
  } catch (e) {
    console.error(`trend message ${msg.kind} could not be settled`, errorMessage(e));
  }
}

// The backstop the cron and the admin route both run. It fails the open terms of pulls that lost their timeout and writes
// their briefs, writes briefs that never came, and ends runs with no live pull. It returns how many items it moved. Each
// item it touches leaves the state it was found in, so a second call moves nothing unless an item failed the first time.
export async function sweepStuckTrends(env: Env, now: number): Promise<number> {
  const db = getDb(env);
  let moved = 0;

  const late = await db
    .select({ id: trendPulls.id })
    .from(trendPulls)
    .where(and(eq(trendPulls.status, "running"), lt(trendPulls.startedAt, now - STUCK_PULL_MS)));
  for (const { id } of late) {
    try {
      await handleTrendPullTimeout(env, { kind: "trend-pull-timeout", pullId: id });
      moved++;
    } catch (e) {
      console.error("sweep could not time out a trend pull", id, errorMessage(e));
      continue;
    }
    // Written here rather than left to the queue, so the pull is closed by the time this sweep returns
    await driveBrief(env, id);
  }

  // Settled pulls whose brief never came. The age is the last term's finish time, which is when the pull settled.
  const { results: waiting } = await env.DB.prepare(
    `SELECT p.id AS id FROM trend_pulls p
     WHERE p.status = 'building'
       AND NOT EXISTS (SELECT 1 FROM trend_briefs b WHERE b.pull_id = p.id)
       AND COALESCE((SELECT MAX(t.finished_at) FROM trend_pull_terms t WHERE t.pull_id = p.id), p.started_at) < ?1`,
  )
    .bind(now - STUCK_BRIEF_MS)
    .all<{ id: string }>();
  for (const { id } of waiting) if (await driveBrief(env, id)) moved++;

  // Runs still queued or running with no live pull: nothing is left that could finish them
  const { results: orphans } = await env.DB.prepare(
    `SELECT r.id AS id FROM runs r
     WHERE r.product = 'trends' AND r.status IN ('queued', 'running')
       AND NOT EXISTS (SELECT 1 FROM trend_pulls p WHERE p.run_id = r.id AND p.status IN ('running', 'building'))`,
  ).all<{ id: string }>();
  for (const { id } of orphans) {
    try {
      if (await failRun(env, id, RUN_FAILURE_TEXT.stopped)) moved++;
    } catch (e) {
      console.error("sweep could not end a trend run", id, errorMessage(e));
    }
  }
  return moved;
}
