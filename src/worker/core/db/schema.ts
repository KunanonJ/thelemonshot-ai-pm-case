import { index, integer, real, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

export const PLATFORMS = ["instagram", "tiktok", "youtube"] as const;
export type Platform = (typeof PLATFORMS)[number];
export const PRODUCTS = ["matrix", "proposal", "optimization", "trends", "dco", "rmn"] as const;
export type Product = (typeof PRODUCTS)[number];
export const RUN_STATUSES = ["queued", "running", "draft", "approved", "rejected", "failed"] as const;
export type RunStatus = (typeof RUN_STATUSES)[number];

// ---------- creator data spine (FR-CORE-4…8) ----------

export const creators = sqliteTable(
  "creators",
  {
    id: text("id").primaryKey(),
    displayName: text("display_name").notNull(),
    categories: text("categories", { mode: "json" }).$type<string[]>().notNull(),
    region: text("region"),
    instagram: text("instagram"),
    tiktok: text("tiktok"),
    youtube: text("youtube"),
    facebook: text("facebook"),
    pastBrands: text("past_brands", { mode: "json" }).$type<string[]>().notNull(),
    collaborationFlags: text("collaboration_flags", { mode: "json" }).$type<string[]>().notNull(),
    // Null means no outcome history yet (cold start), never zero (FR-MX-4)
    historyScore: real("history_score"),
    historyVersion: text("history_version"),
    source: text("source", { enum: ["seed", "import", "manual", "apify_discovered"] }).notNull(),
    isSample: integer("is_sample", { mode: "boolean" }).notNull(),
    active: integer("active", { mode: "boolean" }).notNull(),
    enrichmentStatus: text("enrichment_status", { enum: ["pending", "ok", "partial", "failed"] }).notNull(),
    createdBy: text("created_by").notNull(),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (t) => [
    uniqueIndex("creators_instagram_uq").on(t.instagram),
    uniqueIndex("creators_tiktok_uq").on(t.tiktok),
    uniqueIndex("creators_youtube_uq").on(t.youtube),
    index("creators_active_idx").on(t.active),
  ],
);

// Append-only; products read the latest row per creator and platform (FR-CORE-5)
export const statSnapshots = sqliteTable(
  "stat_snapshots",
  {
    id: text("id").primaryKey(),
    creatorId: text("creator_id")
      .notNull()
      .references(() => creators.id),
    platform: text("platform", { enum: PLATFORMS }).notNull(),
    followers: integer("followers"),
    following: integer("following"),
    postsCount: integer("posts_count"),
    // Percent; the per-platform definition lives in enrichment/normalise.ts
    engagementRate: real("engagement_rate"),
    medianViews: real("median_views"),
    avgLikes: real("avg_likes"),
    avgComments: real("avg_comments"),
    recentPosts: integer("recent_posts").notNull(),
    topHashtags: text("top_hashtags", { mode: "json" }).$type<string[]>().notNull(),
    verified: integer("verified", { mode: "boolean" }),
    source: text("source", { enum: ["apify", "youtube_api"] }).notNull(),
    sourceRef: text("source_ref"),
    rawKey: text("raw_key"),
    fetchedAt: integer("fetched_at").notNull(),
  },
  (t) => [index("snapshots_creator_platform_idx").on(t.creatorId, t.platform, t.fetchedAt)],
);

export const contentItems = sqliteTable(
  "content_items",
  {
    id: text("id").primaryKey(),
    creatorId: text("creator_id")
      .notNull()
      .references(() => creators.id),
    platform: text("platform", { enum: PLATFORMS }).notNull(),
    platformPostId: text("platform_post_id").notNull(),
    url: text("url"),
    postedAt: integer("posted_at"),
    caption: text("caption"),
    status: text("status", { enum: ["available", "unavailable"] }).notNull(),
    firstSeenAt: integer("first_seen_at").notNull(),
  },
  (t) => [uniqueIndex("content_platform_post_uq").on(t.platform, t.platformPostId), index("content_creator_idx").on(t.creatorId)],
);

export const contentMetrics = sqliteTable(
  "content_metrics",
  {
    id: text("id").primaryKey(),
    contentId: text("content_id")
      .notNull()
      .references(() => contentItems.id),
    views: integer("views"),
    likes: integer("likes"),
    comments: integer("comments"),
    shares: integer("shares"),
    source: text("source", { enum: ["apify", "youtube_api"] }).notNull(),
    fetchedAt: integer("fetched_at").notNull(),
  },
  (t) => [index("content_metrics_idx").on(t.contentId, t.fetchedAt)],
);

// One row per creator and platform per enrichment request, so "all platforms failed" is knowable (BR-CORE-1)
export const enrichmentJobs = sqliteTable(
  "enrichment_jobs",
  {
    id: text("id").primaryKey(),
    creatorId: text("creator_id")
      .notNull()
      .references(() => creators.id),
    platform: text("platform", { enum: PLATFORMS }).notNull(),
    status: text("status", { enum: ["pending", "ok", "failed"] }).notNull(),
    reason: text("reason", { enum: ["add", "manual", "sweep", "discovery"] }).notNull(),
    apifyRunId: text("apify_run_id"),
    error: text("error"),
    requestedBy: text("requested_by").notNull(),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (t) => [index("enrichment_jobs_creator_idx").on(t.creatorId, t.status)],
);

export const outcomeRecords = sqliteTable(
  "outcome_records",
  {
    id: text("id").primaryKey(),
    creatorId: text("creator_id")
      .notNull()
      .references(() => creators.id),
    campaignRef: text("campaign_ref").notNull(),
    outcomeScore: real("outcome_score").notNull(),
    detail: text("detail", { mode: "json" }).$type<Record<string, unknown>>().notNull(),
    scoringVersion: text("scoring_version").notNull(),
    createdBy: text("created_by").notNull(),
    createdAt: integer("created_at").notNull(),
  },
  (t) => [index("outcomes_creator_idx").on(t.creatorId)],
);

// ---------- runs and the compounding dataset (FR-CORE-19…23) ----------

export const briefs = sqliteTable("briefs", {
  id: text("id").primaryKey(),
  product: text("product", { enum: PRODUCTS }).notNull(),
  fields: text("fields", { mode: "json" }).$type<Record<string, unknown>>().notNull(),
  inputHash: text("input_hash").notNull(),
  createdBy: text("created_by").notNull(),
  createdAt: integer("created_at").notNull(),
});

export const runs = sqliteTable(
  "runs",
  {
    id: text("id").primaryKey(),
    product: text("product", { enum: PRODUCTS }).notNull(),
    briefId: text("brief_id").references(() => briefs.id),
    status: text("status", { enum: RUN_STATUSES }).notNull(),
    inputHash: text("input_hash").notNull(),
    flags: text("flags", { mode: "json" }).$type<Record<string, unknown>>().notNull(),
    error: text("error"),
    createdBy: text("created_by").notNull(),
    createdAt: integer("created_at").notNull(),
    startedAt: integer("started_at"),
    finishedAt: integer("finished_at"),
    reviewedBy: text("reviewed_by"),
    reviewedAt: integer("reviewed_at"),
  },
  (t) => [index("runs_product_idx").on(t.product, t.createdAt), index("runs_hash_idx").on(t.inputHash)],
);

// Scores are written once; overrides only move final_pick (BR-MX-4)
export const runItems = sqliteTable(
  "run_items",
  {
    id: text("id").primaryKey(),
    runId: text("run_id")
      .notNull()
      .references(() => runs.id),
    creatorId: text("creator_id")
      .notNull()
      .references(() => creators.id),
    rank: integer("rank"),
    composite: real("composite"),
    components: text("components", { mode: "json" }).$type<Record<string, number | null>>().notNull(),
    dims: text("dims", { mode: "json" }).$type<Record<string, number> | null>(),
    features: text("features", { mode: "json" }).$type<Record<string, unknown>>().notNull(),
    rationale: text("rationale"),
    flags: text("flags", { mode: "json" }).$type<string[]>().notNull(),
    completeness: real("completeness").notNull(),
    stalenessDays: real("staleness_days"),
    recommended: integer("recommended", { mode: "boolean" }).notNull(),
    finalPick: integer("final_pick", { mode: "boolean" }).notNull(),
    replacesCreatorId: text("replaces_creator_id"),
    excludedReason: text("excluded_reason", { enum: ["must_exclude", "safety_excluded", "no_data"] }),
  },
  (t) => [index("run_items_run_idx").on(t.runId)],
);

export const runLogs = sqliteTable(
  "run_logs",
  {
    id: text("id").primaryKey(),
    runId: text("run_id")
      .notNull()
      .references(() => runs.id),
    kind: text("kind", { enum: ["inputs", "candidates", "llm", "scores", "override", "decision", "export", "section", "attach"] }).notNull(),
    payload: text("payload", { mode: "json" }).$type<Record<string, unknown>>().notNull(),
    actor: text("actor").notNull(),
    createdAt: integer("created_at").notNull(),
  },
  (t) => [index("run_logs_run_idx").on(t.runId, t.createdAt)],
);

// ---------- ④ Campaign Proposal (FR-CP-1…6) ----------

// One row per proposal section: which version is current and whether a generation job is in flight
export const PROPOSAL_SECTION_STATUSES = ["pending", "generating", "ready", "failed"] as const;
export const proposalSections = sqliteTable(
  "proposal_sections",
  {
    id: text("id").primaryKey(),
    runId: text("run_id")
      .notNull()
      .references(() => runs.id),
    sectionKey: text("section_key").notNull(),
    position: integer("position").notNull(),
    status: text("status", { enum: PROPOSAL_SECTION_STATUSES }).notNull(),
    currentVersionId: text("current_version_id"),
    // A failed generation's reason in plain words; the section keeps its current version (BR-CP-2)
    error: text("error"),
    updatedAt: integer("updated_at").notNull(),
  },
  (t) => [uniqueIndex("proposal_sections_run_key_uq").on(t.runId, t.sectionKey)],
);

// Append-only (FR-CP-4): generations, regenerations and edits each add a version; nothing is overwritten
export const PROPOSAL_ORIGINS = ["generated", "regenerated", "edited", "template", "empty"] as const;
export type ProposalCitation = { creatorId: string; runItemId: string; matrixRunId: string };
export const proposalVersions = sqliteTable(
  "proposal_versions",
  {
    id: text("id").primaryKey(),
    runId: text("run_id")
      .notNull()
      .references(() => runs.id),
    sectionKey: text("section_key").notNull(),
    version: integer("version").notNull(),
    origin: text("origin", { enum: PROPOSAL_ORIGINS }).notNull(),
    content: text("content", { mode: "json" }).$type<Record<string, unknown>>().notNull(),
    // FR-CP-2: the shortlist evidence behind every creator this version mentions
    citations: text("citations", { mode: "json" }).$type<ProposalCitation[]>().notNull(),
    flags: text("flags", { mode: "json" }).$type<string[]>().notNull(),
    note: text("note"),
    promptVersion: text("prompt_version"),
    createdBy: text("created_by").notNull(),
    createdAt: integer("created_at").notNull(),
  },
  (t) => [uniqueIndex("proposal_versions_uq").on(t.runId, t.sectionKey, t.version)],
);

// ---------- ③ Campaign Optimization (FR-CO-1…7) ----------

// Organic scope only (HR-2): public post metrics, no ad-account data. Never deleted once written back (FR-CO-7).
export const CAMPAIGN_STATUSES = ["active", "closed", "archived"] as const;
export const campaigns = sqliteTable(
  "campaigns",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    brand: text("brand").notNull(),
    matrixRunId: text("matrix_run_id"),
    startsAt: integer("starts_at").notNull(),
    endsAt: integer("ends_at").notNull(),
    status: text("status", { enum: CAMPAIGN_STATUSES }).notNull(),
    lastRefreshAt: integer("last_refresh_at"),
    // The outcome summary the planner confirmed at close, and the write-back it produced
    outcome: text("outcome", { mode: "json" }).$type<Record<string, unknown> | null>(),
    closedBy: text("closed_by"),
    closedAt: integer("closed_at"),
    createdBy: text("created_by").notNull(),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (t) => [index("campaigns_status_idx").on(t.status)],
);

export const campaignPosts = sqliteTable(
  "campaign_posts",
  {
    id: text("id").primaryKey(),
    campaignId: text("campaign_id")
      .notNull()
      .references(() => campaigns.id),
    creatorId: text("creator_id")
      .notNull()
      .references(() => creators.id),
    contentId: text("content_id")
      .notNull()
      .references(() => contentItems.id),
    platform: text("platform", { enum: PLATFORMS }).notNull(),
    url: text("url").notNull(),
    baselineViews: integer("baseline_views"),
    baselineEngagementRate: real("baseline_engagement_rate"),
    // Consecutive refreshes in which the source returned nothing for this post (BR-CO-1)
    misses: integer("misses").notNull(),
    unavailableAt: integer("unavailable_at"),
    unavailableReason: text("unavailable_reason"),
    addedAt: integer("added_at").notNull(),
  },
  (t) => [uniqueIndex("campaign_posts_uq").on(t.campaignId, t.contentId), index("campaign_posts_campaign_idx").on(t.campaignId)],
);

// One per refresh: which platforms were asked for and which have answered, so the digest runs once all are in
export const campaignRefreshes = sqliteTable(
  "campaign_refreshes",
  {
    id: text("id").primaryKey(),
    campaignId: text("campaign_id")
      .notNull()
      .references(() => campaigns.id),
    trigger: text("trigger", { enum: ["schedule", "manual", "registration"] }).notNull(),
    platforms: text("platforms", { mode: "json" }).$type<string[]>().notNull(),
    done: text("done", { mode: "json" }).$type<string[]>().notNull(),
    failed: text("failed", { mode: "json" }).$type<{ platform: string; error: string }[]>().notNull(),
    status: text("status", { enum: ["running", "done"] }).notNull(),
    digestRunId: text("digest_run_id"),
    requestedBy: text("requested_by").notNull(),
    startedAt: integer("started_at").notNull(),
    finishedAt: integer("finished_at"),
  },
  (t) => [index("campaign_refreshes_campaign_idx").on(t.campaignId, t.startedAt)],
);

// One per digest run (runs.product = "optimization"). The deterministic part never depends on the model (AC-CO-4).
export const campaignDigests = sqliteTable(
  "campaign_digests",
  {
    runId: text("run_id")
      .primaryKey()
      .references(() => runs.id),
    campaignId: text("campaign_id")
      .notNull()
      .references(() => campaigns.id),
    refreshId: text("refresh_id"),
    deltas: text("deltas", { mode: "json" }).$type<Record<string, unknown>>().notNull(),
    narrative: text("narrative", { mode: "json" }).$type<Record<string, unknown> | null>(),
    freshness: text("freshness", { mode: "json" }).$type<Record<string, unknown>>().notNull(),
    flags: text("flags", { mode: "json" }).$type<string[]>().notNull(),
    createdAt: integer("created_at").notNull(),
  },
  (t) => [index("campaign_digests_campaign_idx").on(t.campaignId, t.createdAt)],
);

// FR-CO-6: notes and actions a planner attaches to a recommendation
export const campaignActions = sqliteTable(
  "campaign_actions",
  {
    id: text("id").primaryKey(),
    campaignId: text("campaign_id")
      .notNull()
      .references(() => campaigns.id),
    digestRunId: text("digest_run_id"),
    recommendation: integer("recommendation"),
    note: text("note").notNull(),
    actor: text("actor").notNull(),
    createdAt: integer("created_at").notNull(),
  },
  (t) => [index("campaign_actions_campaign_idx").on(t.campaignId, t.createdAt)],
);

// Nothing fails silently: failed items land here with a reason (BR-CORE-1, FR-MX-8)
export const deadLetters = sqliteTable(
  "dead_letters",
  {
    id: text("id").primaryKey(),
    kind: text("kind", { enum: ["enrichment", "run"] }).notNull(),
    creatorId: text("creator_id"),
    runId: text("run_id"),
    platform: text("platform"),
    reason: text("reason").notNull(),
    detail: text("detail", { mode: "json" }).$type<Record<string, unknown>>().notNull(),
    createdAt: integer("created_at").notNull(),
    resolvedAt: integer("resolved_at"),
  },
  (t) => [index("dead_letters_open_idx").on(t.resolvedAt, t.createdAt)],
);

// ---------- external-call audit and cost (FR-CORE-10, FR-CORE-18) ----------

export const apifyRuns = sqliteTable(
  "apify_runs",
  {
    id: text("id").primaryKey(),
    actor: text("actor").notNull(),
    purpose: text("purpose", { enum: ["profile", "discovery", "posts", "trends"] }).notNull(),
    inputSummary: text("input_summary").notNull(),
    apifyRunId: text("apify_run_id"),
    status: text("status").notNull(),
    itemCount: integer("item_count"),
    error: text("error"),
    // NFR-5: Apify's own figure for the run (usageTotalUsd); null when it reports none
    costUsd: real("cost_usd"),
    startedAt: integer("started_at").notNull(),
    finishedAt: integer("finished_at"),
  },
  (t) => [index("apify_runs_started_idx").on(t.startedAt)],
);

export const llmCalls = sqliteTable(
  "llm_calls",
  {
    id: text("id").primaryKey(),
    product: text("product", { enum: PRODUCTS }).notNull(),
    promptVersion: text("prompt_version").notNull(),
    model: text("model").notNull(),
    mode: text("mode", { enum: ["json_schema", "prompt_only", "none"] }).notNull(),
    status: text("status", { enum: ["ok", "invalid_json", "schema_mismatch", "http_error", "timeout", "network", "forced_failure", "not_configured"] }).notNull(),
    inputTokens: integer("input_tokens"),
    outputTokens: integer("output_tokens"),
    costUsd: real("cost_usd"),
    latencyMs: integer("latency_ms").notNull(),
    runId: text("run_id"),
    error: text("error"),
    createdAt: integer("created_at").notNull(),
  },
  (t) => [index("llm_calls_created_idx").on(t.createdAt)],
);
