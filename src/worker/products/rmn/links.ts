import { eq } from "drizzle-orm";
import { getDb } from "../../core/db/client";
import { landingPath, type LandingKind } from "./catalog";
import { rmnCampaigns, rmnLinks } from "./schema";

// BR-RM-3: the redirect reads this mapping from KV and never needs D1 once it is cached. D1 stays the record:
// writes go to D1 first, then the cache entry is refreshed (or dropped and rebuilt on the next click).
export type LinkMapping = { linkId: string; campaignId: string; creatorId: string; variant: string | null; disabled: boolean; landingPath: string };

const cacheKey = (slug: string) => `rmn:link:${slug}`;

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

export async function cacheLink(env: Env, slug: string, mapping: LinkMapping): Promise<void> {
  await env.CONFIG.put(cacheKey(slug), JSON.stringify(mapping));
}

// Hot path: one KV read. A miss (cold start, or a write that didn't reach the cache) falls back to D1 once
// and warms the cache, so the next click stays on KV.
export async function resolveLink(env: Env, slug: string): Promise<LinkMapping | null> {
  const cached = await env.CONFIG.get<LinkMapping>(cacheKey(slug), "json");
  if (cached) return cached;
  const [row] = await getDb(env)
    .select({ link: rmnLinks, landingKind: rmnCampaigns.landingKind, landingId: rmnCampaigns.landingId })
    .from(rmnLinks)
    .innerJoin(rmnCampaigns, eq(rmnLinks.campaignId, rmnCampaigns.id))
    .where(eq(rmnLinks.slug, slug));
  if (!row) return null;
  const mapping = toMapping(row.link, { kind: row.landingKind, id: row.landingId });
  await cacheLink(env, slug, mapping);
  return mapping;
}
