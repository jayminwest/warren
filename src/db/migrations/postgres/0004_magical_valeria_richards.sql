ALTER TABLE "runs" DROP CONSTRAINT "runs_agent_name_agents_name_fk";--> statement-breakpoint
ALTER TABLE "agents" DROP CONSTRAINT "agents_pkey";--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "id" serial PRIMARY KEY NOT NULL;--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "project_id" text;--> statement-breakpoint
ALTER TABLE "agents" ADD CONSTRAINT "agents_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "agents_project_name_idx" ON "agents" USING btree ("project_id","name");--> statement-breakpoint
CREATE UNIQUE INDEX "agents_global_name_idx" ON "agents" USING btree ("name") WHERE "agents"."project_id" IS NULL;
