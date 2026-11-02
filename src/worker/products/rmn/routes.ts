import { and, desc, eq, gte, inArray, sql } from "drizzle-orm";
import type { BatchItem } from "drizzle-orm/batch";
import { Hono } from "hono";
import { z } from "zod";
import { requireRole, type AppEnv } from "../../core/auth";
import { getDb } from "../../core/db/client";
import { creators } from "../../core/db/schema";
import { newId } from "../../core/util";
import { groupTouches, HALF_LIFE_DAYS, summariseAttribution, WINDOW_DAYS, type TouchRow } from "./attribution";
import { CATEGORIES, DEMO_PRODUCTS, isKnownLanding, landingLabel, RMN_SCOPE, STORE_BANNER } from "./catalog";
import { cacheLink, toMapping } from "./links";
import { generateSlug } from "./slugs";
import { rmnCampaigns, rmnClicks, rmnLinks, rmnOrderTouchpoints, rmnSimulatedOrders, rmnStoreEvents } from "./schema";

// ⑥ signed-in API (FR-CORE-1). Everything here sits behind requireAuth, mounted at /api/rmn.
export const rmnRoutes = new Hono<AppEnv>();

const MAX_LINKS = 60; // bounds the D1 rows and KV writes one campaign can make
const RAW_LOG_ROWS = 50;
const D1_MAX_PARAMS = 100;

rmnRoutes.get("/catalog", (c) => c.json({ scope: RMN_SCOPE, banner: STORE_BANNER, categories: CATEGORIES, products: DEMO_PRODUCTS }));

rmnRoutes.get("/campaigns", async (c) => {
  const db = getDb(c.env);
  const rows = await db.select().from(rmnCampaigns).orderBy(desc(rmnCampaigns.createdAt)).limit(50);
  if (rows.length === 0) return c.json({ scope: RMN_SCOPE, campaigns: [] });
  const ids = rows.map((r) => r.id);
  const [clicks, links, orders] = await Promise.all([
    db
      .select({ campaignId: rmnClicks.campaignId, uaClass: rmnClicks.uaClass, result: rmnClicks.result, n: sql<number>`count(*)` })
      .from(rmnClicks)
      .where(inArray(rmnClicks.campaignId, ids))
      .groupBy(rmnClicks.campaignId, rmnClicks.uaClass, rmnClicks.result),
    db.select({ campaignId: rmnLinks.campaignId, n: sql<number>`count(*)` }).from(rmnLinks).where(inArray(rmnLinks.campaignId, ids)).groupBy(rmnLinks.campaignId),
    db
      .select({ campaignId: rmnClicks.campaignId, n: sql<number>`count(distinct ${rmnOrderTouchpoints.orderId})` })
      .from(rmnOrderTouchpoints)
      .innerJoin(rmnClicks, eq(rmnOrderTouchpoints.clickId, rmnClicks.id))
      .where(inArray(rmnClicks.campaignId, ids))
      .groupBy(rmnClicks.campaignId),
  ]);
  const clickCount = (campaignId: string, match: (row: (typeof clicks)[number]) => boolean) =>
    clicks.filter((k) => k.campaignId === campaignId && match(k)).reduce((sum, k) => sum + k.n, 0);
  return c.json({
    scope: RMN_SCOPE,
    campaigns: rows.map((r) => ({
      id: r.id,
      name: r.name,
      windowDays: r.windowDays,
      landingLabel: landingLabel(r.landingKind, r.landingId),
      createdAt: r.createdAt,
      links: links.find((l) => l.campaignId === r.id)?.n ?? 0,
      humanClicks: clickCount(r.id, (k) => k.uaClass === "human" && k.result === "redirected"),
      botClicks: clickCount(r.id, (k) => k.uaClass === "bot"),
      trackedOrders: orders.find((o) => o.campaignId === r.id)?.n ?? 0,
    })),
  });
});

const createSchema = z.object({
  name: z.string().trim().min(1, "Give the campaign a name").max(120),
  windowDays: z.number().int().min(WINDOW_DAYS.min).max(WINDOW_DAYS.max).default(WINDOW_DAYS.default),
  landingKind: z.enum(["product", "category"]),
  landingId: z.string().min(1),
  creatorIds: z.array(z.string().min(1)).min(1).max(30),
  variants: z.array(z.string().trim().min(1).max(40)).max(5).default([]),
});

// FR-RM-1: one default link per creator, plus one per per-post variant. Every slug is unique and unguessable.
rmnRoutes.post("/campaigns", requireRole("admin", "member"), async (c) => {
  const parsed = createSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) return c.json({ error: "invalid_campaign", issues: parsed.error.issues.map((i) => i.message) }, 400);
  const input = parsed.data;
  if (!isKnownLanding(input.landingKind, input.landingId)) return c.json({ error: "unknown_landing" }, 400);
  const creatorIds = [...new Set(input.creatorIds)];
  const variants = [...new Map(input.variants.map((v) => [v.toLowerCase(), v])).values()];
  if (creatorIds.length * (1 + variants.length) > MAX_LINKS) return c.json({ error: "too_many_links", max: MAX_LINKS }, 400);

  const db = getDb(c.env);
  const roster = await db.select({ id: creators.id, displayName: creators.displayName, active: creators.active }).from(creators).where(inArray(creators.id, creatorIds));
  const unknown = creatorIds.filter((id) => !roster.some((r) => r.id === id && r.active));
  if (unknown.length) return c.json({ error: "unknown_creator", creatorIds: unknown }, 400);

  const now = Date.now();
  const campaignId = newId();
  const actor = c.get("userId");
  const links = creatorIds.flatMap((creatorId) =>
    [null, ...variants].map((variant) => ({
      id: newId(),
      campaignId,
      creatorId,
      variant,
      slug: generateSlug(),
      disabled: false,
      statusChangedBy: null,
      statusChangedAt: null,
      createdAt: now,
    })),
  );
  const statements: BatchItem<"sqlite">[] = [
    db.insert(rmnCampaigns).values({
      id: campaignId,
      name: input.name,
      windowDays: input.windowDays,
      landingKind: input.landingKind,
      landingId: input.landingId,
      createdBy: actor,
      createdAt: now,
    }),
    ...chunkRows(links).map((rows) => db.insert(rmnLinks).values(rows)),
  ];
  await db.batch([statements[0]!, ...statements.slice(1)]);

  const landing = { kind: input.landingKind, id: input.landingId };
  await Promise.all(links.map((l) => cacheLink(c.env, l.slug, toMapping(l, landing))));
  const names = new Map(roster.map((r) => [r.id, r.displayName]));
  const origin = new URL(c.req.url).origin;
  return c.json(
    {
      id: campaignId,
      links: links.map((l) => ({ linkId: l.id, creatorId: l.creatorId, creatorName: names.get(l.creatorId) ?? l.creatorId, variant: l.variant, url: `${origin}/r/${l.slug}` })),
    },
    201,
  );
});

// FR-RM-1: a link can be turned off and back on. The change is written to D1 first, then the KV mapping follows.
rmnRoutes.patch("/campaigns/:id/links/:linkId", requireRole("admin", "member"), async (c) => {
  const body = z.object({ disabled: z.boolean() }).safeParse(await c.req.json().catch(() => ({})));
  if (!body.success) return c.json({ error: "invalid_update" }, 400);
  const db = getDb(c.env);
  const [row] = await db
    .select({ link: rmnLinks, landingKind: rmnCampaigns.landingKind, landingId: rmnCampaigns.landingId })
    .from(rmnLinks)
    .innerJoin(rmnCampaigns, eq(rmnLinks.campaignId, rmnCampaigns.id))
    .where(and(eq(rmnLinks.id, c.req.param("linkId")), eq(rmnLinks.campaignId, c.req.param("id"))));
  if (!row) return c.json({ error: "not_found" }, 404);
  const disabled = body.data.disabled;
  await db.update(rmnLinks).set({ disabled, statusChangedBy: c.get("userId"), statusChangedAt: Date.now() }).where(eq(rmnLinks.id, row.link.id));
  await cacheLink(c.env, row.link.slug, toMapping({ ...row.link, disabled }, { kind: row.landingKind, id: row.landingId }));
  return c.json({ ok: true, disabled });
});

rmnRoutes.get("/campaigns/:id", async (c) => {
  const dashboard = await loadDashboard(c.env, c.req.param("id"), new URL(c.req.url).origin);
  if (!dashboard) return c.json({ error: "not_found" }, 404);
  return c.json(dashboard);
});

// D1 caps bound parameters per statement, so rows go in chunks sized by their column count
function chunkRows<T extends object>(rows: T[]): T[][] {
  if (rows.length === 0) return [];
  const size = Math.max(1, Math.floor(D1_MAX_PARAMS / Object.keys(rows[0]!).length));
  return Array.from({ length: Math.ceil(rows.length / size) }, (_, i) => rows.slice(i * size, (i + 1) * size));
}

// FR-RM-4: the read model behind the dashboard. Counts are bot-filtered; both attribution models are returned so the
// client can switch between them without another request.
async function loadDashboard(env: Env, campaignId: string, origin: string) {
  const db = getDb(env);
  const [campaign] = await db.select().from(rmnCampaigns).where(eq(rmnCampaigns.id, campaignId));
  if (!campaign) return null;

  const links = await db
    .select({
      id: rmnLinks.id,
      creatorId: rmnLinks.creatorId,
      variant: rmnLinks.variant,
      slug: rmnLinks.slug,
      disabled: rmnLinks.disabled,
      statusChangedAt: rmnLinks.statusChangedAt,
      creatorName: creators.displayName,
      isSample: creators.isSample,
    })
    .from(rmnLinks)
    .innerJoin(creators, eq(rmnLinks.creatorId, creators.id))
    .where(eq(rmnLinks.campaignId, campaignId))
    .orderBy(rmnLinks.createdAt);

  const clicks = await db
    .select({
      id: rmnClicks.id,
      linkId: rmnClicks.linkId,
      creatorId: rmnClicks.creatorId,
      result: rmnClicks.result,
      uaClass: rmnClicks.uaClass,
      botReason: rmnClicks.botReason,
      referrerHost: rmnClicks.referrerHost,
      clickedAt: rmnClicks.clickedAt,
    })
    .from(rmnClicks)
    .where(eq(rmnClicks.campaignId, campaignId))
    .orderBy(desc(rmnClicks.clickedAt));

  const touchRows: TouchRow[] = await db
    .select({
      orderId: rmnOrderTouchpoints.orderId,
      clickId: rmnClicks.id,
      creatorId: rmnClicks.creatorId,
      clickedAt: rmnClicks.clickedAt,
      at: rmnSimulatedOrders.createdAt,
      revenue: rmnSimulatedOrders.revenueThb,
    })
    .from(rmnOrderTouchpoints)
    .innerJoin(rmnClicks, eq(rmnOrderTouchpoints.clickId, rmnClicks.id))
    .innerJoin(rmnSimulatedOrders, eq(rmnOrderTouchpoints.orderId, rmnSimulatedOrders.id))
    .where(eq(rmnClicks.campaignId, campaignId));
  const orders = groupTouches(touchRows);
  const summary = summariseAttribution(orders, campaign.windowDays);

  const humanClicks = clicks.filter((k) => k.uaClass === "human" && k.result === "redirected");
  const humanClickIds = new Set(humanClicks.map((k) => k.id));
  const tiedToCampaign = (e: { clickIds: string[] }) => e.clickIds.some((id) => humanClickIds.has(id));
  const events = await db.select().from(rmnStoreEvents).where(gte(rmnStoreEvents.createdAt, campaign.createdAt));
  const funnel = {
    productViews: events.filter((e) => e.kind === "view" && tiedToCampaign(e)).length,
    cartAdds: events.filter((e) => e.kind === "add" && tiedToCampaign(e)).length,
    checkouts: orders.length,
  };

  const names = new Map(links.map((l) => [l.creatorId, l.creatorName]));
  const creatorRows = [...new Set(links.map((l) => l.creatorId))].map((creatorId) => {
    const mine = clicks.filter((k) => k.creatorId === creatorId);
    const lastClick = summary.models.last_click.creators[creatorId] ?? { conversions: 0, revenue: 0 };
    const timeDecay = summary.models.time_decay.creators[creatorId] ?? { conversions: 0, revenue: 0 };
    return {
      creatorId,
      name: names.get(creatorId) ?? creatorId,
      isSample: links.some((l) => l.creatorId === creatorId && l.isSample),
      links: links.filter((l) => l.creatorId === creatorId).length,
      humanClicks: mine.filter((k) => k.uaClass === "human" && k.result === "redirected").length,
      botClicks: mine.filter((k) => k.uaClass === "bot").length,
      lastClick: { conversions: lastClick.conversions, revenue: lastClick.revenue },
      timeDecay: { conversions: timeDecay.conversions, revenue: timeDecay.revenue },
    };
  });

  const linkRows = links.map((l) => ({
    linkId: l.id,
    creatorId: l.creatorId,
    creatorName: l.creatorName,
    variant: l.variant,
    url: `${origin}/r/${l.slug}`,
    disabled: l.disabled,
    statusChangedAt: l.statusChangedAt,
    humanClicks: humanClicks.filter((k) => k.linkId === l.id).length,
    botClicks: clicks.filter((k) => k.linkId === l.id && k.uaClass === "bot").length,
  }));

  const linkById = new Map(links.map((l) => [l.id, l]));
  const rawLog = clicks.slice(0, RAW_LOG_ROWS).map((k) => ({
    clickedAt: k.clickedAt,
    creatorName: names.get(k.creatorId) ?? k.creatorId,
    variant: linkById.get(k.linkId)?.variant ?? null,
    uaClass: k.uaClass,
    botReason: k.botReason,
    result: k.result,
    referrerHost: k.referrerHost,
  }));

  return {
    campaign: {
      id: campaign.id,
      name: campaign.name,
      windowDays: campaign.windowDays,
      landingKind: campaign.landingKind,
      landingLabel: landingLabel(campaign.landingKind, campaign.landingId),
      createdAt: campaign.createdAt,
    },
    scope: RMN_SCOPE,
    banner: STORE_BANNER,
    sampleData: links.some((l) => l.isSample),
    halfLifeDays: HALF_LIFE_DAYS,
    headline: {
      humanClicks: humanClicks.length,
      botClicks: clicks.filter((k) => k.uaClass === "bot").length,
      disabledAttempts: clicks.filter((k) => k.uaClass === "human" && k.result === "disabled").length,
      attributedOrders: summary.attributedOrders,
      conversionRate: humanClicks.length ? summary.attributedOrders / humanClicks.length : null,
      unattributedOrders: summary.unattributedOrders,
      unattributedRevenue: summary.unattributedRevenue,
      funnel,
    },
    models: {
      last_click: { conversions: summary.models.last_click.conversions, revenue: summary.models.last_click.revenue },
      time_decay: { conversions: summary.models.time_decay.conversions, revenue: summary.models.time_decay.revenue },
    },
    creators: creatorRows,
    links: linkRows,
    rawLog,
  };
}
