import pptxgen from "pptxgenjs";
import type { ProposalDoc } from "./document";
import { fmtDate } from "./document";
import { evidenceLine, KPI_BASIS_LABELS } from "./render-html";
import { NO_SHORTLIST_TEXT, type SectionContent } from "./templates";

// FR-CP-6: the deck is built inside the Worker (pptxgenjs passed the Phase 0 smoke test) and stored in R2.
// One slide per section; long tables continue on titled slides; assumptions close the deck (FR-CP-5).
// PowerPoint only applies "shrink text on overflow" once a slide is edited, so sizes are worked out here.

const INK = "171717";
const MUTED = "737373";
const LINE = "E5E5E5";
const LEMON = "F4E04D";
const X = 0.75;
const W = 11.85;
const BODY_TOP = 1.45;
const BODY_BOTTOM = 6.8;
const CELL_PAD = 0.06;

// Rough text metrics (inches): Arial and Tahoma average about half an em per character
const charWidth = (pt: number) => (pt * 0.5) / 72;
const lineHeight = (pt: number) => (pt * 1.25) / 72;

export function estimateLines(text: string, widthIn: number, pt: number): number {
  const perLine = Math.max(1, Math.floor(widthIn / charWidth(pt)));
  return text.split("\n").reduce((n, para) => n + Math.max(1, Math.ceil(para.length / perLine)), 0);
}

// Largest size from the list whose estimated height fits the box
export function fitFont(parts: { text: string; scale?: number }[], widthIn: number, heightIn: number, sizes = [16, 15, 14, 13, 12, 11, 10]): number {
  for (const pt of sizes) {
    const h = parts.reduce((sum, p) => sum + estimateLines(p.text, widthIn, pt * (p.scale ?? 1)) * lineHeight(pt * (p.scale ?? 1)) + 0.12, 0);
    if (h <= heightIn) return pt;
  }
  return sizes[sizes.length - 1]!;
}

type Row = { cells: pptxgen.TableRow; texts: string[] };

// Splits rows into slide-sized pages from estimated row heights
export function paginate(rows: { texts: string[] }[], colW: number[], pt: number, firstHeight: number, nextHeight: number): number[][] {
  const pages: number[][] = [[]];
  let room = firstHeight - (lineHeight(pt) + 2 * CELL_PAD); // header row
  rows.forEach((row, i) => {
    const h = Math.max(...row.texts.map((t, c) => estimateLines(t, colW[c]! - 2 * CELL_PAD, pt))) * lineHeight(pt) + 2 * CELL_PAD;
    if (h > room && pages[pages.length - 1]!.length) {
      pages.push([]);
      room = nextHeight - (lineHeight(pt) + 2 * CELL_PAD);
    }
    pages[pages.length - 1]!.push(i);
    room -= h;
  });
  return pages;
}

export async function buildProposalPptx(doc: ProposalDoc): Promise<Uint8Array> {
  const pres = new pptxgen();
  pres.layout = "LAYOUT_WIDE"; // 13.33 x 7.5 in
  pres.title = `${doc.brief.brand}: campaign proposal`;
  pres.company = "Lemon Shot AI Suite";
  const font = doc.brief.language === "th" ? "Tahoma" : "Arial";
  const footer = `Lemon Shot AI Suite · Proposal ${doc.run.id.slice(0, 8)}${doc.sampleData ? " · Sample data: public profiles used for demonstration" : ""}`;

  const slideWithTitle = (title: string) => {
    const slide = pres.addSlide();
    slide.background = { color: "FFFFFF" };
    slide.addShape(pres.ShapeType.rect, { x: X, y: 0.62, w: 0.1, h: 0.42, fill: { color: LEMON }, line: { color: LEMON } });
    slide.addText(title, { x: X + 0.25, y: 0.5, w: W - 0.25, h: 0.66, fontFace: font, fontSize: 24, bold: true, color: INK, margin: 0 });
    slide.addText(footer, { x: X, y: 6.95, w: W, h: 0.3, fontFace: font, fontSize: 9, color: MUTED, margin: 0 });
    return slide;
  };

  const body = (slide: pptxgen.Slide, parts: { label?: string; text: string; scale?: number }[], y = BODY_TOP, h = BODY_BOTTOM - BODY_TOP) => {
    const pt = fitFont(parts.map((p) => ({ text: (p.label ? `${p.label}\n` : "") + (p.text || "TBC"), scale: p.scale })), W, h);
    const runs: pptxgen.TextProps[] = parts.flatMap((p) => [
      ...(p.label ? [{ text: p.label.toUpperCase(), options: { fontSize: Math.max(10, pt - 4), color: MUTED, bold: true, breakLine: true } }] : []),
      { text: p.text || "TBC", options: { fontSize: Math.round(pt * (p.scale ?? 1)), color: INK, breakLine: true, paraSpaceAfter: 10 } },
    ]);
    slide.addText(runs, { x: X, y, w: W, h, fontFace: font, valign: "top", margin: 0 });
  };

  // Tables continue on extra slides titled "(continued)", each with its header row
  const table = (title: string, head: string[], rows: Row[], colW: number[], opts: { pt?: number; intro?: string } = {}) => {
    const pt = opts.pt ?? 11;
    let top = BODY_TOP;
    const introPt = opts.intro ? fitFont([{ text: opts.intro }], W, 1.0, [14, 13, 12, 11]) : 0;
    const introH = opts.intro ? Math.min(1.0, estimateLines(opts.intro, W, introPt) * lineHeight(introPt) + 0.1) : 0;
    const pages = paginate(rows, colW, pt, BODY_BOTTOM - top - introH - (opts.intro ? 0.15 : 0), BODY_BOTTOM - BODY_TOP);
    pages.forEach((page, n) => {
      const slide = slideWithTitle(n === 0 ? title : `${title} (continued)`);
      top = BODY_TOP;
      if (n === 0 && opts.intro) {
        slide.addText(opts.intro, { x: X, y: top, w: W, h: introH, fontFace: font, fontSize: introPt, color: INK, valign: "top", margin: 0 });
        top += introH + 0.15;
      }
      const header: pptxgen.TableRow = head.map((text) => ({ text, options: { bold: true, color: MUTED, fill: { color: "F5F5F5" } } }));
      slide.addTable([header, ...page.map((i) => rows[i]!.cells)], {
        x: X,
        y: top,
        w: W,
        colW,
        fontFace: font,
        fontSize: pt,
        color: INK,
        valign: "top",
        border: { type: "solid", pt: 0.5, color: LINE },
        margin: CELL_PAD,
      });
    });
  };
  const row = (texts: string[], styles: (pptxgen.TableCellProps | undefined)[] = []): Row => ({
    texts,
    cells: texts.map((text, i) => ({ text, options: styles[i] })),
  });

  // Cover
  const cover = pres.addSlide();
  cover.background = { color: "FFFFFF" };
  cover.addShape(pres.ShapeType.rect, { x: X, y: 1.9, w: 0.16, h: 0.16, fill: { color: LEMON }, line: { color: "D4C23F" } });
  cover.addText(`CAMPAIGN PROPOSAL · ${doc.template.name.toUpperCase()}`, { x: X + 0.3, y: 1.8, w: W, h: 0.36, fontFace: font, fontSize: 12, color: MUTED, margin: 0 });
  cover.addText(doc.brief.brand || "Untitled brief", { x: X, y: 2.35, w: W, h: 1.2, fontFace: font, fontSize: fitFont([{ text: doc.brief.brand }], W, 1.2, [44, 36, 30, 24]), bold: true, color: INK, margin: 0 });
  cover.addText([doc.brief.product, doc.brief.objective[0]!.toUpperCase() + doc.brief.objective.slice(1)].filter(Boolean).join(" · "), {
    x: X,
    y: 3.55,
    w: W,
    h: 0.5,
    fontFace: font,
    fontSize: 18,
    color: "404040",
    margin: 0,
  });
  const approved = doc.run.reviewedAt ? `Approved ${fmtDate(doc.run.reviewedAt)}` : "Approved";
  cover.addText(`Proposal ${doc.run.id.slice(0, 8)} · ${approved}${doc.sampleData ? " · Sample data" : ""}`, { x: X, y: 4.4, w: W, h: 0.4, fontFace: font, fontSize: 12, color: MUTED, margin: 0 });

  for (const s of doc.sections) {
    const raw = s.current?.content;
    if (!raw) {
      body(slideWithTitle(s.title), [{ text: "Not drafted yet." }]);
      continue;
    }
    switch (s.key) {
      case "situation": {
        const c = raw as SectionContent["situation"];
        body(slideWithTitle(s.title), [
          { label: "Situation", text: c.situation },
          { label: "Insight", text: c.insight },
        ]);
        break;
      }
      case "big_idea": {
        const c = raw as SectionContent["big_idea"];
        body(slideWithTitle(s.title), [{ text: c.title, scale: 1.7 }, { text: c.summary }, { label: "Why it works", text: c.whyItWorks }]);
        break;
      }
      case "creator_strategy": {
        const c = raw as SectionContent["creator_strategy"];
        // BR-CP-1: no shortlist, no names
        if (!doc.flags.shortlist) {
          body(slideWithTitle(s.title), [{ text: NO_SHORTLIST_TEXT }]);
          break;
        }
        const rows = c.creators.map((cr) => {
          const e = doc.evidence[cr.creatorId];
          return row([e?.displayName ?? "Not in the shortlist", cr.role, cr.why, e ? evidenceLine(e) : "No evidence"], [{ bold: true }, undefined, undefined, { color: MUTED }]);
        });
        table(s.title, ["Creator", "Role", "Why", "Evidence"], rows, [2.3, 1.8, 4.45, 3.3], { pt: 10, intro: c.approach });
        break;
      }
      case "content_pillars": {
        const c = raw as SectionContent["content_pillars"];
        table(s.title, ["Pillar", "What it covers", "Formats"], c.pillars.map((p) => row([p.name, p.description, p.formats], [{ bold: true }])), [2.6, 6.45, 2.8], { pt: 12 });
        break;
      }
      case "phased_plan": {
        const c = raw as SectionContent["phased_plan"];
        table(s.title, ["Phase", "Timing", "Activities"], c.phases.map((p) => row([p.name, p.timing, p.activities], [{ bold: true }])), [2.4, 2.0, 7.45], {
          pt: 12,
          intro: `Budget: ${c.budget}\nTimeline: ${c.timeline}`,
        });
        break;
      }
      case "kpi_frame": {
        const c = raw as SectionContent["kpi_frame"];
        table(
          s.title,
          ["Metric", "Target", "Basis", "How it's measured"],
          c.kpis.map((k) => row([k.metric, k.target, KPI_BASIS_LABELS[k.basis] ?? k.basis, k.note], [undefined, { bold: true }, { color: MUTED }])),
          [3.2, 1.6, 1.9, 5.15],
          { pt: 12 },
        );
        break;
      }
      case "risks": {
        const c = raw as SectionContent["risks"];
        table(s.title, ["Risk", "Mitigation"], c.risks.map((r) => row([r.risk, r.mitigation])), [5.0, 6.85], { pt: 12 });
        break;
      }
    }
  }

  // FR-CP-5: the assumptions close the deck
  const last = slideWithTitle("Assumptions");
  const pt = fitFont([{ text: doc.assumptions.join("\n") }], W - 0.3, BODY_BOTTOM - BODY_TOP, [14, 13, 12, 11, 10]);
  last.addText(
    doc.assumptions.map((a) => ({ text: a, options: { bullet: true, breakLine: true, paraSpaceAfter: 6 } })),
    { x: X, y: BODY_TOP, w: W, h: BODY_BOTTOM - BODY_TOP, fontFace: font, fontSize: pt, color: "404040", valign: "top", margin: 0 },
  );

  // Stored, not deflated: pptxgenjs ignores `compression` for typed outputs, and skipping it saves Worker CPU
  return (await pres.write({ outputType: "uint8array" })) as Uint8Array;
}
