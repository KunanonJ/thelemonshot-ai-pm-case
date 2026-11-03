import { z } from "zod";
import type { BUDGET_BANDS, Objective } from "../matrix/brief";

// FR-CP-1: each template fixes the section order, the section titles and guidance, and the brief
// fields it can't do without. Template choice is recorded on the run.

export const TEMPLATE_IDS = ["standard", "always_on"] as const;
export type TemplateId = (typeof TEMPLATE_IDS)[number];

export const SECTION_KEYS = ["situation", "big_idea", "creator_strategy", "content_pillars", "phased_plan", "kpi_frame", "risks"] as const;
export type SectionKey = (typeof SECTION_KEYS)[number];

export type SectionDef = { key: SectionKey; title: string; guidance: string };
export type TemplateDef = { id: TemplateId; name: string; description: string; requiredFields: RequiredField[]; sections: SectionDef[] };
export type RequiredField = "brand" | "product" | "retainerMonths";

const SITUATION: SectionDef = {
  key: "situation",
  title: "Situation and insight",
  guidance:
    "Situation: two or three sentences on where the brand and product stand and what this campaign has to change for the target audience. Insight: one human truth about the audience that the idea builds on. Use the brief only.",
};
const PILLARS: SectionDef = {
  key: "content_pillars",
  title: "Content pillars",
  guidance: "Three or four content pillars. For each: a short name, what the content covers, and suitable formats (for example short video, carousel, live).",
};
const KPIS: SectionDef = {
  key: "kpi_frame",
  title: "KPI frame",
  guidance:
    "Write one note per KPI on how it will be measured during the campaign. Keep every KPI you are given, using its exact metric name; you may add up to two that suit the objective. Never write targets: targets come from the brief or are agreed with the client.",
};
const RISKS: SectionDef = {
  key: "risks",
  title: "Risks and mitigations",
  guidance: "Four to six risks specific to this campaign, each with a practical mitigation. The template risks are a starting point.",
};

export const TEMPLATES: Record<TemplateId, TemplateDef> = {
  standard: {
    id: "standard",
    name: "Standard campaign",
    description: "One campaign with a launch moment: build-up, launch and sustain over a few weeks.",
    requiredFields: ["brand", "product"],
    sections: [
      SITUATION,
      {
        key: "big_idea",
        title: "Big idea",
        guidance:
          "A campaign idea creators can bring to life. Title: a short, memorable name. Summary: what happens and how creators carry it. Why it works: tie the idea to the insight and the objective.",
      },
      {
        key: "creator_strategy",
        title: "Creator strategy",
        guidance:
          "How the shortlisted creators work together. Approach: the casting logic, for example larger creators for launch reach and smaller ones for community conversation. Creators: one entry per shortlisted creator with a role of two to four words and one sentence on why, grounded in their data.",
      },
      PILLARS,
      {
        key: "phased_plan",
        title: "Phased plan",
        guidance: "Three or four phases from build-up to sustain, each with relative timing (for example Week 1, Weeks 2 to 3) and the main creator activities. Start from the template phases.",
      },
      KPIS,
      RISKS,
    ],
  },
  always_on: {
    id: "always_on",
    name: "Always-on retainer",
    description: "A monthly programme over a retainer: one recurring platform idea, a creator roster that rotates, and a monthly rhythm.",
    requiredFields: ["brand", "product", "retainerMonths"],
    sections: [
      SITUATION,
      {
        key: "big_idea",
        title: "Always-on platform idea",
        guidance:
          "A long-running platform idea that gives creators a recurring format to return to every month. Title, summary of the format, and why it works for the objective over the length of the retainer.",
      },
      PILLARS,
      {
        key: "creator_strategy",
        title: "Creator roster and rotation",
        guidance:
          "How the roster rotates over the retainer: a core group posting every month and a rotating group for freshness. Creators: one entry per shortlisted creator with a role (core, rotating or seasonal) and one sentence on why, grounded in their data.",
      },
      {
        key: "phased_plan",
        title: "Monthly cadence",
        guidance: "A month-by-month plan over the retainer (group months when it runs longer than six), each with its focus and the main creator activities. Start from the template months.",
      },
      KPIS,
      RISKS,
    ],
  },
};

// The model drafts everything else first; the creator section goes last because it may wait for a
// shortlist that is still scoring
export function generationOrder(template: TemplateDef): SectionKey[] {
  const keys = template.sections.map((s) => s.key);
  return [...keys.filter((k) => k !== "creator_strategy"), "creator_strategy"];
}

// ---------- section content: what is stored, edited and exported ----------

export const KPI_BASES = ["tbc", "default", "brief", "planner"] as const;
const t = (max: number) => z.string().trim().max(max);

export const CONTENT_SCHEMAS = {
  situation: z.object({ situation: t(2000), insight: t(1000) }),
  big_idea: z.object({ title: t(160), summary: t(1500), whyItWorks: t(1000) }),
  creator_strategy: z.object({ approach: t(1500), creators: z.array(z.object({ creatorId: z.string().min(1), role: t(80), why: t(500) })).max(40) }),
  content_pillars: z.object({ pillars: z.array(z.object({ name: t(100), description: t(600), formats: t(200) })).max(6) }),
  phased_plan: z.object({ budget: t(200), timeline: t(200), phases: z.array(z.object({ name: t(100), timing: t(100), activities: t(800) })).max(12) }),
  kpi_frame: z.object({ kpis: z.array(z.object({ metric: t(160), target: t(100), basis: z.enum(KPI_BASES), note: t(400) })).max(10) }),
  risks: z.object({ risks: z.array(z.object({ risk: t(400), mitigation: t(500) })).max(8) }),
} satisfies Record<SectionKey, z.ZodType>;

export type SectionContent = { [K in SectionKey]: z.infer<(typeof CONTENT_SCHEMAS)[K]> };
export type Kpi = SectionContent["kpi_frame"]["kpis"][number];

// The structured editor is drawn from these (FR-CP-4: sections, not free-form HTML)
type Leaf = { key: string; label: string; kind: "line" | "text"; readOnly?: boolean };
export type FieldSpec = Leaf | { key: string; label: string; kind: "list"; itemLabel: string; max: number; item: Leaf[] } | { key: string; label: string; kind: "creators" };

export const FIELD_SPECS: Record<SectionKey, FieldSpec[]> = {
  situation: [
    { key: "situation", label: "Situation", kind: "text" },
    { key: "insight", label: "Insight", kind: "text" },
  ],
  big_idea: [
    { key: "title", label: "Title", kind: "line" },
    { key: "summary", label: "Summary", kind: "text" },
    { key: "whyItWorks", label: "Why it works", kind: "text" },
  ],
  creator_strategy: [
    { key: "approach", label: "Approach", kind: "text" },
    { key: "creators", label: "Creators", kind: "creators" },
  ],
  content_pillars: [
    {
      key: "pillars",
      label: "Pillars",
      kind: "list",
      itemLabel: "Pillar",
      max: 6,
      item: [
        { key: "name", label: "Name", kind: "line" },
        { key: "description", label: "What it covers", kind: "text" },
        { key: "formats", label: "Formats", kind: "line" },
      ],
    },
  ],
  phased_plan: [
    { key: "budget", label: "Budget", kind: "line", readOnly: true },
    { key: "timeline", label: "Timeline", kind: "line", readOnly: true },
    {
      key: "phases",
      label: "Phases",
      kind: "list",
      itemLabel: "Phase",
      max: 12,
      item: [
        { key: "name", label: "Name", kind: "line" },
        { key: "timing", label: "Timing", kind: "line" },
        { key: "activities", label: "Activities", kind: "text" },
      ],
    },
  ],
  kpi_frame: [
    {
      key: "kpis",
      label: "KPIs",
      kind: "list",
      itemLabel: "KPI",
      max: 10,
      item: [
        { key: "metric", label: "Metric", kind: "line" },
        { key: "target", label: "Target", kind: "line" },
        { key: "note", label: "How it's measured", kind: "line" },
      ],
    },
  ],
  risks: [
    {
      key: "risks",
      label: "Risks",
      kind: "list",
      itemLabel: "Risk",
      max: 8,
      item: [
        { key: "risk", label: "Risk", kind: "text" },
        { key: "mitigation", label: "Mitigation", kind: "text" },
      ],
    },
  ],
};

// ---------- brief-derived values and template defaults (FR-CP-3: numbers come from here, never the model) ----------

type BudgetBand = (typeof BUDGET_BANDS)[number];
export const BUDGET_LABELS: Record<BudgetBand, string> = {
  under_100k: "Under ฿100k",
  "100k_500k": "฿100k to ฿500k",
  "500k_1m": "฿500k to ฿1M",
  over_1m: "Over ฿1M",
};
// The figures behind each label, so a model that repeats the band isn't treated as inventing one
export const BUDGET_BOUNDS: Record<BudgetBand, number[]> = {
  under_100k: [100_000],
  "100k_500k": [100_000, 500_000],
  "500k_1m": [500_000, 1_000_000],
  over_1m: [1_000_000],
};

type BriefValues = { budgetBand?: BudgetBand; timeline: string; template: TemplateId; retainerMonths?: number; objective: Objective };

export function budgetLine(brief: Pick<BriefValues, "budgetBand">): string {
  return brief.budgetBand ? `${BUDGET_LABELS[brief.budgetBand]} (from the brief)` : "TBC (not in the brief)";
}

export function timelineLine(brief: Pick<BriefValues, "timeline" | "template" | "retainerMonths">): string {
  if (brief.template === "always_on" && brief.retainerMonths) {
    return `${brief.retainerMonths}-month retainer${brief.timeline ? `, ${brief.timeline}` : ""} (from the brief)`;
  }
  return brief.timeline ? `${brief.timeline} (from the brief)` : "TBC (not in the brief)";
}

export function defaultPhases(brief: Pick<BriefValues, "template" | "retainerMonths">): SectionContent["phased_plan"]["phases"] {
  if (brief.template === "standard") {
    return [
      { name: "Build-up", timing: "Week 1", activities: "" },
      { name: "Launch", timing: "Weeks 2 to 3", activities: "" },
      { name: "Sustain", timing: "Week 4", activities: "" },
    ];
  }
  const months = brief.retainerMonths ?? 3;
  const phases = [
    { name: "Onboard and test", timing: "Month 1", activities: "" },
    { name: "Learn and optimise", timing: "Month 2", activities: "" },
    { name: "Scale what works", timing: months > 3 ? `Months 3 to ${months}` : "Month 3", activities: "" },
  ];
  return phases.slice(0, Math.min(months, 3));
}

const OUTCOME_KPIS: Record<Objective, string[]> = {
  awareness: ["Reach (unique accounts)", "Video views", "Brand mentions"],
  engagement: ["Engagement rate", "Comments and shares", "Saves"],
  conversion: ["Link clicks", "Promo code redemptions", "Cost per acquisition"],
};

// Outcome targets stay TBC until agreed with the client; the two process KPIs carry marked defaults
export function defaultKpis(objective: Objective): Kpi[] {
  return [
    ...OUTCOME_KPIS[objective].map((metric) => ({ metric, target: "TBC", basis: "tbc" as const, note: "" })),
    { metric: "Posts delivered on schedule", target: "100%", basis: "default", note: "" },
    { metric: "Brand-safety incidents", target: "0", basis: "default", note: "" },
  ];
}
export const TEMPLATE_DEFAULT_FIGURES = [100, 0];

export const DEFAULT_RISKS: SectionContent["risks"]["risks"] = [
  { risk: "Creator content drifts from the brief", mitigation: "Share a one-page creator brief and review drafts before they go live." },
  { risk: "A brand-safety issue involving a creator", mitigation: "Screen creators before contracting, agree a pause protocol and keep a replacement list." },
  { risk: "Posting dates slip", mitigation: "Fix a posting calendar with buffer days and confirm dates in writing." },
  { risk: "Organic reach drops on one platform", mitigation: "Spread posts across creators and platforms and move volume to what performs." },
];

// BR-CP-1: with no shortlist the creator section says so and names nobody
export const NO_SHORTLIST_TEXT =
  "No creator shortlist is attached yet. Attach a Creator Matrix shortlist to fill this section; until then no creators are named in this proposal.";

// FR-CORE-16: the deterministic draft used when the model fails. Every gap reads TBC.
export function skeleton(key: SectionKey, brief: BriefValues, shortlistIds: string[] | null): SectionContent[SectionKey] {
  switch (key) {
    case "situation":
      return { situation: "TBC", insight: "TBC" };
    case "big_idea":
      return { title: "TBC", summary: "TBC", whyItWorks: "TBC" };
    case "creator_strategy":
      return shortlistIds
        ? { approach: "TBC", creators: shortlistIds.map((creatorId) => ({ creatorId, role: "TBC", why: "" })) }
        : { approach: NO_SHORTLIST_TEXT, creators: [] };
    case "content_pillars":
      return { pillars: [1, 2, 3].map(() => ({ name: "TBC", description: "TBC", formats: "TBC" })) };
    case "phased_plan":
      return { budget: budgetLine(brief), timeline: timelineLine(brief), phases: defaultPhases(brief).map((p) => ({ ...p, activities: "TBC" })) };
    case "kpi_frame":
      return { kpis: defaultKpis(brief.objective) };
    case "risks":
      return { risks: DEFAULT_RISKS };
  }
}
