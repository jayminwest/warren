/**
 * Warren-config + database readiness checks for `warren doctor` and
 * `GET /readyz`. Split out of `checks.ts` (warren-5bf4) so the barrel
 * stays under the 500-line global limit; re-exported verbatim from
 * `./checks.ts`, so every importer keeps resolving unchanged.
 *
 * Covers: per-project `.warren/` parsing (fatal + deprecation), the
 * resolved DB dialect, and a live `SELECT 1` reachability probe.
 */

import { ValidationError } from "../core/errors.ts";
import { type AnyWarrenDb, pingDatabase } from "../db/client.ts";
import { parseDatabaseUrl, sqliteUrlForPath } from "../db/url.ts";
import {
	type LoadedWarrenConfig,
	loadWarrenConfig,
	type WarrenConfigCache,
	WarrenConfigUnavailableError,
} from "../warren-config/index.ts";
import type { DiagnosticCheck, EnvLike } from "./checks.ts";

/**
 * Walk every registered project, parse its `.warren/` directory, and
 * fail if any project's config is malformed or its clone has vanished.
 * Absent `.warren/` is the bootstrap shape (acceptance #5 covers all
 * three states: absent, valid, malformed) — those projects count as
 * "checked" but contribute nothing to the failure list.
 *
 * Reads through the `WarrenConfigCache` when one is supplied so the
 * doctor + readyz surfaces share parses with `GET /projects/:id/warren-config`
 * — invalidation already happens in refreshProject/deleteProject, so
 * the cache will not pin stale parse output across a project lifecycle.
 * Tests inject `load` directly to skip the cache.
 */
export interface WarrenConfigCheckProject {
	readonly id: string;
	readonly localPath: string;
}

export interface CheckWarrenConfigDeps {
	readonly projects: ReadonlyArray<WarrenConfigCheckProject>;
	readonly cache?: WarrenConfigCache;
	/** Override the loader (tests). Ignored when `cache` is supplied. */
	readonly load?: (projectPath: string) => Promise<LoadedWarrenConfig>;
}

export async function checkWarrenConfig(deps: CheckWarrenConfigDeps): Promise<DiagnosticCheck> {
	if (deps.projects.length === 0) {
		return {
			name: "warren_config",
			ok: true,
			message: "no projects registered",
		};
	}

	const failures: string[] = [];
	let validated = 0;

	for (const project of deps.projects) {
		let loaded: LoadedWarrenConfig;
		try {
			loaded =
				deps.cache !== undefined
					? await deps.cache.get(project.id, project.localPath)
					: await (deps.load ?? defaultWarrenConfigLoad)(project.localPath);
		} catch (err) {
			if (err instanceof WarrenConfigUnavailableError) {
				failures.push(`${project.id}: ${err.message}`);
				continue;
			}
			failures.push(`${project.id}: ${err instanceof Error ? err.message : String(err)}`);
			continue;
		}
		validated += 1;
		for (const fileError of loaded.errors) {
			failures.push(`${project.id} ${fileError.file}: ${fileError.message}`);
		}
	}

	if (failures.length > 0) {
		return {
			name: "warren_config",
			ok: false,
			message: `${failures.length} .warren/ failure(s) across ${deps.projects.length} project(s): ${failures.join("; ")}`,
			hint: "fix the offending .warren/ files in the project repo and POST /projects/:id/refresh",
		};
	}

	return {
		name: "warren_config",
		ok: true,
		message: `${validated} project(s) checked, no .warren/ failures`,
	};
}

function defaultWarrenConfigLoad(projectPath: string): Promise<LoadedWarrenConfig> {
	return loadWarrenConfig({ projectPath });
}

/**
 * Walk every registered project, parse its `.warren/` directory, and
 * surface any **non-fatal** advisories the loader collected — primarily
 * the `defaults.json` deprecation introduced in warren-5840. Stays
 * `ok: true` regardless so a legacy install doesn't flip `warren doctor`
 * red; the message names the offending files and the migration command
 * (`warren config migrate`) so operators have a one-shot fix to hand.
 *
 * Shares the load path with `checkWarrenConfig` so a cached read is reused
 * across the two checks in one doctor run. The fatal-errors check stays
 * the one that gates exit codes; this check is purely informational.
 */
export async function checkWarrenConfigDeprecations(
	deps: CheckWarrenConfigDeps,
): Promise<DiagnosticCheck> {
	if (deps.projects.length === 0) {
		return {
			name: "warren_config_deprecations",
			ok: true,
			message: "no projects registered",
		};
	}

	const items: string[] = [];

	for (const project of deps.projects) {
		let loaded: LoadedWarrenConfig;
		try {
			loaded =
				deps.cache !== undefined
					? await deps.cache.get(project.id, project.localPath)
					: await (deps.load ?? defaultWarrenConfigLoad)(project.localPath);
		} catch {
			// Fatal load failures show up in `checkWarrenConfig`. Skip them
			// here so this advisory check stays clean — operator-visible
			// noise here would just duplicate the failure already named in
			// the errors-only check.
			continue;
		}
		for (const warning of loaded.warnings) {
			items.push(`${project.id} ${warning.file}: ${warning.message}`);
		}
	}

	if (items.length === 0) {
		return {
			name: "warren_config_deprecations",
			ok: true,
			message: `${deps.projects.length} project(s) checked, no .warren/ deprecations`,
		};
	}

	return {
		name: "warren_config_deprecations",
		ok: true,
		message: `${items.length} .warren/ deprecation(s): ${items.join("; ")}`,
		hint: "run `warren config migrate --project <id>` to convert defaults.json to the .warren/ YAML layout",
	};
}

/**
 * Parse `WARREN_DB_URL` (or the legacy `WARREN_DB_PATH` alias) and
 * report the resolved dialect (R-13 pl-f17e step 5, warren-e2ea). Pure:
 * does NOT open the database — pair with `checkDatabaseReachable` when
 * a live handle is available. Surfaces three operator-facing failures:
 *
 *  - URL is malformed (ValidationError from parseDatabaseUrl).
 *  - WARREN_DB_URL and WARREN_DB_PATH are both set but disagree (a
 *    common foot-gun when migrating off the legacy var).
 *  - Neither var is set AND no default applies in the caller's context.
 *    (`warren doctor` always synthesizes a default so this branch only
 *    fires from custom embeddings.)
 */
export function checkWarrenDb(deps: { readonly env: EnvLike }): DiagnosticCheck {
	const url = deps.env.WARREN_DB_URL;
	const path = deps.env.WARREN_DB_PATH;
	if ((url === undefined || url === "") && (path === undefined || path === "")) {
		return {
			name: "warren_db",
			ok: true,
			message:
				"no WARREN_DB_URL / WARREN_DB_PATH set (will default to sqlite under WARREN_DATA_DIR)",
		};
	}
	if (url !== undefined && url !== "" && path !== undefined && path !== "") {
		const synthesized = sqliteUrlForPath(path);
		if (synthesized !== url) {
			return {
				name: "warren_db",
				ok: false,
				message: `WARREN_DB_URL (${url}) and WARREN_DB_PATH (${path}) disagree`,
				hint: "unset WARREN_DB_PATH or align it with WARREN_DB_URL — WARREN_DB_URL wins at boot",
			};
		}
	}
	const effective = url !== undefined && url !== "" ? url : sqliteUrlForPath(path ?? "");
	try {
		const parsed = parseDatabaseUrl(effective);
		const display = parsed.dialect === "sqlite" ? `sqlite ${parsed.path}` : "postgres";
		return { name: "warren_db", ok: true, message: display };
	} catch (err) {
		if (err instanceof ValidationError) {
			return {
				name: "warren_db",
				ok: false,
				message: err.message,
				...(err.recoveryHint !== undefined ? { hint: err.recoveryHint } : {}),
			};
		}
		return {
			name: "warren_db",
			ok: false,
			message: err instanceof Error ? err.message : String(err),
		};
	}
}

/**
 * Probe the live database via `SELECT 1` and report the active dialect
 * (R-13 pl-f17e step 5 acceptance #2). Used by `warren doctor` (which
 * opens the db through `withCliDb`) and `GET /readyz` (which forwards
 * the bootServer-owned handle via `ServerDeps.db`). Returns an
 * informational `ok: true` when no handle is wired so tests don't have
 * to populate the seam.
 */
export async function checkDatabaseReachable(deps: {
	readonly db?: AnyWarrenDb;
}): Promise<DiagnosticCheck> {
	if (deps.db === undefined) {
		return { name: "db_reachable", ok: true, message: "no db handle wired (test or partial deps)" };
	}
	try {
		await pingDatabase(deps.db);
		return { name: "db_reachable", ok: true, message: `dialect=${deps.db.dialect}` };
	} catch (err) {
		return {
			name: "db_reachable",
			ok: false,
			message: err instanceof Error ? err.message : String(err),
			hint:
				deps.db.dialect === "postgres"
					? "verify WARREN_DB_URL points at a reachable Postgres and the role can SELECT"
					: "verify WARREN_DB_URL (or WARREN_DB_PATH) points at a writable sqlite file",
		};
	}
}
