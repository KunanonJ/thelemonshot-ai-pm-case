import { clusterPosts } from "./cluster";
import type { UniquePost } from "./dedupe";
import { EXEMPLAR_COUNT, MIN_SUPPORT, type SourceNote, type TrendExemplar, type TrendSample, type TrendTheme } from "./model";
import { failedTermText } from "./failures";
import { byEngagement, engagementOf, themeStats, windowOf } from "./stats";
import { platformName } from "./terms";

// The deterministic brief: which posts make each theme, the numbers behind it, and the sentences the model
// may replace. Everything here works without the model (FR-CORE-16, AC-CO-4 pattern).

export type TermRow = {
  id: string;
  label: string;
  category: string;
  platform: string;
  status: string;
  postCount: number | null;
  // Both are plain sentences or failure codes (failures.ts), never raw Apify text
  note: string | null;
  error: string | null;
};

export type BriefBuild = { themes: TrendTheme[]; exemplars: TrendExemplar[]; sample: TrendSample; sources: SourceNote[]; flags: string[] };

// FR-TM-2: the wording a weak theme always carries, whatever the model wrote
export const WEAK_SENTENCE = "Only a few posts support this theme, so it is a weak signal.";

// Pitch angle before the model answers: a template per brand category (FR-TM-4 wording stays within the sample)
export function templateAngle(category: string, seedTag: string): string {
  return `Suggested for ${category} briefs: a creator post built around #${seedTag}, with the sample posts linked as references.`;
}

export function buildTrendBrief(input: { terms: TermRow[]; posts: UniquePost[]; hits: number; duplicatesRemoved: number; watched: string[] }): BriefBuild {
  const window = windowOf(input.posts);
  const byKey = new Map(input.posts.map((p) => [p.key, p]));

  const themes: TrendTheme[] = clusterPosts(input.posts, input.watched).map((c, i) => {
    const members = c.postKeys.map((k) => byKey.get(k)!).sort(byEngagement);
    const s = themeStats(members, input.posts, window);
    const weakSignal = members.length < MIN_SUPPORT;
    const categories = [...new Set(members.flatMap((m) => m.categories))].sort();
    return {
      id: `theme-${i + 1}`,
      seedTag: c.seedTag,
      tags: c.tags,
      name: `Posts tagged #${c.seedTag}`,
      summary: themeSummary(c.seedTag, members.length, input.posts.length, s, weakSignal),
      postCount: members.length,
      weakSignal,
      rising: s.rising,
      categories,
      platforms: [...new Set(members.map((m) => m.platform))].sort(),
      stats: {
        shareOfPostsPct: s.shareOfPostsPct,
        datedPosts: s.datedPosts,
        recentPosts: s.recentPosts,
        recentSharePct: s.recentSharePct,
        topThreeEngagementSharePct: s.topThreeEngagementSharePct,
      },
      pitchAngles: categories.map((category) => ({ category, angle: templateAngle(category, c.seedTag), source: "template" as const })),
      // FR-TM-2: every supporting post is cited with its own URL
      sources: members.map((m) => ({ postId: m.key, platform: m.platform, url: m.url, handle: m.handle, postedAt: m.postedAt })),
    };
  });

  const themeOf = new Map<string, string>();
  for (const t of themes) for (const src of t.sources) if (!themeOf.has(src.postId)) themeOf.set(src.postId, t.id);
  const exemplars: TrendExemplar[] = input.posts
    .filter((p) => themeOf.has(p.key))
    .sort(byEngagement)
    .slice(0, EXEMPLAR_COUNT)
    .map((p) => ({ postId: p.key, themeId: themeOf.get(p.key)!, platform: p.platform, url: p.url, handle: p.handle, postedAt: p.postedAt, engagement: engagementOf(p) }));

  const postsByPlatform: Record<string, number> = {};
  for (const p of input.posts) postsByPlatform[p.platform] = (postsByPlatform[p.platform] ?? 0) + 1;
  const sample: TrendSample = {
    hits: input.hits,
    uniquePosts: input.posts.length,
    duplicatesRemoved: input.duplicatesRemoved,
    postsByPlatform,
    otherPosts: input.posts.length - themeOf.size,
    window,
    termRuns: input.terms.length,
    zeroSignalRuns: input.terms.filter((t) => t.status === "ok" && (t.postCount ?? 0) === 0).map((t) => `${t.label} on ${platformName(t.platform)}`),
    failedRuns: input.terms.filter((t) => t.status === "failed").map((t) => `${t.label} on ${platformName(t.platform)}`),
  };

  // BR-TM-1 and BR-TM-2: an empty term says so; a failed platform degrades the brief to the other one, with a note
  const sources: SourceNote[] = [];
  for (const t of input.terms) {
    const covered = input.terms
      .filter((o) => o.label === t.label && o.id !== t.id && o.status === "ok" && (o.postCount ?? 0) > 0)
      .map((o) => platformName(o.platform));
    if (t.status === "failed") {
      const coverage = covered.length ? `${t.label} is covered by ${covered.join(" and ")} only.` : `${t.label} has no posts in this pull.`;
      sources.push({ level: "warning", pullTermId: t.id, text: `${platformName(t.platform)} pull for ${t.label} failed. ${failedTermText(t.error)} ${coverage}` });
    } else if (t.status === "ok" && (t.postCount ?? 0) === 0) {
      sources.push({ level: "info", pullTermId: t.id, text: `No signal in this pull for ${t.label} on ${platformName(t.platform)}.${t.note ? ` ${t.note}` : ""}` });
    }
  }

  const flags: string[] = [];
  if (input.posts.length === 0) flags.push("no_posts");
  if (sample.zeroSignalRuns.length) flags.push(`zero_signal_runs:${sample.zeroSignalRuns.length}`);
  if (sample.failedRuns.length) flags.push(`source_failed:${sample.failedRuns.length}`);
  const weak = themes.filter((t) => t.weakSignal).length;
  if (weak) flags.push(`weak_signal_themes:${weak}`);

  return { themes, exemplars, sample, sources, flags };
}

function themeSummary(seed: string, n: number, total: number, s: ReturnType<typeof themeStats>, weak: boolean): string {
  const parts = [`In this pull, ${n} of the ${total} unique posts use #${seed}.`];
  if (s.recentSharePct !== null && s.datedPosts >= MIN_SUPPORT) {
    parts.push(`${s.recentPosts} of its ${s.datedPosts} dated posts fall in the newer half of the pulled window.`);
  }
  if (weak) parts.push(WEAK_SENTENCE);
  return parts.join(" ");
}
