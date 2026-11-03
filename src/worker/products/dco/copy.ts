import { z } from "zod";
import { guardFigures } from "../../core/figures";
import { lintText } from "../proposal/guard";
import type { DcoBrief } from "./brief";

// One fixed rubric, versioned with the code (FR-CORE-15)
export const DCO_COPY_PROMPT_VERSION = "dco-copy-v1";

const s = z.string();
export const copyOptionSchema = z.object({
  headline: s.min(1).max(120),
  hookLine: s.min(1).max(200),
  caption: s.min(1).max(600),
  cta: s.min(1).max(40),
});
export const copyOutputSchema = z.object({ options: z.array(copyOptionSchema).min(1).max(5) });
export type CopyOption = z.infer<typeof copyOptionSchema>;

export function copyJsonSchema(): { name: string; schema: Record<string, unknown> } {
  const schema = { ...(z.toJSONSchema(copyOutputSchema) as Record<string, unknown>) };
  delete schema.$schema;
  return { name: "dco_copy", schema };
}

const SYSTEM_PROMPT = `You write short ad copy for one audience segment of a brand's campaign. A planner approves every line before use.

Rules:
- Use only the brand, product, offer, brand voice and segment you are given.
- Never invent a price, discount, percentage, count, date, stock level, rating, review, award, certification, testimonial, result or any performance figure. Where a fact is needed and not given, write TBC in its place.
- Never name a person, creator or influencer.
- No superlatives or guarantees such as "the best", "number one", "guaranteed" or "cures".
- Keep clear of every topic listed under topics to avoid.
- Make each option a different angle on the same product. Keep headlines short.
- Write in English. Plain short sentences. No emojis and no hashtags.
- Reply with one JSON object only, in the form {"options": [{"headline": "", "hookLine": "", "caption": "", "cta": ""}]}, with exactly the number of options requested.`;

export function buildCopyPrompt(brief: DcoBrief, segment: { name: string; note: string | null }, count: number): { system: string; user: string } {
  const lines = [
    `Brand: ${brief.brand}`,
    `Product: ${brief.product}`,
    `Offer: ${brief.offer?.trim() ? brief.offer : "None given. Write no offer, price or discount, and write TBC where one would go."}`,
    `Brand voice: ${brief.brandVoice?.trim() ? brief.brandVoice : "No voice notes given."}`,
    `Topics to avoid: ${brief.prohibitedClaims.length ? brief.prohibitedClaims.join("; ") : "None given."}`,
    `Audience segment: ${segment.name}`,
    `Segment note: ${segment.note?.trim() ? segment.note : "None given."}`,
    `Number of options: ${count}`,
  ];
  return { system: SYSTEM_PROMPT, user: lines.join("\n") };
}

// A template placeholder such as [offer], {price} or <product> is not copy, so it renders as TBC
const PLACEHOLDER_RE = /\[[^\]\n]*\]|\{[^}\n]*\}|<[^>\n]*>/g;

// FR-DC-3 and HR-3: a figure that isn't in the brief becomes TBC, and so does a placeholder. Prohibited topics
// and superlatives are flagged for the reviewer rather than rewritten, so the reviewer sees what the model wrote.
export function guardCopyOption(option: CopyOption, allowed: number[], prohibited: string[]): { option: CopyOption; flags: string[] } {
  let figures = 0;
  let placeholders = 0;
  const lint = new Set<string>();
  const fix = (text: string): string => {
    const noPlaceholders = text.replace(PLACEHOLDER_RE, () => {
      placeholders++;
      return "TBC";
    });
    const guarded = guardFigures(noPlaceholders, allowed);
    figures += guarded.replaced;
    for (const flag of lintText(guarded.text, prohibited)) lint.add(flag);
    return guarded.text.trim();
  };
  const cleaned: CopyOption = {
    headline: fix(option.headline),
    hookLine: fix(option.hookLine),
    caption: fix(option.caption),
    cta: fix(option.cta),
  };
  const flags = [...(figures ? [`figures_replaced:${figures}`] : []), ...(placeholders ? [`placeholder_replaced:${placeholders}`] : []), ...lint];
  return { option: cleaned, flags };
}
