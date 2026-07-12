CREATE TABLE `run_inbox` (
	`id` text PRIMARY KEY NOT NULL,
	`run_id` text NOT NULL,
	`seq` integer NOT NULL,
	`body` text NOT NULL,
	`priority` text DEFAULT 'normal' NOT NULL,
	`from_actor` text DEFAULT 'operator' NOT NULL,
	`state` text DEFAULT 'unread' NOT NULL,
	`created_at` text NOT NULL,
	`delivered_at` text,
	FOREIGN KEY (`run_id`) REFERENCES `runs`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `run_inbox_run_state_idx` ON `run_inbox` (`run_id`,`state`);