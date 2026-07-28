ALTER TABLE "agents" DROP CONSTRAINT "agents_project_id_projects_id_fk";
--> statement-breakpoint
DROP INDEX "agents_project_name_idx";--> statement-breakpoint
DROP INDEX "agents_global_name_idx";--> statement-breakpoint
CREATE UNIQUE INDEX "agents_name_idx" ON "agents" USING btree ("name");--> statement-breakpoint
ALTER TABLE "agents" DROP COLUMN "project_id";