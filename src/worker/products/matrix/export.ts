import type { creators, runItems, runs } from "../../core/db/schema";
import type { CandidateFeatures } from "./features";

type Row = { item: typeof runItems.$inferSelect; creator: typeof creators.$inferSelect };

export function toCsv(run: typeof runs.$inferSelect, rows: Row[]): string {
  const sample = rows.some((r) => r.creator.isSample);
  const lines = [
    `# Lemon Shot AI Suite: Creator Selection Matrix`,
    `# Run ${run.id}, approved ${run.reviewedAt ? new Date(run.reviewedAt).toISOString() : ""}`,
    ...(sample ? ["# Sample data: public creator profiles used for demonstration, not an agency database"] : []),
  ];
  const header = [
    "Rank",
    "Creator",
    "Instagram",
    "TikTok",
    "YouTube",
    "Composite",
    "Audience fit",
    "Brand safety",
    "Creative fit",
    "Engagement",
    "Reach",
    "Category fit",
    "Outcome history",
    "Followers (largest platform)",
    "Data completeness %",
    "Data age (days)",
    "Flags",
    "Rationale",
    "Swapped in for",
  ];
  const sorted = [...rows].sort((a, b) => (b.item.composite ?? -1) - (a.item.composite ?? -1));
  const body = sorted.map((r, i) => {
    const f = r.item.features as unknown as CandidateFeatures;
    const followers = Object.values(f.perPlatform ?? {}).map((p) => p?.followers ?? null).filter((v): v is number => v !== null);
    const swappedFor = r.item.replacesCreatorId ? (rows.find((x) => x.creator.id === r.item.replacesCreatorId)?.creator.displayName ?? r.item.replacesCreatorId) : "";
    return [
      i + 1,
      r.creator.displayName,
      r.creator.instagram ?? "",
      r.creator.tiktok ?? "",
      r.creator.youtube ?? "",
      r.item.composite ?? "",
      r.item.dims?.audienceFit ?? "",
      r.item.dims?.brandSafety ?? "",
      r.item.dims?.creativeFit ?? "",
      r.item.components.engagement ?? "",
      r.item.components.reach ?? "",
      r.item.components.categoryFit ?? "",
      r.item.components.history ?? "no history yet",
      followers.length ? Math.max(...followers) : "no data",
      r.item.completeness,
      r.item.stalenessDays ?? "",
      r.item.flags.join(" "),
      r.item.rationale ?? "rationale unavailable",
      swappedFor,
    ];
  });
  return [...lines, header, ...body].map((l) => (Array.isArray(l) ? l.map(csvCell).join(",") : l)).join("\n") + "\n";
}

function csvCell(v: unknown): string {
  const s = String(v ?? "");
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
