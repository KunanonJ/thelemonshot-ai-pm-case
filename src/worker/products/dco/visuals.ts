// FR-DC-3: visual prompts are fixed in code. They name no person, price, claim or figure.
export const DCO_VISUAL_PROMPT_VERSION = "dco-visual-v1";
const NEGATIVE = "people faces hands text logo";

// Every value must be on FAL_ALLOWLIST; the unit tests check that for the whole plan
export type VisualModelId = "fal-ai/bria/expand" | "fal-ai/bria/background/replace" | "fal-ai/bria/product-shot";

export type VisualPlan = {
  key: string;
  kind: "format" | "scene";
  label: string;
  modelId: VisualModelId;
  format: string;
  // Target canvas for layout (expand) slots only
  canvas: [number, number] | null;
  prompt: string;
  negativePrompt: string | null;
};

// One fal request per slot. Three layout slots cover the feed and story sizes; two scene slots change the setting.
export const VISUAL_PLAN: readonly VisualPlan[] = [
  { key: "format-1x1", kind: "format", label: "Square feed, 1:1", modelId: "fal-ai/bria/expand", format: "1:1", canvas: [1080, 1080], prompt: "soft neutral studio backdrop", negativePrompt: null },
  { key: "format-4x5", kind: "format", label: "Portrait feed, 4:5", modelId: "fal-ai/bria/expand", format: "4:5", canvas: [1080, 1350], prompt: "soft neutral studio backdrop", negativePrompt: null },
  { key: "format-9x16", kind: "format", label: "Stories and reels, 9:16", modelId: "fal-ai/bria/expand", format: "9:16", canvas: [1080, 1920], prompt: "soft neutral studio backdrop", negativePrompt: null },
  { key: "scene-studio", kind: "scene", label: "Studio backdrop", modelId: "fal-ai/bria/background/replace", format: "as uploaded", canvas: null, prompt: "clean light grey studio backdrop with soft window light", negativePrompt: NEGATIVE },
  { key: "scene-kitchen", kind: "scene", label: "Kitchen counter", modelId: "fal-ai/bria/product-shot", format: "1:1", canvas: null, prompt: "bright kitchen counter with a wooden board and soft morning light", negativePrompt: null },
];

export const planFor = (key: string): VisualPlan | null => VISUAL_PLAN.find((p) => p.key === key) ?? null;

// The request body per endpoint, using only the parameters each endpoint documents (fal model pages, 2 Nov 2026)
export function falInput(plan: VisualPlan, imageUrl: string): Record<string, unknown> {
  switch (plan.modelId) {
    case "fal-ai/bria/expand":
      return { image_url: imageUrl, aspect_ratio: plan.format, canvas_size: plan.canvas, prompt: plan.prompt };
    case "fal-ai/bria/background/replace":
      return { image_url: imageUrl, prompt: plan.prompt, negative_prompt: plan.negativePrompt ?? "", num_images: 1 };
    case "fal-ai/bria/product-shot":
      return {
        image_url: imageUrl,
        scene_description: plan.prompt,
        placement_type: "manual_placement",
        manual_placement_selection: "bottom_center",
        shot_size: [1000, 1000],
        num_results: 1,
        fast: true,
      };
  }
}

export type FalImage = { url: string; contentType: string | null };

// Bria's expand returns one `image`; the other two return `images`. Both carry `url` and `content_type`.
export function outputImages(output: unknown): FalImage[] {
  const o = (output ?? {}) as { images?: unknown; image?: unknown };
  const raw: unknown[] = Array.isArray(o.images) ? o.images : o.image ? [o.image] : [];
  return raw.flatMap((item) => {
    const i = (item ?? {}) as { url?: unknown; content_type?: unknown };
    return typeof i.url === "string" ? [{ url: i.url, contentType: typeof i.content_type === "string" ? i.content_type : null }] : [];
  });
}

export function outputSeed(output: unknown): number | null {
  const seed = (output as { seed?: unknown } | null)?.seed;
  return typeof seed === "number" && Number.isFinite(seed) ? seed : null;
}

// BR-DC-2. The three allowlisted endpoints document no safety field, so this checks the flag names fal's image
// models use. A result with any of these set true is discarded before it is downloaded or stored.
export const SAFETY_FLAG_KEYS = ["has_nsfw_concepts", "nsfw_content_detected", "is_nsfw", "nsfw"] as const;

export function isSafetyFlagged(output: unknown): boolean {
  const o = (output ?? {}) as Record<string, unknown>;
  return SAFETY_FLAG_KEYS.some((k) => {
    const v = o[k];
    return v === true || (Array.isArray(v) && v.some((x) => x === true));
  });
}

// A queue-level error that names the safety filter in its machine-readable type
export function isSafetyErrorType(errorType: string | null): boolean {
  return errorType !== null && /nsfw|safety|content[_ -]?policy/i.test(errorType);
}
