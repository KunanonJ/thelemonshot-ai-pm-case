import { describe, expect, it } from "vitest";
import type { CandidateFeatures } from "../src/worker/products/matrix/features";
import { composite, rankCandidates, type Dims } from "../src/worker/products/matrix/scoring";
import { WEIGHT_PROFILES } from "../src/worker/products/matrix/weights";

function features(id: string, score: number, extra: Partial<CandidateFeatures> = {}): CandidateFeatures {
  return {
    creatorId: id,
    platforms: ["tiktok"],
    perPlatform: {},
    tier: "micro",
    engagement: score,
    reach: score,
    categoryFit: score,
    history: null,
    completeness: 100,
    stalenessDays: 1,
    topHashtags: [],
    usable: true,
    ...extra,
  };
}

describe("composite (FR-MX-6)", () => {
  it("rescales the weights when a component is missing", () => {
    const w = WEIGHT_PROFILES.conversion;
    const all = { history: 80, engagement: 80, reach: 80, categoryFit: 80, audienceFit: 80, creativeFit: 80 };
    expect(composite(all, w)).toBe(80);
    expect(composite({ ...all, history: null }, w)).toBe(80);
    expect(composite({ history: null, engagement: null, reach: null, categoryFit: null, audienceFit: null, creativeFit: null }, w)).toBeNull();
  });

  it("weights every profile to 100%", () => {
    for (const profile of Object.values(WEIGHT_PROFILES)) {
      expect(Object.values(profile).reduce((a, b) => a + b, 0)).toBeCloseTo(1, 10);
    }
  });
});

describe("rankCandidates", () => {
  const dims = (brandSafety: number): Dims => ({ audienceFit: 70, brandSafety, creativeFit: 70 });

  it("removes brand safety under 40 whatever the score, and creators with no data", () => {
    const rows = rankCandidates({
      features: [features("risky", 99), features("ok", 50), features("empty", 0, { usable: false })],
      dims: new Map([
        ["risky", dims(30)],
        ["ok", dims(90)],
      ]),
      llmFlags: new Map(),
      objective: "awareness",
      mustInclude: new Set(),
    });
    const by = new Map(rows.map((r) => [r.creatorId, r]));
    expect(by.get("risky")!.excludedReason).toBe("safety_excluded");
    expect(by.get("empty")!.excludedReason).toBe("no_data");
    expect(by.get("ok")!.rank).toBe(1);
  });

  it("caps the shortlist at 15, keeps must-include creators, and ranks by score", () => {
    const pool = Array.from({ length: 20 }, (_, i) => features(`c${i}`, 100 - i));
    const rows = rankCandidates({ features: pool, dims: null, llmFlags: new Map(), objective: "engagement", mustInclude: new Set(["c19"]) });
    const shortlisted = rows.filter((r) => r.recommended).sort((a, b) => a.rank! - b.rank!);
    expect(shortlisted).toHaveLength(15);
    expect(shortlisted.map((r) => r.creatorId)).toContain("c19");
    expect(shortlisted.at(-1)!.creatorId).toBe("c19");
    expect(shortlisted[0]!.creatorId).toBe("c0");
  });

  it("flags every row when the model was unavailable (BR-MX-2)", () => {
    const rows = rankCandidates({ features: [features("a", 50, { completeness: 40 })], dims: null, llmFlags: new Map(), objective: "conversion", mustInclude: new Set() });
    expect(rows[0]!.flags).toEqual(expect.arrayContaining(["rationale_unavailable", "low_confidence", "cold_start"]));
    expect(rows[0]!.composite).toBe(50);
  });
});
