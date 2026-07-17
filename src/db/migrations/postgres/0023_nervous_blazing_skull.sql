CREATE TABLE "run_inbox" (
	"id" text PRIMARY KEY NOT NULL,
	"run_id" text NOT NULL,
	"seq" integer NOT NULL,
	"body" text NOT NULL,
	"priority" text DEFAULT 'normal' NOT NULL,
	"from_actor" text DEFAULT 'operator' NOT NULL,
	"state" text DEFAULT 'unread' NOT NULL,
	"created_at" text NOT NULL,
	"delivered_at" text
);
--> statement-breakpoint
ALTER TABLE "run_inbox" ADD CONSTRAINT "run_inbox_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "run_inbox_run_state_idx" ON "run_inbox" USING btree ("run_id","state");