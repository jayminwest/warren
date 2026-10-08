/**
 * Per-project migration maintenance config (warren-4371):
 * `migrations: { regenerateCommand }` in `.warren/config.yaml`.
 *
 * When the dispatch-time journal preflight detects a drizzle migration
 * slot collision (src/runs/spawn/migration-preflight.ts), warren surfaces
 * it to the run's agent as a prompt note. `regenerateCommand` is the
 * command that note tells the agent to run INSIDE its sandbox. It is
 * guidance text only: the control plane never executes it. Absent →
 * the note asks for "this project's migration generator" generically, so
 * no convention is imposed on repositories warren does not know.
 */

import { z } from "zod";

export const MigrationsConfigSchema = z
	.object({
		regenerateCommand: z
			.string()
			.trim()
			.min(1, "migrations.regenerateCommand must be non-empty if provided")
			.max(512, "migrations.regenerateCommand must be at most 512 characters")
			.optional(),
	})
	.strict();

export type MigrationsConfig = z.infer<typeof MigrationsConfigSchema>;
