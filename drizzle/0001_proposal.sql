CREATE TABLE `proposal_sections` (
	`id` text PRIMARY KEY NOT NULL,
	`run_id` text NOT NULL,
	`section_key` text NOT NULL,
	`position` integer NOT NULL,
	`status` text NOT NULL,
	`current_version_id` text,
	`error` text,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`run_id`) REFERENCES `runs`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `proposal_sections_run_key_uq` ON `proposal_sections` (`run_id`,`section_key`);--> statement-breakpoint
CREATE TABLE `proposal_versions` (
	`id` text PRIMARY KEY NOT NULL,
	`run_id` text NOT NULL,
	`section_key` text NOT NULL,
	`version` integer NOT NULL,
	`origin` text NOT NULL,
	`content` text NOT NULL,
	`citations` text NOT NULL,
	`flags` text NOT NULL,
	`note` text,
	`prompt_version` text,
	`created_by` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`run_id`) REFERENCES `runs`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `proposal_versions_uq` ON `proposal_versions` (`run_id`,`section_key`,`version`);