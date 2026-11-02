import { and, desc, eq, inArray, max } from "drizzle-orm";
import { getDb, type Db } from "../../core/db/client";
import { briefs, creators, PROPOSAL_ORIGINS, proposalSections, proposalVersions, runLogs, runs, type ProposalCitation } from "../../core/db/schema";
import { errorMessage } from "../../core/env";
import { callJson } from "../../core/llm";
import { QueueUnavailable, type ProposalSectionMessage } from "../../core/messages";
import { chunk, inputHash, newId } from "../../core/util";
import { matrixBriefSchema } from "../matrix/brief";
import { createMatrixRun } from "../matrix/pipeline";
import { proposalBriefSchema, type ProposalBrief } from "./brief";
import { buildSectionPrompt, outputJsonSchema, outputSchema, PROMPT_VERSION, toContent, toLlmCreator } from "./contract";
import { ATTACHABLE_STATUSES, loadShortlist, type Shortlist } from "./evidence";
import { addRemovedCreators, allowedFigures, guardModelOutput, makeCreatorGuard, type GuardContext } from "./guard";
import { BUDGET_BOUNDS, CONTENT_SCHEMAS, generationOrder, skeleton, TEMPLATE_DEFAULT_FIGURES, TEMPLATES, type SectionKey, type TemplateDef, type TemplateId } from "./templates";

const DEDUPE_WINDOW_MS = 2 * 60_000;
// An embedded Matrix run normally finishes in a couple of minutes; the creator section waits for it
const SHORTLIST_WAIT_MS = 15 * 60_000;
const SHORTLIST_POLL_S = 30;
export const MAX_ALTERNATIVES = 3;

export type ProposalFlags = {
  template: TemplateId;
  language: string;
  shortlist: { matrixRunId: string; mode: "existing" | "new" | "attached" } | null;
  sampleData?: boolean;
};

type RunRow = typeof runs.$inferSelect;
type SectionRow = typeof proposalSections.$inferSelect;
type VersionRow = typeof proposalVersions.$inferSelect;
type Origin = (typeof PROPOSAL_ORIGINS)[number];
export type NewVersion = { origin: Origin; content: Record<string, unknown>; citations: ProposalCitation[]; flags: string[]; note: string | null };

// Plain words for the planner; upstream errors stay in llm_calls (BR-CORE-3)
const FAILURE_TEXT: Record<string, string> = {
  not_configured: "The model isn't configured yet",
  forced_failure: "Model failure is switched on for testing",
  http_error: "The model service returned an error",
  invalid_json: "The model's answer wasn't valid JSON",
  schema_mismatch: "The model's answer didn't match the section format",
  timeout: "The model took too long to answer",
  network: "The model service couldn't be reached",
  incomplete_output: "The model's answer was empty",
  shortlist_pending: "The attached shortlist is still scoring",
  shortlist_unavailable: "The attached shortlist has no picks to cite",
  unexpected: "Something went wrong while drafting this section",
  stalled: "Drafting stopped before this section finished",
  not_queued: "Drafting couldn't be started. Start the proposal again",
};

export class ProposalInputError extends Error {}

export const proposalFlags = (run: RunRow) => run.flags as unknown as ProposalFlags;

// BR-CORE-4: an identical submission from the same person while the first is still drafting returns that run
export async function createProposalRun(env: Env, brief: ProposalBrief, userId: string): Promise<{ runId: string; deduped: boolean }> {
  const db = getDb(env);
  const hash = await inputHash({ product: "proposal", brief });
  const [recent] = await db
    .select()
    .from(runs)
    .where(and(eq(runs.inputHash, hash), eq(runs.createdBy, userId), inArray(runs.status, ["queued", "running"])))
    .orderBy(desc(runs.createdAt))
    .limit(1);
  if (recent && Date.now() - recent.createdAt < DEDUPE_WINDOW_MS) return { runId: recent.id, deduped: true };

  let shortlist: ProposalFlags["shortlist"] = null;
  if (brief.shortlist.mode === "existing") {
    const [m] = await db.select().from(runs).where(eq(runs.id, brief.shortlist.matrixRunId));
    if (!m || m.product !== "matrix" || !(ATTACHABLE_STATUSES as readonly string[]).includes(m.status)) throw new ProposalInputError("shortlist_not_attachable");
    shortlist = { matrixRunId: m.id, mode: "existing" };
  } else if (brief.shortlist.mode === "new") {
    // Workflow step 2: a fresh Matrix run from the same brief; its picks fill the creator section
    const matrixBrief = matrixBriefSchema.parse({
      brand: brief.brand,
      productCategory: brief.shortlist.productCategory,
      objective: brief.objective,
      audience: brief.audience,
      budgetBand: brief.budgetBand,
      platforms: brief.shortlist.platforms,
      timeline: brief.timeline,
    });
    shortlist = { matrixRunId: (await createMatrixRun(env, matrixBrief, userId)).runId, mode: "new" };
  }

  const template = TEMPLATES[brief.template];
  const now = Date.now();
  const briefId = newId();
  const runId = newId();
  const flags: ProposalFlags = { template: template.id, language: brief.language, shortlist };
  await db.batch([
    db.insert(briefs).values({ id: briefId, product: "proposal", fields: brief, inputHash: hash, createdBy: userId, createdAt: now }),
    db.insert(runs).values({ id: runId, product: "proposal", briefId, status: "queued", inputHash: hash, flags, createdBy: userId, createdAt: now }),
    db.insert(proposalSections).values(template.sections.map((s, i) => ({ id: newId(), runId, sectionKey: s.key, position: i, status: "pending" as const, updatedAt: now }))),
    db.insert(runLogs).values({ id: newId(), runId, kind: "inputs", payload: { brief, template: template.id, shortlist, promptVersion: PROMPT_VERSION }, actor: userId, createdAt: now }),
  ]);
  try {
    await env.ENRICH_QUEUE.send(sectionMessage(runId, generationOrder(template)[0]!, "initial", userId));
  } catch (e) {
    // The chain never started: the run fails now, with its sections settled, instead of drafting forever
    const at = Date.now();
    await db.batch([
      db.update(runs).set({ status: "failed", error: FAILURE_TEXT.not_queued, finishedAt: at }).where(eq(runs.id, runId)),
      db.update(proposalSections).set({ status: "failed", error: FAILURE_TEXT.not_queued, updatedAt: at }).where(eq(proposalSections.runId, runId)),
    ]);
    throw new QueueUnavailable(e);
  }
  return { runId, deduped: false };
}

export function sectionMessage(
  runId: string,
  sectionKey: SectionKey,
  mode: ProposalSectionMessage["mode"],
  requestedBy: string,
  extra: Partial<Pick<ProposalSectionMessage, "alternatives" | "instruction">> = {},
): ProposalSectionMessage {
  return { kind: "proposal-section", runId, sectionKey, mode, alternatives: 1, requestedBy, ...extra };
}

export async function handleProposalSection(env: Env, msg: ProposalSectionMessage): Promise<void> {
  const db = getDb(env);
  const [run] = await db.select().from(runs).where(eq(runs.id, msg.runId));
  if (!run || run.product !== "proposal") return;
  const [section] = await db
    .select()
    .from(proposalSections)
    .where(and(eq(proposalSections.runId, run.id), eq(proposalSections.sectionKey, msg.sectionKey)));
  if (!section) return;

  if (msg.mode === "initial") {
    // A redelivered message for a finished section only moves the chain on
    if (run.status !== "queued" && run.status !== "running") return;
    if (run.status === "queued") await db.update(runs).set({ status: "running", startedAt: Date.now() }).where(eq(runs.id, run.id));
    if (section.status === "pending" || section.status === "generating") {
      try {
        if ((await generateSection(env, db, run, section, msg)) === "waiting") return;
      } catch (e) {
        // BR-CP-2: one section's failure never stalls the rest; it shows a retry instead
        console.error("proposal section failed", errorMessage(e));
        await recordFailure(db, run, section, msg, "unexpected");
      }
    }
    await advance(env, db, run, msg.sectionKey as SectionKey);
    return;
  }

  // Regeneration (FR-CP-4) only runs on a draft, for a section the API marked as generating
  if (run.status !== "draft" || section.status !== "generating") return;
  try {
    await generateSection(env, db, run, section, msg);
  } catch (e) {
    console.error("proposal regeneration failed", errorMessage(e));
    await recordFailure(db, run, section, msg, "unexpected");
  }
}

type Context = {
  brief: ProposalBrief;
  template: TemplateDef;
  flags: ProposalFlags;
  shortlist: Shortlist | null;
  current: Map<SectionKey, VersionRow>;
};

async function loadContext(db: Db, run: RunRow): Promise<Context> {
  const [briefRow] = await db.select().from(briefs).where(eq(briefs.id, run.briefId!));
  const brief = proposalBriefSchema.parse(briefRow!.fields);
  const flags = proposalFlags(run);
  const shortlist = flags.shortlist ? await loadShortlist(db, flags.shortlist.matrixRunId) : null;
  const sectionRows = await db.select().from(proposalSections).where(eq(proposalSections.runId, run.id));
  const ids = sectionRows.flatMap((s) => (s.currentVersionId ? [s.currentVersionId] : []));
  const versions = ids.length ? await db.select().from(proposalVersions).where(inArray(proposalVersions.id, ids)) : [];
  return { brief, template: TEMPLATES[brief.template], flags, shortlist, current: new Map(versions.map((v) => [v.sectionKey as SectionKey, v])) };
}

async function generateSection(env: Env, db: Db, run: RunRow, section: SectionRow, msg: ProposalSectionMessage): Promise<"done" | "waiting"> {
  const ctx = await loadContext(db, run);
  const key = section.sectionKey as SectionKey;
  const def = ctx.template.sections.find((s) => s.key === key)!;
  const sl = ctx.shortlist;

  if (key === "creator_strategy") {
    // BR-CP-1: without a shortlist the section says so and names nobody; it never invents one
    if (!ctx.flags.shortlist) {
      await saveVersions(db, run.id, key, [{ origin: "empty", content: skeleton(key, ctx.brief, null), citations: [], flags: ["no_shortlist"], note: null }], {
        status: "ready",
        actor: msg.requestedBy,
        promptVersion: null,
      });
      return "done";
    }
    const scoring = sl?.run.status === "queued" || sl?.run.status === "running";
    if (scoring && (msg.waitedMs ?? 0) < SHORTLIST_WAIT_MS) {
      await db.update(proposalSections).set({ status: "generating", updatedAt: Date.now() }).where(eq(proposalSections.id, section.id));
      await env.ENRICH_QUEUE.send({ ...msg, waitedMs: (msg.waitedMs ?? 0) + SHORTLIST_POLL_S * 1000 }, { delaySeconds: SHORTLIST_POLL_S });
      return "waiting";
    }
    if (!sl || scoring || sl.picks.length === 0) {
      await recordFailure(db, run, section, msg, scoring ? "shortlist_pending" : "shortlist_unavailable", ctx);
      return "done";
    }
  }

  await db.update(proposalSections).set({ status: "generating", error: null, updatedAt: Date.now() }).where(eq(proposalSections.id, section.id));
  const alternatives = Math.min(Math.max(Math.round(msg.alternatives), 1), MAX_ALTERNATIVES);
  const picks = key === "creator_strategy" ? (sl?.picks ?? []) : [];
  const drafted = ctx.template.sections
    .filter((s) => s.key !== key && s.key !== "creator_strategy")
    .flatMap((s) => {
      const v = ctx.current.get(s.key);
      return v && v.origin !== "template" ? [{ section: s.title, content: v.content }] : [];
    });
  const current = ctx.current.get(key);
  const prompt = buildSectionPrompt({
    template: ctx.template,
    section: def,
    brief: ctx.brief,
    drafted,
    shortlist: key === "creator_strategy" ? picks.map(toLlmCreator) : null,
    current: msg.mode === "regenerate" && current && current.origin !== "template" ? current.content : null,
    instruction: msg.instruction ?? null,
    alternatives,
  });
  const res = await callJson(env, {
    product: "proposal",
    promptVersion: PROMPT_VERSION,
    system: prompt.system,
    user: prompt.user,
    schema: outputSchema(key),
    jsonSchema: outputJsonSchema(key),
    runId: run.id,
    maxTokens: 1_500 + 2_500 * alternatives,
  });

  let failure: string | null = res.ok ? null : res.reason;
  const versions: NewVersion[] = [];
  if (res.ok) {
    const guard = await guardContext(db, ctx, key, picks, [prompt.user]);
    const shortlistIds = key === "creator_strategy" ? new Set(picks.map((p) => p.creatorId)) : null;
    const alts = res.data.alternatives.slice(0, alternatives);
    alts.forEach((alt, i) => {
      const guarded = guardModelOutput(alt, guard);
      const { content, dropped } = toContent(key, guarded.value, { brief: ctx.brief, shortlistIds });
      if (!CONTENT_SCHEMAS[key].safeParse(content).success) return;
      versions.push({
        origin: msg.mode === "initial" ? "generated" : "regenerated",
        content,
        citations: key === "creator_strategy" ? cite(content, sl!) : [],
        flags: addRemovedCreators(guarded.flags, dropped),
        note: alts.length > 1 ? `Alternative ${i + 1} of ${alts.length}` : msg.instruction ? `Steer: ${msg.instruction}` : null,
      });
    });
    if (versions.length === 0) failure = "incomplete_output";
  }
  await db.insert(runLogs).values({
    id: newId(),
    runId: run.id,
    kind: "llm",
    payload: { section: key, mode: msg.mode, alternatives, produced: versions.length, failure, model: res.model, promptVersion: PROMPT_VERSION },
    actor: "system",
    createdAt: Date.now(),
  });

  if (failure) {
    await recordFailure(db, run, section, msg, failure, ctx);
    return "done";
  }
  await saveVersions(db, run.id, key, versions, { status: "ready", actor: msg.requestedBy, promptVersion: PROMPT_VERSION });
  return "done";
}

// FR-CP-2: every creator a version mentions points at the Matrix run item behind it
export function cite(content: unknown, shortlist: Shortlist): ProposalCitation[] {
  const list = (content as { creators?: { creatorId: string }[] }).creators ?? [];
  return list.flatMap((c) => {
    const pick = shortlist.picks.find((p) => p.creatorId === c.creatorId) ?? [...shortlist.byItemId.values()].find((e) => e.creatorId === c.creatorId);
    return pick ? [{ creatorId: c.creatorId, runItemId: pick.runItemId, matrixRunId: pick.matrixRunId }] : [];
  });
}

async function guardContext(db: Db, ctx: Context, key: SectionKey, picks: Shortlist["picks"], inputTexts: string[]): Promise<GuardContext> {
  const roster = await db.select({ id: creators.id, displayName: creators.displayName, instagram: creators.instagram, tiktok: creators.tiktok, youtube: creators.youtube }).from(creators);
  // Creators are named only in the creator section, and only the shortlisted ones
  const allowedIds = new Set(key === "creator_strategy" ? picks.map((p) => p.creatorId) : []);
  const people = (rows: typeof roster) => ({
    names: rows.map((r) => r.displayName),
    handles: rows.flatMap((r) => [r.instagram, r.tiktok, r.youtube].filter((h): h is string => Boolean(h))),
  });
  return {
    figures: allowedFigures(
      [
        ...TEMPLATE_DEFAULT_FIGURES,
        ...(ctx.brief.budgetBand ? BUDGET_BOUNDS[ctx.brief.budgetBand] : []),
        ...picks.flatMap((p) => [p.composite, ...p.platforms.flatMap((x) => [x.followers, x.engagementRate, x.medianViews])]),
      ],
      // Figures already in the prompt (the brief, approved sections, the shortlist rationale) may be repeated
      inputTexts,
    ),
    creators: makeCreatorGuard(
      people(roster.filter((r) => allowedIds.has(r.id))),
      people(roster.filter((r) => !allowedIds.has(r.id))),
      [ctx.brief.brand, ctx.brief.product],
    ),
    mustAvoid: ctx.brief.mustAvoid,
  };
}

// The queue's last delivery of a section message failed (queue.ts). The section settles the way a model failure
// would, and the first-draft chain moves on, so one bad section never holds up the rest (BR-CP-2).
export async function onProposalMessageFailed(env: Env, msg: ProposalSectionMessage): Promise<void> {
  const db = getDb(env);
  const [run] = await db.select().from(runs).where(eq(runs.id, msg.runId));
  if (!run || run.product !== "proposal") return;
  const [section] = await db
    .select()
    .from(proposalSections)
    .where(and(eq(proposalSections.runId, run.id), eq(proposalSections.sectionKey, msg.sectionKey)));
  if (!section) return;
  if (section.status === "pending" || section.status === "generating") await recordFailure(db, run, section, msg, "unexpected");
  if (msg.mode === "initial" && (run.status === "queued" || run.status === "running")) await advance(env, db, run, msg.sectionKey as SectionKey);
}

// BR-CP-2: a first draft that fails keeps the template draft (flagged, with a retry); a failed
// regeneration leaves the current version in place and says so
async function recordFailure(db: Db, run: RunRow, section: SectionRow, msg: ProposalSectionMessage, reason: string, known?: Context): Promise<void> {
  const ctx = known ?? (await loadContext(db, run));
  const key = section.sectionKey as SectionKey;
  const text = FAILURE_TEXT[reason] ?? FAILURE_TEXT.unexpected!;
  const current = ctx.current.get(key);
  if (!current) {
    const ids = ctx.shortlist ? ctx.shortlist.picks.map((p) => p.creatorId) : ctx.flags.shortlist ? [] : null;
    const content = skeleton(key, ctx.brief, ids);
    await saveVersions(
      db,
      run.id,
      key,
      [{ origin: "template", content, citations: key === "creator_strategy" && ctx.shortlist ? cite(content, ctx.shortlist) : [], flags: ["template_draft"], note: null }],
      { status: "failed", error: text, actor: msg.requestedBy, promptVersion: null },
    );
    return;
  }
  await db
    .update(proposalSections)
    .set({
      status: current.origin === "template" ? "failed" : "ready",
      error: current.origin === "template" ? text : `${text}. The current version is unchanged.`,
      updatedAt: Date.now(),
    })
    .where(eq(proposalSections.id, section.id));
}

export async function saveVersions(
  db: Db,
  runId: string,
  key: SectionKey,
  versions: NewVersion[],
  opts: { status: "ready" | "failed"; error?: string; actor: string; promptVersion: string | null },
): Promise<string[]> {
  const [last] = await db
    .select({ version: proposalVersions.version })
    .from(proposalVersions)
    .where(and(eq(proposalVersions.runId, runId), eq(proposalVersions.sectionKey, key)))
    .orderBy(desc(proposalVersions.version))
    .limit(1);
  const now = Date.now();
  const rows = versions.map((v, i) => ({
    id: newId(),
    runId,
    sectionKey: key,
    version: (last?.version ?? 0) + i + 1,
    origin: v.origin,
    content: v.content,
    citations: v.citations,
    flags: v.flags,
    note: v.note,
    promptVersion: opts.promptVersion,
    createdBy: opts.actor,
    createdAt: now,
  }));
  // The first new version becomes current; alternatives wait in the history (FR-CP-4)
  await db.batch([
    db.insert(proposalVersions).values(rows),
    db
      .update(proposalSections)
      .set({ status: opts.status, currentVersionId: rows[0]!.id, error: opts.error ?? null, updatedAt: now })
      .where(and(eq(proposalSections.runId, runId), eq(proposalSections.sectionKey, key))),
  ]);
  return rows.map((r) => r.id);
}

async function advance(env: Env, db: Db, run: RunRow, fromKey: SectionKey): Promise<void> {
  const order = generationOrder(TEMPLATES[proposalFlags(run).template]);
  const next = order[order.indexOf(fromKey) + 1];
  if (next) {
    const [row] = await db
      .select({ status: proposalSections.status })
      .from(proposalSections)
      .where(and(eq(proposalSections.runId, run.id), eq(proposalSections.sectionKey, next)));
    if (row?.status === "pending") await env.ENRICH_QUEUE.send(sectionMessage(run.id, next, "initial", run.createdBy));
    return;
  }
  // Last section done: the proposal is a draft for review (FR-CORE-22), failed sections included
  const [latest] = await db.select().from(runs).where(eq(runs.id, run.id));
  if (!latest || (latest.status !== "queued" && latest.status !== "running")) return;
  const flags = proposalFlags(latest);
  const sl = flags.shortlist ? await loadShortlist(db, flags.shortlist.matrixRunId) : null;
  await db
    .update(runs)
    .set({ status: "draft", finishedAt: Date.now(), flags: { ...flags, sampleData: Boolean(sl?.picks.some((p) => p.isSample)) } })
    .where(eq(runs.id, run.id));
}

// §7.7 and NFR-2: a lost or dead-lettered queue message must not leave a proposal drafting forever. The cron
// sweep settles a stalled section the same way a model failure does (template draft with a retry, or the current
// version kept), then lets the run reach draft. A first draft's heartbeat is the latest update across all its
// sections, since later sections wait "pending" while earlier ones draft; a regeneration's is its own section's.
const STALLED_AFTER_MS = 20 * 60_000;

export async function sweepStuckProposals(env: Env, now = Date.now()): Promise<number> {
  const db = getDb(env);
  const cutoff = now - STALLED_AFTER_MS;
  const open = await db
    .select({ section: proposalSections, run: runs })
    .from(proposalSections)
    .innerJoin(runs, eq(proposalSections.runId, runs.id))
    .where(and(inArray(proposalSections.status, ["pending", "generating"]), inArray(runs.status, ["queued", "running", "draft"])));
  const heartbeat = new Map<string, number>();
  for (const part of chunk([...new Set(open.map((o) => o.run.id))], 90)) {
    const rows = await db
      .select({ runId: proposalSections.runId, last: max(proposalSections.updatedAt) })
      .from(proposalSections)
      .where(inArray(proposalSections.runId, part))
      .groupBy(proposalSections.runId);
    for (const r of rows) heartbeat.set(r.runId, r.last ?? 0);
  }
  const stuck = open.filter(({ section, run }) => (run.status === "draft" ? section.updatedAt : (heartbeat.get(run.id) ?? section.updatedAt)) < cutoff);
  const touched = new Set<string>();
  for (const { section, run } of stuck) {
    await recordFailure(db, run, section, sectionMessage(run.id, section.sectionKey as SectionKey, "initial", "system:sweep"), "stalled");
    touched.add(run.id);
  }
  // A run whose chain stopped: once nothing is pending or generating it becomes a draft for review
  for (const runId of touched) {
    const [run] = await db.select().from(runs).where(eq(runs.id, runId));
    if (!run || (run.status !== "queued" && run.status !== "running")) continue;
    const open = await db
      .select({ id: proposalSections.id })
      .from(proposalSections)
      .where(and(eq(proposalSections.runId, runId), inArray(proposalSections.status, ["pending", "generating"])))
      .limit(1);
    if (open.length) continue;
    await db.update(runs).set({ status: "draft", finishedAt: now, flags: { ...proposalFlags(run), stalled: true } }).where(eq(runs.id, runId));
  }
  return stuck.length;
}
