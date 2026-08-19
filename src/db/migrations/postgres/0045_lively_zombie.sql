CREATE TABLE "dispatch_context" (
	"run_id" text PRIMARY KEY NOT NULL,
	"created_at" text NOT NULL,
	"agent_name" text,
	"provider" text,
	"model" text,
	"provider_source" text,
	"model_source" text,
	"cap_source" text,
	"max_cost_usd" double precision,
	"runtime_id" text,
	"runtime_backend" text,
	"prompt_bytes" integer,
	"mode" text,
	"network" text,
	"queue_queued_runs" integer,
	"queue_running_runs" integer,
	"queue_project_non_terminal" integer,
	"queue_snapshot_source" text,
	"trigger" text,
	"dispatch_origin" text,
	"dispatcher_handle" text,
	"trigger_id" text,
	"plan_run_id" text,
	"retry_kind" text,
	"retry_of_run_id" text,
	"parent_run_id" text,
	"attempt_no" integer,
	"root_run_id" text,
	"seed_id" text,
	"seed_status" text,
	"seed_priority" integer,
	"seed_size" text
);
--> statement-breakpoint
ALTER TABLE "dispatch_context" ADD CONSTRAINT "dispatch_context_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "dispatch_context_created_at_idx" ON "dispatch_context" USING btree ("created_at");--> statement-breakpoint
ALTER TABLE "dispatch_context" ENABLE ROW LEVEL SECURITY;