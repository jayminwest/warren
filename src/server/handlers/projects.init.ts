/**
 * `POST /projects/:id/init` + `POST /projects/:id/config-migrate`
 * (warren-166d), split from `projects.ts` so both stay clear of the
 * 500-line budget (check:size).
 *
 * These are the server-side `.warren/` write routes: they scaffold
 * `triggers.yaml` + `config.yaml` into — and migrate legacy
 * `defaults.json` inside — the project's **host clone**, so a CLI (or
 * any SDK caller) can do it against a remote warren instead of needing
 * to run on the same machine. Before warren-166d the CLI checked
 * `existsSync(project.localPath)` locally, which only worked when the
 * CLI and the server shared a filesystem; the comment in
 * `src/cli/commands/target-dir.ts` recorded that as decision D3, which
 * warren-166d reverses.
 *
 * The write itself lives once in the domain (`src/projects/`); these
 * handlers are a thin surface (project lookup → clone-on-disk gate →
 * domain call → config-cache invalidate). Cache invalidation runs
 * AFTER the write, mirroring `refreshProject`'s ordering guarantee: an
 * in-flight pre-write load is discarded by the cache's identity check,
 * so no reader observes a stale parse paired with the new files.
 *
 * Policy: `admin`, matching `POST /projects/:id/refresh` — the precedent
 * for an operator-gated mutation on a registered project.
 */

import { existsSync } from "node:fs";
import { ValidationError } from "../../core/errors.ts";
import { migrateWarrenDefaults, scaffoldWarrenConfig } from "../../projects/index.ts";
import { jsonResponse } from "../response.ts";
import type { RouteHandler, ServerDeps } from "../types.ts";
import { optionalString, readJsonBodyOrEmpty, requireParam } from "./index.ts";

/**
 * The scalar defaults fields `POST /projects/:id/init` accepts — the
 * dispatch-time default knobs (`docs/design/warren-config.md`). Validated
 * by `parseConfigFile` inside the domain scaffold, so the boundary only
 * proves the JSON type before handing the raw fields over.
 */
const SCAFFOLD_DEFAULT_FIELDS = [
	"defaultRole",
	"defaultPrompt",
	"defaultProvider",
	"defaultModel",
	"defaultBranch",
	"runBranchPrefix",
] as const;

/**
 * Gate both routes on the clone being where the project row says it is.
 * The server CAN see the host filesystem (unlike the remote CLI), so the
 * old "project clone missing on disk" refusal moves here verbatim.
 */
function requireCloneOnDisk(localPath: string): void {
	if (!existsSync(localPath)) {
		throw new ValidationError(`project clone missing on disk: ${localPath}`, {
			recoveryHint: "POST /projects/:id/refresh or re-add the project",
		});
	}
}

/**
 * `POST /projects/:id/init` — scaffold `.warren/triggers.yaml` +
 * `.warren/config.yaml` into the project's host clone. Body fields are
 * all optional (an empty body scaffolds an empty defaults block);
 * `overwrite: true` skips the refusal-to-clobber checks. Returns
 * `{projectId, scaffolded: {files, defaultRole}}`. 201, 404 (unknown
 * project), or 400 (missing clone / existing files / schema miss).
 */
export function initProjectHandler(deps: ServerDeps): RouteHandler {
	return async (ctx) => {
		const id = requireParam(ctx, "id");
		const body = await readJsonBodyOrEmpty(ctx);

		const candidate: Record<string, unknown> = {};
		for (const field of SCAFFOLD_DEFAULT_FIELDS) {
			const value = optionalString(body ?? {}, field);
			if (value !== undefined) candidate[field] = value;
		}
		const overwriteRaw = body?.overwrite;
		if (overwriteRaw !== undefined && typeof overwriteRaw !== "boolean") {
			throw new ValidationError("field 'overwrite' must be a boolean");
		}

		const project = await deps.repos.projects.require(id);
		requireCloneOnDisk(project.localPath);
		const result = await scaffoldWarrenConfig({
			targetDir: project.localPath,
			defaults: candidate,
			...(overwriteRaw === true ? { overwrite: true } : {}),
		});
		deps.warrenConfigs?.invalidate(project.id);
		return jsonResponse(201, {
			projectId: project.id,
			scaffolded: {
				files: result.files,
				defaultRole: result.defaults.defaultRole ?? null,
			},
		});
	};
}

/**
 * `POST /projects/:id/config-migrate` — convert the host clone's legacy
 * `.warren/defaults.json` into `.warren/config.yaml` (+ `preview.yaml`
 * when a preview block exists) and delete the source. Same semantics as
 * `warren config migrate`, executed where the clone actually lives.
 * Returns `{projectId, migrated: {written, previewHoisted}}`. 200, 404
 * (unknown project), or 400 (missing clone / nothing to migrate /
 * existing config.yaml / schema miss).
 */
export function configMigrateProjectHandler(deps: ServerDeps): RouteHandler {
	return async (ctx) => {
		const id = requireParam(ctx, "id");
		const project = await deps.repos.projects.require(id);
		requireCloneOnDisk(project.localPath);
		const result = await migrateWarrenDefaults({ targetDir: project.localPath });
		deps.warrenConfigs?.invalidate(project.id);
		return jsonResponse(200, {
			projectId: project.id,
			migrated: {
				written: result.written,
				previewHoisted: result.previewHoisted,
			},
		});
	};
}
