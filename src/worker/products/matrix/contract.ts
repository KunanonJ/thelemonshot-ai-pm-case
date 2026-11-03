import { z } from "zod";
import type { Platform } from "../../core/db/schema";
import type { MatrixBrief } from "./brief";
import type { CandidateFeatures } from "./features";
import type { Dims } from "./scoring";

// FR-MX-5: one fixed rubric, versioned with the code (FR-CORE-15)
export const PROMPT_VERSION = "matrix-v1";
const RATIONALE_MAX = 280;
// BR-MX-1: above this payload size the candidates go in two calls, merged by creator ID
export const SPLIT_THRESHOLD_CHARS = 90_000;

export type LlmCandidate = {
  id: string;
  name: string;
  categories: string[];
  platforms: { platform: Platform; handle: string; followers: number | null; tier: string | null; engagementRatePct: number | null; medianViews: number | null }[];
  topHashtags: string[];
  recentCaptions: string[];
};

const score = z.number().min(0).max(100);
export const llmOutputSchema = z.object({
  scores: z.array(
    z.object({
      creatorId: z.string(),
      audienceFit: score,
      brandSafety: score,
      creativeFit: score,
      rationale: z.string(),
    }),
  ),
});
export type LlmOutput = z.infer<typeof llmOutputSchema>;

export const llmJsonSchema = {
  name: "matrix_scores",
  schema: {
    type: "object",
    properties: {
      scores: {
        type: "array",
        items: {
          type: "object",
          properties: {
            creatorId: { type: "string" },
            audienceFit: { type: "number", minimum: 0, maximum: 100 },
            brandSafety: { type: "number", minimum: 0, maximum: 100 },
            creativeFit: { type: "number", minimum: 0, maximum: 100 },
            rationale: { type: "string", maxLength: RATIONALE_MAX },
          },
          required: ["creatorId", "audienceFit", "brandSafety", "creativeFit", "rationale"],
          additionalProperties: false,
        },
      },
    },
    required: ["scores"],
    additionalProperties: false,
  },
};

const SYSTEM_PROMPT = `You score creator fit for a Thai creator-marketing agency. You receive a campaign brief and candidate creators with their public metrics, top hashtags and short excerpts of recent captions.

For every candidate return:
- audienceFit (0-100): how well the creator's likely audience matches the brief's target audience, judged only from the data given.
- brandSafety (0-100): 100 means no risk signals in the content given. Lower it for controversy, profanity, harassment, adult, gambling or alcohol themes, or promotion of a competitor of the brand. With too little content to judge, use 70 and say so.
- creativeFit (0-100): how well the creator's content style and topics suit the brand and product.
- rationale: at most ${RATIONALE_MAX} characters, citing at least one concrete fact from the data (a number, a hashtag or a caption topic).

Rules:
- Use only the data given. Never invent metrics, follower counts, audience demographics or past campaigns.
- Score every candidate exactly once, using its id as creatorId.
- Reply with one JSON object only: {"scores": [...]}.`;

export function buildPrompt(brief: MatrixBrief, candidates: LlmCandidate[]): { system: string; user: string } {
  const briefView = {
    brand: brief.brand || "(not given)",
    productCategory: brief.productCategory,
    objective: brief.objective,
    targetAudience: brief.audience || "(not given)",
    platforms: brief.platforms,
    budgetBand: brief.budgetBand ?? "(not given)",
  };
  return { system: SYSTEM_PROMPT, user: JSON.stringify({ brief: briefView, candidates }) };
}

// FR-CORE-17: public handles, metrics, hashtags and caption excerpts only. Contact details are stripped.
export function sanitiseCaption(text: string, max = 120): string {
  return text
    .replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, "[email]")
    .replace(/https?:\/\/\S+|www\.\S+/gi, "[link]")
    .replace(/(?:\+?66|0)[\s-]?\d(?:[\s-]?\d){7,9}/g, "[phone]")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

export function toLlmCandidate(
  f: CandidateFeatures,
  creator: { displayName: string; categories: string[]; handles: Partial<Record<Platform, string | null>> },
  captions: string[],
): LlmCandidate {
  return {
    id: f.creatorId,
    name: creator.displayName,
    categories: creator.categories,
    platforms: f.platforms.map((platform) => {
      const pf = f.perPlatform[platform]!;
      return {
        platform,
        handle: creator.handles[platform] ?? "",
        followers: pf.followers,
        tier: pf.tier,
        engagementRatePct: pf.engagementRate,
        medianViews: pf.medianViews,
      };
    }),
    topHashtags: f.topHashtags,
    recentCaptions: captions.slice(0, 3).map((c) => sanitiseCaption(c)).filter(Boolean),
  };
}

export function splitForContext(candidates: LlmCandidate[], thresholdChars = SPLIT_THRESHOLD_CHARS): LlmCandidate[][] {
  if (JSON.stringify(candidates).length <= thresholdChars || candidates.length < 2) return [candidates];
  const mid = Math.ceil(candidates.length / 2);
  return [candidates.slice(0, mid), candidates.slice(mid)];
}

// A rationale must point at something concrete: a number, a hashtag or a named metric (FR-MX-5)
const FEATURE_REFERENCE = /\d|#|follower|engagement|views|hashtag|caption|ผู้ติดตาม|ยอดวิว/i;

export function validateScores(
  inputIds: string[],
  outputs: LlmOutput["scores"],
): { dims: Map<string, Dims>; rationales: Map<string, string>; flags: Map<string, string[]>; missing: string[] } {
  const wanted = new Set(inputIds);
  const dims = new Map<string, Dims>();
  const rationales = new Map<string, string>();
  const flags = new Map<string, string[]>();
  for (const s of outputs) {
    if (!wanted.has(s.creatorId) || dims.has(s.creatorId)) continue;
    dims.set(s.creatorId, { audienceFit: Math.round(s.audienceFit), brandSafety: Math.round(s.brandSafety), creativeFit: Math.round(s.creativeFit) });
    const rationale = s.rationale.trim().slice(0, RATIONALE_MAX);
    rationales.set(s.creatorId, rationale);
    if (!FEATURE_REFERENCE.test(rationale)) flags.set(s.creatorId, ["rationale_unverified"]);
  }
  return { dims, rationales, flags, missing: inputIds.filter((id) => !dims.has(id)) };
}
