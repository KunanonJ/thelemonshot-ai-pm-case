import { z } from "zod";
import type { Objective } from "../matrix/brief";
import type { ProposalBrief } from "./brief";
import type { Evidence } from "./evidence";
import {
  budgetLine,
  DEFAULT_RISKS,
  defaultKpis,
  defaultPhases,
  timelineLine,
  type Kpi,
  type SectionContent,
  type SectionDef,
  type SectionKey,
  type TemplateDef,
} from "./templates";

// One fixed rubric per section, versioned with the code (FR-CORE-15)
export const PROMPT_VERSION = "proposal-v1";

// What the model returns for a section. Code adds the brief-derived fields (budget, timeline, KPI
// targets), keeps only shortlisted creators and runs the guards before anything is stored.
const s = z.string();
const MODEL_SCHEMAS = {
  situation: z.object({ situation: s, insight: s }),
  big_idea: z.object({ title: s, summary: s, whyItWorks: s }),
  creator_strategy: z.object({ approach: s, creators: z.array(z.object({ creatorId: s, role: s, why: s })) }),
  content_pillars: z.object({ pillars: z.array(z.object({ name: s, description: s, formats: s })) }),
  phased_plan: z.object({ phases: z.array(z.object({ name: s, timing: s, activities: s })) }),
  kpi_frame: z.object({ kpis: z.array(z.object({ metric: s, note: s })) }),
  risks: z.object({ risks: z.array(z.object({ risk: s, mitigation: s })) }),
} satisfies Record<SectionKey, z.ZodType>;

type ModelSection = { [K in SectionKey]: z.infer<(typeof MODEL_SCHEMAS)[K]> };
export type ModelOutput = { alternatives: Record<string, unknown>[] };

const wrapper = (key: SectionKey) => z.object({ alternatives: z.array(MODEL_SCHEMAS[key]) });

export function outputSchema(key: SectionKey): z.ZodType<ModelOutput> {
  return wrapper(key) as unknown as z.ZodType<ModelOutput>;
}

export function outputJsonSchema(key: SectionKey): { name: string; schema: Record<string, unknown> } {
  const schema = { ...(z.toJSONSchema(wrapper(key)) as Record<string, unknown>) };
  delete schema.$schema;
  return { name: `proposal_${key}`, schema };
}

const SYSTEM_PROMPT = `You draft one section of a campaign proposal for a creator-marketing agency in Thailand. A strategist edits your draft before any client sees it.

Rules:
- Use only what you are given: the brief, the section guidance, the sections drafted so far and, for the creator section only, the attached shortlist.
- Never state performance figures as facts. Write no forecast reach, views, engagement, sales, return, cost or percentage unless that exact figure is in the input. Where a figure would help but isn't given, write "TBC".
- Name no creator, influencer, celebrity or other person, except shortlisted creators inside the creator section, and refer to those through their creatorId in the creators list.
- Don't disparage competitors or other brands. Avoid unverifiable superlatives such as "the best", "number one" or "guaranteed".
- Follow the tone notes and keep clear of the topics to avoid.
- Be specific to this brand, product and audience. Use short, plain sentences.
- Reply with one JSON object only, {"alternatives": [...]}, with exactly the number of alternatives requested. When more than one is requested, make them genuinely different directions.`;

const LANGUAGE_LINE: Record<ProposalBrief["language"], string> = {
  en: "Write in English.",
  th: "Write in Thai. Keep brand and product names exactly as written in the brief.",
};

// FR-CORE-17: public handles and metrics only, the same data the Matrix used
export type LlmCreator = {
  creatorId: string;
  name: string;
  score: number | null;
  platforms: { platform: string; handle: string | null; followers: number | null; engagementRatePct: number | null; medianViews: number | null }[];
  topHashtags: string[];
  matrixRationale: string | null;
};

export function toLlmCreator(e: Evidence): LlmCreator {
  return {
    creatorId: e.creatorId,
    name: e.displayName,
    score: e.composite === null ? null : Math.round(e.composite),
    platforms: e.platforms.map((p) => ({
      platform: p.platform,
      handle: e.handles[p.platform] ?? null,
      followers: p.followers,
      engagementRatePct: p.engagementRate,
      medianViews: p.medianViews,
    })),
    topHashtags: e.topHashtags,
    matrixRationale: e.rationale,
  };
}

export type PromptInput = {
  template: TemplateDef;
  section: SectionDef;
  brief: ProposalBrief;
  drafted: { section: string; content: unknown }[];
  shortlist: LlmCreator[] | null;
  current: unknown;
  instruction: string | null;
  alternatives: number;
};

export function buildSectionPrompt(p: PromptInput): { system: string; user: string } {
  const brief = {
    brand: p.brief.brand,
    product: p.brief.product,
    objective: p.brief.objective,
    targetAudience: p.brief.audience || "(not given)",
    budget: budgetLine(p.brief),
    timeline: timelineLine(p.brief),
    toneNotes: p.brief.toneNotes || "(none)",
    topicsToAvoid: p.brief.mustAvoid,
  };
  const defaults =
    p.section.key === "phased_plan"
      ? { phases: defaultPhases(p.brief).map(({ name, timing }) => ({ name, timing })) }
      : p.section.key === "kpi_frame"
        ? { kpis: defaultKpis(p.brief.objective).map((k) => k.metric) }
        : p.section.key === "risks"
          ? { risks: DEFAULT_RISKS }
          : null;
  const task = {
    section: p.section.title,
    guidance: p.section.guidance,
    alternatives: p.alternatives,
    ...(p.current ? { currentDraft: p.current } : {}),
    ...(p.instruction ? { plannerInstruction: p.instruction } : {}),
  };
  const payload = {
    template: p.template.name,
    task,
    brief,
    ...(defaults ? { templateDefaults: defaults } : {}),
    sectionsSoFar: p.drafted,
    ...(p.shortlist ? { shortlist: p.shortlist } : {}),
  };
  return { system: `${SYSTEM_PROMPT}\n${LANGUAGE_LINE[p.brief.language]}`, user: JSON.stringify(payload) };
}

const clip = (text: string, max: number) => text.trim().slice(0, max);

// Maps one validated, guarded alternative to stored content. `dropped` counts creators the model listed
// who aren't on the attached shortlist (FR-CP-2): they are removed, never kept.
export function toContent(
  key: SectionKey,
  raw: Record<string, unknown>,
  ctx: { brief: ProposalBrief; shortlistIds: Set<string> | null },
): { content: SectionContent[SectionKey]; dropped: number } {
  switch (key) {
    case "situation": {
      const m = raw as ModelSection["situation"];
      return { content: { situation: clip(m.situation, 2000), insight: clip(m.insight, 1000) }, dropped: 0 };
    }
    case "big_idea": {
      const m = raw as ModelSection["big_idea"];
      return { content: { title: clip(m.title, 160), summary: clip(m.summary, 1500), whyItWorks: clip(m.whyItWorks, 1000) }, dropped: 0 };
    }
    case "creator_strategy": {
      const m = raw as ModelSection["creator_strategy"];
      const seen = new Set<string>();
      let dropped = 0;
      const creators = m.creators.flatMap((c) => {
        if (!ctx.shortlistIds?.has(c.creatorId) || seen.has(c.creatorId)) {
          dropped++;
          return [];
        }
        seen.add(c.creatorId);
        return [{ creatorId: c.creatorId, role: clip(c.role, 80), why: clip(c.why, 500) }];
      });
      return { content: { approach: clip(m.approach, 1500), creators }, dropped };
    }
    case "content_pillars": {
      const m = raw as ModelSection["content_pillars"];
      const pillars = m.pillars.slice(0, 6).map((p) => ({ name: clip(p.name, 100), description: clip(p.description, 600), formats: clip(p.formats, 200) }));
      return { content: { pillars }, dropped: 0 };
    }
    case "phased_plan": {
      const m = raw as ModelSection["phased_plan"];
      const phases = m.phases.slice(0, 12).map((p) => ({ name: clip(p.name, 100), timing: clip(p.timing, 100), activities: clip(p.activities, 800) }));
      return { content: { budget: budgetLine(ctx.brief), timeline: timelineLine(ctx.brief), phases }, dropped: 0 };
    }
    case "kpi_frame": {
      const m = raw as ModelSection["kpi_frame"];
      return { content: { kpis: mergeKpis(m.kpis, ctx.brief.objective) }, dropped: 0 };
    }
    case "risks": {
      const m = raw as ModelSection["risks"];
      return { content: { risks: m.risks.slice(0, 8).map((r) => ({ risk: clip(r.risk, 400), mitigation: clip(r.mitigation, 500) })) }, dropped: 0 };
    }
  }
}

// FR-CP-3: the model only writes notes. Targets come from the template (marked as defaults) or stay
// TBC; up to two extra metrics the model proposes are kept with a TBC target.
export function mergeKpis(model: { metric: string; note: string }[], objective: Objective): Kpi[] {
  const defaults = defaultKpis(objective);
  const norm = (text: string) => text.trim().toLowerCase();
  const notes = new Map(model.map((k) => [norm(k.metric), clip(k.note, 400)]));
  const merged = defaults.map((d) => ({ ...d, note: notes.get(norm(d.metric)) ?? "" }));
  const extras = model
    .filter((k) => k.metric.trim() && !defaults.some((d) => norm(d.metric) === norm(k.metric)))
    .slice(0, 2)
    .map((k) => ({ metric: clip(k.metric, 160), target: "TBC", basis: "tbc" as const, note: clip(k.note, 400) }));
  return [...merged, ...extras];
}
