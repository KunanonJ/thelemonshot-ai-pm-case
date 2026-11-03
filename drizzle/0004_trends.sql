CREATE TABLE `trend_attachments` (
	`proposal_run_id` text NOT NULL,
	`trend_run_id` text NOT NULL,
	`attached_by` text NOT NULL,
	`attached_at` integer NOT NULL,
	PRIMARY KEY(`proposal_run_id`, `trend_run_id`),
	FOREIGN KEY (`proposal_run_id`) REFERENCES `runs`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`trend_run_id`) REFERENCES `runs`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `trend_briefs` (
	`run_id` text PRIMARY KEY NOT NULL,
	`pull_id` text NOT NULL,
	`sample` text NOT NULL,
	`themes` text NOT NULL,
	`exemplars` text NOT NULL,
	`sources` text NOT NULL,
	`flags` text NOT NULL,
	`prompt_version` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`run_id`) REFERENCES `runs`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`pull_id`) REFERENCES `trend_pulls`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `trend_posts` (
	`id` text PRIMARY KEY NOT NULL,
	`platform` text NOT NULL,
	`platform_post_id` text NOT NULL,
	`url` text NOT NULL,
	`handle` text,
	`caption` text,
	`hashtags` text NOT NULL,
	`posted_at` integer,
	`likes` integer,
	`comments` integer,
	`views` integer,
	`shares` integer,
	`first_seen_at` integer NOT NULL,
	`last_seen_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `trend_posts_platform_uq` ON `trend_posts` (`platform`,`platform_post_id`);--> statement-breakpoint
CREATE TABLE `trend_pull_hits` (
	`pull_term_id` text NOT NULL,
	`pull_id` text NOT NULL,
	`post_id` text NOT NULL,
	`likes` integer,
	`comments` integer,
	`views` integer,
	`shares` integer,
	PRIMARY KEY(`pull_term_id`, `post_id`),
	FOREIGN KEY (`pull_term_id`) REFERENCES `trend_pull_terms`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`pull_id`) REFERENCES `trend_pulls`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`post_id`) REFERENCES `trend_posts`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `trend_hits_pull_idx` ON `trend_pull_hits` (`pull_id`);--> statement-breakpoint
CREATE TABLE `trend_pull_terms` (
	`id` text PRIMARY KEY NOT NULL,
	`pull_id` text NOT NULL,
	`watchlist_id` text NOT NULL,
	`label` text NOT NULL,
	`term` text NOT NULL,
	`kind` text NOT NULL,
	`category` text NOT NULL,
	`platform` text NOT NULL,
	`post_cap` integer NOT NULL,
	`status` text NOT NULL,
	`local_run_id` text,
	`apify_run_id` text,
	`item_count` integer,
	`post_count` integer,
	`usage_usd` real,
	`note` text,
	`error` text,
	`created_at` integer NOT NULL,
	`finished_at` integer,
	FOREIGN KEY (`pull_id`) REFERENCES `trend_pulls`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `trend_pull_terms_pull_idx` ON `trend_pull_terms` (`pull_id`);--> statement-breakpoint
CREATE TABLE `trend_pulls` (
	`id` text PRIMARY KEY NOT NULL,
	`run_id` text NOT NULL,
	`status` text NOT NULL,
	`term_ids` text NOT NULL,
	`requested_by` text NOT NULL,
	`started_at` integer NOT NULL,
	`finished_at` integer,
	FOREIGN KEY (`run_id`) REFERENCES `runs`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `trend_pulls_run_uq` ON `trend_pulls` (`run_id`);--> statement-breakpoint
CREATE TABLE `trend_watchlist` (
	`id` text PRIMARY KEY NOT NULL,
	`term` text NOT NULL,
	`term_key` text NOT NULL,
	`kind` text NOT NULL,
	`platforms` text NOT NULL,
	`category` text NOT NULL,
	`post_cap` integer NOT NULL,
	`active` integer NOT NULL,
	`created_by` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `trend_watchlist_uq` ON `trend_watchlist` (`kind`,`term_key`,`category`);