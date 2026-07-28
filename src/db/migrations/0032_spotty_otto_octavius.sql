PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_agents` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`rendered_json` text NOT NULL,
	`registered_at` text NOT NULL,
	`last_refreshed` text NOT NULL
);
--> statement-breakpoint
INSERT INTO `__new_agents`("id", "name", "rendered_json", "registered_at", "last_refreshed") SELECT "id", "name", "rendered_json", "registered_at", "last_refreshed" FROM `agents`;--> statement-breakpoint
DROP TABLE `agents`;--> statement-breakpoint
ALTER TABLE `__new_agents` RENAME TO `agents`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE UNIQUE INDEX `agents_name_idx` ON `agents` (`name`);