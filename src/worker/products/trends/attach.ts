import { eq, inArray } from "drizzle-orm";
import type { Db } from "../../core/db/client";
import { runs } from "../../core/db/schema";
import { trendAttachments, trendBriefs, trendPullTerms, trendPulls } from "./schema";

// AC-TM-2: the approved trend briefs a ④ proposal run cites. The proposal document prints them in its assumptions.
export type AttachedTrend = {
  runId: string;
  approvedAt: number | null;
  terms: string[];
  uniquePosts: number;
  themeCount: number;
  weakThemes: number;
  risingThemes: number;
};

export async function loadAttachedTrends(db: Db, proposalRunId: string): Promise<AttachedTrend[]> {
  const rows = await db
    .select({ trendRunId: trendAttachments.trendRunId, approvedAt: runs.reviewedAt, pullId: trendPulls.id, brief: trendBriefs })
    .from(trendAttachments)
    .innerJoin(runs, eq(trendAttachments.trendRunId, runs.id))
    .innerJoin(trendPulls, eq(trendPulls.runId, runs.id))
    .leftJoin(trendBriefs, eq(trendBriefs.runId, runs.id))
    .where(eq(trendAttachments.proposalRunId, proposalRunId))
    .orderBy(trendAttachments.attachedAt);
  if (!rows.length) return [];

  const terms = await db
    .select({ pullId: trendPullTerms.pullId, label: trendPullTerms.label })
    .from(trendPullTerms)
    .where(inArray(
      trendPullTerms.pullId,
      rows.map((r) => r.pullId),
    ));
  return rows.map((r) => ({
    runId: r.trendRunId,
    approvedAt: r.approvedAt,
    terms: [...new Set(terms.filter((t) => t.pullId === r.pullId).map((t) => t.label))],
    uniquePosts: r.brief?.sample.uniquePosts ?? 0,
    themeCount: r.brief?.themes.length ?? 0,
    weakThemes: r.brief?.themes.filter((t) => t.weakSignal).length ?? 0,
    risingThemes: r.brief?.themes.filter((t) => t.rising).length ?? 0,
  }));
}
