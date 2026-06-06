CREATE TABLE `plots` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`status` text NOT NULL,
	`title` text,
	`updated_at` text NOT NULL,
	`state_json` text NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `plots_project_updated_idx` ON `plots` (`project_id`,`updated_at`);--> statement-breakpoint
CREATE INDEX `plots_status_idx` ON `plots` (`status`);