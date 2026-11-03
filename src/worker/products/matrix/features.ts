import type { Platform } from "../../core/db/schema";
import { median } from "../../core/enrichment/normalise";

// FR-MX-4: deterministic features from the latest snapshots. Missing data stays null, never zero (FR-CORE-6).

export type Tier = "nano" | "micro" | "mid" | "macro" | "mega";

export type SnapshotInput = {
  platform: Platform;
  followers: number | null;
  engagementRate: number | null;
  medianViews: number | null;
  topHashtags: string[];
  fetchedAt: number;
};

export type CandidateInput = {
  creatorId: string;
  categories: string[];
  historyScore: number | null;
  snapshots: SnapshotInput[]; // latest per platform
};

export type PlatformFeatures = {
  followers: number | null;
  engagementRate: number | null;
  medianViews: number | null;
  tier: Tier | null;
  fetchedAt: number;
};

export type CandidateFeatures = {
  creatorId: string;
  platforms: Platform[]; // requested platforms that have a snapshot
  perPlatform: Partial<Record<Platform, PlatformFeatures>>;
  tier: Tier | null;
  engagement: number | null;
  reach: number | null;
  categoryFit: number;
  history: number | null;
  completeness: number; // 0-100
  stalenessDays: number | null;
  topHashtags: string[];
  usable: boolean;
};

// Category vocabularies for the hashtag share in category fit (Thai and English)
export const CATEGORY_LEXICON: Record<string, string[]> = {
  food_snacks: ["ขนม", "อร่อย", "ของกิน", "อาหาร", "กิน", "ของหวาน", "snack", "food", "eat", "yummy", "mukbang", "dessert", "review"],
  beauty: ["สกินแคร์", "เครื่องสำอาง", "แต่งหน้า", "บิวตี้", "ผิว", "ลิป", "makeup", "skincare", "beauty", "cosmetic", "lip", "serum"],
};

export function followerTier(followers: number | null): Tier | null {
  if (followers === null) return null;
  if (followers < 10_000) return "nano";
  if (followers < 100_000) return "micro";
  if (followers < 500_000) return "mid";
  if (followers < 1_000_000) return "macro";
  return "mega";
}

export function computeFeatures(
  candidates: CandidateInput[],
  brief: { platforms: Platform[]; productCategory: string },
  now: number,
): CandidateFeatures[] {
  const requested = new Set(brief.platforms);
  const perCandidate = candidates.map((c) => {
    const perPlatform: Partial<Record<Platform, PlatformFeatures>> = {};
    for (const s of c.snapshots) {
      if (!requested.has(s.platform)) continue;
      perPlatform[s.platform] = {
        followers: s.followers,
        engagementRate: s.engagementRate,
        medianViews: s.medianViews,
        tier: followerTier(s.followers),
        fetchedAt: s.fetchedAt,
      };
    }
    return { c, perPlatform };
  });

  // Engagement is judged against peers on the same platform and tier, within this pool
  const tierMedians = new Map<string, number>();
  const platformMedians = new Map<string, number>();
  for (const platform of requested) {
    const rows = perCandidate.flatMap(({ perPlatform }) => (perPlatform[platform]?.engagementRate != null ? [perPlatform[platform]!] : []));
    if (rows.length) platformMedians.set(platform, median(rows.map((r) => r.engagementRate!)));
    const byTier = new Map<Tier, number[]>();
    for (const r of rows) if (r.tier) byTier.set(r.tier, [...(byTier.get(r.tier) ?? []), r.engagementRate!]);
    for (const [tier, values] of byTier) if (values.length >= 3) tierMedians.set(`${platform}:${tier}`, median(values));
  }

  // Reach is a percentile within the pool, per platform: views where reported, followers otherwise
  const reachValue = (pf: PlatformFeatures) => pf.medianViews ?? pf.followers;
  const reachPools = new Map<string, number[]>();
  for (const platform of requested) {
    reachPools.set(
      platform,
      perCandidate.flatMap(({ perPlatform }) => {
        const pf = perPlatform[platform];
        const v = pf ? reachValue(pf) : null;
        return v != null ? [v] : [];
      }),
    );
  }

  const lexicon = CATEGORY_LEXICON[brief.productCategory] ?? [];

  return perCandidate.map(({ c, perPlatform }) => {
    const platforms = (Object.keys(perPlatform) as Platform[]).sort();
    const engagementScores: number[] = [];
    const reachScores: number[] = [];
    let present = 0;
    for (const platform of platforms) {
      const pf = perPlatform[platform]!;
      present += [pf.followers, pf.engagementRate, pf.medianViews].filter((v) => v !== null).length;
      if (pf.engagementRate !== null) {
        const benchmark = (pf.tier && tierMedians.get(`${platform}:${pf.tier}`)) || platformMedians.get(platform);
        if (benchmark) engagementScores.push(clamp((pf.engagementRate / benchmark) * 50));
      }
      const v = reachValue(pf);
      if (v !== null) reachScores.push(percentileRank(reachPools.get(platform) ?? [], v));
    }

    const hashtags = [...new Set(c.snapshots.filter((s) => requested.has(s.platform)).flatMap((s) => s.topHashtags))];
    const onTopic = hashtags.filter((h) => lexicon.some((word) => h.includes(word))).length;
    const categoryFit = round((c.categories.includes(brief.productCategory) ? 60 : 0) + (hashtags.length ? (40 * onTopic) / hashtags.length : 0));

    const followers = platforms.map((p) => perPlatform[p]!.followers).filter((f): f is number => f !== null);
    const oldest = platforms.length ? Math.min(...platforms.map((p) => perPlatform[p]!.fetchedAt)) : null;

    return {
      creatorId: c.creatorId,
      platforms,
      perPlatform,
      tier: followerTier(followers.length ? Math.max(...followers) : null),
      engagement: engagementScores.length ? round(avg(engagementScores)) : null,
      reach: reachScores.length ? round(avg(reachScores)) : null,
      categoryFit,
      history: c.historyScore,
      // Share of the per-platform stats that exist for the requested platforms (FR-MX-7)
      completeness: round((present / (3 * requested.size)) * 100),
      stalenessDays: oldest === null ? null : round((now - oldest) / 86_400_000, 1),
      topHashtags: hashtags.slice(0, 10),
      usable: present > 0,
    };
  });
}

export function percentileRank(pool: number[], value: number): number {
  if (pool.length === 0) return 50;
  const below = pool.filter((v) => v < value).length;
  const equal = pool.filter((v) => v === value).length;
  return round(((below + 0.5 * equal) / pool.length) * 100);
}

function clamp(v: number, lo = 0, hi = 100): number {
  return Math.max(lo, Math.min(hi, v));
}
function avg(values: number[]): number {
  return values.reduce((a, b) => a + b, 0) / values.length;
}
function round(v: number, digits = 0): number {
  const f = 10 ** digits;
  return Math.round(v * f) / f;
}
