ALTER TABLE "plots" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP TABLE "plots" CASCADE;--> statement-breakpoint
DROP INDEX "plan_runs_plot_id_idx";--> statement-breakpoint
DROP INDEX "runs_plot_id_idx";--> statement-breakpoint
ALTER TABLE "plan_runs" DROP COLUMN "plot_id";--> statement-breakpoint
ALTER TABLE "projects" DROP COLUMN "has_plot";--> statement-breakpoint
ALTER TABLE "runs" DROP COLUMN "plot_id";