CREATE TABLE "plots" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"status" text NOT NULL,
	"title" text,
	"updated_at" text NOT NULL,
	"state_json" jsonb NOT NULL
);
--> statement-breakpoint
ALTER TABLE "plots" ADD CONSTRAINT "plots_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "plots_project_updated_idx" ON "plots" USING btree ("project_id","updated_at");--> statement-breakpoint
CREATE INDEX "plots_status_idx" ON "plots" USING btree ("status");--> statement-breakpoint
ALTER TABLE "plots" ENABLE ROW LEVEL SECURITY;