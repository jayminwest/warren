ALTER TABLE `runs` ADD `mode` text DEFAULT 'batch' NOT NULL;--> statement-breakpoint
ALTER TABLE `runs` ADD `paused_at` text;--> statement-breakpoint
ALTER TABLE `runs` ADD `paused_question_event_id` text;--> statement-breakpoint
CREATE INDEX `runs_mode_idx` ON `runs` (`mode`);