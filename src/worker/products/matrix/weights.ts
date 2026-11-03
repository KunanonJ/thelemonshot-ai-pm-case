import type { Objective } from "./brief";

export const SCORING_VERSION = "matrix-scoring-v1";

export const COMPONENTS = ["history", "engagement", "reach", "categoryFit", "audienceFit", "creativeFit"] as const;
export type Component = (typeof COMPONENTS)[number];

// FR-MX-2: weight profiles are code constants, shown in "how scoring works". PRD-01 sets the direction
// (conversion weights history highest, awareness weights reach highest); the numbers are a starting
// point for Fronk to own and for the pilot to calibrate.
export const WEIGHT_PROFILES: Record<Objective, Record<Component, number>> = {
  conversion: { history: 0.3, engagement: 0.2, audienceFit: 0.2, creativeFit: 0.1, reach: 0.1, categoryFit: 0.1 },
  awareness: { reach: 0.3, audienceFit: 0.25, engagement: 0.15, creativeFit: 0.1, categoryFit: 0.1, history: 0.1 },
  engagement: { engagement: 0.3, creativeFit: 0.25, audienceFit: 0.2, categoryFit: 0.1, history: 0.1, reach: 0.05 },
};

export const COMPONENT_INFO: Record<Component, { label: string; source: "data" | "llm"; description: string }> = {
  history: {
    label: "Outcome history",
    source: "data",
    description: "Results of past campaigns written back to the creator record. Empty for creators with no history yet; their score uses the other components.",
  },
  engagement: {
    label: "Engagement",
    source: "data",
    description: "Engagement rate against the median for the same platform and follower tier in this pool. The tier median scores 50; twice the median scores 100.",
  },
  reach: {
    label: "Reach",
    source: "data",
    description: "Median views of recent content (followers where a platform reports no views), ranked against the rest of the pool.",
  },
  categoryFit: {
    label: "Category fit",
    source: "data",
    description: "60 points when the creator is tagged with the brief's category, plus up to 40 for the share of recent hashtags on the category's topics.",
  },
  audienceFit: {
    label: "Audience fit",
    source: "llm",
    description: "The model's 0-100 judgement of how well the creator's audience matches the brief, from the metrics, hashtags and captions it is given.",
  },
  creativeFit: {
    label: "Creative fit",
    source: "llm",
    description: "The model's 0-100 judgement of how well the creator's content style suits the brand and product.",
  },
};

export const RULES = {
  candidateCap: 40, // FR-MX-3
  thinPool: 10, // FR-MX-3
  shortlistSize: 15, // workflow step 6
  brandSafetyFloor: 40, // FR-MX-6
  confidenceThreshold: 70, // FR-MX-7
  staleAfterDays: 3, // 72 h TTL, FR-CORE-12
} as const;
