import type { UniquePost } from "./dedupe";
import { MIN_SUPPORT, RISING_RECENT_SHARE, type TrendThemeStats } from "./model";

// Growth signals are computed inside the pulled set only (FR-TM-3). "Recent" means the newer half of the window
// that the pulled posts span; nothing here says anything about the platform as a whole.

export type WindowSpan = { from: number; to: number };

export function windowOf(posts: UniquePost[]): WindowSpan | null {
  const dates = posts.flatMap((p) => (p.postedAt === null ? [] : [p.postedAt]));
  if (dates.length < 2) return null;
  const from = Math.min(...dates);
  const to = Math.max(...dates);
  return from < to ? { from, to } : null;
}

export function themeStats(members: UniquePost[], all: UniquePost[], window: WindowSpan | null): TrendThemeStats & { rising: boolean } {
  const shareOfPostsPct = all.length ? round1((members.length / all.length) * 100) : 0;

  const dated = members.filter((p) => p.postedAt !== null);
  let recentPosts = 0;
  let recentSharePct: number | null = null;
  if (window && dated.length >= 2) {
    const mid = (window.from + window.to) / 2;
    recentPosts = dated.filter((p) => (p.postedAt as number) >= mid).length;
    recentSharePct = Math.round((recentPosts / dated.length) * 100);
  }

  // Engagement concentration: how much of the theme's likes and comments the top three posts hold.
  // Needs at least three posts with engagement figures, and posts with hidden likes are left out, not counted as zero.
  const engaged = members.filter((p) => p.likes !== null || p.comments !== null);
  const values = engaged.map((p) => (p.likes ?? 0) + (p.comments ?? 0)).sort((a, b) => b - a);
  const total = values.reduce((a, b) => a + b, 0);
  const topThreeEngagementSharePct = engaged.length >= 3 && total > 0 ? Math.round((values.slice(0, 3).reduce((a, b) => a + b, 0) / total) * 100) : null;

  return {
    shareOfPostsPct,
    datedPosts: dated.length,
    recentPosts,
    recentSharePct,
    topThreeEngagementSharePct,
    rising: recentSharePct !== null && recentSharePct >= RISING_RECENT_SHARE && members.length >= MIN_SUPPORT,
  };
}

export function engagementOf(p: UniquePost): number | null {
  return p.likes === null && p.comments === null ? null : (p.likes ?? 0) + (p.comments ?? 0);
}

// Highest engagement first; ties go to the newer post, then to the key
export function byEngagement(a: UniquePost, b: UniquePost): number {
  const ea = engagementOf(a) ?? -1;
  const eb = engagementOf(b) ?? -1;
  if (ea !== eb) return eb - ea;
  const ta = a.postedAt ?? -1;
  const tb = b.postedAt ?? -1;
  if (ta !== tb) return tb - ta;
  return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
}

function round1(v: number): number {
  return Math.round(v * 10) / 10;
}
