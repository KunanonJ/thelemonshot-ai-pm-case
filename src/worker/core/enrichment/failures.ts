import { errorMessage } from "../env";
import { isTimeout } from "../http";
import { ApifyNotConfigured } from "./apify";

// Why a source didn't answer, as a code plus a fixed phrase for every role (BR-CORE-3). The raw upstream text
// stays where only the operator sees it: apify_runs.error, enrichment_jobs.error and the log.
export const SOURCE_FAILURE_TEXT = {
  not_configured: "the source isn't set up yet",
  refused: "the source refused the request",
  limited: "the source's usage limit was reached",
  timeout: "the source didn't answer in time",
  unavailable: "the source was unavailable",
} as const;
export type SourceFailure = keyof typeof SOURCE_FAILURE_TEXT;

// "handle": about this creator (not found, private). "global": about the source, so it would hit anyone (finding 18).
export type FailureScope = "global" | "handle";

export function classifySourceFailure(e: unknown): SourceFailure {
  if (e instanceof ApifyNotConfigured) return "not_configured";
  const text = errorMessage(e);
  if (/is not set|not configured/i.test(text)) return "not_configured";
  if (isTimeout(e) || /timed? ?out|TIMED-OUT/i.test(text)) return "timeout";
  if (/HTTP (401|403)\b/.test(text)) return "refused";
  if (/HTTP (402|429)\b/.test(text)) return "limited";
  return "unavailable";
}

// Finding 18: when a source fails for everyone (a missing or refused key, quota, an outage), every page says so,
// instead of the failure showing up only as one stale row at a time. Cleared by the next success; expires anyway.
export type DataSource = "apify" | "youtube_api";
export type Degraded = { source: DataSource; since: number; reason: string };
const DEGRADED_TTL_S = 3 * 3_600;
const SOURCES: DataSource[] = ["apify", "youtube_api"];
const degradedKey = (source: DataSource) => `source:degraded:${source}`;

export async function markDegraded(env: Env, source: DataSource, failure: SourceFailure): Promise<void> {
  try {
    const previous = parseDegraded(source, await env.CONFIG.get(degradedKey(source)));
    const value = { since: previous?.since ?? Date.now(), reason: SOURCE_FAILURE_TEXT[failure] };
    await env.CONFIG.put(degradedKey(source), JSON.stringify(value), { expirationTtl: DEGRADED_TTL_S });
  } catch (e) {
    console.error("degraded flag not written", { source, failure, error: errorMessage(e) });
  }
}

export async function clearDegraded(env: Env, source: DataSource): Promise<void> {
  await env.CONFIG.delete(degradedKey(source)).catch((e) => console.error("degraded flag not cleared", { source, error: errorMessage(e) }));
}

export async function degradedSources(env: Env): Promise<Degraded[]> {
  const rows = await Promise.all(SOURCES.map(async (source) => parseDegraded(source, await env.CONFIG.get(degradedKey(source)).catch(() => null))));
  return rows.filter((r): r is Degraded => r !== null);
}

function parseDegraded(source: DataSource, raw: string | null): Degraded | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as { since?: unknown; reason?: unknown };
    return typeof v.since === "number" && typeof v.reason === "string" ? { source, since: v.since, reason: v.reason } : null;
  } catch {
    return null;
  }
}
