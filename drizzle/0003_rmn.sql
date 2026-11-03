CREATE TABLE `rmn_campaigns` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`window_days` integer NOT NULL,
	`landing_kind` text NOT NULL,
	`landing_id` text NOT NULL,
	`created_by` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `rmn_clicks` (
	`id` text PRIMARY KEY NOT NULL,
	`link_id` text NOT NULL,
	`campaign_id` text NOT NULL,
	`creator_id` text NOT NULL,
	`result` text NOT NULL,
	`ua_class` text NOT NULL,
	`bot_reason` text,
	`referrer_host` text,
	`clicked_at` integer NOT NULL,
	FOREIGN KEY (`link_id`) REFERENCES `rmn_links`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`campaign_id`) REFERENCES `rmn_campaigns`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`creator_id`) REFERENCES `creators`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `rmn_clicks_campaign_idx` ON `rmn_clicks` (`campaign_id`,`clicked_at`);--> statement-breakpoint
CREATE INDEX `rmn_clicks_link_idx` ON `rmn_clicks` (`link_id`);--> statement-breakpoint
CREATE TABLE `rmn_links` (
	`id` text PRIMARY KEY NOT NULL,
	`campaign_id` text NOT NULL,
	`creator_id` text NOT NULL,
	`variant` text,
	`slug` text NOT NULL,
	`disabled` integer NOT NULL,
	`status_changed_by` text,
	`status_changed_at` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`campaign_id`) REFERENCES `rmn_campaigns`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`creator_id`) REFERENCES `creators`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `rmn_links_slug_uq` ON `rmn_links` (`slug`);--> statement-breakpoint
CREATE INDEX `rmn_links_campaign_idx` ON `rmn_links` (`campaign_id`);--> statement-breakpoint
CREATE TABLE `rmn_order_touchpoints` (
	`id` text PRIMARY KEY NOT NULL,
	`order_id` text NOT NULL,
	`click_id` text NOT NULL,
	FOREIGN KEY (`order_id`) REFERENCES `rmn_simulated_orders`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `rmn_touch_uq` ON `rmn_order_touchpoints` (`order_id`,`click_id`);--> statement-breakpoint
CREATE INDEX `rmn_touch_click_idx` ON `rmn_order_touchpoints` (`click_id`);--> statement-breakpoint
CREATE TABLE `rmn_simulated_orders` (
	`id` text PRIMARY KEY NOT NULL,
	`items` text NOT NULL,
	`revenue_thb` integer NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `rmn_simulated_orders_created_idx` ON `rmn_simulated_orders` (`created_at`);--> statement-breakpoint
CREATE TABLE `rmn_store_events` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`product_id` text NOT NULL,
	`click_ids` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `rmn_store_events_created_idx` ON `rmn_store_events` (`created_at`);