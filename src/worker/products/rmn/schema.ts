import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import { creators } from "../../core/db/schema";

// ⑥ Creator Retail Media Network (PRD-01 §8.6). Kept in the product folder, not the core schema.
// Simulated commerce (rmn_simulated_orders) is stored apart from outcome_records and creators.historyScore (BR-RM-2).

export const RMN_LANDING_KINDS = ["product", "category"] as const;

// FR-RM-3: a campaign carries its attribution window (1 to 30 days) and its landing target in the demo store
export const rmnCampaigns = sqliteTable("rmn_campaigns", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  windowDays: integer("window_days").notNull(),
  landingKind: text("landing_kind", { enum: RMN_LANDING_KINDS }).notNull(),
  landingId: text("landing_id").notNull(),
  createdBy: text("created_by").notNull(),
  createdAt: integer("created_at").notNull(),
});

// FR-RM-1: one default link per linked creator (variant null) plus one per per-post variant.
// The slug is the public address; the unique index makes it unguessable and unambiguous.
export const rmnLinks = sqliteTable(
  "rmn_links",
  {
    id: text("id").primaryKey(),
    campaignId: text("campaign_id")
      .notNull()
      .references(() => rmnCampaigns.id),
    creatorId: text("creator_id")
      .notNull()
      .references(() => creators.id),
    variant: text("variant"),
    slug: text("slug").notNull(),
    disabled: integer("disabled", { mode: "boolean" }).notNull(),
    // Audit: who last turned the link off or on, and when (FR-CORE-3)
    statusChangedBy: text("status_changed_by"),
    statusChangedAt: integer("status_changed_at"),
    createdAt: integer("created_at").notNull(),
  },
  (t) => [uniqueIndex("rmn_links_slug_uq").on(t.slug), index("rmn_links_campaign_idx").on(t.campaignId)],
);

// FR-RM-2: append-only click log. The id is the click ID the attribution cookie carries. Raw user agents are
// never stored, only their class and the reason for it (BR-RM-1). Bot rows stay here and are excluded from headline counts.
export const rmnClicks = sqliteTable(
  "rmn_clicks",
  {
    id: text("id").primaryKey(),
    linkId: text("link_id")
      .notNull()
      .references(() => rmnLinks.id),
    campaignId: text("campaign_id")
      .notNull()
      .references(() => rmnCampaigns.id),
    creatorId: text("creator_id")
      .notNull()
      .references(() => creators.id),
    // "disabled" rows are attempts on a turned-off link; they never set the attribution cookie
    result: text("result", { enum: ["redirected", "disabled"] }).notNull(),
    uaClass: text("ua_class", { enum: ["human", "bot"] }).notNull(),
    botReason: text("bot_reason"),
    // The referrer's host only, never the full URL
    referrerHost: text("referrer_host"),
    clickedAt: integer("clicked_at").notNull(),
  },
  (t) => [index("rmn_clicks_campaign_idx").on(t.campaignId, t.clickedAt), index("rmn_clicks_link_idx").on(t.linkId)],
);

// Demo store funnel (FR-RM-5): product views and add-to-cart events, tied to the click IDs in the attribution cookie
export const rmnStoreEvents = sqliteTable(
  "rmn_store_events",
  {
    id: text("id").primaryKey(),
    kind: text("kind", { enum: ["view", "add"] }).notNull(),
    productId: text("product_id").notNull(),
    clickIds: text("click_ids", { mode: "json" }).$type<string[]>().notNull(),
    createdAt: integer("created_at").notNull(),
  },
  (t) => [index("rmn_store_events_created_idx").on(t.createdAt)],
);

// BR-RM-2: the simulated outcomes, one row per demo checkout. Nothing here feeds creators.historyScore.
export const rmnSimulatedOrders = sqliteTable(
  "rmn_simulated_orders",
  {
    id: text("id").primaryKey(),
    items: text("items", { mode: "json" }).$type<{ productId: string; name: string; priceThb: number }[]>().notNull(),
    revenueThb: integer("revenue_thb").notNull(),
    createdAt: integer("created_at").notNull(),
  },
  (t) => [index("rmn_simulated_orders_created_idx").on(t.createdAt)],
);

// Which tracked clicks a simulated order is tied to. Click times and creators come from rmn_clicks at read time,
// so attribution always uses the logged times. No foreign key on clickId: a click's log write runs after the redirect.
export const rmnOrderTouchpoints = sqliteTable(
  "rmn_order_touchpoints",
  {
    id: text("id").primaryKey(),
    orderId: text("order_id")
      .notNull()
      .references(() => rmnSimulatedOrders.id),
    clickId: text("click_id").notNull(),
  },
  (t) => [uniqueIndex("rmn_touch_uq").on(t.orderId, t.clickId), index("rmn_touch_click_idx").on(t.clickId)],
);
