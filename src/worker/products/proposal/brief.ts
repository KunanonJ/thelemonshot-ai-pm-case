import { z } from "zod";
import { PLATFORMS } from "../../core/db/schema";
import { BUDGET_BANDS, OBJECTIVES } from "../matrix/brief";
import { TEMPLATE_IDS, TEMPLATES, type RequiredField } from "./templates";

export const LANGUAGES = ["en", "th"] as const;

const FIELD_LABELS: Record<RequiredField, string> = { brand: "Brand", product: "Product", retainerMonths: "Retainer length" };

// Workflow step 2: attach an existing ① shortlist, start a fresh one with the proposal, or none (BR-CP-1)
const shortlistSchema = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("none") }),
  z.object({ mode: z.literal("existing"), matrixRunId: z.string().min(1) }),
  z.object({ mode: z.literal("new"), productCategory: z.string().trim().min(1), platforms: z.array(z.enum(PLATFORMS)).min(1) }),
]);

export const proposalBriefSchema = z
  .object({
    template: z.enum(TEMPLATE_IDS),
    language: z.enum(LANGUAGES).default("en"),
    brand: z.string().trim().max(120).default(""),
    product: z.string().trim().max(200).default(""),
    objective: z.enum(OBJECTIVES),
    audience: z.string().trim().max(600).default(""),
    budgetBand: z.enum(BUDGET_BANDS).optional(),
    timeline: z.string().trim().max(120).default(""),
    retainerMonths: z.number().int().min(1).max(24).optional(),
    toneNotes: z.string().trim().max(400).default(""),
    mustAvoid: z.array(z.string().trim().min(1).max(80)).max(20).default([]),
    shortlist: shortlistSchema.default({ mode: "none" }),
  })
  .superRefine((brief, ctx) => {
    // FR-CP-1: the template decides which brief fields are required
    for (const field of TEMPLATES[brief.template].requiredFields) {
      const value = brief[field];
      if (value === undefined || value === "") ctx.addIssue({ code: "custom", path: [field], message: `${FIELD_LABELS[field]} is required for this template` });
    }
  });

export type ProposalBrief = z.infer<typeof proposalBriefSchema>;
export type ShortlistChoice = ProposalBrief["shortlist"];
