import type { ParsedPost } from "./parse";
import type { TrendPlatform } from "./schema";

// One hit is one post as one term returned it in one pull
export type TrendHit = { pullTermId: string; label: string; category: string; postRowId: string; post: ParsedPost };

export type UniquePost = Omit<ParsedPost, "platform"> & {
  platform: TrendPlatform;
  id: string;
  key: string;
  matchedTerms: string[];
  categories: string[];
  hits: number;
};

// FR-TM-1: a post is identified by platform and platform post ID. The same post found by two terms, or twice
// by one term, counts once. Metrics take the highest value seen, so a missing value never wipes a real one.
export function dedupePosts(hits: TrendHit[]): { posts: UniquePost[]; duplicatesRemoved: number } {
  const byKey = new Map<string, UniquePost>();
  for (const h of hits) {
    const key = `${h.post.platform}:${h.post.platformPostId}`;
    const prev = byKey.get(key);
    if (!prev) {
      byKey.set(key, { ...h.post, id: h.postRowId, key, matchedTerms: [h.label], categories: [h.category], hits: 1, hashtags: [...h.post.hashtags] });
      continue;
    }
    prev.hits++;
    if (!prev.matchedTerms.includes(h.label)) prev.matchedTerms.push(h.label);
    if (!prev.categories.includes(h.category)) prev.categories.push(h.category);
    prev.hashtags = [...new Set([...prev.hashtags, ...h.post.hashtags])];
    prev.likes = maxOf(prev.likes, h.post.likes);
    prev.comments = maxOf(prev.comments, h.post.comments);
    prev.views = maxOf(prev.views, h.post.views);
    prev.shares = maxOf(prev.shares, h.post.shares);
    prev.caption = prev.caption ?? h.post.caption;
    prev.handle = prev.handle ?? h.post.handle;
    prev.postedAt = prev.postedAt ?? h.post.postedAt;
  }
  const posts = [...byKey.values()].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  return { posts, duplicatesRemoved: hits.length - posts.length };
}

function maxOf(a: number | null, b: number | null): number | null {
  if (a === null) return b;
  if (b === null) return a;
  return Math.max(a, b);
}
