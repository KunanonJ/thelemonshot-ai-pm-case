import { z } from "zod";
import { allowedFigures } from "../../core/figures";
import { templateAngle, WEAK_SENTENCE, type TermRow } from "./brief";
import type { UniquePost } from "./dedupe";
import { guardTrendText, sanitiseExcerpt } from "./guard";
import type { PitchAngle, TrendTheme } from "./model";

// ② theme naming and pitch angles. The model receives computed numbers and captions only (FR-CORE-17) and
// writes names, summaries and angles. It never adds, removes or re-ranks themes, posts or numbers.
export const TREND_PROMPT_VERSION = "trends-v1";

const MAX_NAME = 60;
const MAX_SUMMARY = 320;
const EXCERPTS_PER_THEME = 3;

export const themeNarrativeSchema = z.object({
  themes: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      summary: z.string(),
      pitchAngles: z.array(z.object({ category: z.string(), angle: z.string() })),
    }),
  ),
});
export type RawThemeNarrative = z.infer<typeof themeNarrativeSchema>;

export function themeNarrativeJsonSchema(): { name: string; schema: Record<string, unknown> } {
  const schema = { ...(z.toJSONSchema(themeNarrativeSchema) as Record<string, unknown>) };
  delete schema.$schema;
  return { name: "trend_themes", schema };
}

const SYSTEM_PROMPT = `You name themes found in public social posts that were pulled for a creator-marketing agency in Thailand, and you suggest pitch angles for brand categories.

Scope: only the posts pulled in this run. You receive, for each theme, its seed hashtag, its related tags, computed counts and shares, and up to three caption excerpts.

Rules:
- Use only numbers that appear in the payload. Never estimate, forecast or invent a figure.
- All quantitative language is within this pull. Say "in this pull" or "of the posts pulled", never describe the platform as a whole, never claim what is trending or popular across TikTok or Instagram, and never generalise about users or the market.
- name: two to five words, in English, or in Thai when the captions are in Thai.
- summary: one or two plain sentences on what the pulled posts in this theme show. Keep the weak-signal wording when the theme is marked weakSignal.
- pitchAngles: one or two per category listed for the theme. Each angle is a suggestion for a creator post for that brand category, grounded in the theme's posts. Do not promise results.
- Reply with one JSON object only: {"themes": [{"id": ..., "name": ..., "summary": ..., "pitchAngles": [{"category": ..., "angle": ...}]}]}.`;

export function buildThemePrompt(input: { terms: TermRow[]; uniquePosts: number; themes: TrendTheme[]; posts: UniquePost[] }): {
  system: string;
  user: string;
  figures: number[];
} {
  const byKey = new Map(input.posts.map((p) => [p.key, p]));
  const payload = {
    pull: {
      uniquePosts: input.uniquePosts,
      terms: input.terms.map((t) => ({ label: t.label, platform: t.platform, category: t.category, status: t.status, postCount: t.postCount })),
    },
    themes: input.themes.map((t) => ({
      id: t.id,
      seedTag: t.seedTag,
      tags: t.tags,
      postCount: t.postCount,
      platforms: t.platforms,
      categories: t.categories,
      weakSignal: t.weakSignal,
      rising: t.rising,
      stats: t.stats,
      captions: t.sources.slice(0, EXCERPTS_PER_THEME).flatMap((s) => {
        const caption = byKey.get(s.postId)?.caption;
        return caption ? [sanitiseExcerpt(caption)] : [];
      }),
    })),
  };
  return { system: SYSTEM_PROMPT, user: JSON.stringify(payload), figures: allowedFigures(numbersIn(payload), []) };
}

// Applies the model's names, summaries and angles to the deterministic themes. Anything that fails a guard keeps
// the deterministic sentence, and the flags say how much was replaced.
export function applyThemeNarrative(themes: TrendTheme[], raw: RawThemeNarrative, allowed: number[]): { themes: TrendTheme[]; flags: string[] } {
  let figures = 0;
  let platformWide = 0;
  let dropped = 0;
  const known = new Set(themes.map((t) => t.id));
  const answers = new Map<string, RawThemeNarrative["themes"][number]>();
  for (const r of raw.themes) {
    if (!known.has(r.id) || answers.has(r.id)) dropped++;
    else answers.set(r.id, r);
  }

  const take = (text: string, max: number): string | null => {
    const g = guardTrendText(text, allowed);
    figures += g.figuresReplaced;
    if (g.platformWide) platformWide++;
    if (!g.text || g.text.length > max) {
      if (g.text) dropped++;
      return null;
    }
    return g.text;
  };

  const out = themes.map((theme): TrendTheme => {
    const r = answers.get(theme.id);
    if (!r) return theme;
    // An angle for a category the theme doesn't cover is an item the model made up, so it is counted as dropped
    const covered = new Set(theme.categories.map((c) => c.toLowerCase()));
    dropped += r.pitchAngles.filter((a) => !covered.has(a.category.trim().toLowerCase())).length;
    const name = take(r.name, MAX_NAME) ?? theme.name;
    const modelSummary = take(r.summary, MAX_SUMMARY) ?? theme.summary;
    // FR-TM-2: a weak theme keeps its label whatever the model wrote
    const summary = theme.weakSignal && !/weak signal/i.test(modelSummary) ? `${modelSummary} ${WEAK_SENTENCE}` : modelSummary;
    const pitchAngles: PitchAngle[] = theme.categories.map((category) => {
      const fromModel = r.pitchAngles.find((a) => a.category.trim().toLowerCase() === category.toLowerCase());
      const angle = fromModel ? take(fromModel.angle, 240) : null;
      if (fromModel && !angle) dropped++;
      if (angle) return { category, angle, source: "model" };
      return theme.pitchAngles.find((p) => p.category === category) ?? { category, angle: templateAngle(category, theme.seedTag), source: "template" };
    });
    return { ...theme, name, summary, pitchAngles };
  });

  const flags = [
    ...(figures ? [`figures_replaced:${figures}`] : []),
    ...(platformWide ? [`platform_wording_removed:${platformWide}`] : []),
    ...(dropped ? [`items_dropped:${dropped}`] : []),
  ];
  return { themes: out, flags };
}

function numbersIn(value: unknown): number[] {
  if (typeof value === "number") return [value];
  if (Array.isArray(value)) return value.flatMap(numbersIn);
  if (value && typeof value === "object") return Object.values(value).flatMap(numbersIn);
  return [];
}
