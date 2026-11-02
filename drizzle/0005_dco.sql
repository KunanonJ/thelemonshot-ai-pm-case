CREATE TABLE `dco_assets` (
	`id` text PRIMARY KEY NOT NULL,
	`run_id` text NOT NULL,
	`r2_key` text NOT NULL,
	`file_name` text NOT NULL,
	`content_type` text NOT NULL,
	`bytes` integer NOT NULL,
	`sha256` text NOT NULL,
	`uploaded_by` text NOT NULL,
	`uploaded_at` integer NOT NULL,
	`rights_attested_by` text NOT NULL,
	`rights_attested_at` integer NOT NULL,
	FOREIGN KEY (`run_id`) REFERENCES `runs`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `dco_assets_run_uq` ON `dco_assets` (`run_id`);--> statement-breakpoint
CREATE TABLE `dco_copy` (
	`id` text PRIMARY KEY NOT NULL,
	`run_id` text NOT NULL,
	`segment_key` text NOT NULL,
	`position` integer NOT NULL,
	`headline` text NOT NULL,
	`hook_line` text NOT NULL,
	`caption` text NOT NULL,
	`cta` text NOT NULL,
	`flags` text NOT NULL,
	`model` text NOT NULL,
	`prompt_version` text NOT NULL,
	`review_status` text NOT NULL,
	`reviewed_by` text,
	`reviewed_at` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`run_id`) REFERENCES `runs`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `dco_copy_run_idx` ON `dco_copy` (`run_id`,`segment_key`);--> statement-breakpoint
CREATE TABLE `dco_events` (
	`id` text PRIMARY KEY NOT NULL,
	`run_id` text NOT NULL,
	`kind` text NOT NULL,
	`payload` text NOT NULL,
	`actor` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`run_id`) REFERENCES `runs`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `dco_events_run_idx` ON `dco_events` (`run_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `dco_segments` (
	`id` text PRIMARY KEY NOT NULL,
	`run_id` text NOT NULL,
	`segment_key` text NOT NULL,
	`position` integer NOT NULL,
	`name` text NOT NULL,
	`note` text,
	`status` text NOT NULL,
	`error` text,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`run_id`) REFERENCES `runs`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `dco_segments_run_key_uq` ON `dco_segments` (`run_id`,`segment_key`);--> statement-breakpoint
CREATE TABLE `dco_visuals` (
	`id` text PRIMARY KEY NOT NULL,
	`run_id` text NOT NULL,
	`plan_key` text NOT NULL,
	`position` integer NOT NULL,
	`kind` text NOT NULL,
	`label` text NOT NULL,
	`segment_key` text NOT NULL,
	`format` text NOT NULL,
	`model_id` text NOT NULL,
	`status` text NOT NULL,
	`attempts` integer NOT NULL,
	`error` text,
	`fal_request_id` text,
	`status_url` text,
	`response_url` text,
	`submitted_at` integer,
	`r2_key` text,
	`content_type` text,
	`bytes` integer,
	`provenance` text,
	`review_status` text NOT NULL,
	`reviewed_by` text,
	`reviewed_at` integer,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`run_id`) REFERENCES `runs`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `dco_visuals_run_plan_uq` ON `dco_visuals` (`run_id`,`plan_key`);