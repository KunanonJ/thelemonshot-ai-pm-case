import type { Platform } from "../../core/db/schema";
import type { PostMetrics } from "../../core/enrichment/posts";

// FR-CO-3: every number in a digest is computed here; the model only ever receives these results.
// Versioned so a digest or a write-back can say which arithmetic produced it (FR-CORE-21).

export const DELTAS_VERSION = "deltas-v1";
export const OUTCOME_VERSION = "outcome-v1";
export const HISTORY_VERSION = "history-v1";
const RANK_THRESHOLD_PCT = 10; // a post is a winner or a loser beyond ±10%
const VERDICT_BAND_PCT = 5; // within ±5% of baseline counts as on track
const SHRINK_K = 3; // Bayesian shrinkage toward the benchmark, as in the case repo's n8n build
const BENCHMARK = 50; // an outcome score of 50 means "performed as expected"
const DAY_MS = 86_400_000;

export type MetricPoint = PostMetrics & { fetchedAt: number };

export type TrackedPostInput = {
  postId: string;
  creatorId: string;
  creatorName: string;
  platform: Platform;
  url: string;
  baselineViews: number | null;
  baselineEr: number | null;
  // The creator's latest profile snapshot on that platform: Instagram engagement is measured against followers
  followers: number | null;
  history: MetricPoint[]; // oldest first
  state: "tracking" | "missing" | "unavailable";
  unavailableReason: string | null;
};

export type Delta = { value: number; reference: number; abs: number; pct: number };
export type Trend = "rising" | "steady" | "falling" | "too_early";

export type PostDelta = {
  postId: string;
  creatorId: string;
  creatorName: string;
  platform: Platform;
  url: string;
  state: TrackedPostInput["state"];
  unavailableReason: string | null;
  latest: (PostMetrics & { er: number | null; fetchedAt: number }) | null;
  notReported: (keyof PostMetrics)[];
  vsBaseline: { views: Delta | null; er: Delta | null };
  vsPeer: { views: Delta | null; er: Delta | null };
  trend: Trend;
  // The percentage that ranks winners and losers: against baseline when set, else against peers
  rankPct: number | null;
};

export type CreatorDelta = {
  creatorId: string;
  creatorName: string;
  posts: number;
  views: number | null;
  baselineViews: number | null;
  medianEr: number | null;
  vsBaseline: Delta | null;
  vsPeer: Delta | null;
};

export type Verdict = { kind: "ahead" | "on_track" | "behind" | "no_baseline" | "no_data"; text: string };

export type DigestDeltas = {
  version: string;
  computedAt: number;
  baselinesSet: boolean;
  peer: Partial<Record<Platform, { medianViews: number | null; medianEr: number | null; posts: number }>>;
  campaignMedianEr: number | null;
  posts: PostDelta[];
  creators: CreatorDelta[];
  verdict: Verdict;
  winners: string[];
  losers: string[];
  unavailable: string[];
  missing: string[];
};

const round = (v: number, digits: number) => Math.round(v * 10 ** digits) / 10 ** digits;

export function median(values: number[]): number | null {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

// Same per-platform definitions as the profile snapshots (enrichment/normalise.ts), in percent
export function engagementRate(platform: Platform, m: PostMetrics, followers: number | null): number | null {
  if (m.likes === null || m.comments === null) return null;
  if (platform === "instagram") return followers ? round(((m.likes + m.comments) / followers) * 100, 2) : null;
  if (!m.views) return null;
  return round(((m.likes + m.comments + (platform === "tiktok" ? (m.shares ?? 0) : 0)) / m.views) * 100, 2);
}

export function delta(value: number | null, reference: number | null, digits = 0): Delta | null {
  if (value === null || reference === null || reference === 0) return null;
  return { value: round(value, digits), reference: round(reference, digits), abs: round(value - reference, digits), pct: round(((value - reference) / reference) * 100, 1) };
}

// Views only ever grow, so the trend is about speed: views a day between the last three refreshes
export function trendOf(history: MetricPoint[]): Trend {
  const pts = history.filter((p) => p.views !== null).slice(-3);
  if (pts.length < 3) return "too_early";
  const rate = (a: MetricPoint, b: MetricPoint) => ((b.views! - a.views!) / Math.max(b.fetchedAt - a.fetchedAt, 1)) * DAY_MS;
  const before = rate(pts[0]!, pts[1]!);
  const after = rate(pts[1]!, pts[2]!);
  if (after > before * 1.1) return "rising";
  if (after < before * 0.9) return "falling";
  return "steady";
}

export function computeDeltas(inputs: TrackedPostInput[], now: number): DigestDeltas {
  const prepared = inputs.map((p) => {
    const last = p.history[p.history.length - 1] ?? null;
    const er = last ? engagementRate(p.platform, last, p.followers) : null;
    return { p, last, er };
  });

  const platforms = [...new Set(prepared.map((x) => x.p.platform))];
  const peer: DigestDeltas["peer"] = {};
  for (const platform of platforms) {
    const same = prepared.filter((x) => x.p.platform === platform && x.last);
    // A peer median needs at least two posts to compare against
    const ok = same.length >= 2;
    peer[platform] = {
      medianViews: ok ? median(same.flatMap((x) => (x.last!.views !== null ? [x.last!.views] : []))) : null,
      medianEr: ok ? median(same.flatMap((x) => (x.er !== null ? [x.er] : []))) : null,
      posts: same.length,
    };
  }

  const posts: PostDelta[] = prepared.map(({ p, last, er }) => {
    const pr = peer[p.platform];
    const vsBaseline = { views: delta(last?.views ?? null, p.baselineViews), er: delta(er, p.baselineEr, 2) };
    const vsPeer = { views: delta(last?.views ?? null, pr?.medianViews ?? null), er: delta(er, pr?.medianEr ?? null, 2) };
    const notReported = last ? (["views", "likes", "comments", "shares"] as const).filter((k) => last[k] === null) : [];
    return {
      postId: p.postId,
      creatorId: p.creatorId,
      creatorName: p.creatorName,
      platform: p.platform,
      url: p.url,
      state: p.state,
      unavailableReason: p.unavailableReason,
      latest: last ? { views: last.views, likes: last.likes, comments: last.comments, shares: last.shares, er, fetchedAt: last.fetchedAt } : null,
      notReported: [...notReported],
      vsBaseline,
      vsPeer,
      trend: trendOf(p.history),
      rankPct: vsBaseline.er?.pct ?? vsBaseline.views?.pct ?? vsPeer.er?.pct ?? vsPeer.views?.pct ?? null,
    };
  });

  const campaignMedianEr = median(posts.flatMap((x) => (x.latest?.er != null ? [x.latest.er] : [])));
  const creators: CreatorDelta[] = [...new Set(posts.map((x) => x.creatorId))].map((creatorId) => {
    const mine = posts.filter((x) => x.creatorId === creatorId);
    const withViews = mine.filter((x) => x.latest?.views != null);
    const withBaseline = withViews.filter((x) => inputs.find((i) => i.postId === x.postId)?.baselineViews != null);
    const views = withViews.length ? withViews.reduce((s, x) => s + x.latest!.views!, 0) : null;
    const baselineViews = withBaseline.length ? withBaseline.reduce((s, x) => s + inputs.find((i) => i.postId === x.postId)!.baselineViews!, 0) : null;
    const baselinedViews = withBaseline.length ? withBaseline.reduce((s, x) => s + x.latest!.views!, 0) : null;
    const medianEr = median(mine.flatMap((x) => (x.latest?.er != null ? [x.latest.er] : [])));
    return {
      creatorId,
      creatorName: mine[0]!.creatorName,
      posts: mine.length,
      views,
      baselineViews,
      medianEr: medianEr === null ? null : round(medianEr, 2),
      vsBaseline: delta(baselinedViews, baselineViews),
      vsPeer: delta(medianEr, campaignMedianEr, 2),
    };
  });

  const live = posts.filter((x) => x.state !== "unavailable" && x.rankPct !== null);
  const winners = live.filter((x) => x.rankPct! >= RANK_THRESHOLD_PCT).sort((a, b) => b.rankPct! - a.rankPct!).map((x) => x.postId);
  const losers = live.filter((x) => x.rankPct! <= -RANK_THRESHOLD_PCT).sort((a, b) => a.rankPct! - b.rankPct!).map((x) => x.postId);
  const baselinesSet = inputs.some((p) => p.baselineViews !== null || p.baselineEr !== null);

  return {
    version: DELTAS_VERSION,
    computedAt: now,
    baselinesSet,
    peer,
    campaignMedianEr: campaignMedianEr === null ? null : round(campaignMedianEr, 2),
    posts,
    creators,
    verdict: verdictOf(posts, inputs),
    winners,
    losers,
    unavailable: posts.filter((x) => x.state === "unavailable").map((x) => x.postId),
    missing: posts.filter((x) => x.state === "missing").map((x) => x.postId),
  };
}

function verdictOf(posts: PostDelta[], inputs: TrackedPostInput[]): Verdict {
  const withData = posts.filter((x) => x.latest);
  if (!withData.length) return { kind: "no_data", text: "No metrics yet: the first refresh hasn't returned data." };
  const baseline = (id: string) => inputs.find((i) => i.postId === id)!;
  const viewed = withData.filter((x) => x.latest!.views !== null && baseline(x.postId).baselineViews !== null);
  const band = (pct: number, what: string, n: number): Verdict => {
    const scope = `across ${n} post${n === 1 ? "" : "s"} with a baseline`;
    if (pct >= VERDICT_BAND_PCT) return { kind: "ahead", text: `${what} ${pct}% above baseline ${scope}.` };
    if (pct <= -VERDICT_BAND_PCT) return { kind: "behind", text: `${what} ${Math.abs(pct)}% below baseline ${scope}.` };
    return { kind: "on_track", text: `${what} within ${VERDICT_BAND_PCT}% of baseline ${scope}.` };
  };
  if (viewed.length) {
    const d = delta(
      viewed.reduce((s, x) => s + x.latest!.views!, 0),
      viewed.reduce((s, x) => s + baseline(x.postId).baselineViews!, 0),
    )!;
    return band(d.pct, "Views are", viewed.length);
  }
  const rated = withData.filter((x) => x.vsBaseline.er);
  if (rated.length) return band(round(rated.reduce((s, x) => s + x.vsBaseline.er!.pct, 0) / rated.length, 1), "Engagement is on average", rated.length);
  // BR-CO-3: no baselines is said out loud, not silently defaulted
  const compared = withData.filter((x) => x.vsPeer.er);
  const above = compared.filter((x) => x.vsPeer.er!.pct > 0).length;
  return {
    kind: "no_baseline",
    text: compared.length
      ? `No baselines were set, so posts are compared with their platform's peer median only: ${above} of ${compared.length} are above it on engagement rate.`
      : "No baselines were set, and there aren't yet enough posts per platform for a peer comparison.",
  };
}

// ---------- closing write-back (FR-CO-7, FR-CORE-21) ----------

export type OutcomeRow = {
  creatorId: string;
  creatorName: string;
  posts: number;
  views: number | null;
  baselineViews: number | null;
  medianEr: number | null;
  peerMedianEr: number | null;
  outcomeScore: number | null;
};

// One creator's result in one campaign, 0 to 100, where 50 means "as expected": engagement against the
// campaign's median, and views against baseline when set, combined as a geometric mean
export function outcomeScore(c: Pick<OutcomeRow, "views" | "baselineViews" | "medianEr" | "peerMedianEr">): number | null {
  const ratios: number[] = [];
  if (c.medianEr !== null && c.peerMedianEr) ratios.push(c.medianEr / c.peerMedianEr);
  if (c.views !== null && c.baselineViews) ratios.push(c.views / c.baselineViews);
  if (!ratios.length) return null;
  const ratio = Math.exp(ratios.reduce((s, r) => s + Math.log(Math.max(r, 1e-6)), 0) / ratios.length);
  return Math.round(Math.min(100, Math.max(0, BENCHMARK * ratio)));
}

export function closingSummary(d: DigestDeltas): OutcomeRow[] {
  return d.creators.map((c) => {
    const row = { creatorId: c.creatorId, creatorName: c.creatorName, posts: c.posts, views: c.views, baselineViews: c.baselineViews, medianEr: c.medianEr, peerMedianEr: d.campaignMedianEr };
    return { ...row, outcomeScore: outcomeScore(row) };
  });
}

// The history score the Matrix reads is a pure function of all of a creator's outcome records, so it can
// always be recomputed from them. A few results pull it only part of the way from the benchmark.
export function historyScore(outcomes: number[]): number | null {
  if (!outcomes.length) return null;
  return round((outcomes.reduce((a, b) => a + b, 0) + SHRINK_K * BENCHMARK) / (outcomes.length + SHRINK_K), 1);
}
