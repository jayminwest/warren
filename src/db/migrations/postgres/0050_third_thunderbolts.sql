ALTER TABLE "runs" ADD COLUMN "workspace_ready_at" text;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "agent_ready_at" text;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "agent_ended_at" text;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "reaped_at" text;