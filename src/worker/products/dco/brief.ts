import { z } from "zod";

// The brief is the only source the copy may use (FR-DC-3). Nothing outside it is invented.
export const DCO_MAX_SEGMENTS = 4;
export const DCO_COPY_MIN = 1;
export const DCO_COPY_MAX = 5;
export const DCO_COPY_DEFAULT = 3;

export const dcoBriefSchema = z.object({
  brand: z.string().trim().min(1, "Enter the brand name").max(80),
  product: z.string().trim().min(1, "Enter the product").max(160),
  offer: z.string().trim().max(300).optional(),
  segments: z
    .array(
      z.object({
        name: z.string().trim().min(1, "Name each audience segment").max(60),
        note: z.string().trim().max(240).optional(),
      }),
    )
    .min(1, "Add at least one audience segment")
    .max(DCO_MAX_SEGMENTS, "Use four audience segments at most"),
  brandVoice: z.string().trim().max(300).optional(),
  prohibitedClaims: z.array(z.string().trim().min(1).max(80)).max(20).default([]),
  copyPerSegment: z.number().int().min(DCO_COPY_MIN).max(DCO_COPY_MAX).default(DCO_COPY_DEFAULT),
});

export type DcoBrief = z.infer<typeof dcoBriefSchema>;

// Every string in the brief, for the figure guard: a number the planner wrote may be repeated, nothing else may
export function briefTexts(brief: DcoBrief): string[] {
  return [brief.brand, brief.product, brief.offer ?? "", brief.brandVoice ?? "", ...brief.segments.map((s) => `${s.name} ${s.note ?? ""}`)];
}
