import { localOverride, readSecret } from "../../core/env";
import { fetchWithRetry } from "../../core/http";
import { hashtagsOf, type ParsedPost } from "./parse";
import type { TrendTermKind } from "./schema";

// ② Trend Monitoring on YouTube, through the free YouTube Data API v3 instead of Apify. One term is one search.list
// call (100 of the 10,000 daily quota units) for the most-viewed videos in Thailand over the last two weeks, then
// videos.list for their numbers and channels.list for the channel handles (1 unit each). It answers in seconds, so a
// pull runs it inline. Trend searches have their own daily allowance, so they can never use up the quota that creator
// enrichment and campaign refreshes need (about 3 units per creator and 1 per 50 tracked videos).
export const YT_TREND_SEARCHES_PER_DAY = 40;
export const YT_TREND_WINDOW_DAYS = 14;
export const YT_MAX_RESULTS = 50; // search.list returns at most 50 videos per call
export const YT_TREND_NOTE = `Live YouTube search: the most-viewed videos in Thailand from the last ${YT_TREND_WINDOW_DAYS} days.`;

const DAY_MS = 86_400_000;
const CAPTION_MAX = 500;

// YouTube resets the quota at midnight Pacific time; UTC-8 is close enough for a soft cap
export const searchQuotaKey = (now: number) => `yt:trend-searches:${new Date(now - 8 * 3_600_000).toISOString().slice(0, 10)}`;

export type YouTubeTrendResult = { posts: ParsedPost[] } | { error: "quota_reached" | "search_failed"; detail: string };

type Snippet = { title?: string; description?: string; publishedAt?: string; channelId?: string };
type Video = { id?: string; snippet?: Snippet; statistics?: { viewCount?: string; likeCount?: string; commentCount?: string } };

export async function searchYouTubeTrend(env: Env, kind: TrendTermKind, term: string, cap: number, now = Date.now()): Promise<YouTubeTrendResult> {
  const key = readSecret(env, "YOUTUBE_API_KEY");
  if (!key) return { error: "search_failed", detail: "YOUTUBE_API_KEY is not set" };
  const quotaKey = searchQuotaKey(now);
  const used = Number((await env.CONFIG.get(quotaKey)) ?? 0);
  if (used >= YT_TREND_SEARCHES_PER_DAY) return { error: "quota_reached", detail: `${used} trend searches already today` };
  // Counted before the call, so a search that fails still counts: the quota is spent either way
  await env.CONFIG.put(quotaKey, String(used + 1), { expirationTtl: 2 * 86_400 });

  const base = localOverride(env, "YOUTUBE_API_URL", "https://www.googleapis.com/youtube/v3");
  // Error details never include the request URL, because it carries the key
  const get = (path: string, params: Record<string, string>) => fetchWithRetry(`${base}/${path}?${new URLSearchParams({ ...params, key }).toString()}`);
  const clean = term.trim().replace(/^#+/, "");

  const search = await get("search", {
    part: "snippet",
    type: "video",
    q: kind === "hashtag" ? `#${clean}` : clean,
    regionCode: "TH",
    relevanceLanguage: "th",
    order: "viewCount",
    publishedAfter: new Date(now - YT_TREND_WINDOW_DAYS * DAY_MS).toISOString(),
    maxResults: String(Math.max(1, Math.min(cap, YT_MAX_RESULTS))),
  });
  if (!search.ok) return { error: "search_failed", detail: `search.list returned HTTP ${search.status}` };
  const ids = (((await search.json()) as { items?: { id?: { videoId?: string } }[] }).items ?? []).flatMap((i) => (i.id?.videoId ? [i.id.videoId] : []));
  if (ids.length === 0) return { posts: [] };

  const vRes = await get("videos", { part: "snippet,statistics", id: ids.join(",") });
  if (!vRes.ok) return { error: "search_failed", detail: `videos.list returned HTTP ${vRes.status}` };
  const videos = new Map((((await vRes.json()) as { items?: Video[] }).items ?? []).flatMap((v) => (v.id ? [[v.id, v] as const] : [])));

  // Handles make the brief's "who posted it" readable; without them a post still counts, with no handle
  const channelIds = [...new Set([...videos.values()].flatMap((v) => (v.snippet?.channelId ? [v.snippet.channelId] : [])))];
  const handles = new Map<string, string>();
  if (channelIds.length) {
    const cRes = await get("channels", { part: "snippet", id: channelIds.slice(0, 50).join(","), maxResults: "50" });
    if (cRes.ok) {
      for (const ch of ((await cRes.json()) as { items?: { id?: string; snippet?: { customUrl?: string } }[] }).items ?? []) {
        const handle = ch.snippet?.customUrl?.replace(/^@/, "");
        if (ch.id && handle) handles.set(ch.id, handle);
      }
    }
  }

  // Search order is kept: most viewed first. A video the search named but videos.list didn't return is private or gone
  const posts = ids.flatMap((id): ParsedPost[] => {
    const v = videos.get(id);
    if (!v) return [];
    const title = v.snippet?.title?.trim() ?? "";
    const description = v.snippet?.description?.trim() ?? "";
    const text = [title, description].filter(Boolean).join("\n");
    const postedAt = v.snippet?.publishedAt ? Date.parse(v.snippet.publishedAt) : NaN;
    return [
      {
        platform: "youtube",
        platformPostId: id,
        url: `https://www.youtube.com/watch?v=${id}`,
        handle: (v.snippet?.channelId && handles.get(v.snippet.channelId)) || null,
        caption: text ? text.slice(0, CAPTION_MAX) : null,
        hashtags: hashtagsOf([], text),
        postedAt: Number.isFinite(postedAt) ? postedAt : null,
        likes: count(v.statistics?.likeCount),
        comments: count(v.statistics?.commentCount),
        views: count(v.statistics?.viewCount),
        shares: null,
      },
    ];
  });
  return { posts };
}

function count(v: string | undefined): number | null {
  if (v === undefined) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
