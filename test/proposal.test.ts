import { describe, expect, it } from "vitest";
import { proposalBriefSchema } from "../src/worker/products/proposal/brief";
import { mergeKpis, outputJsonSchema, toContent } from "../src/worker/products/proposal/contract";
import { buildAssumptions, type ProposalDoc } from "../src/worker/products/proposal/document";
import { allowedFigures, CREATOR_PLACEHOLDER, findFigures, guardCreators, guardFigures, guardModelOutput, lintText, makeCreatorGuard } from "../src/worker/products/proposal/guard";
import { renderProposalHtml } from "../src/worker/products/proposal/render-html";
import { fitFont, paginate } from "../src/worker/products/proposal/render-pptx";
import { defaultPhases, NO_SHORTLIST_TEXT, skeleton, TEMPLATES, type SectionKey } from "../src/worker/products/proposal/templates";

const brief = proposalBriefSchema.parse({ template: "standard", brand: "Crunchy Co", product: "Seaweed chips", objective: "awareness", budgetBand: "100k_500k" });

describe("figure guard (HR-3, FR-CP-3)", () => {
  it("treats currency, percentages, multiples and magnitudes as figures, but not structure or years", () => {
    const kinds = findFigures("Reach 2.5M people, lift sales 30%, 3x ROI, ฿250k budget, 12,000 views in 2026, Week 2, 3 pillars, Q4").map((f) => [f.raw, f.kind]);
    expect(kinds).toEqual([
      ["2.5M", "count"],
      ["30%", "percent"],
      ["3x", "multiple"],
      ["฿250k", "money"],
      ["12,000", "count"],
    ]);
  });

  it("reads Thai magnitudes", () => {
    expect(findFigures("ยอดวิว 1 ล้านวิว").map((f) => f.value)).toEqual([1_000_000]);
  });

  it("replaces unsupported figures with TBC and keeps figures that trace to an input", () => {
    const allowed = allowedFigures([125_400, 4.37], []);
    const out = guardFigures("She has 125K followers and a 4.4% engagement rate, so expect 2M views.", allowed);
    expect(out.text).toBe("She has 125K followers and a 4.4% engagement rate, so expect TBC views.");
    expect(out.replaced).toBe(1);
  });

  it("lets the model repeat figures written in the brief", () => {
    const allowed = allowedFigures([], ["Launch budget around ฿300k"]);
    expect(guardFigures("Keep production inside ฿300k.", allowed).replaced).toBe(0);
  });
});

describe("creator guard (FR-CP-2)", () => {
  const guard = makeCreatorGuard({ names: ["Nong View"], handles: ["nongview"] }, { names: ["Snack Queen BKK", "เจ๊ขนมอร่อย"], handles: ["snackqueen.bkk"] }, ["Crunchy Co"]);

  it("removes @mentions and roster names that aren't on the shortlist", () => {
    const out = guardCreators("Pair @nongview with @snackqueen.bkk and Snack Queen BKK, or @madeup_creator.", guard);
    expect(out.text).toBe(`Pair @nongview with ${CREATOR_PLACEHOLDER} and ${CREATOR_PLACEHOLDER}, or ${CREATOR_PLACEHOLDER}.`);
    expect(out.removed).toBe(3);
  });

  it("matches Thai names without word boundaries", () => {
    expect(guardCreators("ให้เจ๊ขนมอร่อยรีวิว", guard).removed).toBe(1);
  });

  it("never blocks the brand", () => {
    const g = makeCreatorGuard({ names: [], handles: [] }, { names: ["Crunchy Co"], handles: [] }, ["Crunchy Co"]);
    expect(guardCreators("Crunchy Co launches", g).removed).toBe(0);
  });
});

describe("lint (BR-CP-3)", () => {
  it("flags superlatives and topics to avoid without changing text", () => {
    expect(lintText("The best snack, guaranteed", [])).toEqual(["superlatives"]);
    expect(lintText("ขนมที่อร่อยที่สุด", [])).toEqual(["superlatives"]);
    expect(lintText("A diet-friendly crunch", ["diet"])).toEqual(["avoid:diet"]);
  });

  it("reports what a guarded section changed", () => {
    const g = { figures: [], creators: makeCreatorGuard({ names: [], handles: [] }, { names: [], handles: [] }, []), mustAvoid: [] };
    const out = guardModelOutput({ summary: "Hit 5M views with @someone", creators: [{ creatorId: "@id-stays" }] }, g);
    expect(out.value).toEqual({ summary: `Hit TBC views with ${CREATOR_PLACEHOLDER}`, creators: [{ creatorId: "@id-stays" }] });
    expect(out.flags).toEqual(["figures_replaced:1", "creators_removed:1"]);
  });
});

describe("model contract", () => {
  it("emits a strict JSON schema without the $schema key", () => {
    const { name, schema } = outputJsonSchema("big_idea");
    expect(name).toBe("proposal_big_idea");
    expect(schema.$schema).toBeUndefined();
    expect(schema.additionalProperties).toBe(false);
  });

  it("keeps only shortlisted creators, once each (FR-CP-2)", () => {
    const raw = { approach: "Hero plus community", creators: [{ creatorId: "a", role: "Hero", why: "x" }, { creatorId: "zzz", role: "Hero", why: "x" }, { creatorId: "a", role: "Dup", why: "y" }] };
    const { content, dropped } = toContent("creator_strategy", raw, { brief, shortlistIds: new Set(["a", "b"]) });
    expect((content as { creators: unknown[] }).creators).toHaveLength(1);
    expect(dropped).toBe(2);
  });

  it("sets KPI targets from the template, never from the model (FR-CP-3)", () => {
    const kpis = mergeKpis(
      [
        { metric: "video views", note: "Platform analytics" },
        { metric: "Search lift", note: "Google Trends" },
        { metric: "Saves", note: "a" },
        { metric: "Shares", note: "b" },
      ],
      "awareness",
    );
    expect(kpis.find((k) => k.metric === "Video views")).toMatchObject({ target: "TBC", basis: "tbc", note: "Platform analytics" });
    expect(kpis.find((k) => k.metric === "Posts delivered on schedule")).toMatchObject({ target: "100%", basis: "default" });
    expect(kpis.filter((k) => k.basis === "tbc" && !["Reach (unique accounts)", "Video views", "Brand mentions"].includes(k.metric))).toHaveLength(2);
  });

  it("adds budget and timeline from the brief to the phased plan", () => {
    const { content } = toContent("phased_plan", { phases: [{ name: "Launch", timing: "Week 1", activities: "Go" }] }, { brief, shortlistIds: null });
    expect(content).toMatchObject({ budget: "฿100k to ฿500k (from the brief)", timeline: "TBC (not in the brief)" });
  });
});

describe("templates (FR-CP-1)", () => {
  it("requires the retainer length for the always-on template", () => {
    const r = proposalBriefSchema.safeParse({ template: "always_on", brand: "A", product: "B", objective: "engagement" });
    expect(r.success).toBe(false);
    expect(r.error?.issues[0]?.path).toEqual(["retainerMonths"]);
    expect(proposalBriefSchema.safeParse({ template: "always_on", brand: "A", product: "B", objective: "engagement", retainerMonths: 6 }).success).toBe(true);
  });

  it("orders sections per template", () => {
    expect(TEMPLATES.standard.sections.map((s) => s.key).indexOf("creator_strategy")).toBeLessThan(TEMPLATES.standard.sections.map((s) => s.key).indexOf("content_pillars"));
    expect(TEMPLATES.always_on.sections.map((s) => s.key).indexOf("creator_strategy")).toBeGreaterThan(TEMPLATES.always_on.sections.map((s) => s.key).indexOf("content_pillars"));
  });

  it("builds months for a retainer", () => {
    expect(defaultPhases({ template: "always_on", retainerMonths: 6 }).map((p) => p.timing)).toEqual(["Month 1", "Month 2", "Months 3 to 6"]);
    expect(defaultPhases({ template: "always_on", retainerMonths: 2 })).toHaveLength(2);
  });

  it("names nobody in the creator skeleton without a shortlist (BR-CP-1)", () => {
    expect(skeleton("creator_strategy", brief, null)).toEqual({ approach: NO_SHORTLIST_TEXT, creators: [] });
    expect(skeleton("creator_strategy", brief, ["a"])).toEqual({ approach: "TBC", creators: [{ creatorId: "a", role: "TBC", why: "" }] });
  });
});

describe("deck layout (FR-CP-6)", () => {
  it("shrinks body text until it fits the box", () => {
    expect(fitFont([{ text: "Short" }], 11.85, 5.3)).toBe(16);
    expect(fitFont([{ text: "x".repeat(3000) }], 11.85, 5.3)).toBeLessThan(16);
  });

  it("continues long tables on new pages, never splitting a row", () => {
    const rows = Array.from({ length: 15 }, () => ({ texts: ["Demo Creator", "Launch lead", "y".repeat(300), "Score 80 · TT 1M followers, ER 5.0%"] }));
    const pages = paginate(rows, [2.3, 1.8, 4.45, 3.3], 10, 4.2, 5.35);
    expect(pages.length).toBeGreaterThan(1);
    expect(pages.flat()).toEqual(rows.map((_, i) => i));
    expect(paginate(rows.slice(0, 2), [2.3, 1.8, 4.45, 3.3], 10, 4.2, 5.35)).toEqual([[0, 1]]);
  });
});

// AC-CP-2 inspection test: no shortlist means an explicit empty creator section and no creator names
describe("HTML export without a shortlist (AC-CP-2)", () => {
  const roster = ["Nong View", "Snack Queen BKK", "nongview", "snackqueen.bkk"];
  const content: Partial<Record<SectionKey, Record<string, unknown>>> = {
    situation: { situation: "Snacking moves to <script>alert(1)</script> desks", insight: "People snack between calls" },
    big_idea: { title: "Desk Crunch", summary: "A desk-snack ritual", whyItWorks: "It fits the insight" },
    creator_strategy: { approach: NO_SHORTLIST_TEXT, creators: [] },
    content_pillars: { pillars: [{ name: "Desk rituals", description: "Snack breaks", formats: "Short video" }] },
    phased_plan: { budget: "TBC (not in the brief)", timeline: "TBC (not in the brief)", phases: [{ name: "Launch", timing: "Week 1", activities: "Posts" }] },
    kpi_frame: { kpis: [{ metric: "Video views", target: "TBC", basis: "tbc", note: "" }] },
    risks: { risks: [{ risk: "Slip", mitigation: "Buffer" }] },
  };
  const template = TEMPLATES.standard;
  const doc = {
    run: { id: "run-12345678", status: "approved", reviewedAt: Date.UTC(2026, 10, 2) },
    brief,
    template,
    flags: { template: "standard", language: "en", shortlist: null },
    sections: template.sections.map((s, i) => ({
      key: s.key,
      title: s.title,
      position: i,
      status: "ready",
      error: null,
      versionCount: 1,
      current: { id: `v-${s.key}`, version: 1, origin: s.key === "creator_strategy" ? "empty" : "generated", content: content[s.key]!, citations: [], flags: [] },
    })),
    shortlist: null,
    evidence: {},
    assumptions: buildAssumptions({ brief, template, shortlist: null, attached: false, model: null, sampleData: false }),
    sampleData: false,
  } as unknown as ProposalDoc;
  const html = renderProposalHtml(doc, { draft: false });

  it("prints the empty creator section explicitly", () => {
    expect(html).toContain(NO_SHORTLIST_TEXT);
    expect(html).toContain("Creator shortlist: none attached");
  });

  it("contains no creator names, handles or mentions", () => {
    const text = html.replace(/<style>[\s\S]*?<\/style>/, ""); // CSS @media rules aren't mentions
    for (const name of roster) expect(text.toLowerCase()).not.toContain(name.toLowerCase());
    expect(text).not.toMatch(/@[a-z0-9._]/i);
  });

  it("escapes every value", () => {
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("&lt;script&gt;");
  });

  it("ends with the assumptions block (FR-CP-5)", () => {
    expect(html.indexOf("<h2>Assumptions</h2>")).toBeGreaterThan(html.indexOf("Risks and mitigations"));
  });
});
