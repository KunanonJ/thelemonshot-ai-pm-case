import { z } from "zod";
import { PLATFORMS } from "../../core/db/schema";
import { normaliseHandle } from "../../core/util";

export const OBJECTIVES = ["awareness", "engagement", "conversion"] as const;
export type Objective = (typeof OBJECTIVES)[number];
export const BUDGET_BANDS = ["under_100k", "100k_500k", "500k_1m", "over_1m"] as const; // THB

// FR-MX-1: objective, category and at least one platform are required; everything else is optional
export const matrixBriefSchema = z.object({
  brand: z.string().trim().max(120).default(""),
  productCategory: z.string().trim().min(1, "Choose a product category"),
  objective: z.enum(OBJECTIVES),
  audience: z.string().trim().max(600).default(""),
  budgetBand: z.enum(BUDGET_BANDS).optional(),
  platforms: z.array(z.enum(PLATFORMS)).min(1, "Choose at least one platform"),
  mustInclude: z.array(z.string().trim().min(1)).max(20).default([]),
  mustExclude: z.array(z.string().trim().min(1)).max(50).default([]),
  timeline: z.string().trim().max(120).default(""),
});

export type MatrixBrief = z.infer<typeof matrixBriefSchema>;

// Handles are compared without "@" and case; creator IDs pass through unchanged
export function normaliseRef(ref: string): string {
  return normaliseHandle(ref);
}

// FR-MX-1, AC-MX-2: a creator on both lists is excluded, and the conflict is shown before the run starts
export function findConflicts(brief: Pick<MatrixBrief, "mustInclude" | "mustExclude">): string[] {
  const excluded = new Set(brief.mustExclude.map(normaliseRef));
  return [...new Set(brief.mustInclude.map(normaliseRef))].filter((ref) => excluded.has(ref));
}
