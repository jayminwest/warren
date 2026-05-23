ALTER TABLE "runs" ADD COLUMN "mode" text DEFAULT 'batch' NOT NULL;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "paused_at" text;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "paused_question_event_id" text;--> statement-breakpoint
CREATE INDEX "runs_mode_idx" ON "runs" USING btree ("mode");