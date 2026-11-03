import { z } from "zod";
import { ACTORS } from "../../core/enrichment/apify";
import { TREND_PLATFORMS, TREND_TERM_KINDS, type TrendPlatform, type TrendTermKind } from "./schema";

export { TREND_PLATFORMS, TREND_TERM_KINDS, type TrendPlatform, type TrendTermKind };

export const DEFAULT_POST_CAP = 30; // FR-TM-1
export const MAX_POST_CAP = 100; // cost control (my call)
export const MAX_TERMS_PER_PULL = 10; // cost control (my call)

const PLATFORM_NAME: Record<TrendPlatform, string> = { instagram: "Instagram", tiktok: "TikTok" };
export const platformName = (p: string): string => PLATFORM_NAME[p as TrendPlatform] ?? p;

// Lower-case key for de-duplication; a hashtag never keeps its leading "#"
export function termKey(term: string): string {
  return term.trim().replace(/^#+/, "").replace(/\s+/g, " ").toLowerCase();
}

export function displayLabel(kind: TrendTermKind, term: string): string {
  const clean = term.trim().replace(/^#+/, "");
  return kind === "hashtag" ? `#${clean}` : clean;
}

export const termInputSchema = z
  .object({
    term: z.string().trim().min(1, "Enter a hashtag or keyword").max(60),
    kind: z.enum(TREND_TERM_KINDS),
    platforms: z.array(z.enum(TREND_PLATFORMS)).min(1, "Pick at least one platform").max(2),
    category: z.string().trim().min(1, "Give the term a category").max(60),
    postCap: z.number().int().min(1).max(MAX_POST_CAP).default(DEFAULT_POST_CAP),
  })
  .superRefine((t, ctx) => {
    // The actor joins words in a hashtag into one tag, so a spaced hashtag is refused rather than silently fused
    if (t.kind === "hashtag" && /\s/.test(t.term.trim().replace(/^#+/, ""))) {
      ctx.addIssue({ code: "custom", path: ["term"], message: "A hashtag can't contain spaces. Add it as a keyword instead." });
    }
  });

// Actor input per term and platform, checked against the Store input schemas (2 Nov 2026):
//   instagram-hashtag-scraper: hashtags, keywordSearch, resultsType, resultsLimit (per hashtag or keyword)
//   clockworks/tiktok-scraper: hashtags or searchQueries, resultsPerPage (per hashtag, profile or search input)
export function actorRequest(platform: TrendPlatform, kind: TrendTermKind, term: string, cap: number): { actor: string; input: Record<string, unknown>; summary: string } {
  const clean = term.trim().replace(/^#+/, "");
  const summary = `${platform} ${kind} ${displayLabel(kind, term)}, cap ${cap}`;
  if (platform === "instagram") {
    return {
      actor: ACTORS.instagramHashtag,
      input: { hashtags: [clean], resultsType: "posts", resultsLimit: cap, ...(kind === "keyword" ? { keywordSearch: true } : {}) },
      summary,
    };
  }
  return {
    actor: ACTORS.tiktokSearch,
    input: kind === "keyword" ? { searchQueries: [clean], resultsPerPage: cap } : { hashtags: [clean], resultsPerPage: cap },
    summary,
  };
}

// Words that identify the watched term inside a post's tags, so the term itself never becomes a theme
export function watchTokens(kind: TrendTermKind, term: string): string[] {
  const key = termKey(term);
  if (kind === "hashtag") return [key.replace(/\s/g, "")];
  return [key, ...key.split(" ").filter((w) => w.length >= 3)];
}
