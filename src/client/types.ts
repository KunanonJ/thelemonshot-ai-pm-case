export type Role = "admin" | "member" | "viewer";

export type Brief = {
  brand?: string;
  productCategory: string;
  objective: string;
  audience?: string;
  budgetBand?: string;
  platforms: string[];
  mustInclude?: string[];
  mustExclude?: string[];
  timeline?: string;
};

export type RunFlags = {
  conflicts?: string[];
  poolSize?: number;
  candidates?: number;
  thinPool?: boolean;
  excludedByBrief?: number;
  safetyExcluded?: number;
  noData?: number;
  shortlisted?: number;
  llmUnavailable?: boolean;
  llmFailure?: string | null;
  split?: boolean;
  sampleData?: boolean;
};

export type RunSummary = {
  id: string;
  status: string;
  createdAt: number;
  createdBy: string;
  startedAt: number | null;
  finishedAt: number | null;
  reviewedAt: number | null;
  error: string | null;
  flags: RunFlags;
  brief: Brief | null;
};

export type PlatformFeatures = { followers: number | null; engagementRate: number | null; medianViews: number | null; tier: string | null; fetchedAt: number };

export type RunItem = {
  id: string;
  creatorId: string;
  rank: number | null;
  composite: number | null;
  components: Record<string, number | null>;
  dims: { audienceFit: number; brandSafety: number; creativeFit: number } | null;
  features: { perPlatform?: Record<string, PlatformFeatures>; topHashtags?: string[]; tier?: string | null };
  rationale: string | null;
  flags: string[];
  completeness: number;
  stalenessDays: number | null;
  recommended: boolean;
  finalPick: boolean;
  replacesCreatorId: string | null;
  excludedReason: "safety_excluded" | "no_data" | null;
  creator: { displayName: string; instagram: string | null; tiktok: string | null; youtube: string | null; isSample: boolean; categories: string[] };
};

export type RunDetail = RunSummary & {
  items: RunItem[];
  logs: { id: string; kind: string; payload: Record<string, unknown>; actor: string; createdAt: number }[];
};

export type Snapshot = { platform: string; followers: number | null; engagement_rate: number | null; median_views: number | null; fetched_at: number };

export type Creator = {
  id: string;
  displayName: string;
  categories: string[];
  instagram: string | null;
  tiktok: string | null;
  youtube: string | null;
  source: string;
  isSample: boolean;
  active: boolean;
  enrichmentStatus: string;
  createdAt: number;
  snapshots: Snapshot[];
};

export type Scoring = {
  version: string;
  weights: Record<string, Record<string, number>>;
  components: Record<string, { label: string; source: "data" | "llm"; description: string }>;
  rules: Record<string, number>;
};

// ---------- ④ Campaign Proposal ----------

export type ShortlistChoice = { mode: "none" } | { mode: "existing"; matrixRunId: string } | { mode: "new"; productCategory: string; platforms: string[] };

export type ProposalBrief = {
  template: string;
  language: string;
  brand: string;
  product: string;
  objective: string;
  audience: string;
  budgetBand?: string;
  timeline: string;
  retainerMonths?: number;
  toneNotes: string;
  mustAvoid: string[];
  shortlist: ShortlistChoice;
};

export type LeafSpec = { key: string; label: string; kind: "line" | "text"; readOnly?: boolean };
export type FieldSpec = LeafSpec | { key: string; label: string; kind: "list"; itemLabel: string; max: number; item: LeafSpec[] } | { key: string; label: string; kind: "creators" };

export type ProposalTemplates = {
  templates: { id: string; name: string; description: string; requiredFields: string[]; sections: { key: string; title: string }[] }[];
  fields: Record<string, FieldSpec[]>;
  maxAlternatives: number;
  promptVersion: string;
};

export type ProposalVersion = {
  id: string;
  version: number;
  origin: string;
  content: Record<string, unknown>;
  flags: string[];
  note: string | null;
  createdAt: number;
  createdBy: string;
  isCurrent?: boolean;
};

export type ProposalSection = {
  key: string;
  title: string;
  status: "pending" | "generating" | "ready" | "failed";
  error: string | null;
  versionCount: number;
  current: ProposalVersion | null;
};

export type Evidence = {
  creatorId: string;
  runItemId: string;
  matrixRunId: string;
  displayName: string;
  handles: Record<string, string | null>;
  isSample: boolean;
  finalPick: boolean;
  composite: number | null;
  rationale: string | null;
  platforms: { platform: string; followers: number | null; engagementRate: number | null; medianViews: number | null; fetchedAt: number }[];
  topHashtags: string[];
};

export type ProposalFlags = { template: string; language: string; shortlist: { matrixRunId: string; mode: string } | null; sampleData?: boolean };

export type ProposalSummary = {
  id: string;
  status: string;
  createdAt: number;
  createdBy: string;
  reviewedAt: number | null;
  flags: ProposalFlags;
  brief: ProposalBrief | null;
  progress: { total: number; ready: number; failed: number };
};

export type ProposalDetail = {
  id: string;
  status: string;
  createdAt: number;
  createdBy: string;
  startedAt: number | null;
  finishedAt: number | null;
  reviewedAt: number | null;
  flags: ProposalFlags;
  brief: ProposalBrief;
  template: { id: string; name: string; description: string };
  sections: ProposalSection[];
  shortlist: { id: string; status: string; reviewedAt: number | null; brief: Brief | null; picks: string[] } | null;
  evidence: Record<string, Evidence>;
  assumptions: string[];
  sampleData: boolean;
  logs: { id: string; kind: string; payload: Record<string, unknown>; actor: string; createdAt: number }[];
};

export type AttachableShortlist = { id: string; status: string; createdAt: number; reviewedAt: number | null; brief: Brief | null; shortlisted: number | null; sampleData: boolean };

// ---------- ③ Campaign Optimization ----------

export type Delta = { value: number; reference: number; abs: number; pct: number };

export type PostDelta = {
  postId: string;
  creatorId: string;
  creatorName: string;
  platform: string;
  url: string;
  state: "tracking" | "missing" | "unavailable";
  unavailableReason: string | null;
  latest: { views: number | null; likes: number | null; comments: number | null; shares: number | null; er: number | null; fetchedAt: number } | null;
  notReported: string[];
  vsBaseline: { views: Delta | null; er: Delta | null };
  vsPeer: { views: Delta | null; er: Delta | null };
  trend: "rising" | "steady" | "falling" | "too_early";
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
  campaignMedianEr: number | null;
  posts: PostDelta[];
  creators: CreatorDelta[];
  verdict: Verdict;
  winners: string[];
  losers: string[];
  unavailable: string[];
  missing: string[];
};

export type Recommendation = { action: string; targetId: string; delta: string; text: string; motivating: Delta | string | null };
export type Narrative = { headline: string; hypotheses: { text: string; refs: string[] }[]; recommendations: Recommendation[] };

export type CampaignAction = { id: string; digestRunId: string | null; recommendation: number | null; note: string; actor: string; createdAt: number };

export type CampaignRefresh = {
  id: string;
  trigger: string;
  platforms: string[];
  done: string[];
  failed: { platform: string; error: string }[];
  status: "running" | "done";
  digestRunId: string | null;
  startedAt: number;
  finishedAt: number | null;
};

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

export type WriteBack = {
  runId: string;
  outcomeVersion: string;
  historyVersion: string;
  creators: { creatorId: string; outcomeScore: number; before: number | null; after: number | null }[];
  unscored: string[];
};

export type CampaignSummary = {
  id: string;
  name: string;
  brand: string;
  status: "active" | "closed" | "archived";
  startsAt: number;
  endsAt: number;
  lastRefreshAt: number | null;
  createdAt: number;
  posts: number;
  unavailable: number;
  latestDigest: { runId: string; createdAt: number; status: string } | null;
};

export type CampaignDetail = CampaignSummary & {
  scope: string;
  sampleData: boolean;
  matrixRunId: string | null;
  matrixRun: { id: string; status: string; brand: string | null } | null;
  deltas: DigestDeltas;
  refreshes: CampaignRefresh[];
  digests: { runId: string; createdAt: number; flags: string[]; status: string; reviewedAt: number | null; verdict: Verdict | null }[];
  actions: CampaignAction[];
  outcome: { rows: OutcomeRow[]; writeBack: WriteBack } | null;
  closedAt: number | null;
};

export type CampaignDigest = {
  runId: string;
  campaignId: string;
  refreshId: string | null;
  scope: string;
  status: string;
  reviewedAt: number | null;
  llmFailure: string | null;
  deltas: DigestDeltas;
  narrative: Narrative | null;
  freshness: { refreshStartedAt: number | null; refreshFinishedAt: number | null; lastData: Record<string, number>; failed: { platform: string; error: string }[] };
  flags: string[];
  createdAt: number;
  actions: CampaignAction[];
};

// ---------- ⑤ Creative Variants (DCO) ----------

export type DcoRunStatus = "queued" | "running" | "draft" | "approved" | "rejected" | "failed";
export type DcoItemStatus = "pending" | "generating" | "ready" | "failed";
export type DcoReviewStatus = "draft" | "approved" | "rejected";
export type DcoBrief = { brand: string; product: string; offer?: string; segments: { name: string; note?: string }[]; brandVoice?: string; prohibitedClaims: string[]; copyPerSegment: number };
export type DcoProvenance = { jobId: string; modelId: string; planKey: string; format: string; prompt: string; negativePrompt: string | null; seed: number | null; falRequestId: string; inputSha256: string; outputSha256: string; outputBytes: number; contentType: string; promptVersion: string; submittedAt: number; completedAt: number };
export type DcoRunSummary = { id: string; status: DcoRunStatus; createdAt: number; reviewedAt: number | null; brief: DcoBrief | null; progress: { visualsTotal: number; visualsReady: number; visualsFailed: number; visualsPending: number; copyReady: number; copyFailed: number; copyPending: number; approvedVisuals: number } };
export type DcoSegmentView = { key: string; name: string; note: string | null; status: DcoItemStatus; error: string | null; copyCount: number };
export type DcoCopyView = { id: string; segmentKey: string; position: number; headline: string; hookLine: string; caption: string; cta: string; flags: string[]; reviewStatus: DcoReviewStatus; reviewedBy: string | null; reviewedAt: number | null; model: string; promptVersion: string; createdAt: number };
export type DcoVisualView = { key: string; position: number; kind: "format" | "scene"; label: string; segmentKey: string; format: string; modelId: string; status: DcoItemStatus; error: string | null; attempts: number; reviewStatus: DcoReviewStatus; reviewedBy: string | null; reviewedAt: number | null; bytes: number | null; contentType: string | null; provenance: DcoProvenance | null; hasImage: boolean };
export type DcoEventView = { id: string; kind: string; payload: Record<string, unknown>; actor: string; createdAt: number };
export type DcoRunDetail = { id: string; status: DcoRunStatus; createdAt: number; reviewedAt: number | null; reviewedBy: string | null; brief: DcoBrief; asset: { fileName: string; contentType: string; bytes: number; sha256: string; uploadedBy: string; uploadedAt: number; rightsAttestedBy: string; rightsAttestedAt: number } | null; segments: DcoSegmentView[]; copy: DcoCopyView[]; visuals: DcoVisualView[]; safetyDiscarded: number; approvedVisuals: number; exportable: boolean; events: DcoEventView[] };
export type DcoAllowlist = { models: { id: string; role: "layout" | "scene"; description: string; docs: string; verifiedOn: string; providerSafetyField: string }[]; blockedFamilies: string[]; audit: { ok: boolean; checked: number; violations: { id: string; reason: string }[] } };
