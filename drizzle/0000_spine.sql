CREATE TABLE `apify_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`actor` text NOT NULL,
	`purpose` text NOT NULL,
	`input_summary` text NOT NULL,
	`apify_run_id` text,
	`status` text NOT NULL,
	`item_count` integer,
	`error` text,
	`started_at` integer NOT NULL,
	`finished_at` integer
);
--> statement-breakpoint
CREATE INDEX `apify_runs_started_idx` ON `apify_runs` (`started_at`);--> statement-breakpoint
CREATE TABLE `briefs` (
	`id` text PRIMARY KEY NOT NULL,
	`product` text NOT NULL,
	`fields` text NOT NULL,
	`input_hash` text NOT NULL,
	`created_by` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `content_items` (
	`id` text PRIMARY KEY NOT NULL,
	`creator_id` text NOT NULL,
	`platform` text NOT NULL,
	`platform_post_id` text NOT NULL,
	`url` text,
	`posted_at` integer,
	`caption` text,
	`status` text NOT NULL,
	`first_seen_at` integer NOT NULL,
	FOREIGN KEY (`creator_id`) REFERENCES `creators`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `content_platform_post_uq` ON `content_items` (`platform`,`platform_post_id`);--> statement-breakpoint
CREATE INDEX `content_creator_idx` ON `content_items` (`creator_id`);--> statement-breakpoint
CREATE TABLE `content_metrics` (
	`id` text PRIMARY KEY NOT NULL,
	`content_id` text NOT NULL,
	`views` integer,
	`likes` integer,
	`comments` integer,
	`shares` integer,
	`source` text NOT NULL,
	`fetched_at` integer NOT NULL,
	FOREIGN KEY (`content_id`) REFERENCES `content_items`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `content_metrics_idx` ON `content_metrics` (`content_id`,`fetched_at`);--> statement-breakpoint
CREATE TABLE `creators` (
	`id` text PRIMARY KEY NOT NULL,
	`display_name` text NOT NULL,
	`categories` text NOT NULL,
	`region` text,
	`instagram` text,
	`tiktok` text,
	`youtube` text,
	`facebook` text,
	`past_brands` text NOT NULL,
	`collaboration_flags` text NOT NULL,
	`history_score` real,
	`history_version` text,
	`source` text NOT NULL,
	`is_sample` integer NOT NULL,
	`active` integer NOT NULL,
	`enrichment_status` text NOT NULL,
	`created_by` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `creators_instagram_uq` ON `creators` (`instagram`);--> statement-breakpoint
CREATE UNIQUE INDEX `creators_tiktok_uq` ON `creators` (`tiktok`);--> statement-breakpoint
CREATE UNIQUE INDEX `creators_youtube_uq` ON `creators` (`youtube`);--> statement-breakpoint
CREATE INDEX `creators_active_idx` ON `creators` (`active`);--> statement-breakpoint
CREATE TABLE `dead_letters` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`creator_id` text,
	`run_id` text,
	`platform` text,
	`reason` text NOT NULL,
	`detail` text NOT NULL,
	`created_at` integer NOT NULL,
	`resolved_at` integer
);
--> statement-breakpoint
CREATE INDEX `dead_letters_open_idx` ON `dead_letters` (`resolved_at`,`created_at`);--> statement-breakpoint
CREATE TABLE `enrichment_jobs` (
	`id` text PRIMARY KEY NOT NULL,
	`creator_id` text NOT NULL,
	`platform` text NOT NULL,
	`status` text NOT NULL,
	`reason` text NOT NULL,
	`apify_run_id` text,
	`error` text,
	`requested_by` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`creator_id`) REFERENCES `creators`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `enrichment_jobs_creator_idx` ON `enrichment_jobs` (`creator_id`,`status`);--> statement-breakpoint
CREATE TABLE `llm_calls` (
	`id` text PRIMARY KEY NOT NULL,
	`product` text NOT NULL,
	`prompt_version` text NOT NULL,
	`model` text NOT NULL,
	`mode` text NOT NULL,
	`status` text NOT NULL,
	`input_tokens` integer,
	`output_tokens` integer,
	`cost_usd` real,
	`latency_ms` integer NOT NULL,
	`run_id` text,
	`error` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `llm_calls_created_idx` ON `llm_calls` (`created_at`);--> statement-breakpoint
CREATE TABLE `outcome_records` (
	`id` text PRIMARY KEY NOT NULL,
	`creator_id` text NOT NULL,
	`campaign_ref` text NOT NULL,
	`outcome_score` real NOT NULL,
	`detail` text NOT NULL,
	`scoring_version` text NOT NULL,
	`created_by` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`creator_id`) REFERENCES `creators`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `outcomes_creator_idx` ON `outcome_records` (`creator_id`);--> statement-breakpoint
CREATE TABLE `run_items` (
	`id` text PRIMARY KEY NOT NULL,
	`run_id` text NOT NULL,
	`creator_id` text NOT NULL,
	`rank` integer,
	`composite` real,
	`components` text NOT NULL,
	`dims` text,
	`features` text NOT NULL,
	`rationale` text,
	`flags` text NOT NULL,
	`completeness` real NOT NULL,
	`staleness_days` real,
	`recommended` integer NOT NULL,
	`final_pick` integer NOT NULL,
	`replaces_creator_id` text,
	`excluded_reason` text,
	FOREIGN KEY (`run_id`) REFERENCES `runs`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`creator_id`) REFERENCES `creators`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `run_items_run_idx` ON `run_items` (`run_id`);--> statement-breakpoint
CREATE TABLE `run_logs` (
	`id` text PRIMARY KEY NOT NULL,
	`run_id` text NOT NULL,
	`kind` text NOT NULL,
	`payload` text NOT NULL,
	`actor` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`run_id`) REFERENCES `runs`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `run_logs_run_idx` ON `run_logs` (`run_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `runs` (
	`id` text PRIMARY KEY NOT NULL,
	`product` text NOT NULL,
	`brief_id` text,
	`status` text NOT NULL,
	`input_hash` text NOT NULL,
	`flags` text NOT NULL,
	`error` text,
	`created_by` text NOT NULL,
	`created_at` integer NOT NULL,
	`started_at` integer,
	`finished_at` integer,
	`reviewed_by` text,
	`reviewed_at` integer,
	FOREIGN KEY (`brief_id`) REFERENCES `briefs`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `runs_product_idx` ON `runs` (`product`,`created_at`);--> statement-breakpoint
CREATE INDEX `runs_hash_idx` ON `runs` (`input_hash`);--> statement-breakpoint
CREATE TABLE `stat_snapshots` (
	`id` text PRIMARY KEY NOT NULL,
	`creator_id` text NOT NULL,
	`platform` text NOT NULL,
	`followers` integer,
	`following` integer,
	`posts_count` integer,
	`engagement_rate` real,
	`median_views` real,
	`avg_likes` real,
	`avg_comments` real,
	`recent_posts` integer NOT NULL,
	`top_hashtags` text NOT NULL,
	`verified` integer,
	`source` text NOT NULL,
	`source_ref` text,
	`raw_key` text,
	`fetched_at` integer NOT NULL,
	FOREIGN KEY (`creator_id`) REFERENCES `creators`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `snapshots_creator_platform_idx` ON `stat_snapshots` (`creator_id`,`platform`,`fetched_at`);