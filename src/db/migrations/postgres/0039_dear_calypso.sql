CREATE TABLE "tool_calls" (
	"id" serial PRIMARY KEY NOT NULL,
	"run_id" text NOT NULL,
	"seq" integer NOT NULL,
	"ts" text NOT NULL,
	"tool_name" text,
	"command" text,
	"file_paths" jsonb,
	"tool_use_id" text,
	"is_error" boolean DEFAULT false NOT NULL,
	"result_bytes" integer,
	"origin" text
);
--> statement-breakpoint
ALTER TABLE "tool_calls" ADD CONSTRAINT "tool_calls_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "tool_calls_run_seq_idx" ON "tool_calls" USING btree ("run_id","seq");--> statement-breakpoint
CREATE INDEX "tool_calls_run_use_id_idx" ON "tool_calls" USING btree ("run_id","tool_use_id");--> statement-breakpoint
ALTER TABLE "tool_calls" ENABLE ROW LEVEL SECURITY;
