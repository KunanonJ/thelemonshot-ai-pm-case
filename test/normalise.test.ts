import { describe, expect, it } from "vitest";
import {
  computeStats,
  discoverFromInstagramPosts,
  discoverFromTikTokVideos,
  normaliseInstagram,
  normaliseTikTok,
  normaliseYouTube,
} from "../src/worker/core/enrichment/normalise";

// Fixtures follow the field names documented by each source (Apify actor READMEs, YouTube Data API v3)

describe("Instagram (apify/instagram-profile-scraper)", () => {
  const items = [
    {
      username: "Demo.Foodie",
      fullName: "Demo Foodie",
      followersCount: 10_000,
      followsCount: 300,
      postsCount: 120,
      verified: false,
      latestPosts: [
        { id: "1", likesCount: 400, commentsCount: 100, type: "Image", caption: "ขนมใหม่ #รีวิวขนม", timestamp: "2026-10-30T10:00:00.000Z" },
        { id: "2", likesCount: -1, commentsCount: 50, type: "Video", videoViewCount: 9000, hashtags: ["snack"] },
      ],
    },
  ];

  it("normalises the handle and treats a hidden like count as missing", () => {
    const [p] = normaliseInstagram(items);
    expect(p!.handle).toBe("demo.foodie");
    expect(p!.posts[1]!.likes).toBeNull();
    expect(p!.posts[0]!.hashtags).toEqual(["รีวิวขนม"]);
  });

  it("computes engagement as (likes + comments) / followers over posts with both values", () => {
    const stats = computeStats(normaliseInstagram(items)[0]!);
    expect(stats.engagementRate).toBe(5);
    expect(stats.medianViews).toBe(9000);
    expect(stats.recentPosts).toBe(2);
  });
});

describe("TikTok (clockworks/tiktok-profile-scraper)", () => {
  const video = (id: string, plays: number) => ({
    id,
    text: "#ขนม",
    playCount: plays,
    diggCount: 80,
    commentCount: 10,
    shareCount: 10,
    createTimeISO: "2026-10-28T00:00:00.000Z",
    authorMeta: { name: "Snack.Haul", nickName: "Snack Haul", fans: 18_000, verified: false, privateAccount: false },
  });

  it("groups videos by author and computes engagement against views", () => {
    const [p] = normaliseTikTok([video("1", 1000), video("2", 2000)]);
    expect(p!.handle).toBe("snack.haul");
    expect(p!.followers).toBe(18_000);
    const stats = computeStats(p!);
    expect(stats.engagementRate).toBe(7.5); // (10% + 5%) / 2
    expect(stats.medianViews).toBe(1500);
  });
});

describe("YouTube Data API v3", () => {
  it("keeps a hidden subscriber count as a gap, not zero", () => {
    const p = normaliseYouTube(
      "@demo",
      { id: "UC1", snippet: { title: "Demo" }, statistics: { subscriberCount: "1000", hiddenSubscriberCount: true, videoCount: "10" } },
      [{ id: "v1", snippet: { title: "t", publishedAt: "2026-10-01T00:00:00Z", tags: ["Food"] }, statistics: { viewCount: "500", likeCount: "40", commentCount: "10" } }],
    );
    expect(p!.followers).toBeNull();
    expect(p!.handle).toBe("demo");
    expect(computeStats(p!).engagementRate).toBe(10);
  });
});

describe("discovery", () => {
  it("counts repeat posters on Instagram and reads TikTok author stats", () => {
    const ig = discoverFromInstagramPosts([{ ownerUsername: "A" }, { ownerUsername: "a" }, { ownerUsername: "b", ownerFullName: "B" }]);
    expect(ig.find((c) => c.handle === "a")!.hits).toBe(2);
    const tt = discoverFromTikTokVideos([{ authorMeta: { name: "x", fans: 5, privateAccount: true } }]);
    expect(tt[0]).toMatchObject({ handle: "x", followers: 5, isPrivate: true });
  });
});
