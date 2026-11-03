import { and, count, desc, eq, inArray } from "drizzle-orm";
import type { Db } from "../../core/db/client";
import { briefs, llmCalls, proposalSections, proposalVersions, runs } from "../../core/db/schema";
import { proposalBriefSchema, type ProposalBrief } from "./brief";
import { PROMPT_VERSION } from "./contract";
import { loadShortlist, snapshotRange, type Evidence, type Shortlist } from "./evidence";
import { proposalFlags, type ProposalFlags } from "./pipeline";
import { budgetLine, timelineLine, TEMPLATES, type SectionKey, type TemplateDef } from "./templates";
import { loadAttachedTrends, type AttachedTrend } from "../trends/attach";

type VersionRow = typeof proposalVersions.$inferSelect;

export type SectionView = {
  key: SectionKey;
  title: string;
  position: number;
  status: string;
  error: string | null;
  current: VersionRow | null;
  versionCount: number;
};

// Everything the editor, the HTML export and the PPTX export draw from
export type ProposalDoc = {
  run: typeof runs.$inferSelect;
  brief: ProposalBrief;
  template: TemplateDef;
  flags: ProposalFlags;
  sections: SectionView[];
  shortlist: Shortlist | null;
  // By creator ID: the current picks plus every creator a current version cites (FR-CP-2)
  evidence: Record<string, Evidence>;
  assumptions: string[];
  sampleData: boolean;
  // AC-TM-2: approved ② trend briefs attached to this proposal
  trends: AttachedTrend[];
};

export async function loadProposalDoc(db: Db, runId: string): Promise<ProposalDoc | null> {
  const [row] = await db.select({ run: runs, fields: briefs.fields }).from(runs).leftJoin(briefs, eq(runs.briefId, briefs.id)).where(eq(runs.id, runId));
  if (!row || row.run.product !== "proposal" || !row.fields) return null;
  const brief = proposalBriefSchema.parse(row.fields);
  const template = TEMPLATES[brief.template];
  const flags = proposalFlags(row.run);
  const shortlist = flags.shortlist ? await loadShortlist(db, flags.shortlist.matrixRunId) : null;

  const sectionRows = await db.select().from(proposalSections).where(eq(proposalSections.runId, runId));
  const counts = await db
    .select({ key: proposalVersions.sectionKey, n: count() })
    .from(proposalVersions)
    .where(eq(proposalVersions.runId, runId))
    .groupBy(proposalVersions.sectionKey);
  const ids = sectionRows.flatMap((s) => (s.currentVersionId ? [s.currentVersionId] : []));
  const versions = ids.length ? await db.select().from(proposalVersions).where(inArray(proposalVersions.id, ids)) : [];
  const byId = new Map(versions.map((v) => [v.id, v]));
  const sections = template.sections.map((def): SectionView => {
    const s = sectionRows.find((r) => r.sectionKey === def.key);
    return {
      key: def.key,
      title: def.title,
      position: s?.position ?? 0,
      status: s?.status ?? "pending",
      error: s?.error ?? null,
      current: s?.currentVersionId ? (byId.get(s.currentVersionId) ?? null) : null,
      versionCount: counts.find((c) => c.key === def.key)?.n ?? 0,
    };
  });

  const evidence: Record<string, Evidence> = {};
  const cited: Evidence[] = [];
  if (shortlist) {
    for (const p of shortlist.picks) evidence[p.creatorId] = p;
    for (const v of versions) {
      for (const c of v.citations) {
        const e = shortlist.byItemId.get(c.runItemId);
        if (!e) continue;
        evidence[c.creatorId] = e;
        cited.push(e);
      }
    }
  }
  const [llm] = await db
    .select({ model: llmCalls.model })
    .from(llmCalls)
    .where(and(eq(llmCalls.runId, runId), eq(llmCalls.status, "ok")))
    .orderBy(desc(llmCalls.createdAt))
    .limit(1);
  const sampleData = Object.values(evidence).some((e) => e.isSample);
  const trends = await loadAttachedTrends(db, runId);
  const assumptions = buildAssumptions({
    brief,
    template,
    trends,
    shortlist: shortlist
      ? { id: shortlist.run.id, status: shortlist.run.status, reviewedAt: shortlist.run.reviewedAt, range: snapshotRange(cited.length ? cited : shortlist.picks) }
      : null,
    attached: Boolean(flags.shortlist),
    model: llm?.model ?? null,
    sampleData,
  });
  return { run: row.run, brief, template, flags, sections, shortlist, evidence, assumptions, sampleData, trends };
}

export function fmtDate(ms: number): string {
  return new Date(ms).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "Asia/Bangkok" });
}

const sentence = (text: string) => (/[.!?]$/.test(text.trim()) ? text.trim() : `${text.trim()}.`);

// FR-CP-5: the inputs behind the proposal, printed on its last page and slide
export function buildAssumptions(i: {
  brief: ProposalBrief;
  template: TemplateDef;
  shortlist: { id: string; status: string; reviewedAt: number | null; range: [number, number] | null } | null;
  attached: boolean;
  model: string | null;
  sampleData: boolean;
  trends?: AttachedTrend[];
}): string[] {
  const b = i.brief;
  const lines = [
    sentence(`Brief: ${b.brand || "brand not given"}, ${b.product || "product not given"}. Objective: ${b.objective}. Audience: ${b.audience || "not given"}`),
    `Budget: ${budgetLine(b)}.`,
    `Timeline: ${timelineLine(b)}.`,
  ];
  if (b.toneNotes) lines.push(sentence(`Tone notes: ${b.toneNotes}`));
  if (b.mustAvoid.length) lines.push(`Topics to avoid: ${b.mustAvoid.join(", ")}.`);
  lines.push(`Template: ${i.template.name}. Phase timings and process KPIs marked as template defaults are starting points, not commitments.`);
  if (i.shortlist) {
    const r = i.shortlist.range;
    const taken = !r ? "" : fmtDate(r[0]) === fmtDate(r[1]) ? ` Creator figures come from public-profile snapshots taken on ${fmtDate(r[0])}.` : ` Creator figures come from public-profile snapshots taken between ${fmtDate(r[0])} and ${fmtDate(r[1])}.`;
    const reviewed = i.shortlist.status === "approved" && i.shortlist.reviewedAt ? `approved on ${fmtDate(i.shortlist.reviewedAt)}` : i.shortlist.status;
    lines.push(`Creator shortlist: Creator Matrix run ${i.shortlist.id.slice(0, 8)}, ${reviewed}.${taken}`);
  } else {
    lines.push(i.attached ? "Creator shortlist: attached but no longer available." : "Creator shortlist: none attached. The creator section is left empty on purpose and no creators are named.");
  }
  // AC-TM-2: each attached trend brief is named here, with its within-sample scope
  for (const t of i.trends ?? []) {
    const approved = t.approvedAt ? `approved ${fmtDate(t.approvedAt)}` : "approved";
    lines.push(
      `Trend brief ${t.runId.slice(0, 8)}, ${approved}: ${t.uniquePosts} unique public posts pulled for ${t.terms.join(", ") || "no terms"}. ${t.themeCount} themes, ${t.weakThemes} marked weak signal and ${t.risingThemes} rising within the pull. Trend figures describe these posts only, not the platforms as a whole.`,
    );
  }
  lines.push("Figures: every figure comes from the brief, the shortlist data or the template. Anything else is marked TBC and is to be agreed with the client.");
  if (i.sampleData) lines.push("Sample data: the creator profiles are public profiles used for demonstration, not an agency database.");
  lines.push(
    i.model
      ? `Drafted with ${i.model} (prompt ${PROMPT_VERSION}) from these inputs. A planner reviews every section before the proposal is approved.`
      : "Drafted from the template. A planner reviews every section before the proposal is approved.",
  );
  return lines;
}
