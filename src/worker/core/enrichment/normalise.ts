import type { Platform } from "../db/schema";

// Pure functions from source payloads to one shape. Field names come from each source's documented
// output (Apify actor READMEs, YouTube Data API v3) and are re-checked against the Phase 0 samples.
// Every value is optional: a field a source stops sending becomes null, never an estimate (HR-3).

export type NormalisedPost = {
  platformPostId: string;
  url: string | null;
  postedAt: number | null;
  caption: string | null;
  views: number | null;
  likes: number | null;
  comments: number | null;
  shares: number | null;
  hashtags: string[];
};

export type NormalisedProfile = {
  platform: Platform;
  handle: string;
  displayName: string | null;
  followers: number | null;
  following: number | null;
  postsCount: number | null;
  verified: boolean | null;
  isPrivate: boolean;
  posts: NormalisedPost[];
};

export type SnapshotStats = {
  engagementRate: number | null;
  medianViews: number | null;
  avgLikes: number | null;
  avgComments: number | null;
  recentPosts: number;
  topHashtags: string[];
};

export type DiscoveredCreator = {
  platform: "instagram" | "tiktok";
  handle: string;
  displayName: string | null;
  followers: number | null;
  verified: boolean | null;
  isPrivate: boolean;
  hits: number;
};

const CAPTION_MAX = 500;

// ---------- Instagram: apify/instagram-profile-scraper (one item per profile) ----------

export function normaliseInstagram(items: unknown[]): NormalisedProfile[] {
  return items.flatMap((raw) => {
    const item = obj(raw);
    const handle = str(item.username);
    if (!handle) return [];
    const posts = arr(item.latestPosts).flatMap((p): NormalisedPost[] => {
      const post = obj(p);
      const id = str(post.id) ?? str(post.shortCode);
      if (!id) return [];
      const likes = num(post.likesCount);
      const caption = str(post.caption);
      return [
        {
          platformPostId: id,
          url: str(post.url),
          postedAt: time(post.timestamp),
          caption: caption ? caption.slice(0, CAPTION_MAX) : null,
          views: num(post.videoViewCount) ?? num(post.videoPlayCount),
          // -1 means the creator hid the like count
          likes: likes !== null && likes >= 0 ? likes : null,
          comments: num(post.commentsCount),
          shares: null,
          hashtags: hashtagsOf(post.hashtags, caption),
        },
      ];
    });
    return [
      {
        platform: "instagram" as const,
        handle: handle.toLowerCase(),
        displayName: str(item.fullName),
        followers: num(item.followersCount),
        following: num(item.followsCount),
        postsCount: num(item.postsCount),
        verified: bool(item.verified),
        isPrivate: bool(item.private) === true,
        posts,
      },
    ];
  });
}

// ---------- TikTok: clockworks/tiktok-profile-scraper (one item per video, author in authorMeta) ----------

export function normaliseTikTok(items: unknown[]): NormalisedProfile[] {
  const byHandle = new Map<string, NormalisedProfile>();
  for (const raw of items) {
    const item = obj(raw);
    const author = obj(item.authorMeta);
    const handle = str(author.name)?.toLowerCase();
    if (!handle) continue;
    let profile = byHandle.get(handle);
    if (!profile) {
      profile = {
        platform: "tiktok",
        handle,
        displayName: str(author.nickName),
        followers: num(author.fans),
        following: num(author.following),
        postsCount: num(author.video),
        verified: bool(author.verified),
        isPrivate: bool(author.privateAccount) === true,
        posts: [],
      };
      byHandle.set(handle, profile);
    }
    const id = str(item.id);
    if (!id) continue;
    const caption = str(item.text);
    profile.posts.push({
      platformPostId: id,
      url: str(item.webVideoUrl),
      postedAt: time(item.createTimeISO) ?? secondsToMs(num(item.createTime)),
      caption: caption ? caption.slice(0, CAPTION_MAX) : null,
      views: num(item.playCount),
      likes: num(item.diggCount),
      comments: num(item.commentCount),
      shares: num(item.shareCount),
      hashtags: hashtagsOf(arr(item.hashtags).map((h) => obj(h).name), caption),
    });
  }
  return [...byHandle.values()];
}

// ---------- YouTube Data API v3: channels.list + videos.list ----------

export function normaliseYouTube(handle: string, channel: unknown, videos: unknown[]): NormalisedProfile | null {
  const ch = obj(channel);
  if (!str(ch.id)) return null;
  const stats = obj(ch.statistics);
  const posts = videos.flatMap((raw): NormalisedPost[] => {
    const v = obj(raw);
    const id = str(v.id);
    if (!id) return [];
    const snippet = obj(v.snippet);
    const vs = obj(v.statistics);
    const title = str(snippet.title);
    return [
      {
        platformPostId: id,
        url: `https://www.youtube.com/watch?v=${id}`,
        postedAt: time(snippet.publishedAt),
        caption: title ? title.slice(0, CAPTION_MAX) : null,
        views: num(vs.viewCount),
        likes: num(vs.likeCount),
        comments: num(vs.commentCount),
        shares: null,
        hashtags: arr(snippet.tags).flatMap((t) => (typeof t === "string" ? [t.toLowerCase()] : [])).slice(0, 15),
      },
    ];
  });
  return {
    platform: "youtube",
    handle: handle.replace(/^@/, "").toLowerCase(),
    displayName: str(obj(ch.snippet).title),
    // A hidden subscriber count is a gap, not zero (FR-CORE-6)
    followers: bool(stats.hiddenSubscriberCount) === true ? null : num(stats.subscriberCount),
    following: null,
    postsCount: num(stats.videoCount),
    verified: null,
    isPrivate: false,
    posts,
  };
}

// ---------- snapshot statistics ----------

// Engagement rate, per platform (shown in "how scoring works"):
//   Instagram: (likes + comments) / followers, averaged over recent posts
//   TikTok:    (likes + comments + shares) / views, averaged over recent videos
//   YouTube:   (likes + comments) / views, averaged over recent videos
export function computeStats(profile: NormalisedProfile): SnapshotStats {
  const posts = profile.posts;
  const rates: number[] = [];
  for (const p of posts) {
    if (profile.platform === "instagram") {
      if (profile.followers && p.likes !== null && p.comments !== null) rates.push(((p.likes + p.comments) / profile.followers) * 100);
    } else if (p.views && p.likes !== null && p.comments !== null) {
      rates.push(((p.likes + p.comments + (p.shares ?? 0)) / p.views) * 100);
    }
  }
  const views = posts.flatMap((p) => (p.views !== null ? [p.views] : []));
  const likes = posts.flatMap((p) => (p.likes !== null ? [p.likes] : []));
  const comments = posts.flatMap((p) => (p.comments !== null ? [p.comments] : []));
  return {
    engagementRate: rates.length ? round(mean(rates), 3) : null,
    medianViews: views.length ? median(views) : null,
    avgLikes: likes.length ? round(mean(likes), 1) : null,
    avgComments: comments.length ? round(mean(comments), 1) : null,
    recentPosts: posts.length,
    topHashtags: topCounts(posts.flatMap((p) => p.hashtags), 10),
  };
}

// ---------- discovery: who posts under the category hashtags ----------

export function discoverFromInstagramPosts(items: unknown[]): DiscoveredCreator[] {
  const found = new Map<string, DiscoveredCreator>();
  for (const raw of items) {
    const item = obj(raw);
    const handle = str(item.ownerUsername)?.toLowerCase();
    if (!handle) continue;
    const prev = found.get(handle);
    if (prev) prev.hits += 1;
    else found.set(handle, { platform: "instagram", handle, displayName: str(item.ownerFullName), followers: null, verified: null, isPrivate: false, hits: 1 });
  }
  return [...found.values()];
}

export function discoverFromTikTokVideos(items: unknown[]): DiscoveredCreator[] {
  const found = new Map<string, DiscoveredCreator>();
  for (const raw of items) {
    const author = obj(obj(raw).authorMeta);
    const handle = str(author.name)?.toLowerCase();
    if (!handle) continue;
    const prev = found.get(handle);
    if (prev) prev.hits += 1;
    else
      found.set(handle, {
        platform: "tiktok",
        handle,
        displayName: str(author.nickName),
        followers: num(author.fans),
        verified: bool(author.verified),
        isPrivate: bool(author.privateAccount) === true,
        hits: 1,
      });
  }
  return [...found.values()];
}

// ---------- helpers ----------

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
function bool(v: unknown): boolean | null {
  return typeof v === "boolean" ? v : null;
}
function time(v: unknown): number | null {
  if (typeof v !== "string") return null;
  const t = Date.parse(v);
  return Number.isFinite(t) ? t : null;
}
function secondsToMs(v: number | null): number | null {
  return v === null ? null : v * 1000;
}
function hashtagsOf(listed: unknown, caption: string | null): string[] {
  const fromList = arr(listed).flatMap((h) => (typeof h === "string" && h.trim() ? [h.trim().replace(/^#/, "").toLowerCase()] : []));
  if (fromList.length) return fromList;
  // \p{M} matters for Thai: vowel and tone marks are combining marks, not letters
  return [...(caption ?? "").matchAll(/#([\p{L}\p{M}\p{N}_]+)/gu)].map((m) => m[1]!.toLowerCase());
}
export function mean(values: number[]): number {
  return values.reduce((a, b) => a + b, 0) / values.length;
}
export function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}
function round(v: number, digits: number): number {
  const f = 10 ** digits;
  return Math.round(v * f) / f;
}
function topCounts(values: string[], limit: number): string[] {
  const counts = new Map<string, number>();
  for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1);
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
    .slice(0, limit)
    .map(([v]) => v);
}
