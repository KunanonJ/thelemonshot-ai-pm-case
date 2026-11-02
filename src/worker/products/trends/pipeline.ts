import { and, desc, eq, inArray } from "drizzle-orm";
import { chunk, inputHash, newId } from "../../core/util";
import { getDb, insertChunked } from "../../core/db/client";
import { runLogs, runs } from "../../core/db/schema";
import { finishApifyRun, getActorRun, getDatasetItems, startActor } from "../../core/enrichment/apify";
import { errorMessage } from "../../core/env";
import { callJson } from "../../core/llm";
import type { TrendBriefMessage, TrendPollMessage, TrendPullTimeoutMessage } from "../../core/messages";
import { buildTrendBrief, type TermRow } from "./brief";
import { applyThemeNarrative, buildThemePrompt, TREND_PROMPT_VERSION, themeNarrativeJsonSchema, themeNarrativeSchema } from "./contract";
import { dedupePosts, type TrendHit } from "./dedupe";
import { parseItems, type ParsedPost } from "./parse";
import { trendBriefs, trendPullHits, trendPullTerms, trendPosts, trendPulls, trendWatchlist } from "./schema";
import { actorRequest, displayLabel, MAX_TERMS_PER_PULL, watchTokens } from "./terms";

// ② Trend Monitoring pipeline: one Apify run per watched term and platform (FR-TM-1), polled from the queue,
// deduplicated by platform post ID, then one brief per pull (FR-TM-2 to FR-TM-4, BR-TM-1, BR-TM-2).

const DEDUPE_WINDOW_MS = 2 * 60_000; // BR-CORE-4: an identical request from the same person while it runs returns that run
const APIFY_POLL_LIMIT_MS = 5 * 60_000; // FR-CORE-13
const FIRST_POLL_S = 10;
const RETRY_POLL_S = 15;
const PULL_TIMEOUT_S = 8 * 60; // as the ③ refresh timeout
const ITEM_LIMIT = 200; // dataset items read per term; the term's cap is applied after parsing
const UPSERT_CHUNK = 20;
const ID_QUERY_CHUNK = 80; // D1 allows 100 bound parameters per statement

type PullTermRow = typeof trendPullTerms.$inferSelect;

export class TrendInputError extends Error {}

export type PullStart = { runId: string; pullId: string; deduped: boolean; started: number; failedToStart: number; terms: number };

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
  await db.batch([
    db.insert(runs).values({
      id: runId,
      product: "trends",
      status: "running",
      inputHash: hash,
      flags: { kind: "pull", terms: chosen.map((t) => displayLabel(t.kind, t.term)), platforms: [...new Set(plan.map((p) => p.platform))] },
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
  ]);
  await insertChunked(db, trendPullTerms, rows);

  let started = 0;
  let failedToStart = 0;
  for (const row of rows) {
    const req = actorRequest(row.platform, row.kind, row.term, row.postCap);
    try {
      const { localRunId, apifyRunId } = await startActor(env, req.actor, req.input, "trends", req.summary);
      await db.update(trendPullTerms).set({ localRunId, apifyRunId }).where(eq(trendPullTerms.id, row.id));
      await env.ENRICH_QUEUE.send(
        { kind: "trend-poll", pullId, pullTermId: row.id, platform: row.platform, localRunId, apifyRunId, startedAt: Date.now() } satisfies TrendPollMessage,
        { delaySeconds: FIRST_POLL_S },
      );
      started++;
    } catch (e) {
      failedToStart++;
      await db
        .update(trendPullTerms)
        .set({ status: "failed", error: errorMessage(e).slice(0, 300), finishedAt: Date.now() })
        .where(and(eq(trendPullTerms.id, row.id), eq(trendPullTerms.status, "running")));
    }
  }
  await env.ENRICH_QUEUE.send({ kind: "trend-pull-timeout", pullId } satisfies TrendPullTimeoutMessage, { delaySeconds: PULL_TIMEOUT_S });
  if (started === 0) await settlePull(env, pullId);
  return { runId, pullId, deduped: false, started, failedToStart, terms: rows.length };
}

// Exactly once: the single statement that moves the pull to "building" is the one that queues the brief
export async function settlePull(env: Env, pullId: string): Promise<void> {
  const open = await env.DB.prepare("SELECT COUNT(*) AS n FROM trend_pull_terms WHERE pull_id = ?1 AND status = 'running'").bind(pullId).first<{ n: number }>();
  if (!open || open.n > 0) return;
  const claimed = await env.DB.prepare("UPDATE trend_pulls SET status = 'building' WHERE id = ?1 AND status = 'running' RETURNING id")
    .bind(pullId)
    .first<{ id: string }>();
  if (claimed) await env.ENRICH_QUEUE.send({ kind: "trend-brief", pullId } satisfies TrendBriefMessage);
}

async function failTerm(env: Env, term: PullTermRow, error: string, apifyStatus: string): Promise<void> {
  const db = getDb(env);
  // Only a running term can fail, so a late answer never overwrites a result that already landed
  await db
    .update(trendPullTerms)
    .set({ status: "failed", error: error.slice(0, 300), finishedAt: Date.now() })
    .where(and(eq(trendPullTerms.id, term.id), eq(trendPullTerms.status, "running")));
  if (term.localRunId) await finishApifyRun(env, term.localRunId, apifyStatus, null, error);
  await settlePull(env, term.pullId);
}

export async function handleTrendPoll(env: Env, msg: TrendPollMessage): Promise<void> {
  const db = getDb(env);
  const [term] = await db.select().from(trendPullTerms).where(eq(trendPullTerms.id, msg.pullTermId));
  if (!term || term.status !== "running") return;
  const withinWindow = Date.now() - msg.startedAt < APIFY_POLL_LIMIT_MS;
  let state;
  try {
    state = await getActorRun(env, msg.apifyRunId, 50);
  } catch (e) {
    if (withinWindow) return void (await env.ENRICH_QUEUE.send(msg, { delaySeconds: RETRY_POLL_S }));
    return failTerm(env, term, errorMessage(e), "POLL_FAILED");
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
        note: parsed.errorCodes.length ? `Apify returned ${parsed.errorCodes.join(", ")}` : null,
        error: null,
        finishedAt: Date.now(),
      })
      .where(and(eq(trendPullTerms.id, term.id), eq(trendPullTerms.status, "running")));
    await finishApifyRun(env, msg.localRunId, "SUCCEEDED", items.length, undefined, state.usageUsd);
    return settlePull(env, term.pullId);
  }
  if (state.status === "SUCCEEDED") return failTerm(env, term, "Apify run finished without a dataset", "NO_DATASET");
  if ((state.status === "READY" || state.status === "RUNNING") && withinWindow) {
    return void (await env.ENRICH_QUEUE.send(msg, { delaySeconds: RETRY_POLL_S }));
  }
  return failTerm(env, term, `Apify run ended as ${state.status}`, state.status === "RUNNING" ? "POLL_TIMEOUT" : state.status);
}

// A pull that never answers is failed term by term, so the brief still ships with the sources that did answer
export async function handleTrendPullTimeout(env: Env, msg: TrendPullTimeoutMessage): Promise<void> {
  const open = await getDb(env)
    .select()
    .from(trendPullTerms)
    .where(and(eq(trendPullTerms.pullId, msg.pullId), eq(trendPullTerms.status, "running")));
  for (const term of open) await failTerm(env, term, "Timed out waiting for Apify", "POLL_TIMEOUT");
  await settlePull(env, msg.pullId);
}

function uniqueByPlatformId(posts: ParsedPost[]): ParsedPost[] {
  return [...new Map(posts.map((p) => [p.platformPostId, p])).values()];
}

// Posts are shared across pulls: upsert by platform post ID, then link each term's hits to the stored row
async function saveHits(env: Env, term: PullTermRow, posts: ParsedPost[]): Promise<void> {
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

// Brief for a settled pull: dedupe, cluster, measure, then let the model name the themes (FR-CORE-16 fallback)
export async function handleTrendBrief(env: Env, msg: TrendBriefMessage): Promise<void> {
  const db = getDb(env);
  const [pull] = await db.select().from(trendPulls).where(eq(trendPulls.id, msg.pullId));
  if (!pull || pull.status !== "building") return;
  const [run] = await db.select().from(runs).where(eq(runs.id, pull.runId));
  if (!run) return;

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
  const watched = [...new Set(terms.flatMap((t) => watchTokens(t.kind, t.term)))];
  const termRows: TermRow[] = terms.map((t) => ({
    id: t.id,
    label: t.label,
    category: t.category,
    platform: t.platform,
    status: t.status,
    postCount: t.postCount,
    note: t.note,
    error: t.error,
  }));
  const built = buildTrendBrief({ terms: termRows, posts, hits: hits.length, duplicatesRemoved, watched });

  const flags = [...built.flags];
  let themes = built.themes;
  let model: string | null = null;
  let llmFailure: string | null = null;
  if (themes.length) {
    const prompt = buildThemePrompt({ terms: termRows, uniquePosts: posts.length, themes, posts });
    const res = await callJson(env, {
      product: "trends",
      promptVersion: TREND_PROMPT_VERSION,
      system: prompt.system,
      user: prompt.user,
      schema: themeNarrativeSchema,
      jsonSchema: themeNarrativeJsonSchema(),
      runId: run.id,
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
  }

  const now = Date.now();
  await db.batch([
    db.insert(trendBriefs).values({
      runId: run.id,
      pullId: pull.id,
      sample: built.sample,
      themes,
      exemplars: built.exemplars,
      sources: built.sources,
      flags,
      promptVersion: TREND_PROMPT_VERSION,
      createdAt: now,
    }),
    db
      .update(runs)
      .set({ status: "draft", finishedAt: now, flags: { ...(run.flags as Record<string, unknown>), llmFailure, sampleData: false } })
      .where(eq(runs.id, run.id)),
    db.update(trendPulls).set({ status: "done", finishedAt: now }).where(eq(trendPulls.id, pull.id)),
  ]);
  if (model || llmFailure) {
    await db.insert(runLogs).values({
      id: newId(),
      runId: run.id,
      kind: "llm",
      payload: { model, failure: llmFailure, promptVersion: TREND_PROMPT_VERSION, themes: themes.length },
      actor: "system",
      createdAt: now,
    });
  }
}
