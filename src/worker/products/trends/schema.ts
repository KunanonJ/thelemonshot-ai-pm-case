import { index, integer, primaryKey, real, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import { runs } from "../../core/db/schema";
import type { SourceNote, TrendExemplar, TrendSample, TrendTheme } from "./model";

// ② Trend Monitoring (FR-TM-1 to FR-TM-4). The brief is the runs row (product "trends"); these tables hold the
// watchlist, the pulls, the per-term Apify cost and the deduplicated posts behind each brief.

export const TREND_PLATFORMS = ["instagram", "tiktok"] as const;
export type TrendPlatform = (typeof TREND_PLATFORMS)[number];
export const TREND_TERM_KINDS = ["hashtag", "keyword"] as const;
export type TrendTermKind = (typeof TREND_TERM_KINDS)[number];

// FR-TM-1: a watched term. Deactivated terms keep their pull history.
export const trendWatchlist = sqliteTable(
  "trend_watchlist",
  {
    id: text("id").primaryKey(),
    term: text("term").notNull(),
    termKey: text("term_key").notNull(),
    kind: text("kind", { enum: TREND_TERM_KINDS }).notNull(),
    platforms: text("platforms", { mode: "json" }).$type<TrendPlatform[]>().notNull(),
    category: text("category").notNull(),
    postCap: integer("post_cap").notNull(),
    active: integer("active", { mode: "boolean" }).notNull(),
    createdBy: text("created_by").notNull(),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (t) => [uniqueIndex("trend_watchlist_uq").on(t.kind, t.termKey, t.category)],
);

// One pull per run. status: running (Apify runs in flight) -> building (brief being written) -> done
export const trendPulls = sqliteTable(
  "trend_pulls",
  {
    id: text("id").primaryKey(),
    runId: text("run_id")
      .notNull()
      .references(() => runs.id),
    status: text("status", { enum: ["running", "building", "done"] }).notNull(),
    termIds: text("term_ids", { mode: "json" }).$type<string[]>().notNull(),
    requestedBy: text("requested_by").notNull(),
    startedAt: integer("started_at").notNull(),
    finishedAt: integer("finished_at"),
  },
  (t) => [uniqueIndex("trend_pulls_run_uq").on(t.runId)],
);

// One row per watched term and platform in a pull: one Apify run each, so cost is visible per term (FR-TM-4)
export const trendPullTerms = sqliteTable(
  "trend_pull_terms",
  {
    id: text("id").primaryKey(),
    pullId: text("pull_id")
      .notNull()
      .references(() => trendPulls.id),
    watchlistId: text("watchlist_id").notNull(),
    label: text("label").notNull(),
    term: text("term").notNull(),
    kind: text("kind", { enum: TREND_TERM_KINDS }).notNull(),
    category: text("category").notNull(),
    platform: text("platform", { enum: TREND_PLATFORMS }).notNull(),
    postCap: integer("post_cap").notNull(),
    status: text("status", { enum: ["running", "ok", "failed"] }).notNull(),
    localRunId: text("local_run_id"),
    apifyRunId: text("apify_run_id"),
    // Items the actor returned, including error items; postCount is the usable posts parsed from them
    itemCount: integer("item_count"),
    postCount: integer("post_count"),
    // Dollars as Apify reports them for the run; null when Apify did not report a figure
    usageUsd: real("usage_usd"),
    note: text("note"),
    error: text("error"),
    createdAt: integer("created_at").notNull(),
    finishedAt: integer("finished_at"),
  },
  (t) => [index("trend_pull_terms_pull_idx").on(t.pullId)],
);

// One row per platform post, across all pulls (FR-TM-1 dedupe by platform post ID)
export const trendPosts = sqliteTable(
  "trend_posts",
  {
    id: text("id").primaryKey(),
    platform: text("platform", { enum: TREND_PLATFORMS }).notNull(),
    platformPostId: text("platform_post_id").notNull(),
    url: text("url").notNull(),
    handle: text("handle"),
    caption: text("caption"),
    hashtags: text("hashtags", { mode: "json" }).$type<string[]>().notNull(),
    postedAt: integer("posted_at"),
    likes: integer("likes"),
    comments: integer("comments"),
    views: integer("views"),
    shares: integer("shares"),
    firstSeenAt: integer("first_seen_at").notNull(),
    lastSeenAt: integer("last_seen_at").notNull(),
  },
  (t) => [uniqueIndex("trend_posts_platform_uq").on(t.platform, t.platformPostId)],
);

// Which posts a term returned in a pull, with the metrics as that pull saw them
export const trendPullHits = sqliteTable(
  "trend_pull_hits",
  {
    pullTermId: text("pull_term_id")
      .notNull()
      .references(() => trendPullTerms.id),
    pullId: text("pull_id")
      .notNull()
      .references(() => trendPulls.id),
    postId: text("post_id")
      .notNull()
      .references(() => trendPosts.id),
    likes: integer("likes"),
    comments: integer("comments"),
    views: integer("views"),
    shares: integer("shares"),
  },
  (t) => [primaryKey({ columns: [t.pullTermId, t.postId] }), index("trend_hits_pull_idx").on(t.pullId)],
);

// One brief per pull. Themes, exemplars and sources are computed by code; the model only names and angles them.
export const trendBriefs = sqliteTable("trend_briefs", {
  runId: text("run_id")
    .primaryKey()
    .references(() => runs.id),
  pullId: text("pull_id")
    .notNull()
    .references(() => trendPulls.id),
  sample: text("sample", { mode: "json" }).$type<TrendSample>().notNull(),
  themes: text("themes", { mode: "json" }).$type<TrendTheme[]>().notNull(),
  exemplars: text("exemplars", { mode: "json" }).$type<TrendExemplar[]>().notNull(),
  sources: text("sources", { mode: "json" }).$type<SourceNote[]>().notNull(),
  flags: text("flags", { mode: "json" }).$type<string[]>().notNull(),
  promptVersion: text("prompt_version").notNull(),
  createdAt: integer("created_at").notNull(),
});

// BR-CP / AC-TM-2: an approved trend brief attached to a ④ proposal run
export const trendAttachments = sqliteTable(
  "trend_attachments",
  {
    proposalRunId: text("proposal_run_id")
      .notNull()
      .references(() => runs.id),
    trendRunId: text("trend_run_id")
      .notNull()
      .references(() => runs.id),
    attachedBy: text("attached_by").notNull(),
    attachedAt: integer("attached_at").notNull(),
  },
  (t) => [primaryKey({ columns: [t.proposalRunId, t.trendRunId] })],
);
