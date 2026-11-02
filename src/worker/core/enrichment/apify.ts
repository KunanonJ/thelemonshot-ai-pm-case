import { and, eq, isNull } from "drizzle-orm";
import { getDb } from "../db/client";
import { apifyRuns } from "../db/schema";
import { errorMessage, localOverride, readSecret } from "../env";
import { fetchWithRetry } from "../http";
import { newId } from "../util";

// Apify API v2 (docs.apify.com/api/v2): Bearer auth, canonical /v2/actors/ prefix (the /v2/acts/ form is deprecated)
const apifyApi = (env: Env) => localOverride(env, "APIFY_API_URL", "https://api.apify.com/v2");

export const ACTORS = {
  instagramProfile: "apify~instagram-profile-scraper",
  tiktokProfile: "clockworks~tiktok-profile-scraper",
  instagramHashtag: "apify~instagram-hashtag-scraper",
  tiktokSearch: "clockworks~tiktok-scraper",
  // Post-level refresh for ③: Instagram takes post URLs in directUrls, TikTok in postURLs (Apify Store input schemas, 2 Nov 2026)
  instagramPosts: "apify~instagram-scraper",
  tiktokPosts: "clockworks~tiktok-scraper",
} as const;

export type ApifyPurpose = "profile" | "discovery" | "posts" | "trends";

// usageUsd is the run's dollar cost as Apify reports it (usageTotalUsd); null when Apify reports none (FR-TM-4)
export type ApifyRunState = { status: string; datasetId: string | null; usageUsd: number | null };

export class ApifyNotConfigured extends Error {
  constructor() {
    super("APIFY_TOKEN is not set");
  }
}

function token(env: Env): string {
  const t = readSecret(env, "APIFY_TOKEN");
  if (!t) throw new ApifyNotConfigured();
  return t;
}

// FR-CORE-10: start a run and log it in apify_runs; returns our row id and Apify's run id
export async function startActor(
  env: Env,
  actor: string,
  input: Record<string, unknown>,
  purpose: ApifyPurpose,
  inputSummary: string,
): Promise<{ localRunId: string; apifyRunId: string }> {
  const db = getDb(env);
  const localRunId = newId();
  const startedAt = Date.now();
  try {
    const res = await fetchWithRetry(`${apifyApi(env)}/actors/${actor}/runs`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token(env)}`, "Content-Type": "application/json" },
      body: JSON.stringify(input),
    });
    if (!res.ok) throw new Error(`Apify start failed: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
    const run = ((await res.json()) as { data: { id: string; status: string } }).data;
    await db.insert(apifyRuns).values({ id: localRunId, actor, purpose, inputSummary, apifyRunId: run.id, status: run.status, startedAt });
    return { localRunId, apifyRunId: run.id };
  } catch (e) {
    await db
      .insert(apifyRuns)
      .values({ id: localRunId, actor, purpose, inputSummary, status: "START_FAILED", error: errorMessage(e).slice(0, 300), startedAt, finishedAt: Date.now() });
    throw e;
  }
}

export async function getActorRun(env: Env, apifyRunId: string, waitForFinishSec: number): Promise<ApifyRunState> {
  const res = await fetchWithRetry(
    `${apifyApi(env)}/actor-runs/${apifyRunId}?waitForFinish=${waitForFinishSec}`,
    { headers: { Authorization: `Bearer ${token(env)}` } },
    { timeoutMs: (waitForFinishSec + 15) * 1000 },
  );
  if (!res.ok) throw new Error(`Apify run lookup failed: HTTP ${res.status}`);
  const run = ((await res.json()) as { data: { status: string; defaultDatasetId?: string; usageTotalUsd?: number | null } }).data;
  return {
    status: run.status,
    datasetId: run.defaultDatasetId ?? null,
    usageUsd: typeof run.usageTotalUsd === "number" ? run.usageTotalUsd : null,
  };
}

export async function getDatasetItems(env: Env, datasetId: string, limit: number): Promise<unknown[]> {
  const res = await fetchWithRetry(`${apifyApi(env)}/datasets/${datasetId}/items?format=json&clean=true&limit=${limit}`, {
    headers: { Authorization: `Bearer ${token(env)}` },
  });
  if (!res.ok) throw new Error(`Apify dataset fetch failed: HTTP ${res.status}`);
  const items = (await res.json()) as unknown;
  // A 200 with anything but a list (an error object, say) would break every normaliser downstream
  if (!Array.isArray(items)) throw new Error("Apify dataset fetch returned something other than a list");
  return items;
}

// Apify API v2: POST /actor-runs/:runId/abort stops a starting or running run; a finished run is left as it is
export async function abortActorRun(env: Env, apifyRunId: string): Promise<ApifyRunState> {
  const res = await fetchWithRetry(`${apifyApi(env)}/actor-runs/${apifyRunId}/abort`, { method: "POST", headers: { Authorization: `Bearer ${token(env)}` } }, { retries: 1 });
  if (!res.ok) throw new Error(`Apify abort failed: HTTP ${res.status}`);
  const run = ((await res.json()) as { data: { status: string; defaultDatasetId?: string; usageTotalUsd?: number | null } }).data;
  return { status: run.status, datasetId: run.defaultDatasetId ?? null, usageUsd: typeof run.usageTotalUsd === "number" ? run.usageTotalUsd : null };
}

// NFR-5 and finding 16: a run that nothing will poll any more is stopped, so it doesn't go on billing, and its row
// says why. A row already finished (its results were used) is left alone.
export async function abandonApifyRun(env: Env, run: { localRunId: string; apifyRunId: string }, reason: string): Promise<void> {
  const db = getDb(env);
  const open = and(eq(apifyRuns.id, run.localRunId), isNull(apifyRuns.finishedAt));
  const [row] = await db.select({ id: apifyRuns.id }).from(apifyRuns).where(open);
  if (!row) return;
  try {
    const state = await abortActorRun(env, run.apifyRunId);
    // A run that finished after its poll window gave up on it: real cost, unused results
    const status = state.status === "SUCCEEDED" ? "SUCCEEDED_UNUSED" : "ABORTED";
    await db.update(apifyRuns).set({ status, error: reason.slice(0, 300), costUsd: state.usageUsd, finishedAt: Date.now() }).where(open);
  } catch (e) {
    console.error("apify run not aborted", { ...run, reason, error: errorMessage(e) });
    await db.update(apifyRuns).set({ status: "ABANDONED", error: `${reason}; the abort request failed`.slice(0, 300), finishedAt: Date.now() }).where(open);
  }
}

export async function finishApifyRun(env: Env, localRunId: string, status: string, itemCount: number | null, error?: string, costUsd: number | null = null): Promise<void> {
  await getDb(env)
    .update(apifyRuns)
    .set({ status, itemCount, error: error?.slice(0, 300) ?? null, costUsd, finishedAt: Date.now() })
    .where(eq(apifyRuns.id, localRunId));
}
