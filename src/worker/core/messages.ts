import type { Platform } from "./db/schema";
import type { Phase0Message } from "../phase0";

export type EnrichReason = "add" | "manual" | "sweep" | "discovery";

export type EnrichMessage = { kind: "enrich"; creatorIds: string[]; reason: EnrichReason; requestedBy: string };

export type ApifyPollMessage = {
  kind: "apify-poll";
  purpose: "profile" | "discovery";
  platform: Exclude<Platform, "youtube">;
  localRunId: string;
  apifyRunId: string;
  startedAt: number;
  // discovery only
  category?: string;
  maxNew?: number;
  requestedBy?: string;
};

export type MatrixRunMessage = { kind: "matrix-run"; runId: string };

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

export type QueueMessage = Phase0Message | EnrichMessage | ApifyPollMessage | MatrixRunMessage | ProposalSectionMessage;
