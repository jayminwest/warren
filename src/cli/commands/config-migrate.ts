/**
 * `warren config migrate` — convert a project's legacy `.warren/defaults.json`
 * into the warren-5840 YAML layout in place.
 *
 * Mechanics (owned by the domain, `src/projects/warren-config-migrate.ts`,
 * shared with `POST /projects/:id/config-migrate` since warren-166d):
 *   1. Read and schema-validate the legacy `defaults.json`.
 *   2. Pull any `preview` block out into a top-level `.warren/preview.yaml`.
 *   3. Write the remaining fields to `.warren/config.yaml`.
 *   4. Delete `.warren/defaults.json` (the deprecation source) so doctor /
 *      readyz / load no longer emit the deprecation warning on the next
 *      refresh.
 *
 * Refuses to clobber an existing `config.yaml` or `preview.yaml` — the
 * operator either already migrated (in which case `defaults.json` is stale
 * and should be deleted by hand) or has uncommitted edits we'd silently
 * lose. Schema failures in the source file abort the migrate with the
 * underlying error: a malformed `defaults.json` is fixed by editing, not
 * by converting.
 *
 * Targets the same `--cwd` / `--project <id>` pair that `warren init`
 * uses. `--cwd` is a pure local file edit. `--project` dispatches
 * through `POST /projects/:id/config-migrate` (warren-166d) so the
 * migration runs where the clone actually lives — the operator's CLI
 * works against a remote warren instead of needing to share the
 * server's filesystem. Either way the operator owns the commit + push.
 */

import type { WarrenClient } from "../../client/index.ts";
import { migrateWarrenDefaults } from "../../projects/index.ts";
import { warrenConfigRelativePath } from "../../warren-config/config.ts";
import type { CliContext } from "../output.ts";
import { commandFailure, writeResult } from "../output.ts";
import { resolveTargetDir } from "./target-dir.ts";

export type ConfigMigrateArgs =
	| { readonly mode: "cwd"; readonly cwd: string }
	| { readonly mode: "project"; readonly projectId: string };

export interface ConfigMigrateDeps {
	/**
	 * Remote warren client (warren-97a2). `--project` dispatches through
	 * `POST /projects/:id/config-migrate` (warren-166d); `--cwd` mode
	 * never touches it. The CLI no longer opens the server's DB.
	 */
	readonly client: WarrenClient;
}

export interface ConfigMigrateResult {
	readonly exitCode: number;
}

export async function runConfigMigrate(
	context: CliContext,
	deps: ConfigMigrateDeps,
	args: ConfigMigrateArgs,
): Promise<ConfigMigrateResult> {
	try {
		if (args.mode === "project") {
			const res = await deps.client.migrateProjectConfig(args.projectId);
			writeResult(
				context,
				{
					ok: true,
					migrated: {
						project: args.projectId,
						removed: warrenConfigRelativePath("defaults"),
						written: res.migrated.written,
						previewHoisted: res.migrated.previewHoisted,
					},
				},
				`✔ migrated .warren/defaults.json in project ${args.projectId} — wrote ${res.migrated.written.join(", ")}`,
			);
			return { exitCode: 0 };
		}

		const targetDir = resolveTargetDir({ cwd: args.cwd });
		const result = await migrateWarrenDefaults({ targetDir });

		writeResult(
			context,
			{
				ok: true,
				migrated: {
					root: targetDir,
					removed: warrenConfigRelativePath("defaults"),
					written: result.written,
					previewHoisted: result.previewHoisted,
				},
			},
			`✔ migrated .warren/defaults.json in ${targetDir} — wrote ${result.written.join(", ")}`,
		);
		return { exitCode: 0 };
	} catch (err) {
		return commandFailure(context, err);
	}
}
