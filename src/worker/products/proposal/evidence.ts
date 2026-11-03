import { eq } from "drizzle-orm";
import type { Db } from "../../core/db/client";
import { briefs, creators, runItems, runs, type Platform } from "../../core/db/schema";
import type { CandidateFeatures } from "../matrix/features";

// FR-CP-2: what a proposal may say about a creator comes from a Matrix run item. Scores are written once
// (BR-MX-4), so a cited run item stays valid evidence even if the planner later swaps picks.
export type Evidence = {
  creatorId: string;
  runItemId: string;
  matrixRunId: string;
  displayName: string;
  handles: Partial<Record<Platform, string | null>>;
  isSample: boolean;
  finalPick: boolean;
  composite: number | null;
  rationale: string | null;
  platforms: { platform: Platform; followers: number | null; engagementRate: number | null; medianViews: number | null; fetchedAt: number }[];
  topHashtags: string[];
};

export type Shortlist = {
  run: typeof runs.$inferSelect;
  brief: Record<string, unknown> | null;
  // Final picks, best score first
  picks: Evidence[];
  byItemId: Map<string, Evidence>;
};

export const ATTACHABLE_STATUSES = ["queued", "running", "draft", "approved"] as const;

export async function loadShortlist(db: Db, matrixRunId: string): Promise<Shortlist | null> {
  const [row] = await db.select({ run: runs, fields: briefs.fields }).from(runs).leftJoin(briefs, eq(runs.briefId, briefs.id)).where(eq(runs.id, matrixRunId));
  if (!row || row.run.product !== "matrix") return null;
  const rows = await db.select({ item: runItems, creator: creators }).from(runItems).innerJoin(creators, eq(runItems.creatorId, creators.id)).where(eq(runItems.runId, matrixRunId));
  const all = rows.map(({ item, creator }): Evidence => {
    const f = item.features as unknown as Partial<CandidateFeatures>;
    return {
      creatorId: creator.id,
      runItemId: item.id,
      matrixRunId,
      displayName: creator.displayName,
      handles: { instagram: creator.instagram, tiktok: creator.tiktok, youtube: creator.youtube },
      isSample: creator.isSample,
      finalPick: item.finalPick,
      composite: item.composite,
      rationale: item.rationale,
      platforms: Object.entries(f.perPlatform ?? {}).map(([platform, p]) => ({
        platform: platform as Platform,
        followers: p?.followers ?? null,
        engagementRate: p?.engagementRate ?? null,
        medianViews: p?.medianViews ?? null,
        fetchedAt: p?.fetchedAt ?? 0,
      })),
      topHashtags: (f.topHashtags ?? []).slice(0, 5),
    };
  });
  return {
    run: row.run,
    brief: row.fields,
    picks: all.filter((e) => e.finalPick).sort((a, b) => (b.composite ?? -1) - (a.composite ?? -1)),
    byItemId: new Map(all.map((e) => [e.runItemId, e])),
  };
}

// Oldest and newest snapshot behind the cited creators, for the assumptions block (FR-CP-5)
export function snapshotRange(evidence: Evidence[]): [number, number] | null {
  const times = evidence.flatMap((e) => e.platforms.map((p) => p.fetchedAt)).filter((t) => t > 0);
  return times.length ? [Math.min(...times), Math.max(...times)] : null;
}
