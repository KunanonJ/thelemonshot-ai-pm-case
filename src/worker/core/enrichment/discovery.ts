import { inArray } from "drizzle-orm";
import { getDb, insertChunked } from "../db/client";
import { creators } from "../db/schema";
import { errorMessage } from "../env";
import type { ApifyPollMessage } from "../messages";
import { chunk, newId } from "../util";
import { abandonApifyRun, ACTORS, startActor } from "./apify";
import { classifySourceFailure, type SourceFailure } from "./failures";
import { discoverFromInstagramPosts, discoverFromTikTokVideos } from "./normalise";
import { requestEnrichment } from "./service";

// Builds the sample roster: whoever posts under a category's hashtags becomes a candidate creator,
// flagged is_sample (HR-1, FR-CORE-8), then goes through normal enrichment. Fronk curates afterwards.

// Starting hashtags per demo category. My picks; the discovery form lets the Operator change them.
export const DISCOVERY_DEFAULTS: Record<string, { label: string; instagram: string[]; tiktok: string[] }> = {
  food_snacks: {
    label: "Food & snacks",
    instagram: ["รีวิวขนม", "ขนมอร่อย", "ของกิน", "อร่อยบอกต่อ"],
    tiktok: ["รีวิวขนม", "ขนมอร่อย", "ของกินบอกต่อ", "อร่อยบอกต่อ"],
  },
  beauty: {
    label: "Beauty",
    instagram: ["รีวิวเครื่องสำอาง", "สกินแคร์", "แต่งหน้า", "รีวิวสกินแคร์"],
    tiktok: ["รีวิวเครื่องสำอาง", "สกินแคร์", "แต่งหน้า", "บิวตี้"],
  },
};

export type DiscoveryRequest = {
  category: string;
  instagramHashtags: string[];
  tiktokHashtags: string[];
  perHashtag: number;
  maxNewPerPlatform: number;
};

// Each platform starts on its own (finding 22): one that fails doesn't take the other down, and the Operator sees
// a fixed reason per platform. The raw Apify text stays in apify_runs.error and the log.
export type DiscoveryStart = { platform: "instagram" | "tiktok"; status: "started" } | { platform: "instagram" | "tiktok"; status: "failed"; reason: SourceFailure | "not_queued" };

export async function startDiscovery(env: Env, req: DiscoveryRequest, requestedBy: string): Promise<DiscoveryStart[]> {
  const base = { purpose: "discovery" as const, startedAt: Date.now(), category: req.category, maxNew: req.maxNewPerPlatform, requestedBy };
  const plans = [
    req.instagramHashtags.length && {
      platform: "instagram" as const,
      actor: ACTORS.instagramHashtag,
      input: { hashtags: req.instagramHashtags, resultsType: "posts", resultsLimit: req.perHashtag },
      summary: `instagram ${req.category}: #${req.instagramHashtags.join(" #")}`,
    },
    req.tiktokHashtags.length && {
      platform: "tiktok" as const,
      actor: ACTORS.tiktokSearch,
      input: { hashtags: req.tiktokHashtags, resultsPerPage: req.perHashtag },
      summary: `tiktok ${req.category}: #${req.tiktokHashtags.join(" #")}`,
    },
  ].filter((p) => p !== 0);
  const out: DiscoveryStart[] = [];
  for (const plan of plans) {
    let started: { localRunId: string; apifyRunId: string } | null = null;
    try {
      started = await startActor(env, plan.actor, plan.input, "discovery", plan.summary);
      await env.ENRICH_QUEUE.send({ kind: "apify-poll", platform: plan.platform, ...started, ...base } satisfies ApifyPollMessage, { delaySeconds: 45 });
      out.push({ platform: plan.platform, status: "started" });
    } catch (e) {
      console.error("discovery not started", { platform: plan.platform, category: req.category, error: errorMessage(e) });
      // A paid run nothing will poll is stopped, so a retry can't leave two of them billing
      if (started) await abandonApifyRun(env, started, "Its poll couldn't be queued");
      out.push({ platform: plan.platform, status: "failed", reason: started ? "not_queued" : classifySourceFailure(e) });
    }
  }
  return out;
}

export async function processDiscoveryResults(env: Env, msg: ApifyPollMessage, items: unknown[]): Promise<void> {
  if (!msg.category) return;
  const db = getDb(env);
  const found = (msg.platform === "instagram" ? discoverFromInstagramPosts(items) : discoverFromTikTokVideos(items))
    .filter((c) => !c.isPrivate)
    // Creators who post repeatedly under the category tags first, then bigger accounts
    .sort((a, b) => b.hits - a.hits || (b.followers ?? 0) - (a.followers ?? 0));

  const column = msg.platform === "instagram" ? creators.instagram : creators.tiktok;
  const known = new Set<string>();
  for (const part of chunk(found.map((c) => c.handle), 90)) {
    const rows = await db.select({ handle: column }).from(creators).where(inArray(column, part));
    for (const r of rows) if (r.handle) known.add(r.handle);
  }

  const now = Date.now();
  const fresh = found.filter((c) => !known.has(c.handle)).slice(0, msg.maxNew ?? 35);
  const rows = fresh.map((c) => ({
    id: newId(),
    displayName: c.displayName ?? c.handle,
    categories: [msg.category!],
    instagram: msg.platform === "instagram" ? c.handle : null,
    tiktok: msg.platform === "tiktok" ? c.handle : null,
    pastBrands: [],
    collaborationFlags: [],
    source: "apify_discovered" as const,
    isSample: true,
    active: true,
    enrichmentStatus: "pending" as const,
    createdBy: msg.requestedBy ?? "system",
    createdAt: now,
    updatedAt: now,
  }));
  await insertChunked(db, creators, rows);
  if (rows.length) await requestEnrichment(env, rows.map((r) => r.id), "discovery", msg.requestedBy ?? "system");
}
