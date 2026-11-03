import { eq } from "drizzle-orm";
import { getDb } from "../../core/db/client";
import { readLinkCache, writeLinkCache } from "./cache";
import { landingPath, type LandingKind } from "./catalog";
import { rmnCampaigns, rmnLinks } from "./schema";

// BR-RM-3: the redirect reads this mapping from KV and never needs D1 once it is cached. D1 stays the record:
// writes go to D1 first, then the cache entry is overwritten (or expires and is rebuilt on the next click).
export type LinkMapping = { linkId: string; campaignId: string; creatorId: string; variant: string | null; disabled: boolean; landingPath: string };

export function toMapping(
  link: { id: string; campaignId: string; creatorId: string; variant: string | null; disabled: boolean },
  landing: { kind: LandingKind; id: string },
): LinkMapping {
  return {
    linkId: link.id,
    campaignId: link.campaignId,
    creatorId: link.creatorId,
    variant: link.variant,
    disabled: link.disabled,
    landingPath: landingPath(landing.kind, landing.id),
  };
}

// Hot path: one KV read. A miss, a KV error or a malformed entry falls back to D1 and warms the cache, so the next click
// stays on KV. Only a D1 error is thrown, and the caller answers the shopper with the neutral page.
export async function resolveLink(env: Env, slug: string): Promise<LinkMapping | null> {
  const cached = await readLinkCache(env.CONFIG, slug);
  if (cached) return cached;
  const [row] = await getDb(env)
    .select({ link: rmnLinks, landingKind: rmnCampaigns.landingKind, landingId: rmnCampaigns.landingId })
    .from(rmnLinks)
    .innerJoin(rmnCampaigns, eq(rmnLinks.campaignId, rmnCampaigns.id))
    .where(eq(rmnLinks.slug, slug));
  if (!row) return null;
  const mapping = toMapping(row.link, { kind: row.landingKind, id: row.landingId });
  // A failed warm-up only means the next click reads D1 again, so it never holds up this one
  await writeLinkCache(env.CONFIG, slug, mapping);
  return mapping;
}
