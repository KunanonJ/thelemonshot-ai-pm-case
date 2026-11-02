const compact = new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 });

export function fmtCompact(n: number | null | undefined): string {
  return n === null || n === undefined ? "–" : compact.format(n);
}

export function fmtPct(n: number | null | undefined, digits = 1): string {
  return n === null || n === undefined ? "–" : `${n.toFixed(digits)}%`;
}

export function fmtScore(n: number | null | undefined): string {
  return n === null || n === undefined ? "–" : String(Math.round(n));
}

export function fmtAgo(ms: number | null | undefined): string {
  if (!ms) return "never";
  const s = Math.max(0, (Date.now() - ms) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86_400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86_400)}d ago`;
}

export function fmtDateTime(ms: number | null | undefined): string {
  return ms ? new Date(ms).toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }) : "–";
}

export const CATEGORY_LABELS: Record<string, string> = { food_snacks: "Food & snacks", beauty: "Beauty" };
export const categoryLabel = (c: string) => CATEGORY_LABELS[c] ?? c.replace(/_/g, " ");

export const OBJECTIVE_LABELS: Record<string, string> = { awareness: "Awareness", engagement: "Engagement", conversion: "Conversion" };

export const PLATFORM_LABELS: Record<string, string> = { instagram: "Instagram", tiktok: "TikTok", youtube: "YouTube" };

export const FLAG_LABELS: Record<string, string> = {
  rationale_unavailable: "Rationale unavailable",
  rationale_unverified: "Rationale unverified",
  low_confidence: "Low confidence",
  cold_start: "No history yet",
  stale_data: "Stale data",
  must_include: "Must include",
};

export const TEMPLATE_LABELS: Record<string, string> = { standard: "Standard campaign", always_on: "Always-on retainer" };

export const ORIGIN_LABELS: Record<string, string> = {
  generated: "Drafted by the model",
  regenerated: "Regenerated",
  edited: "Edited",
  template: "Template draft",
  empty: "Empty by design",
};

export const KPI_BASIS_LABELS: Record<string, string> = { tbc: "To be agreed", default: "Template default", brief: "From the brief", planner: "Set by the planner" };

// What the guards changed or noticed in a section version
export function sectionFlag(flag: string): { label: string; tone: "amber" | "neutral" | "red" } {
  const [kind, value] = flag.split(/:(.*)/s);
  const n = Number(value);
  if (kind === "figures_replaced") return { label: `${n} unsourced figure${n === 1 ? "" : "s"} replaced with TBC`, tone: "amber" };
  if (kind === "creators_removed") return { label: `${n} creator mention${n === 1 ? "" : "s"} removed`, tone: "amber" };
  if (kind === "superlatives") return { label: "Check wording: superlatives", tone: "amber" };
  if (kind === "avoid") return { label: `Mentions a topic to avoid: ${value}`, tone: "red" };
  if (kind === "template_draft") return { label: "Template draft, the model was unavailable", tone: "amber" };
  if (kind === "no_shortlist") return { label: "No shortlist attached", tone: "neutral" };
  return { label: flag, tone: "neutral" };
}

export const ACTION_LABELS: Record<string, string> = {
  scale_creator: "Scale this creator",
  shift_posting_window: "Shift the posting window",
  brief_follow_up: "Brief a follow-up asset",
  retire_placement: "Retire this placement",
  keep_monitoring: "Keep monitoring",
};

export const DELTA_LABELS: Record<string, string> = {
  "vsBaseline.views": "Views vs baseline",
  "vsBaseline.er": "Engagement vs baseline",
  "vsPeer.views": "Views vs peer median",
  "vsPeer.er": "Engagement vs peer median",
  trend: "Trend",
};

export const TREND_LABELS: Record<string, string> = { rising: "Rising", steady: "Steady", falling: "Slowing", too_early: "Too early" };

export function fmtSignedPct(n: number | null | undefined): string {
  return n === null || n === undefined ? "–" : `${n > 0 ? "+" : ""}${n.toFixed(1)}%`;
}

export function fmtDate(ms: number | null | undefined): string {
  return ms ? new Date(ms).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" }) : "–";
}
