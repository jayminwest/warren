ALTER TABLE "conversations" ADD COLUMN "submitted_pr_url" text;--> statement-breakpoint
ALTER TABLE "conversations" ADD COLUMN "submitted_pr_number" integer;--> statement-breakpoint
ALTER TABLE "conversations" ADD COLUMN "planner_agent" text;