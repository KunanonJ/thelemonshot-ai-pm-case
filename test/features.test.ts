import { describe, expect, it } from "vitest";
import { computeFeatures, followerTier, percentileRank, type CandidateInput } from "../src/worker/products/matrix/features";

const NOW = Date.UTC(2026, 10, 2);
const DAY = 86_400_000;

function creator(id: string, followers: number | null, er: number | null, views: number | null, extra: Partial<CandidateInput> = {}): CandidateInput {
  return {
    creatorId: id,
    categories: ["food_snacks"],
    historyScore: null,
    snapshots: [{ platform: "tiktok", followers, engagementRate: er, medianViews: views, topHashtags: ["รีวิวขนม", "travel"], fetchedAt: NOW - DAY }],
    ...extra,
  };
}

describe("follower tiers", () => {
  it("uses fixed boundaries and keeps unknown as null", () => {
    expect(followerTier(9_999)).toBe("nano");
    expect(followerTier(10_000)).toBe("micro");
    expect(followerTier(499_999)).toBe("mid");
    expect(followerTier(1_000_000)).toBe("mega");
    expect(followerTier(null)).toBeNull();
  });
});

describe("matrix features (FR-MX-4)", () => {
  const brief = { platforms: ["tiktok" as const], productCategory: "food_snacks" };

  it("scores engagement against the tier median: median = 50, double = 100", () => {
    const pool = [creator("a", 50_000, 4, 1000), creator("b", 60_000, 4, 2000), creator("c", 70_000, 8, 3000), creator("d", 80_000, 2, 4000)];
    const f = new Map(computeFeatures(pool, brief, NOW).map((x) => [x.creatorId, x]));
    // micro-tier median of [4, 4, 8, 2] is 4
    expect(f.get("a")!.engagement).toBe(50);
    expect(f.get("c")!.engagement).toBe(100);
    expect(f.get("d")!.engagement).toBe(25);
  });

  it("keeps a missing value as null and lowers completeness instead of scoring zero", () => {
    const [x] = computeFeatures([creator("a", 50_000, null, null)], brief, NOW);
    expect(x!.engagement).toBeNull();
    expect(x!.completeness).toBe(33);
    expect(x!.history).toBeNull();
    expect(x!.usable).toBe(true);
  });

  it("marks a creator with no snapshot on the requested platforms as unusable", () => {
    const [x] = computeFeatures([creator("a", 1, 1, 1, { snapshots: [] })], brief, NOW);
    expect(x!.usable).toBe(false);
    expect(x!.completeness).toBe(0);
  });

  it("gives category fit 60 for the tag plus up to 40 for on-topic hashtags", () => {
    const [x] = computeFeatures([creator("a", 50_000, 4, 1000)], brief, NOW);
    expect(x!.categoryFit).toBe(80); // tagged, and 1 of 2 hashtags on topic
  });

  it("reports data age in days", () => {
    const [x] = computeFeatures([creator("a", 50_000, 4, 1000)], brief, NOW);
    expect(x!.stalenessDays).toBe(1);
  });
});

describe("percentile rank", () => {
  it("counts ties as half", () => {
    expect(percentileRank([1, 2, 3, 4], 4)).toBe(88);
    expect(percentileRank([5, 5], 5)).toBe(50);
    expect(percentileRank([], 5)).toBe(50);
  });
});
