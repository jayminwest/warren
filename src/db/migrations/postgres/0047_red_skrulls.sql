ALTER TABLE "plan_runs" ALTER COLUMN "plan_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "plan_runs" ADD COLUMN "source" text DEFAULT 'plan' NOT NULL;