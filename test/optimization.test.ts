import { describe, expect, it } from "vitest";
import { instagramPostResults, parsePostUrl, tiktokPostResults, youtubePostResults } from "../src/worker/core/enrichment/posts";
import { validateNarrative } from "../src/worker/products/optimization/contract";
import { closingSummary, computeDeltas, engagementRate, historyScore, outcomeScore, trendOf, type TrackedPostInput } from "../src/worker/products/optimization/deltas";

const DAY = 86_400_000;
const T0 = Date.UTC(2026, 10, 1);

describe("post URLs (FR-CO-1)", () => {
  it("recognises Instagram, TikTok and YouTube post URLs", () => {
    expect(parsePostUrl("https://www.instagram.com/reel/Cx1AbC/?igsh=abc")).toMatchObject({ platform: "instagram", postId: "Cx1AbC", handle: null, url: "https://www.instagram.com/p/Cx1AbC/" });
    expect(parsePostUrl("https://instagram.com/snackbkk/p/Cx2/")).toMatchObject({ platform: "instagram", postId: "Cx2", handle: "snackbkk" });
    expect(parsePostUrl("https://www.tiktok.com/@Demo.Food1/video/7533731959172861206?lang=th")).toMatchObject({
      platform: "tiktok",
      postId: "7533731959172861206",
      handle: "demo.food1",
    });
    expect(parsePostUrl("https://youtu.be/dQw4w9WgXcQ")).toMatchObject({ platform: "youtube", postId: "dQw4w9WgXcQ" });
    expect(parsePostUrl("https://www.youtube.com/shorts/abcdEFG1234")).toMatchObject({ platform: "youtube", postId: "abcdEFG1234" });
    expect(parsePostUrl("https://www.youtube.com/watch?v=abcdEFG1234&t=3")).toMatchObject({ postId: "abcdEFG1234" });
  });

  it("rejects anything else", () => {
    expect(parsePostUrl("https://www.tiktok.com/video/123")).toBeNull(); // no handle
    expect(parsePostUrl("https://example.com/p/abc")).toBeNull();
    expect(parsePostUrl("not a url")).toBeNull();
  });
});

describe("post results (FR-CO-2, BR-CO-1)", () => {
  it("treats hidden Instagram likes as not reported and absent posts as missing", () => {
    const r = instagramPostResults([{ shortCode: "A", likesCount: -1, commentsCount: 4, videoViewCount: 900 }], ["A", "B"]);
    expect(r.get("A")).toEqual({ status: "ok", metrics: { views: 900, likes: null, comments: 4, shares: null } });
    expect(r.get("B")).toEqual({ status: "missing" });
  });

  it("reads TikTok's not-found-or-private error as gone", () => {
    const r = tiktokPostResults(
      [
        { id: "111", playCount: 1000, diggCount: 80, commentCount: 5, shareCount: 3 },
        { url: "https://www.tiktok.com/@a/video/222", errorCode: "POST_NOT_FOUND_OR_PRIVATE", error: "Post not found" },
      ],
      [
        { postId: "111", url: "https://www.tiktok.com/@a/video/111" },
        { postId: "222", url: "https://www.tiktok.com/@a/video/222" },
        { postId: "333", url: "https://www.tiktok.com/@a/video/333" },
      ],
    );
    expect(r.get("111")).toMatchObject({ status: "ok", metrics: { views: 1000, likes: 80, comments: 5, shares: 3 } });
    expect(r.get("222")).toMatchObject({ status: "gone" });
    expect(r.get("333")).toEqual({ status: "missing" });
  });

  it("treats a video missing from videos.list as gone", () => {
    const r = youtubePostResults([{ id: "v1", views: 10, likes: 1, comments: 0 }], ["v1", "v2"]);
    expect(r.get("v1")?.status).toBe("ok");
    expect(r.get("v2")?.status).toBe("gone");
  });
});

const post = (id: string, overrides: Partial<TrackedPostInput> = {}): TrackedPostInput => ({
  postId: id,
  creatorId: `c-${id}`,
  creatorName: `Creator ${id}`,
  platform: "tiktok",
  url: `https://www.tiktok.com/@x/video/${id}`,
  baselineViews: null,
  baselineEr: null,
  followers: null,
  history: [],
  state: "tracking",
  unavailableReason: null,
  ...overrides,
});
const point = (views: number | null, likes: number | null, comments: number | null, shares: number | null, day: number) => ({ views, likes, comments, shares, fetchedAt: T0 + day * DAY });

describe("delta engine (FR-CO-3)", () => {
  it("computes engagement per platform, never from missing parts", () => {
    expect(engagementRate("tiktok", { views: 1000, likes: 80, comments: 10, shares: 10 }, null)).toBe(10);
    expect(engagementRate("youtube", { views: 1000, likes: 80, comments: 20, shares: null }, null)).toBe(10);
    expect(engagementRate("instagram", { views: null, likes: 90, comments: 10, shares: null }, 2000)).toBe(5);
    expect(engagementRate("instagram", { views: null, likes: null, comments: 10, shares: null }, 2000)).toBeNull();
  });

  it("reads speed, not totals, for the trend", () => {
    expect(trendOf([point(100, 1, 1, 0, 0), point(200, 1, 1, 0, 1), point(400, 1, 1, 0, 2)])).toBe("rising");
    expect(trendOf([point(100, 1, 1, 0, 0), point(300, 1, 1, 0, 1), point(350, 1, 1, 0, 2)])).toBe("falling");
    expect(trendOf([point(100, 1, 1, 0, 0), point(200, 1, 1, 0, 1)])).toBe("too_early");
  });

  it("compares against baseline and peer median, and ranks winners and losers", () => {
    const d = computeDeltas(
      [
        post("a", { baselineViews: 1000, history: [point(1500, 150, 10, 5, 1)] }),
        post("b", { baselineViews: 1000, history: [point(500, 20, 2, 0, 1)] }),
        post("c", { history: [point(1000, 60, 5, 2, 1)] }),
      ],
      T0 + 2 * DAY,
    );
    const a = d.posts.find((p) => p.postId === "a")!;
    expect(a.vsBaseline.views).toEqual({ value: 1500, reference: 1000, abs: 500, pct: 50 });
    expect(a.vsPeer.views?.reference).toBe(1000);
    expect(d.winners).toEqual(["a"]);
    expect(d.losers).toEqual(["b"]);
    expect(d.verdict).toMatchObject({ kind: "on_track" });
    expect(d.verdict.text).toContain("2 posts with a baseline");
  });

  it("says when no baselines were set (BR-CO-3)", () => {
    const d = computeDeltas([post("a", { history: [point(1500, 150, 10, 5, 1)] }), post("b", { history: [point(500, 20, 2, 0, 1)] })], T0);
    expect(d.baselinesSet).toBe(false);
    expect(d.verdict.kind).toBe("no_baseline");
    expect(d.verdict.text).toContain("1 of 2 are above it");
  });

  it("keeps an unavailable post's last numbers but leaves it out of the rankings (AC-CO-2)", () => {
    const d = computeDeltas(
      [post("a", { history: [point(1500, 150, 10, 5, 1)] }), post("b", { history: [point(100, 1, 0, 0, 1)], state: "unavailable", unavailableReason: "Removed" })],
      T0,
    );
    expect(d.unavailable).toEqual(["b"]);
    expect(d.posts.find((p) => p.postId === "b")!.latest?.views).toBe(100);
    expect(d.losers).not.toContain("b");
  });

  it("lists metrics a source didn't report", () => {
    const d = computeDeltas([post("a", { platform: "youtube", history: [point(10, 1, 0, null, 1)] })], T0);
    expect(d.posts[0]!.notReported).toEqual(["shares"]);
  });

  it("reports no data before the first refresh", () => {
    expect(computeDeltas([post("a")], T0).verdict.kind).toBe("no_data");
  });
});

describe("write-back scoring (FR-CORE-21)", () => {
  it("scores 50 for performing as expected", () => {
    expect(outcomeScore({ views: 1000, baselineViews: 1000, medianEr: 5, peerMedianEr: 5 })).toBe(50);
    expect(outcomeScore({ views: 2000, baselineViews: 1000, medianEr: 10, peerMedianEr: 5 })).toBe(100);
    expect(outcomeScore({ views: null, baselineViews: null, medianEr: null, peerMedianEr: 5 })).toBeNull();
  });

  it("pulls a short history toward the benchmark", () => {
    expect(historyScore([])).toBeNull();
    expect(historyScore([90])).toBe(60);
    expect(historyScore([90, 90, 90, 90, 90, 90])).toBeGreaterThan(75);
  });

  it("summarises each creator for the closing confirmation", () => {
    const d = computeDeltas([post("a", { history: [point(1500, 150, 10, 5, 1)] }), post("b", { history: [point(500, 20, 2, 0, 1)] })], T0);
    const rows = closingSummary(d);
    expect(rows).toHaveLength(2);
    expect(rows.find((r) => r.creatorId === "c-a")!.outcomeScore).toBeGreaterThan(50);
  });
});

describe("digest narrative guardrails (FR-CO-5, HR-3)", () => {
  const d = computeDeltas([post("a", { baselineViews: 1000, history: [point(1500, 150, 10, 5, 1)] }), post("b", { history: [point(500, 20, 2, 0, 1)] })], T0);

  it("keeps grounded recommendations and attaches the real delta", () => {
    const { narrative, flags } = validateNarrative(
      {
        headline: "Views are 50% above baseline.",
        hypotheses: [{ text: "The hook may land better", refs: ["a", "unknown"] }],
        recommendations: [{ action: "scale_creator", targetId: "a", delta: "vsBaseline.views", text: "Views are 50% above baseline; brief a second post." }],
      },
      d,
    );
    expect(narrative.recommendations[0]!.motivating).toMatchObject({ pct: 50 });
    expect(narrative.hypotheses[0]!.refs).toEqual(["a"]);
    expect(flags).toEqual([]);
  });

  it("drops paid-media advice, unknown targets and invented figures", () => {
    const { narrative, flags } = validateNarrative(
      {
        headline: "Expect 3M views next week.",
        hypotheses: [],
        recommendations: [
          { action: "scale_creator", targetId: "a", delta: "vsPeer.er", text: "Boost this post with ad spend." },
          { action: "scale_creator", targetId: "zzz", delta: "vsPeer.er", text: "Use them more." },
          { action: "dance", targetId: "a", delta: "vsPeer.er", text: "Something" },
        ],
      },
      d,
    );
    expect(narrative.recommendations).toHaveLength(0);
    expect(narrative.headline).toBe("Expect TBC views next week.");
    expect(flags).toEqual(["figures_replaced:1", "items_dropped:2", "paid_media_removed:1"]);
  });
});
