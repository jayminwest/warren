PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_plan_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`plan_id` text,
	`source` text DEFAULT 'plan' NOT NULL,
	`project_id` text NOT NULL,
	`agent_name` text NOT NULL,
	`prompt_template` text DEFAULT 'work on sd {seed_id}' NOT NULL,
	`ref` text,
	`provider_override` text,
	`model_override` text,
	`max_cost_usd` real,
	`dispatcher_handle` text DEFAULT 'operator' NOT NULL,
	`trigger` text DEFAULT 'manual' NOT NULL,
	`parent_run_id` text,
	`state` text NOT NULL,
	`failure_reason` text,
	`created_at` text NOT NULL,
	`started_at` text,
	`ended_at` text,
	`resumed_at` text,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
INSERT INTO `__new_plan_runs`("id", "plan_id", "source", "project_id", "agent_name", "prompt_template", "ref", "provider_override", "model_override", "max_cost_usd", "dispatcher_handle", "trigger", "parent_run_id", "state", "failure_reason", "created_at", "started_at", "ended_at", "resumed_at") SELECT "id", "plan_id", 'plan' AS "source", "project_id", "agent_name", "prompt_template", "ref", "provider_override", "model_override", "max_cost_usd", "dispatcher_handle", "trigger", "parent_run_id", "state", "failure_reason", "created_at", "started_at", "ended_at", "resumed_at" FROM `plan_runs`;--> statement-breakpoint
DROP TABLE `plan_runs`;--> statement-breakpoint
ALTER TABLE `__new_plan_runs` RENAME TO `plan_runs`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `plan_runs_project_state_idx` ON `plan_runs` (`project_id`,`state`);--> statement-breakpoint
CREATE INDEX `plan_runs_state_idx` ON `plan_runs` (`state`);