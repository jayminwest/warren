PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_events` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`run_id` text NOT NULL,
	`burrow_event_seq` integer NOT NULL,
	`ts` text NOT NULL,
	`kind` text NOT NULL,
	`stream` text,
	`payload_json` text NOT NULL,
	FOREIGN KEY (`run_id`) REFERENCES `runs`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
INSERT INTO `__new_events`("id", "run_id", "burrow_event_seq", "ts", "kind", "stream", "payload_json") SELECT "id", "run_id", "burrow_event_seq", "ts", "kind", "stream", "payload_json" FROM `events`;--> statement-breakpoint
DROP TABLE `events`;--> statement-breakpoint
ALTER TABLE `__new_events` RENAME TO `events`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `events_run_seq_idx` ON `events` (`run_id`,`burrow_event_seq`);--> statement-breakpoint
CREATE INDEX `events_run_ts_idx` ON `events` (`run_id`,`ts`);--> statement-breakpoint
CREATE TABLE `__new_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`agent_name` text NOT NULL,
	`project_id` text,
	`burrow_id` text,
	`burrow_run_id` text,
	`worker_id` text,
	`seed_id` text,
	`rendered_agent_json` text NOT NULL,
	`state` text NOT NULL,
	`failure_reason` text,
	`started_at` text,
	`ended_at` text,
	`prompt` text NOT NULL,
	`trigger` text NOT NULL,
	`pr_url` text,
	`target_branch` text,
	`cost_usd` real,
	`tokens_input` integer,
	`tokens_output` integer,
	`tokens_cache_read` integer,
	`tokens_cache_write` integer,
	`preview_state` text,
	`preview_port` integer,
	`preview_started_at` text,
	`preview_last_hit_at` text,
	`preview_failure_message` text,
	`mode` text DEFAULT 'batch' NOT NULL,
	`paused_at` text,
	`paused_question_event_id` text,
	`parent_run_id` text,
	`clone_kind` text,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
INSERT INTO `__new_runs`("id", "agent_name", "project_id", "burrow_id", "burrow_run_id", "worker_id", "seed_id", "rendered_agent_json", "state", "failure_reason", "started_at", "ended_at", "prompt", "trigger", "pr_url", "target_branch", "cost_usd", "tokens_input", "tokens_output", "tokens_cache_read", "tokens_cache_write", "preview_state", "preview_port", "preview_started_at", "preview_last_hit_at", "preview_failure_message", "mode", "paused_at", "paused_question_event_id", "parent_run_id", "clone_kind") SELECT "id", "agent_name", "project_id", "burrow_id", "burrow_run_id", "worker_id", "seed_id", "rendered_agent_json", "state", "failure_reason", "started_at", "ended_at", "prompt", "trigger", "pr_url", "target_branch", "cost_usd", "tokens_input", "tokens_output", "tokens_cache_read", "tokens_cache_write", "preview_state", "preview_port", "preview_started_at", "preview_last_hit_at", "preview_failure_message", "mode", "paused_at", "paused_question_event_id", "parent_run_id", "clone_kind" FROM `runs`;--> statement-breakpoint
DROP TABLE `runs`;--> statement-breakpoint
ALTER TABLE `__new_runs` RENAME TO `runs`;--> statement-breakpoint
CREATE INDEX `runs_state_idx` ON `runs` (`state`);--> statement-breakpoint
CREATE INDEX `runs_project_started_idx` ON `runs` (`project_id`,"started_at" DESC);--> statement-breakpoint
CREATE INDEX `runs_agent_started_idx` ON `runs` (`agent_name`,"started_at" DESC);--> statement-breakpoint
CREATE INDEX `runs_worker_state_idx` ON `runs` (`worker_id`,`state`);--> statement-breakpoint
CREATE INDEX `runs_mode_idx` ON `runs` (`mode`);--> statement-breakpoint
CREATE INDEX `runs_pr_url_idx` ON `runs` (`pr_url`);