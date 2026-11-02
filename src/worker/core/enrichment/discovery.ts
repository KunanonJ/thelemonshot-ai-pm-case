import { inArray } from "drizzle-orm";
import { getDb, insertChunked } from "../db/client";
import { creators } from "../db/schema";
import type { ApifyPollMessage } from "../messages";
import { chunk, newId } from "../util";
import { ACTORS, startActor } from "./apify";
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

export async function startDiscovery(env: Env, req: DiscoveryRequest, requestedBy: string): Promise<string[]> {
  const started: string[] = [];
  const base = { purpose: "discovery" as const, startedAt: Date.now(), category: req.category, maxNew: req.maxNewPerPlatform, requestedBy };
  if (req.instagramHashtags.length) {
    const { localRunId, apifyRunId } = await startActor(
      env,
      ACTORS.instagramHashtag,
      { hashtags: req.instagramHashtags, resultsType: "posts", resultsLimit: req.perHashtag },
      "discovery",
      `instagram ${req.category}: #${req.instagramHashtags.join(" #")}`,
    );
    await env.ENRICH_QUEUE.send({ kind: "apify-poll", platform: "instagram", localRunId, apifyRunId, ...base } satisfies ApifyPollMessage, {
      delaySeconds: 45,
    });
    started.push(localRunId);
  }
  if (req.tiktokHashtags.length) {
    const { localRunId, apifyRunId } = await startActor(
      env,
      ACTORS.tiktokSearch,
      { hashtags: req.tiktokHashtags, resultsPerPage: req.perHashtag },
      "discovery",
      `tiktok ${req.category}: #${req.tiktokHashtags.join(" #")}`,
    );
    await env.ENRICH_QUEUE.send({ kind: "apify-poll", platform: "tiktok", localRunId, apifyRunId, ...base } satisfies ApifyPollMessage, {
      delaySeconds: 45,
    });
    started.push(localRunId);
  }
  return started;
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
