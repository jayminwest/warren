CREATE TABLE `tool_calls` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`run_id` text NOT NULL,
	`seq` integer NOT NULL,
	`ts` text NOT NULL,
	`tool_name` text,
	`command` text,
	`file_paths` text,
	`tool_use_id` text,
	`is_error` integer DEFAULT false NOT NULL,
	`result_bytes` integer,
	`origin` text,
	FOREIGN KEY (`run_id`) REFERENCES `runs`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `tool_calls_run_seq_idx` ON `tool_calls` (`run_id`,`seq`);--> statement-breakpoint
CREATE INDEX `tool_calls_run_use_id_idx` ON `tool_calls` (`run_id`,`tool_use_id`);