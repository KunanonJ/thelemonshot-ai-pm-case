import type { ProposalDoc } from "./document";
import { fmtDate } from "./document";
import type { Evidence } from "./evidence";
import { NO_SHORTLIST_TEXT, type SectionContent, type SectionKey } from "./templates";

// FR-CP-6: a self-contained, printable HTML proposal. Every value is escaped: brief text and model text
// both end up here.

const ESCAPES: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
export const esc = (text: string) => text.replace(/[&<>"']/g, (c) => ESCAPES[c]!);
const para = (text: string) => (text.trim() ? `<p>${esc(text.trim()).replace(/\n+/g, "<br>")}</p>` : "");

const compact = new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 });
const PLATFORM_SHORT: Record<string, string> = { instagram: "IG", tiktok: "TikTok", youtube: "YT" };
export const KPI_BASIS_LABELS: Record<string, string> = { tbc: "To be agreed", default: "Template default", brief: "From the brief", planner: "Set by the planner" };

// FR-CP-2: the data behind a creator, as cited from the Matrix run
export function evidenceLine(e: Evidence): string {
  const parts = [e.composite !== null ? `Score ${Math.round(e.composite)}` : "No score"];
  for (const p of e.platforms) {
    const bits = [p.followers !== null ? `${compact.format(p.followers)} followers` : "followers: no data", p.engagementRate !== null ? `ER ${p.engagementRate.toFixed(1)}%` : null];
    parts.push(`${PLATFORM_SHORT[p.platform] ?? p.platform} ${bits.filter(Boolean).join(", ")}`);
  }
  const latest = Math.max(0, ...e.platforms.map((p) => p.fetchedAt));
  if (latest) parts.push(`data from ${fmtDate(latest)}`);
  return parts.join(" · ");
}

function table(head: string[], rows: string[][], cls = ""): string {
  return `<table class="${cls}"><thead><tr>${head.map((h) => `<th>${esc(h)}</th>`).join("")}</tr></thead><tbody>${rows
    .map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join("")}</tr>`)
    .join("")}</tbody></table>`;
}

function sectionBody(key: SectionKey, raw: Record<string, unknown>, doc: ProposalDoc): string {
  switch (key) {
    case "situation": {
      const c = raw as SectionContent["situation"];
      return `<h3>Situation</h3>${para(c.situation)}<h3>Insight</h3>${para(c.insight)}`;
    }
    case "big_idea": {
      const c = raw as SectionContent["big_idea"];
      return `<p class="idea">${esc(c.title)}</p>${para(c.summary)}<h3>Why it works</h3>${para(c.whyItWorks)}`;
    }
    case "creator_strategy": {
      const c = raw as SectionContent["creator_strategy"];
      // BR-CP-1 / AC-CP-2: an explicit empty section, no names
      if (!doc.flags.shortlist) return `<div class="empty">${esc(NO_SHORTLIST_TEXT)}</div>`;
      const rows = c.creators.map((cr) => {
        const e = doc.evidence[cr.creatorId];
        const name = e ? e.displayName : "Creator not found in the shortlist";
        const handles = e ? Object.entries(e.handles).flatMap(([p, h]) => (h ? [`${PLATFORM_SHORT[p]} @${h}`] : [])).join(" · ") : "";
        return [
          `<strong>${esc(name)}</strong>${handles ? `<div class="muted">${esc(handles)}</div>` : ""}`,
          esc(cr.role),
          esc(cr.why),
          `<span class="muted">${esc(e ? evidenceLine(e) : "No evidence")}</span>`,
        ];
      });
      const source = doc.shortlist ? `<p class="muted small">Creator data from Creator Matrix run ${esc(doc.shortlist.run.id.slice(0, 8))}.</p>` : "";
      return `${para(c.approach)}${rows.length ? table(["Creator", "Role", "Why", "Evidence"], rows, "creators") : '<div class="empty">No creators placed yet.</div>'}${source}`;
    }
    case "content_pillars": {
      const c = raw as SectionContent["content_pillars"];
      return `<div class="pillars">${c.pillars
        .map((p) => `<div class="pillar"><div class="pillar-name">${esc(p.name)}</div>${para(p.description)}<div class="muted small">${esc(p.formats)}</div></div>`)
        .join("")}</div>`;
    }
    case "phased_plan": {
      const c = raw as SectionContent["phased_plan"];
      return `<p class="facts"><span>Budget: ${esc(c.budget)}</span><span>Timeline: ${esc(c.timeline)}</span></p>${table(
        ["Phase", "Timing", "Activities"],
        c.phases.map((p) => [`<strong>${esc(p.name)}</strong>`, esc(p.timing), esc(p.activities)]),
      )}`;
    }
    case "kpi_frame": {
      const c = raw as SectionContent["kpi_frame"];
      return table(
        ["Metric", "Target", "Basis", "How it's measured"],
        c.kpis.map((k) => [esc(k.metric), `<strong>${esc(k.target)}</strong>`, `<span class="muted">${esc(KPI_BASIS_LABELS[k.basis] ?? k.basis)}</span>`, esc(k.note)]),
      );
    }
    case "risks": {
      const c = raw as SectionContent["risks"];
      return table(
        ["Risk", "Mitigation"],
        c.risks.map((r) => [esc(r.risk), esc(r.mitigation)]),
      );
    }
  }
}

const STYLE = `
:root{color-scheme:light}
*{box-sizing:border-box}
body{margin:0;background:#fff;color:#171717;font:15px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"Noto Sans Thai","Leelawadee UI",Tahoma,sans-serif}
.page{max-width:880px;margin:0 auto;padding:40px 24px 64px}
.cover{border-bottom:1px solid #e5e5e5;padding-bottom:28px;margin-bottom:8px}
.kicker{font-size:12px;letter-spacing:.06em;text-transform:uppercase;color:#737373}
.mark{display:inline-block;width:10px;height:10px;border-radius:50%;background:#f4e04d;box-shadow:0 0 0 1px rgba(0,0,0,.1);margin-right:8px;vertical-align:1px}
h1{font-size:34px;line-height:1.15;margin:12px 0 6px;letter-spacing:-.01em}
.sub{font-size:17px;color:#404040;margin:0}
.meta{font-size:13px;color:#737373;margin-top:14px}
.tag{display:inline-block;font-size:11px;font-weight:600;border-radius:4px;padding:2px 6px;margin-left:6px;background:#fef3c7;color:#92400e}
.draft{margin:16px 0 0;padding:10px 14px;border:1px solid #fde68a;background:#fffbeb;color:#92400e;border-radius:8px;font-size:13px}
section{padding:28px 0 8px;border-bottom:1px solid #f0f0f0}
h2{font-size:20px;margin:0 0 12px;letter-spacing:-.01em}
h3{font-size:13px;text-transform:uppercase;letter-spacing:.05em;color:#737373;margin:16px 0 4px}
p{margin:0 0 10px}
.idea{font-size:22px;font-weight:600;margin:4px 0 10px}
.muted{color:#737373}.small{font-size:12px}
.empty{border:1px dashed #d4d4d4;border-radius:8px;padding:16px;color:#525252;font-size:14px}
.facts span{display:inline-block;margin-right:20px;font-size:14px}
table{width:100%;border-collapse:collapse;margin:8px 0 12px;font-size:14px}
th{text-align:left;font-weight:500;font-size:12px;color:#737373;border-bottom:1px solid #e5e5e5;padding:6px 8px}
td{vertical-align:top;border-bottom:1px solid #f0f0f0;padding:8px}
.creators td:last-child{font-size:12px;width:30%}
.pillars{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:12px}
.pillar{border:1px solid #e5e5e5;border-radius:8px;padding:14px}
.pillar-name{font-weight:600;margin-bottom:6px}
.assumptions li{margin:0 0 6px;font-size:14px;color:#404040}
footer{margin-top:32px;font-size:12px;color:#a3a3a3}
@media (max-width:640px){h1{font-size:26px}.creators td:last-child{width:auto}}
@media print{@page{size:A4;margin:16mm}.page{padding:0;max-width:none}section{break-inside:avoid-page}.cover{break-after:avoid}a{color:inherit}}
`;

export function renderProposalHtml(doc: ProposalDoc, opts: { draft: boolean }): string {
  const b = doc.brief;
  const title = `${b.brand || "Untitled"}: campaign proposal`;
  const status = opts.draft ? "Draft, not approved" : doc.run.reviewedAt ? `Approved ${fmtDate(doc.run.reviewedAt)}` : "Approved";
  const sections = doc.sections
    .map((s) => {
      const body = s.current ? sectionBody(s.key, s.current.content, doc) : '<div class="empty">Not drafted yet.</div>';
      return `<section id="${s.key}"><h2>${esc(s.title)}</h2>${body}</section>`;
    })
    .join("");
  return `<!doctype html>
<html lang="${b.language}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title>
<style>${STYLE}</style>
</head>
<body>
<div class="page">
<header class="cover">
<div class="kicker"><span class="mark"></span>Campaign proposal · ${esc(doc.template.name)}</div>
<h1>${esc(b.brand || "Untitled brief")}</h1>
<p class="sub">${esc(b.product)}${b.product ? " · " : ""}${esc(b.objective[0]!.toUpperCase() + b.objective.slice(1))}</p>
<div class="meta">Proposal ${esc(doc.run.id.slice(0, 8))} · ${esc(status)}${doc.sampleData ? '<span class="tag">Sample data</span>' : ""}</div>
${opts.draft ? '<div class="draft">Draft preview: not approved for client use.</div>' : ""}
</header>
<main>${sections}
<section class="assumptions"><h2>Assumptions</h2><ul>${doc.assumptions.map((a) => `<li>${esc(a)}</li>`).join("")}</ul></section>
</main>
<footer>Prepared with Lemon Shot AI Suite · Proposal run ${esc(doc.run.id)}${doc.sampleData ? " · Sample data: public profiles used for demonstration" : ""}</footer>
</div>
</body>
</html>`;
}
