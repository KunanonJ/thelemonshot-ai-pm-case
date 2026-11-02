import { getDb } from "./core/db/client";
import { deadLetters } from "./core/db/schema";
import { failApifyPoll, failEnrichMessage, handleApifyPoll, handleEnrich } from "./core/enrichment/service";
import { errorMessage } from "./core/env";
import type { QueueMessage } from "./core/messages";
import { newId } from "./core/util";
import { pollApifyRun, recordEcho } from "./phase0";
import { handleDcoCopy, handleDcoVisual, handleDcoVisualPoll, onDcoMessageFailed } from "./products/dco/pipeline";
import { executeMatrixRun, failMatrixRun } from "./products/matrix/pipeline";
import { handleCampaignDigest, onDigestMessageFailed } from "./products/optimization/digest";
import { failCampaignPostsPoll, handleCampaignPostsPoll, handleRefreshTimeout } from "./products/optimization/refresh";
import { handleProposalSection, onProposalMessageFailed } from "./products/proposal/pipeline";
import { handleTrendBrief, handleTrendPoll, handleTrendPullTimeout, onTrendMessageFailed } from "./products/trends/pipeline";

// wrangler.jsonc sets max_retries 3, so a message is delivered at most four times (Message.attempts counts from 1)
export const MAX_DELIVERIES = 4;
// Spaced retries, so a short D1, KV or provider blip doesn't use up every delivery within a few seconds
const RETRY_DELAYS_S = [15, 60, 180];

export function retryDelaySeconds(attempts: number): number {
  return RETRY_DELAYS_S[Math.min(Math.max(attempts, 1), RETRY_DELAYS_S.length) - 1]!;
}

export async function handleMessage(env: Env, body: QueueMessage, attempts: number): Promise<void> {
  switch (body.kind) {
    case "phase0-echo":
      return recordEcho(env, body.probe);
    case "phase0-apify-poll":
      return pollApifyRun(env, body);
    case "enrich":
      return handleEnrich(env, body);
    case "apify-poll":
      return body.purpose === "posts" ? handleCampaignPostsPoll(env, body) : handleApifyPoll(env, body);
    case "matrix-run":
      return executeMatrixRun(env, body.runId, attempts);
    case "proposal-section":
      return handleProposalSection(env, body);
    case "campaign-digest":
      return handleCampaignDigest(env, body);
    case "campaign-refresh-timeout":
      return handleRefreshTimeout(env, body);
    case "trend-poll":
      return handleTrendPoll(env, body);
    case "trend-pull-timeout":
      return handleTrendPullTimeout(env, body);
    case "trend-brief":
      return handleTrendBrief(env, body);
    case "dco-copy":
      return handleDcoCopy(env, body);
    case "dco-visual":
      return handleDcoVisual(env, body);
    case "dco-visual-poll":
      return handleDcoVisualPoll(env, body);
    default: {
      // A kind no handler knows (a message from an older deploy, say): recorded once, never retried
      const kind = String((body as { kind?: unknown }).kind).slice(0, 40);
      console.error("unrecognised queue message", { kind });
      await recordDeadLetter(env, null, "A background message wasn't recognised", { kind });
    }
  }
}

// Called once, on the last delivery of a message that kept failing. The work it owned settles in a visible,
// retryable failed state with a plain reason, and a dead letter records what happened (BR-CORE-1, NFR-2).
// Whatever this misses, the stuck-work sweep settles later.
export async function onFinalFailure(env: Env, body: QueueMessage, error: string): Promise<void> {
  switch (body.kind) {
    case "enrich":
      await failEnrichMessage(env, body);
      break;
    case "apify-poll":
      await (body.purpose === "posts" ? failCampaignPostsPoll(env, body) : failApifyPoll(env, body));
      break;
    case "matrix-run":
      await failMatrixRun(env, body.runId);
      break;
    case "proposal-section":
      await onProposalMessageFailed(env, body);
      break;
    case "campaign-digest":
      await onDigestMessageFailed(env, body);
      break;
    case "trend-poll":
    case "trend-pull-timeout":
    case "trend-brief":
      await onTrendMessageFailed(env, body, error);
      break;
    case "dco-copy":
    case "dco-visual":
    case "dco-visual-poll":
      await onDcoMessageFailed(env, body, error);
      break;
    // A refresh timeout that keeps failing is settled by the stuck-work sweep; Phase 0 checks re-run from the cron
    case "campaign-refresh-timeout":
    case "phase0-echo":
    case "phase0-apify-poll":
      break;
  }
  await recordDeadLetter(env, "runId" in body ? body.runId : null, `A background step stopped after ${MAX_DELIVERIES} attempts`, {
    kind: body.kind,
    ...refOf(body),
    error: error.slice(0, 300),
  });
}

// Ids only, for logs and dead letters: creator lists are long, and nothing else in a message is needed to trace it
export function refOf(body: QueueMessage): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(body)
      .filter(([k]) => /(Id|Ids|Key)$/.test(k))
      .map(([k, v]) => [k, Array.isArray(v) ? `${v.length} ids` : v]),
  );
}

async function recordDeadLetter(env: Env, runId: string | null, reason: string, detail: Record<string, unknown>): Promise<void> {
  try {
    await getDb(env).insert(deadLetters).values({ id: newId(), kind: "run", runId, reason, detail, createdAt: Date.now() });
  } catch (e) {
    console.error("dead letter not recorded", { reason, ...detail, error: errorMessage(e) });
  }
}
