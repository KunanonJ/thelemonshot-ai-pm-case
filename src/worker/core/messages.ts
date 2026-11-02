import type { Platform } from "./db/schema";
import type { Phase0Message } from "../phase0";

export type EnrichReason = "add" | "manual" | "sweep" | "discovery";

export type EnrichMessage = { kind: "enrich"; creatorIds: string[]; reason: EnrichReason; requestedBy: string };

export type ApifyPollMessage = {
  kind: "apify-poll";
  purpose: "profile" | "discovery" | "posts";
  platform: Exclude<Platform, "youtube">;
  localRunId: string;
  apifyRunId: string;
  startedAt: number;
  // discovery only
  category?: string;
  maxNew?: number;
  requestedBy?: string;
  // posts only: the ③ campaign refresh this run belongs to
  refreshId?: string;
};

// ③: build a digest once every platform in a refresh has answered, and close refreshes that never do
export type CampaignDigestMessage = { kind: "campaign-digest"; campaignId: string; refreshId: string };
export type CampaignRefreshTimeoutMessage = { kind: "campaign-refresh-timeout"; refreshId: string };

export type MatrixRunMessage = { kind: "matrix-run"; runId: string };

// ② Trend Monitoring: one poll per term and platform run, a timeout per pull, then one brief per pull
export type TrendPollMessage = {
  kind: "trend-poll";
  pullId: string;
  pullTermId: string;
  platform: "instagram" | "tiktok";
  localRunId: string;
  apifyRunId: string;
  startedAt: number;
};
export type TrendPullTimeoutMessage = { kind: "trend-pull-timeout"; pullId: string };
export type TrendBriefMessage = { kind: "trend-brief"; pullId: string };

// One message per proposal section: the first draft runs as a chain, regeneration as a single job (FR-CP-4)
export type ProposalSectionMessage = {
  kind: "proposal-section";
  runId: string;
  sectionKey: string;
  mode: "initial" | "regenerate";
  alternatives: number;
  instruction?: string;
  requestedBy: string;
  // time already spent waiting for an attached shortlist that is still scoring
  waitedMs?: number;
};

// ⑤ Creative Variants: copy per segment, one provider call per visual slot, then polling until the provider answers
export type DcoCopyMessage = { kind: "dco-copy"; runId: string; segmentKey: string; requestedBy: string };
// origin is where the base-asset link is minted (the request's own origin); the link is never stored in a message
export type DcoVisualMessage = { kind: "dco-visual"; runId: string; planKey: string; origin: string; requestedBy: string };
export type DcoVisualPollMessage = { kind: "dco-visual-poll"; runId: string; planKey: string; polls: number };

export type QueueMessage =
  | Phase0Message
  | EnrichMessage
  | ApifyPollMessage
  | MatrixRunMessage
  | ProposalSectionMessage
  | CampaignDigestMessage
  | CampaignRefreshTimeoutMessage
  | TrendPollMessage
  | TrendPullTimeoutMessage
  | TrendBriefMessage
  | DcoCopyMessage
  | DcoVisualMessage
  | DcoVisualPollMessage;
