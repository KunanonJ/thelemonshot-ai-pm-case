import type { TrendPlatform } from "./schema";

// Pure functions from Apify dataset items to one post shape. Field names were checked against the actors'
// Store pages (2 Nov 2026): Instagram hashtag scraper items carry shortCode, url, ownerUsername, caption,
// hashtags, timestamp, likesCount, commentsCount, videoPlayCount/videoViewCount. TikTok scraper items carry
// id, webVideoUrl, text, createTimeISO, playCount, diggCount, commentCount, shareCount, hashtags[].name,
// authorMeta.name, and error items with errorCode. A metric the source leaves out stays null (HR-3).

export type ParsedPost = {
  platform: TrendPlatform;
  platformPostId: string;
  url: string;
  handle: string | null;
  caption: string | null;
  hashtags: string[];
  postedAt: number | null;
  likes: number | null;
  comments: number | null;
  views: number | null;
  shares: number | null;
};

// errorCodes are the actor's own error items (for example a search with no results); they are notes, not posts
export type ParseResult = { posts: ParsedPost[]; errorCodes: string[] };

const CAPTION_MAX = 500;

export function parseItems(platform: TrendPlatform, items: unknown[]): ParseResult {
  return platform === "instagram" ? parseInstagramItems(items) : parseTikTokItems(items);
}

export function parseInstagramItems(items: unknown[]): ParseResult {
  const posts: ParsedPost[] = [];
  const errorCodes: string[] = [];
  for (const raw of items) {
    const item = obj(raw);
    const err = str(item.errorCode) ?? str(item.error);
    if (err) errorCodes.push(err);
    const shortCode = str(item.shortCode);
    const id = shortCode ?? str(item.id);
    const given = str(item.url);
    // The link must be the post itself: keep the actor's URL when it names the post, otherwise build the canonical one
    const url = shortCode ? (given?.includes(shortCode) ? given : `https://www.instagram.com/p/${shortCode}/`) : given;
    if (!id || !url || (err && !shortCode)) continue;
    const caption = str(item.caption);
    const likes = num(item.likesCount);
    posts.push({
      platform: "instagram",
      platformPostId: id,
      url,
      handle: str(item.ownerUsername)?.toLowerCase() ?? null,
      caption: caption ? caption.slice(0, CAPTION_MAX) : null,
      hashtags: hashtagsOf(arr(item.hashtags).map(str), caption),
      postedAt: time(item.timestamp),
      // -1 means the creator hid the like count: a gap, not zero
      likes: likes !== null && likes >= 0 ? likes : null,
      comments: num(item.commentsCount),
      views: num(item.videoViewCount) ?? num(item.videoPlayCount),
      shares: null,
    });
  }
  return { posts, errorCodes: unique(errorCodes) };
}

export function parseTikTokItems(items: unknown[]): ParseResult {
  const posts: ParsedPost[] = [];
  const errorCodes: string[] = [];
  for (const raw of items) {
    const item = obj(raw);
    if (typeof item.errorCode === "string") {
      errorCodes.push(item.errorCode);
      continue;
    }
    const id = str(item.id);
    const handle = str(obj(item.authorMeta).name)?.toLowerCase() ?? null;
    const given = str(item.webVideoUrl);
    // Keep the actor's link when it names the video; otherwise build it from the handle and ID
    const url = id && given?.includes(id) ? given : id && handle ? `https://www.tiktok.com/@${handle}/video/${id}` : null;
    if (!id || !url) continue;
    const caption = str(item.text);
    const created = time(item.createTimeISO) ?? (num(item.createTime) !== null ? (num(item.createTime) as number) * 1000 : null);
    posts.push({
      platform: "tiktok",
      platformPostId: id,
      url,
      handle,
      caption: caption ? caption.slice(0, CAPTION_MAX) : null,
      hashtags: hashtagsOf(arr(item.hashtags).map((h) => str(obj(h).name)), caption),
      postedAt: created,
      likes: num(item.diggCount),
      comments: num(item.commentCount),
      views: num(item.playCount),
      shares: num(item.shareCount),
    });
  }
  return { posts, errorCodes: unique(errorCodes) };
}

// Tags come from the actor's list and from the caption; Thai vowel and tone marks are combining marks (\p{M})
export function hashtagsOf(listed: (string | null)[], caption: string | null): string[] {
  const fromList = listed.flatMap((t) => (t ? [normTag(t)] : []));
  const fromCaption = [...(caption ?? "").matchAll(/#([\p{L}\p{M}\p{N}_]+)/gu)].map((m) => normTag(m[1]!));
  return unique([...fromList, ...fromCaption].filter((t) => t.length > 0));
}

const normTag = (t: string) => t.trim().replace(/^#/, "").toLowerCase();

function obj(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}
function arr(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}
function str(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? v.trim() : typeof v === "number" ? String(v) : null;
}
function num(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() && Number.isFinite(Number(v))) return Number(v);
  return null;
}
function time(v: unknown): number | null {
  if (typeof v !== "string") return null;
  const t = Date.parse(v);
  return Number.isFinite(t) ? t : null;
}
function unique<T>(values: T[]): T[] {
  return [...new Set(values)];
}
