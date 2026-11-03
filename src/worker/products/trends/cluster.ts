import type { UniquePost } from "./dedupe";

// Deterministic grouping on hashtags (the brief's theme seeds). The model names the themes; it never decides membership.

export const MAX_THEMES = 8;
// A tag shared by fewer posts than this cannot seed a theme (a theme needs two posts to exist at all)
const SEED_MIN_POSTS = 2;
// Generic tags that say nothing about a theme (my call; kept short on purpose)
export const STOP_TAGS = new Set([
  "fyp",
  "foryou",
  "foryoupage",
  "viral",
  "trending",
  "reels",
  "reel",
  "tiktok",
  "tiktokthailand",
  "instagram",
  "instagood",
  "explore",
  "love",
  "like",
  "follow",
  "ad",
  "ads",
  "sponsored",
]);

export type Cluster = { seedTag: string; tags: string[]; postKeys: string[] };

export function postTags(post: UniquePost, watched: Set<string>): string[] {
  return [...new Set(post.hashtags)].filter((t) => t.length > 1 && !watched.has(t) && !STOP_TAGS.has(t) && !/^\d+$/.test(t));
}

// Greedy and deterministic: the most-used tag seeds a theme first, and a post joins the first theme it fits
export function clusterPosts(posts: UniquePost[], watched: string[]): Cluster[] {
  const watchedSet = new Set(watched.map((w) => w.toLowerCase()));
  const tagsByKey = new Map(posts.map((p) => [p.key, postTags(p, watchedSet)]));
  const keysByTag = new Map<string, string[]>();
  for (const [key, tags] of tagsByKey) for (const t of tags) keysByTag.set(t, [...(keysByTag.get(t) ?? []), key]);

  const seeds = [...keysByTag.entries()]
    .filter(([, keys]) => keys.length >= SEED_MIN_POSTS)
    .sort((a, b) => b[1].length - a[1].length || compare(a[0], b[0]))
    .map(([tag]) => tag);

  const assigned = new Set<string>();
  const clusters: Cluster[] = [];
  for (const seed of seeds) {
    if (clusters.length >= MAX_THEMES) break;
    const members = (keysByTag.get(seed) ?? []).filter((k) => !assigned.has(k)).sort(compare);
    if (members.length < SEED_MIN_POSTS) continue;
    for (const k of members) assigned.add(k);
    const counts = new Map<string, number>();
    for (const k of members) for (const t of tagsByKey.get(k) ?? []) if (t !== seed) counts.set(t, (counts.get(t) ?? 0) + 1);
    const co = [...counts.entries()].sort((a, b) => b[1] - a[1] || compare(a[0], b[0])).slice(0, 4).map(([t]) => t);
    clusters.push({ seedTag: seed, tags: [seed, ...co], postKeys: members });
  }
  return clusters;
}

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
