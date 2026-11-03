import { describe, expect, it } from "vitest";
import { samplePostMetrics, sampleTrendPosts, unit } from "../src/worker/core/enrichment/sample";

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 10, 4);

describe("sample post metrics (demo campaigns)", () => {
  it("gives the same numbers for the same post and moment", () => {
    expect(samplePostMetrics("post-1", NOW - 2 * DAY, NOW)).toEqual(samplePostMetrics("post-1", NOW - 2 * DAY, NOW));
    expect(unit("a")).toBe(unit("a"));
    expect(unit("a")).toBeGreaterThanOrEqual(0);
    expect(unit("a")).toBeLessThan(1);
  });

  it("grows over a post's first week, so refreshes show movement", () => {
    const day1 = samplePostMetrics("post-1", NOW - 1 * DAY, NOW).views!;
    const day5 = samplePostMetrics("post-1", NOW - 5 * DAY, NOW).views!;
    expect(day5).toBeGreaterThan(day1);
  });

  it("varies between posts, so a campaign has winners and laggards", () => {
    const views = Array.from({ length: 8 }, (_, i) => samplePostMetrics(`post-${i}`, NOW - 4 * DAY, NOW).views!);
    expect(Math.max(...views) / Math.min(...views)).toBeGreaterThan(2);
    for (let i = 0; i < 8; i++) {
      const m = samplePostMetrics(`post-${i}`, NOW - 4 * DAY, NOW);
      expect(m.likes!).toBeLessThan(m.views!);
      expect(m.comments!).toBeLessThan(m.likes!);
    }
  });
});

describe("sample trend posts (demo pulls)", () => {
  const posts = sampleTrendPosts({ term: "#SnackReview", category: "food_snacks" }, "tiktok", 25, NOW);

  it("respects the post cap, up to 18 per term and platform", () => {
    expect(posts).toHaveLength(18);
    expect(sampleTrendPosts({ term: "snack", category: "food_snacks" }, "instagram", 5, NOW)).toHaveLength(5);
  });

  it("marks every post as invented: demo_ handles", () => {
    expect(posts.every((p) => p.handle?.startsWith("demo_"))).toBe(true);
  });

  it("tags every post with the watched term and gives clustering shared hashtags", () => {
    expect(posts.every((p) => p.hashtags.includes("snackreview"))).toBe(true);
    const counts = new Map<string, number>();
    for (const p of posts) for (const h of p.hashtags.slice(1)) counts.set(h, (counts.get(h) ?? 0) + 1);
    expect([...counts.values()].filter((n) => n >= 2).length).toBeGreaterThanOrEqual(3);
  });

  it("dates most posts within the last week, never in the future", () => {
    const recent = posts.filter((p) => NOW - p.postedAt! <= 7 * DAY).length;
    expect(recent / posts.length).toBeGreaterThan(0.5);
    expect(posts.every((p) => p.postedAt! <= NOW)).toBe(true);
  });

  it("gives unique post IDs and real-format URLs", () => {
    expect(new Set(posts.map((p) => p.platformPostId)).size).toBe(posts.length);
    expect(posts.every((p) => p.url.startsWith(`https://www.tiktok.com/@${p.handle}/video/`))).toBe(true);
  });
});
