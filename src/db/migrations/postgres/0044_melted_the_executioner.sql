ALTER TABLE "events" RENAME COLUMN "burrow_event_seq" TO "sandbox_event_seq";--> statement-breakpoint
ALTER TABLE "runs" RENAME COLUMN "burrow_id" TO "sandbox_id";--> statement-breakpoint
ALTER TABLE "runs" RENAME COLUMN "burrow_run_id" TO "sandbox_run_id";--> statement-breakpoint
DROP INDEX "events_run_seq_idx";--> statement-breakpoint
CREATE INDEX "events_run_seq_idx" ON "events" USING btree ("run_id","sandbox_event_seq");