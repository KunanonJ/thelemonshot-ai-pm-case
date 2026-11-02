import { eq } from "drizzle-orm";
import { getDb } from "../db/client";
import { apifyRuns } from "../db/schema";
import { errorMessage, readSecret } from "../env";
import { fetchWithRetry } from "../http";
import { newId } from "../util";

// Apify API v2 (docs.apify.com/api/v2): Bearer auth, canonical /v2/actors/ prefix (the /v2/acts/ form is deprecated)
const APIFY_API = "https://api.apify.com/v2";

export const ACTORS = {
  instagramProfile: "apify~instagram-profile-scraper",
  tiktokProfile: "clockworks~tiktok-profile-scraper",
  instagramHashtag: "apify~instagram-hashtag-scraper",
  tiktokSearch: "clockworks~tiktok-scraper",
} as const;

export type ApifyRunState = { status: string; datasetId: string | null };

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
  purpose: "profile" | "discovery",
  inputSummary: string,
): Promise<{ localRunId: string; apifyRunId: string }> {
  const db = getDb(env);
  const localRunId = newId();
  const startedAt = Date.now();
  try {
    const res = await fetchWithRetry(`${APIFY_API}/actors/${actor}/runs`, {
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
    `${APIFY_API}/actor-runs/${apifyRunId}?waitForFinish=${waitForFinishSec}`,
    { headers: { Authorization: `Bearer ${token(env)}` } },
    { timeoutMs: (waitForFinishSec + 15) * 1000 },
  );
  if (!res.ok) throw new Error(`Apify run lookup failed: HTTP ${res.status}`);
  const run = ((await res.json()) as { data: { status: string; defaultDatasetId?: string } }).data;
  return { status: run.status, datasetId: run.defaultDatasetId ?? null };
}

export async function getDatasetItems(env: Env, datasetId: string, limit: number): Promise<unknown[]> {
  const res = await fetchWithRetry(`${APIFY_API}/datasets/${datasetId}/items?format=json&clean=true&limit=${limit}`, {
    headers: { Authorization: `Bearer ${token(env)}` },
  });
  if (!res.ok) throw new Error(`Apify dataset fetch failed: HTTP ${res.status}`);
  return (await res.json()) as unknown[];
}

export async function finishApifyRun(env: Env, localRunId: string, status: string, itemCount: number | null, error?: string): Promise<void> {
  await getDb(env)
    .update(apifyRuns)
    .set({ status, itemCount, error: error?.slice(0, 300) ?? null, finishedAt: Date.now() })
    .where(eq(apifyRuns.id, localRunId));
}
