import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import { runs } from "../../core/db/schema";

// ⑤ Creative Variants (PRD §8.5). The tables live in this product folder; drizzle.config.ts picks them up
// from products/*/schema.ts. A job is a `runs` row with product "dco" and a `briefs` row for its brief.

export const DCO_ITEM_STATUSES = ["pending", "generating", "ready", "failed"] as const;
export const DCO_REVIEW_STATUSES = ["draft", "approved", "rejected"] as const;
export const DCO_EVENT_KINDS = ["intake", "visual", "copy", "safety", "review", "retry", "export", "decision"] as const;

// FR-DC-4: stored with every generated image (and in the export's provenance sheet). Never holds a token.
export type DcoProvenance = {
  jobId: string;
  planKey: string;
  modelId: string;
  format: string;
  prompt: string;
  negativePrompt: string | null;
  seed: number | null;
  falRequestId: string;
  inputSha256: string;
  outputSha256: string;
  outputBytes: number;
  contentType: string;
  promptVersion: string;
  submittedAt: number;
  completedAt: number;
};

// FR-DC-1: one base asset per job, with its uploader and the rights attestation that let the job run
export const dcoAssets = sqliteTable(
  "dco_assets",
  {
    id: text("id").primaryKey(),
    runId: text("run_id")
      .notNull()
      .references(() => runs.id),
    r2Key: text("r2_key").notNull(),
    fileName: text("file_name").notNull(),
    contentType: text("content_type").notNull(),
    bytes: integer("bytes").notNull(),
    sha256: text("sha256").notNull(),
    uploadedBy: text("uploaded_by").notNull(),
    uploadedAt: integer("uploaded_at").notNull(),
    rightsAttestedBy: text("rights_attested_by").notNull(),
    rightsAttestedAt: integer("rights_attested_at").notNull(),
  },
  (t) => [uniqueIndex("dco_assets_run_uq").on(t.runId)],
);

// One row per audience segment: the copy for it is generated as its own queued call (BR-DC-1)
export const dcoSegments = sqliteTable(
  "dco_segments",
  {
    id: text("id").primaryKey(),
    runId: text("run_id")
      .notNull()
      .references(() => runs.id),
    segmentKey: text("segment_key").notNull(),
    position: integer("position").notNull(),
    name: text("name").notNull(),
    note: text("note"),
    status: text("status", { enum: DCO_ITEM_STATUSES }).notNull(),
    error: text("error"),
    updatedAt: integer("updated_at").notNull(),
  },
  (t) => [uniqueIndex("dco_segments_run_key_uq").on(t.runId, t.segmentKey)],
);

// FR-DC-3: copy options per segment. Drafts until a person approves them (HR-4).
export const dcoCopy = sqliteTable(
  "dco_copy",
  {
    id: text("id").primaryKey(),
    runId: text("run_id")
      .notNull()
      .references(() => runs.id),
    segmentKey: text("segment_key").notNull(),
    position: integer("position").notNull(),
    headline: text("headline").notNull(),
    hookLine: text("hook_line").notNull(),
    caption: text("caption").notNull(),
    cta: text("cta").notNull(),
    flags: text("flags", { mode: "json" }).$type<string[]>().notNull(),
    model: text("model").notNull(),
    promptVersion: text("prompt_version").notNull(),
    reviewStatus: text("review_status", { enum: DCO_REVIEW_STATUSES }).notNull(),
    reviewedBy: text("reviewed_by"),
    reviewedAt: integer("reviewed_at"),
    createdAt: integer("created_at").notNull(),
  },
  (t) => [index("dco_copy_run_idx").on(t.runId, t.segmentKey)],
);

// FR-DC-2: one row per visual slot in the code-level plan. The image lives in R2 under r2Key, and only
// after the provider's safety filter has passed it (BR-DC-2). Provider URLs are kept for polling; no keys.
export const dcoVisuals = sqliteTable(
  "dco_visuals",
  {
    id: text("id").primaryKey(),
    runId: text("run_id")
      .notNull()
      .references(() => runs.id),
    planKey: text("plan_key").notNull(),
    position: integer("position").notNull(),
    kind: text("kind", { enum: ["format", "scene"] }).notNull(),
    label: text("label").notNull(),
    segmentKey: text("segment_key").notNull(),
    format: text("format").notNull(),
    modelId: text("model_id").notNull(),
    status: text("status", { enum: DCO_ITEM_STATUSES }).notNull(),
    attempts: integer("attempts").notNull(),
    error: text("error"),
    falRequestId: text("fal_request_id"),
    statusUrl: text("status_url"),
    responseUrl: text("response_url"),
    submittedAt: integer("submitted_at"),
    r2Key: text("r2_key"),
    contentType: text("content_type"),
    bytes: integer("bytes"),
    provenance: text("provenance", { mode: "json" }).$type<DcoProvenance>(),
    reviewStatus: text("review_status", { enum: DCO_REVIEW_STATUSES }).notNull(),
    reviewedBy: text("reviewed_by"),
    reviewedAt: integer("reviewed_at"),
    updatedAt: integer("updated_at").notNull(),
  },
  (t) => [uniqueIndex("dco_visuals_run_plan_uq").on(t.runId, t.planKey)],
);

// Audit trail (FR-CORE-3). Safety discards are recorded here without any image, so they can be counted.
export const dcoEvents = sqliteTable(
  "dco_events",
  {
    id: text("id").primaryKey(),
    runId: text("run_id")
      .notNull()
      .references(() => runs.id),
    kind: text("kind", { enum: DCO_EVENT_KINDS }).notNull(),
    payload: text("payload", { mode: "json" }).$type<Record<string, unknown>>().notNull(),
    actor: text("actor").notNull(),
    createdAt: integer("created_at").notNull(),
  },
  (t) => [index("dco_events_run_idx").on(t.runId, t.createdAt)],
);
