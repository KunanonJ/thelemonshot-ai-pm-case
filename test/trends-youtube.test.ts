import { afterEach, describe, expect, it, vi } from "vitest";
import { failedTermText } from "../src/worker/products/trends/failures";
import { termInputSchema } from "../src/worker/products/trends/terms";
import { searchQuotaKey, searchYouTubeTrend, YT_TREND_SEARCHES_PER_DAY } from "../src/worker/products/trends/youtube";

const NOW = Date.parse("2026-11-06T03:00:00Z");
const KEY = "test-key-not-real";

function envWith(store = new Map<string, string>()) {
  return {
    YOUTUBE_API_KEY: KEY,
    CONFIG: { get: async (k: string) => store.get(k) ?? null, put: async (k: string, v: string) => void store.set(k, v) },
  } as unknown as Env;
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

// Answers search.list, videos.list and channels.list the way the live API shapes them
function fakeYouTube(overrides: Partial<Record<"search" | "videos" | "channels", Response>> = {}) {
  const calls: URL[] = [];
  const fetch = vi.fn(async (input: string | URL) => {
    const url = new URL(String(input));
    calls.push(url);
    const path = url.pathname.split("/").pop() as "search" | "videos" | "channels";
    if (overrides[path]) return overrides[path]!;
    if (path === "search") return json({ items: [{ id: { videoId: "vid2" } }, { id: { videoId: "gone" } }, { id: { videoId: "vid1" } }] });
    if (path === "videos")
      return json({
        items: [
          { id: "vid1", snippet: { title: "รีวิวขนมใหม่ #ขนม", description: "ลองชิม #รีวิวขนม", publishedAt: "2026-11-01T10:00:00Z", channelId: "ch1" }, statistics: { viewCount: "1200", likeCount: "80", commentCount: "5" } },
          { id: "vid2", snippet: { title: "Mukbang", description: "", publishedAt: "2026-11-03T10:00:00Z", channelId: "ch2" }, statistics: { viewCount: "90000" } },
        ],
      });
    return json({ items: [{ id: "ch1", snippet: { customUrl: "@snackreviewer" } }] });
  });
  vi.stubGlobal("fetch", fetch);
  return calls;
}

afterEach(() => vi.unstubAllGlobals());

describe("Trend Monitoring on YouTube", () => {
  it("searches Thailand's most-viewed videos of the last two weeks for the term", async () => {
    const calls = fakeYouTube();
    await searchYouTubeTrend(envWith(), "hashtag", "#รีวิวขนม", 80, NOW);
    const search = calls.find((u) => u.pathname.endsWith("/search"))!;
    expect(search.searchParams.get("q")).toBe("#รีวิวขนม");
    expect(search.searchParams.get("type")).toBe("video");
    expect(search.searchParams.get("regionCode")).toBe("TH");
    expect(search.searchParams.get("order")).toBe("viewCount");
    expect(search.searchParams.get("publishedAfter")).toBe("2026-10-23T03:00:00.000Z");
    expect(search.searchParams.get("maxResults")).toBe("50");
    expect(calls.map((u) => u.pathname.split("/").pop())).toEqual(["search", "videos", "channels"]);

    calls.length = 0;
    await searchYouTubeTrend(envWith(), "keyword", "snack review", 20, NOW);
    expect(calls[0]!.searchParams.get("q")).toBe("snack review");
    expect(calls[0]!.searchParams.get("maxResults")).toBe("20");
  });

  it("returns posts in search order with their numbers, handle and hashtags", async () => {
    fakeYouTube();
    const res = await searchYouTubeTrend(envWith(), "keyword", "ขนม", 30, NOW);
    if ("error" in res) throw new Error(res.error);
    // "gone" was named by the search but not returned by videos.list: private or deleted, so it is dropped
    expect(res.posts.map((p) => p.platformPostId)).toEqual(["vid2", "vid1"]);
    const [mukbang, review] = res.posts;
    expect(review).toMatchObject({
      platform: "youtube",
      url: "https://www.youtube.com/watch?v=vid1",
      handle: "snackreviewer",
      views: 1200,
      likes: 80,
      comments: 5,
      shares: null,
      postedAt: Date.parse("2026-11-01T10:00:00Z"),
    });
    expect(review!.hashtags).toEqual(["ขนม", "รีวิวขนม"]);
    expect(mukbang).toMatchObject({ handle: null, views: 90000, likes: null, comments: null, caption: "Mukbang" });
  });

  it("stops at the daily allowance without calling YouTube", async () => {
    const calls = fakeYouTube();
    const store = new Map([[searchQuotaKey(NOW), String(YT_TREND_SEARCHES_PER_DAY)]]);
    const res = await searchYouTubeTrend(envWith(store), "keyword", "ขนม", 30, NOW);
    expect(res).toMatchObject({ error: "quota_reached" });
    expect(calls).toHaveLength(0);
  });

  it("counts every search against the allowance, including failed ones", async () => {
    fakeYouTube({ search: json({ error: {} }, 403) });
    const store = new Map<string, string>();
    const res = await searchYouTubeTrend(envWith(store), "keyword", "ขนม", 30, NOW);
    expect(res).toEqual({ error: "search_failed", detail: "search.list returned HTTP 403" });
    expect(JSON.stringify(res)).not.toContain(KEY);
    expect(store.get(searchQuotaKey(NOW))).toBe("1");
  });

  it("says so in plain words when a search fails or the allowance is used up", async () => {
    const noKey = await searchYouTubeTrend({ CONFIG: envWith().CONFIG } as unknown as Env, "keyword", "ขนม", 30, NOW);
    expect(noKey).toMatchObject({ error: "search_failed" });
    expect(failedTermText("search_failed")).toBe("YouTube did not answer this search.");
    expect(failedTermText("quota_reached")).toMatch(/allowance is used up/);
  });

  it("lets a watched term use YouTube alone or with the other platforms", () => {
    expect(termInputSchema.parse({ term: "ขนม", kind: "keyword", platforms: ["youtube"], category: "food_snacks" }).platforms).toEqual(["youtube"]);
    expect(termInputSchema.safeParse({ term: "ขนม", kind: "keyword", platforms: ["youtube", "instagram", "tiktok"], category: "food_snacks" }).success).toBe(true);
  });
});
