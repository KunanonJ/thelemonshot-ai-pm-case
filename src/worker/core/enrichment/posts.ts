import type { Platform } from "../db/schema";

// ③ post-level enrichment: which post a URL points at, and the metrics a source returns for it.
// Pure functions; field names follow the actors' documented output and are re-checked against real runs.
// A metric the source doesn't send stays null ("not reported"), never an estimate (FR-CO-2).

export type ParsedPost = { platform: Platform; postId: string; handle: string | null; url: string };

export type PostMetrics = { views: number | null; likes: number | null; comments: number | null; shares: number | null };

// What one refresh learned about one tracked post
export type PostResult = { status: "ok"; metrics: PostMetrics } | { status: "gone"; reason: string } | { status: "missing" };

export function parsePostUrl(input: string): ParsedPost | null {
  let u: URL;
  try {
    u = new URL(input.trim());
  } catch {
    return null;
  }
  const host = u.hostname.replace(/^(www|m|vm)\./, "");
  const parts = u.pathname.split("/").filter(Boolean);
  if (host === "instagram.com") {
    // /p/{code}/, /reel/{code}/ and /{user}/p/{code}/ all name the same shortcode
    const i = parts.findIndex((p) => p === "p" || p === "reel" || p === "reels" || p === "tv");
    const code = i >= 0 ? parts[i + 1] : undefined;
    if (!code) return null;
    return { platform: "instagram", postId: code, handle: i > 0 ? parts[0]!.toLowerCase() : null, url: `https://www.instagram.com/p/${code}/` };
  }
  if (host === "tiktok.com") {
    const handle = parts[0]?.startsWith("@") ? parts[0].slice(1).toLowerCase() : null;
    const i = parts.findIndex((p) => p === "video" || p === "photo");
    const id = i >= 0 ? parts[i + 1] : undefined;
    if (!id || !/^\d+$/.test(id) || !handle) return null;
    return { platform: "tiktok", postId: id, handle, url: `https://www.tiktok.com/@${handle}/video/${id}` };
  }
  if (host === "youtube.com" || host === "youtu.be") {
    const id = host === "youtu.be" ? parts[0] : parts[0] === "shorts" || parts[0] === "live" ? parts[1] : u.searchParams.get("v");
    if (!id || !/^[\w-]{6,20}$/.test(id)) return null;
    return { platform: "youtube", postId: id, handle: null, url: `https://www.youtube.com/watch?v=${id}` };
  }
  return null;
}

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const obj = (v: unknown): Record<string, unknown> => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {});

// apify/instagram-scraper with resultsType "posts": one item per post, keyed by shortCode.
// likesCount is -1 when the creator hides likes; that is "not reported", not zero.
export function instagramPostResults(items: unknown[], postIds: string[]): Map<string, PostResult> {
  const out = new Map<string, PostResult>(postIds.map((id) => [id, { status: "missing" } as PostResult]));
  for (const raw of items) {
    const item = obj(raw);
    const code = typeof item.shortCode === "string" ? item.shortCode : null;
    if (!code || !out.has(code)) continue;
    const likes = num(item.likesCount);
    out.set(code, {
      status: "ok",
      metrics: {
        views: num(item.videoViewCount) ?? num(item.videoPlayCount),
        likes: likes !== null && likes >= 0 ? likes : null,
        comments: num(item.commentsCount),
        shares: null,
      },
    });
  }
  return out;
}

// clockworks/tiktok-scraper with postURLs: one item per video; a removed or private video comes back as an
// error item with errorCode POST_NOT_FOUND_OR_PRIVATE
export function tiktokPostResults(items: unknown[], posts: { postId: string; url: string }[]): Map<string, PostResult> {
  const out = new Map<string, PostResult>(posts.map((p) => [p.postId, { status: "missing" } as PostResult]));
  const idFromUrl = (u: unknown) => (typeof u === "string" ? (u.match(/\/(?:video|photo)\/(\d+)/)?.[1] ?? null) : null);
  for (const raw of items) {
    const item = obj(raw);
    if (typeof item.errorCode === "string") {
      const id = idFromUrl(item.url) ?? idFromUrl(item.input);
      if (id && out.has(id) && item.errorCode === "POST_NOT_FOUND_OR_PRIVATE") out.set(id, { status: "gone", reason: "Removed or made private" });
      continue;
    }
    const id = typeof item.id === "string" ? item.id : (idFromUrl(item.webVideoUrl) ?? idFromUrl(item.submittedVideoUrl));
    if (!id || !out.has(id)) continue;
    out.set(id, {
      status: "ok",
      metrics: { views: num(item.playCount), likes: num(item.diggCount), comments: num(item.commentCount), shares: num(item.shareCount) },
    });
  }
  return out;
}

// YouTube videos.list leaves out deleted and private videos, which makes the absence an explicit answer
export function youtubePostResults(videos: { id: string; views: number | null; likes: number | null; comments: number | null }[], postIds: string[]): Map<string, PostResult> {
  const found = new Map(videos.map((v) => [v.id, v]));
  return new Map(
    postIds.map((id): [string, PostResult] => {
      const v = found.get(id);
      return [id, v ? { status: "ok", metrics: { views: v.views, likes: v.likes, comments: v.comments, shares: null } } : { status: "gone", reason: "Deleted or private on YouTube" }];
    }),
  );
}
