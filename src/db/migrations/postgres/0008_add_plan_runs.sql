CREATE TABLE "plan_run_children" (
	"plan_run_id" text NOT NULL,
	"seq" integer NOT NULL,
	"seed_id" text NOT NULL,
	"run_id" text,
	"state" text NOT NULL,
	"created_at" text NOT NULL,
	"updated_at" text NOT NULL,
	"started_at" text,
	"ended_at" text,
	"pr_merged_at" text,
	"failure_reason" text,
	CONSTRAINT "plan_run_children_plan_run_id_seq_pk" PRIMARY KEY("plan_run_id","seq")
);
--> statement-breakpoint
CREATE TABLE "plan_runs" (
	"id" text PRIMARY KEY NOT NULL,
	"plan_id" text NOT NULL,
	"project_id" text NOT NULL,
	"agent_name" text NOT NULL,
	"prompt_template" text DEFAULT 'work on sd {seed_id}' NOT NULL,
	"ref" text,
	"provider_override" text,
	"model_override" text,
	"dispatcher_handle" text DEFAULT 'operator' NOT NULL,
	"trigger" text DEFAULT 'manual' NOT NULL,
	"state" text NOT NULL,
	"failure_reason" text,
	"created_at" text NOT NULL,
	"started_at" text,
	"ended_at" text
);
--> statement-breakpoint
ALTER TABLE "plan_run_children" ADD CONSTRAINT "plan_run_children_plan_run_id_plan_runs_id_fk" FOREIGN KEY ("plan_run_id") REFERENCES "plan_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plan_run_children" ADD CONSTRAINT "plan_run_children_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plan_runs" ADD CONSTRAINT "plan_runs_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "plan_run_children_run_idx" ON "plan_run_children" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "plan_run_children_state_idx" ON "plan_run_children" USING btree ("plan_run_id","state");--> statement-breakpoint
CREATE INDEX "plan_runs_project_state_idx" ON "plan_runs" USING btree ("project_id","state");--> statement-breakpoint
CREATE INDEX "plan_runs_state_idx" ON "plan_runs" USING btree ("state");--> statement-breakpoint
ALTER TABLE "plan_runs" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "plan_run_children" ENABLE ROW LEVEL SECURITY;