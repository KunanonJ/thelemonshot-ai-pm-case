// ⑥ Redirect cache and completeness counters, kept in Cloudflare KV. Every KV call here catches its own failure, so a KV
// outage costs a shopper one D1 read and never a 500 (BR-RM-3, BR-CORE-3). Counter writes are best-effort (BR-CORE-2).
import { errorMessage } from "../../core/env";
import type { LinkMapping } from "./links";

// KV keeps a key for at least 60 seconds (its minimum expirationTtl). Ten minutes keeps a quiet link warm without rewriting
// it on every click, and bounds how long a disable or enable whose cache write failed can lag behind D1.
export const LINK_CACHE_TTL_S = 600;
export const LINK_CACHE_WRITE = { expirationTtl: LINK_CACHE_TTL_S } as const;

// The part of KV this module uses, so a test can pass a fake that throws
export type KvLike = Pick<KVNamespace, "get" | "put">;

const linkKey = (slug: string) => `rmn:link:${slug}`;
const droppedKey = (campaignId: string) => `rmn:dropped:${campaignId}`;

export function encodeMapping(mapping: LinkMapping): string {
  return JSON.stringify(mapping);
}

function isMapping(value: unknown): value is LinkMapping {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.linkId === "string" &&
    typeof v.campaignId === "string" &&
    typeof v.creatorId === "string" &&
    (v.variant === null || typeof v.variant === "string") &&
    typeof v.disabled === "boolean" &&
    typeof v.landingPath === "string" &&
    v.landingPath.startsWith("/store/")
  );
}

// Anything malformed is a miss. A bad entry can then never turn a link on by accident or send a shopper off site.
export function decodeMapping(raw: string | null): LinkMapping | null {
  if (raw === null) return null;
  try {
    const value: unknown = JSON.parse(raw);
    return isMapping(value) ? value : null;
  } catch {
    return null;
  }
}

// A KV error is reported as a miss, so the caller falls through to D1
export async function readLinkCache(kv: KvLike, slug: string): Promise<LinkMapping | null> {
  try {
    return decodeMapping(await kv.get(linkKey(slug)));
  } catch (e) {
    console.error("rmn link cache read failed", errorMessage(e));
    return null;
  }
}

// Returns false instead of throwing, so the caller can still answer with the links it has
export async function writeLinkCache(kv: KvLike, slug: string, mapping: LinkMapping): Promise<boolean> {
  try {
    await kv.put(linkKey(slug), encodeMapping(mapping), LINK_CACHE_WRITE);
    return true;
  } catch (e) {
    console.error("rmn link cache write failed", errorMessage(e));
    return false;
  }
}

// Only plain whole numbers count. Anything else is unknown, never zero.
export function parseCount(raw: string): number | null {
  return /^\d+$/.test(raw) && Number.isSafeInteger(Number(raw)) ? Number(raw) : null;
}

// One counter per campaign for clicks and store events that could not be saved. The read and the write are separate
// calls, so two drops landing together can undercount; the dashboard note says the counts may be low.
export async function readDroppedCount(kv: KvLike, campaignId: string): Promise<number | null> {
  try {
    const raw = await kv.get(droppedKey(campaignId));
    return raw === null ? 0 : parseCount(raw);
  } catch (e) {
    console.error("rmn drop count read failed", errorMessage(e));
    return null;
  }
}

export async function countDroppedWrite(kv: KvLike, campaignId: string): Promise<boolean> {
  try {
    const key = droppedKey(campaignId);
    const next = (parseCount((await kv.get(key)) ?? "0") ?? 0) + 1;
    await kv.put(key, String(next));
    return true;
  } catch (e) {
    console.error("rmn drop count write failed", errorMessage(e));
    return false;
  }
}

// Plain sentence for the dashboard. A null count means the counter itself could not be read.
export function completenessNote(dropped: number | null): string | null {
  if (dropped === 0) return null;
  if (dropped === null) {
    return "We could not check whether every click and store event was saved, so these counts may be lower than the real numbers.";
  }
  return `${dropped} ${dropped === 1 ? "click or store event was" : "clicks or store events were"} not saved, so these counts may be lower than the real numbers.`;
}

// Shown when a change reached D1 but its cache entry could not be written
export function propagationNote(ttlSeconds: number): string {
  const minutes = Math.ceil(ttlSeconds / 60);
  return `The change is saved, but the cached copy could not be updated, so it may take up to ${minutes} ${minutes === 1 ? "minute" : "minutes"} to reach every location.`;
}
