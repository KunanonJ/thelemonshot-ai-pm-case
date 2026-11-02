CREATE TABLE `campaign_actions` (
	`id` text PRIMARY KEY NOT NULL,
	`campaign_id` text NOT NULL,
	`digest_run_id` text,
	`recommendation` integer,
	`note` text NOT NULL,
	`actor` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`campaign_id`) REFERENCES `campaigns`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `campaign_actions_campaign_idx` ON `campaign_actions` (`campaign_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `campaign_digests` (
	`run_id` text PRIMARY KEY NOT NULL,
	`campaign_id` text NOT NULL,
	`refresh_id` text,
	`deltas` text NOT NULL,
	`narrative` text,
	`freshness` text NOT NULL,
	`flags` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`run_id`) REFERENCES `runs`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`campaign_id`) REFERENCES `campaigns`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `campaign_digests_campaign_idx` ON `campaign_digests` (`campaign_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `campaign_posts` (
	`id` text PRIMARY KEY NOT NULL,
	`campaign_id` text NOT NULL,
	`creator_id` text NOT NULL,
	`content_id` text NOT NULL,
	`platform` text NOT NULL,
	`url` text NOT NULL,
	`baseline_views` integer,
	`baseline_engagement_rate` real,
	`misses` integer NOT NULL,
	`unavailable_at` integer,
	`unavailable_reason` text,
	`added_at` integer NOT NULL,
	FOREIGN KEY (`campaign_id`) REFERENCES `campaigns`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`creator_id`) REFERENCES `creators`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`content_id`) REFERENCES `content_items`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `campaign_posts_uq` ON `campaign_posts` (`campaign_id`,`content_id`);--> statement-breakpoint
CREATE INDEX `campaign_posts_campaign_idx` ON `campaign_posts` (`campaign_id`);--> statement-breakpoint
CREATE TABLE `campaign_refreshes` (
	`id` text PRIMARY KEY NOT NULL,
	`campaign_id` text NOT NULL,
	`trigger` text NOT NULL,
	`platforms` text NOT NULL,
	`done` text NOT NULL,
	`failed` text NOT NULL,
	`status` text NOT NULL,
	`digest_run_id` text,
	`requested_by` text NOT NULL,
	`started_at` integer NOT NULL,
	`finished_at` integer,
	FOREIGN KEY (`campaign_id`) REFERENCES `campaigns`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `campaign_refreshes_campaign_idx` ON `campaign_refreshes` (`campaign_id`,`started_at`);--> statement-breakpoint
CREATE TABLE `campaigns` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`brand` text NOT NULL,
	`matrix_run_id` text,
	`starts_at` integer NOT NULL,
	`ends_at` integer NOT NULL,
	`status` text NOT NULL,
	`last_refresh_at` integer,
	`outcome` text,
	`closed_by` text,
	`closed_at` integer,
	`created_by` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `campaigns_status_idx` ON `campaigns` (`status`);