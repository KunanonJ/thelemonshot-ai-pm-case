ALTER TABLE `enrichment_jobs` ADD `failure_scope` text;--> statement-breakpoint
-- Hand-added before each unique index, so existing duplicates can't make it fail. An older duplicate digest for a
-- refresh keeps its data and lets go of the refresh id.
UPDATE `campaign_digests` SET `refresh_id` = NULL
WHERE `refresh_id` IS NOT NULL AND EXISTS (
  SELECT 1 FROM `campaign_digests` AS newer
  WHERE newer.`refresh_id` = `campaign_digests`.`refresh_id`
    AND (newer.`created_at` > `campaign_digests`.`created_at` OR (newer.`created_at` = `campaign_digests`.`created_at` AND newer.`run_id` > `campaign_digests`.`run_id`))
);--> statement-breakpoint
CREATE UNIQUE INDEX `campaign_digests_refresh_uq` ON `campaign_digests` (`refresh_id`);--> statement-breakpoint
-- Only the newest running refresh per campaign stays running; older ones close as done
UPDATE `campaign_refreshes` SET `status` = 'done', `finished_at` = COALESCE(`finished_at`, `started_at`)
WHERE `status` = 'running' AND EXISTS (
  SELECT 1 FROM `campaign_refreshes` AS newer
  WHERE newer.`campaign_id` = `campaign_refreshes`.`campaign_id` AND newer.`status` = 'running'
    AND (newer.`started_at` > `campaign_refreshes`.`started_at` OR (newer.`started_at` = `campaign_refreshes`.`started_at` AND newer.`id` > `campaign_refreshes`.`id`))
);--> statement-breakpoint
CREATE UNIQUE INDEX `campaign_refreshes_running_uq` ON `campaign_refreshes` (`campaign_id`) WHERE status = 'running';
