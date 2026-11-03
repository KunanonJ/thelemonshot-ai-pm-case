import { z } from "zod";
import { allowedFigures, guardFigures } from "../../core/figures";
import type { Delta, DigestDeltas } from "./deltas";

// FR-CO-4: the model writes only the narrative (headline, hypotheses, recommendations); verdict, winners,
// losers and freshness come from code. One fixed rubric, versioned with the code (FR-CORE-15).
export const DIGEST_PROMPT_VERSION = "digest-v1";

export const ACTIONS = ["scale_creator", "shift_posting_window", "brief_follow_up", "retire_placement", "keep_monitoring"] as const;
export const DELTA_KEYS = ["vsBaseline.views", "vsBaseline.er", "vsPeer.views", "vsPeer.er", "trend"] as const;
const MAX_ITEMS = 5;

// The schema sent to the model lists the allowed values; parsing stays lenient so one stray value drops a
// recommendation instead of the whole narrative
const strict = z.object({
  headline: z.string(),
  hypotheses: z.array(z.object({ text: z.string(), refs: z.array(z.string()) })),
  recommendations: z.array(z.object({ action: z.enum(ACTIONS), targetId: z.string(), delta: z.enum(DELTA_KEYS), text: z.string() })),
});
export const narrativeSchema = z.object({
  headline: z.string(),
  hypotheses: z.array(z.object({ text: z.string(), refs: z.array(z.string()) })),
  recommendations: z.array(z.object({ action: z.string(), targetId: z.string(), delta: z.string(), text: z.string() })),
});
export type RawNarrative = z.infer<typeof narrativeSchema>;

export function narrativeJsonSchema(): { name: string; schema: Record<string, unknown> } {
  const schema = { ...(z.toJSONSchema(strict) as Record<string, unknown>) };
  delete schema.$schema;
  return { name: "campaign_digest", schema };
}

const SYSTEM_PROMPT = `You write the narrative part of a campaign performance digest for a creator-marketing agency in Thailand. Scope: the organic performance of public creator posts. There is no ad-account data, and this product never gives paid-media advice.

You receive deltas computed by code: per post and per creator, the latest metrics, the change against the planner's baseline and against the peer median of tracked posts on the same platform, and the trend over the last three refreshes.

Rules:
- Use only these deltas. Every number you write must appear in them. Never estimate or forecast.
- headline: one sentence restating the verdict in plain words.
- hypotheses: possible causes of the biggest gaps. They are guesses, so phrase them with "may", "could" or "possibly". List the post or creator IDs each one is about in refs.
- recommendations: at most five. Each picks one action (scale_creator, shift_posting_window, brief_follow_up, retire_placement, keep_monitoring), names one tracked post or creator ID as targetId, names the delta that motivates it (vsBaseline.views, vsBaseline.er, vsPeer.views, vsPeer.er or trend), and explains it in one or two sentences.
- Never recommend boosting posts, ad spend, paid amplification, promoted or sponsored placements, or any budget change.
- For unavailable posts, note the loss; recommend nothing for them except keep_monitoring or retire_placement.
- Reply with one JSON object only: {"headline": ..., "hypotheses": [...], "recommendations": [...]}.`;

// FR-CORE-17: IDs, public names, platforms and computed numbers; no URLs or contact details
export function buildDigestPrompt(campaign: { name: string; brand: string }, d: DigestDeltas): { system: string; user: string } {
  const payload = {
    campaign,
    verdict: d.verdict,
    baselinesSet: d.baselinesSet,
    posts: d.posts.map((p) => ({
      postId: p.postId,
      creatorId: p.creatorId,
      creator: p.creatorName,
      platform: p.platform,
      state: p.state,
      latest: p.latest && { views: p.latest.views, likes: p.latest.likes, comments: p.latest.comments, shares: p.latest.shares, engagementRatePct: p.latest.er },
      notReported: p.notReported,
      vsBaseline: p.vsBaseline,
      vsPeer: p.vsPeer,
      trend: p.trend,
    })),
    creators: d.creators,
    winners: d.winners,
    losers: d.losers,
    unavailable: d.unavailable,
  };
  return { system: SYSTEM_PROMPT, user: JSON.stringify(payload) };
}

// FR-CO-5: paid-media advice is out of vocabulary for this product
const PAID_MEDIA =
  /\b(?:boost(?:ed|ing)?|ad spend|ads? budget|paid (?:media|amplification|ads?|promotion|reach)|promot(?:e|ed|ing) (?:the |this |these )?posts?|sponsored (?:ads?|placements?)|spark ads?|media (?:buy|buying|spend)|cpm|cpc|roas|(?:increase|raise) (?:the )?budget)\b/i;

export type Recommendation = { action: (typeof ACTIONS)[number]; targetId: string; delta: (typeof DELTA_KEYS)[number]; text: string; motivating: Delta | string | null };
export type Narrative = { headline: string; hypotheses: { text: string; refs: string[] }[]; recommendations: Recommendation[] };

// The delta a recommendation rests on, looked up by code so the digest shows the real number
export function motivatingDelta(d: DigestDeltas, targetId: string, key: (typeof DELTA_KEYS)[number]): Delta | string | null {
  const post = d.posts.find((p) => p.postId === targetId);
  if (post) {
    if (key === "trend") return post.trend;
    const [group, metric] = key.split(".") as ["vsBaseline" | "vsPeer", "views" | "er"];
    return post[group][metric];
  }
  const creator = d.creators.find((c) => c.creatorId === targetId);
  if (!creator) return null;
  if (key === "vsBaseline.views") return creator.vsBaseline;
  if (key === "vsPeer.er") return creator.vsPeer;
  return null;
}

// FR-CO-5 and HR-3: recommendations reference tracked posts or creators and a real delta; every figure in the
// text traces to the deltas; anything else is dropped or marked TBC, and the digest says so
export function validateNarrative(raw: RawNarrative, d: DigestDeltas): { narrative: Narrative; flags: string[] } {
  const known = new Set([...d.posts.map((p) => p.postId), ...d.creators.map((c) => c.creatorId)]);
  const figures = allowedFigures(numbersIn(d), [d.verdict.text]);
  let replaced = 0;
  const clean = (text: string) => {
    const g = guardFigures(text.trim(), figures);
    replaced += g.replaced;
    return g.text;
  };
  const headline = clean(raw.headline);
  let dropped = 0;
  let paid = 0;
  const recommendations: Recommendation[] = [];
  for (const r of raw.recommendations) {
    const action = (ACTIONS as readonly string[]).includes(r.action) ? (r.action as Recommendation["action"]) : null;
    const key = (DELTA_KEYS as readonly string[]).includes(r.delta) ? (r.delta as Recommendation["delta"]) : null;
    if (PAID_MEDIA.test(r.text)) {
      paid++;
      continue;
    }
    if (!action || !key || !known.has(r.targetId) || recommendations.length >= MAX_ITEMS) {
      dropped++;
      continue;
    }
    recommendations.push({ action, targetId: r.targetId, delta: key, text: clean(r.text), motivating: motivatingDelta(d, r.targetId, key) });
  }
  const hypotheses = raw.hypotheses.flatMap((h) => {
    const refs = h.refs.filter((id) => known.has(id));
    if (!refs.length || PAID_MEDIA.test(h.text)) {
      dropped++;
      return [];
    }
    return [{ text: clean(h.text), refs }];
  });
  const flags = [
    ...(replaced ? [`figures_replaced:${replaced}`] : []),
    ...(dropped ? [`items_dropped:${dropped}`] : []),
    ...(paid ? [`paid_media_removed:${paid}`] : []),
  ];
  return { narrative: { headline, hypotheses: hypotheses.slice(0, MAX_ITEMS), recommendations }, flags };
}

function numbersIn(value: unknown): number[] {
  if (typeof value === "number") return [value];
  if (Array.isArray(value)) return value.flatMap(numbersIn);
  if (value && typeof value === "object") return Object.values(value).flatMap(numbersIn);
  return [];
}
