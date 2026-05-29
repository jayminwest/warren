/**
 * `warren doctor` — startup health check (SPEC §8.2).
 *
 * Runs the union of:
 *   - required env vars (WARREN_API_TOKEN, CANOPY_REPO_URL),
 *   - canopy clone exists on disk,
 *   - canopy clone is "clean" (no working-tree mutations — Phase 13),
 *   - bwrap binary reachable (Phase 13),
 *   - projects root resolvable (non-fatal),
 *   - per-project `.warren/` config validity (R-02, pl-5d74 step 6),
 *   - burrow socket reachable.
 *
 * The Phase-13 probes (bwrap + canopy_clean) live in
 * `src/diagnostics/checks.ts` so `GET /readyz` mirrors them without
 * duplicating logic. Each check returns `{name, ok, message?, hint?}`;
 * the command exits 0 when every check passes and 1 otherwise.
 */

import { existsSync } from "node:fs";
import { BurrowClient } from "../../burrow-client/client.ts";
import { loadBurrowClientConfigFromEnv } from "../../burrow-client/config.ts";
import { ValidationError } from "../../core/errors.ts";
import type { AnyWarrenDb } from "../../db/client.ts";
import { DrizzleAdapter } from "../../db/repos/drizzle-adapter.ts";
import { createRepos } from "../../db/repos/index.ts";
import {
	checkBurrowReachable,
	checkBwrap,
	checkCanopyClean,
	checkCanopyClone,
	checkDatabaseReachable,
	checkPreviewAuthStrength,
	checkPreviewPortAllocator,
	checkWarrenConfig,
	checkWarrenConfigDeprecations,
	checkWarrenDb,
	type DiagnosticCheck,
	type WarrenConfigCheckProject,
} from "../../diagnostics/checks.ts";
import { checkStaleBurrowWorkspaces } from "../../diagnostics/stale-workspaces.ts";
import { loadPreviewPortRangeFromEnv, PreviewPortAllocator } from "../../preview/port-allocator.ts";
import { loadProjectsConfigFromEnv } from "../../projects/config.ts";
import { loadWorkspaceGcConfigFromEnv } from "../../runs/reap/gc.ts";
import type { CliContext, EnvLike } from "../output.ts";
import { writeJsonLine } from "../output.ts";

export type DoctorCheck = DiagnosticCheck;

export interface DoctorArgs {
	readonly noAuth?: boolean;
}

export interface DoctorDeps {
	/** Override the live `BurrowClient.probe` (tests). */
	readonly probeBurrow?: (env: EnvLike) => Promise<void>;
	/** Override `existsSync` (tests). */
	readonly existsSync?: (path: string) => boolean;
	/**
	 * Registered projects to validate `.warren/` against. `main.ts` wires
	 * this from the live projects table via `withCliDb`; tests pass a
	 * synthetic list (or omit for an empty registry). When the list is
	 * empty the warren_config check still runs and reports an
	 * informational `ok: true`.
	 */
	readonly projects?: ReadonlyArray<WarrenConfigCheckProject>;
	/**
	 * Live db handle for the `db_reachable` probe (R-13 pl-f17e step 5,
	 * warren-e2ea). `main.ts` wires this from `withCliDb`; tests omit
	 * and the check degrades to an informational `ok: true`.
	 */
	readonly db?: AnyWarrenDb;
}

export interface DoctorResult {
	readonly exitCode: number;
	readonly checks: readonly DoctorCheck[];
}

export async function runDoctor(
	context: CliContext,
	deps: DoctorDeps,
	args: DoctorArgs,
): Promise<DoctorResult> {
	const exists = deps.existsSync ?? existsSync;
	const checks: DoctorCheck[] = [];

	checks.push(envCheck("WARREN_API_TOKEN", context.env, args.noAuth ?? false));
	checks.push(canopyRepoUrlCheck(context.env));

	checks.push(checkWarrenDb({ env: context.env }));
	checks.push(await checkDatabaseReachable({ ...(deps.db !== undefined ? { db: deps.db } : {}) }));

	checks.push(checkCanopyClone({ env: context.env, exists }));
	checks.push(await checkCanopyClean({ env: context.env, spawn: context.spawn, exists }));

	checks.push(projectsRootCheck(context.env, exists));

	checks.push(await checkBwrap({ spawn: context.spawn }));

	checks.push(await checkWarrenConfig({ projects: deps.projects ?? [] }));
	checks.push(await checkWarrenConfigDeprecations({ projects: deps.projects ?? [] }));

	checks.push(await previewPortAllocatorCheck(context.env, deps.db));

	checks.push(await staleBurrowWorkspacesCheck(context.env, deps.db));

	checks.push(checkPreviewAuthStrength({ env: context.env }));

	checks.push(await burrowCheck(context.env, deps.probeBurrow));

	for (const check of checks) {
		writeJsonLine(context.stdio.stdout, check);
	}

	const allOk = checks.every((c) => c.ok);
	if (!allOk) {
		context.stdio.stderr.write("warren: one or more checks failed\n");
	}
	return { exitCode: allOk ? 0 : 1, checks };
}

function envCheck(name: string, env: EnvLike, exempted: boolean): DoctorCheck {
	if (exempted) {
		return { name, ok: true, message: "skipped (--no-auth)" };
	}
	const value = env[name];
	if (value !== undefined && value !== "") return { name, ok: true };
	return {
		name,
		ok: false,
		message: `${name} is not set`,
		hint: `export ${name}=...`,
	};
}

/**
 * `CANOPY_REPO_URL` is optional (warren-d3e9): warren ships built-in
 * agents that cover the common case. Report unset as `ok: true` with an
 * informational message rather than failing the check.
 */
function canopyRepoUrlCheck(env: EnvLike): DoctorCheck {
	const value = env.CANOPY_REPO_URL;
	if (value !== undefined && value !== "") {
		return { name: "CANOPY_REPO_URL", ok: true };
	}
	return {
		name: "CANOPY_REPO_URL",
		ok: true,
		message: "no canopy library configured (using built-in agents only)",
	};
}

function projectsRootCheck(env: EnvLike, exists: (path: string) => boolean): DoctorCheck {
	let config: ReturnType<typeof loadProjectsConfigFromEnv>;
	try {
		config = loadProjectsConfigFromEnv(env);
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		return { name: "projects_root", ok: false, message };
	}
	// Missing root is non-fatal — addProject will mkdirp on first use. Just
	// surface the path for visibility.
	return {
		name: "projects_root",
		ok: true,
		message: exists(config.root)
			? config.root
			: `${config.root} (will be created on first project add)`,
	};
}

async function staleBurrowWorkspacesCheck(
	env: EnvLike,
	db: AnyWarrenDb | undefined,
): Promise<DoctorCheck> {
	let ttlMs: number;
	try {
		ttlMs = loadWorkspaceGcConfigFromEnv(env).ttlMs;
	} catch (err) {
		return {
			name: "stale_burrow_workspaces",
			ok: false,
			message: err instanceof Error ? err.message : String(err),
		};
	}
	if (db === undefined) {
		return { name: "stale_burrow_workspaces", ok: true, message: "no db handle wired" };
	}
	const repos = createRepos(db);
	return checkStaleBurrowWorkspaces({
		probe: {
			listAll: () => repos.burrows.listAll(),
			listByState: (state) => repos.runs.listByState(state),
		},
		ttlMs,
	});
}

async function previewPortAllocatorCheck(
	env: EnvLike,
	db: AnyWarrenDb | undefined,
): Promise<DoctorCheck> {
	// Range parse is the operator-facing typo path; surface it as a check
	// failure before we touch the db so the message names the env var.
	let range: ReturnType<typeof loadPreviewPortRangeFromEnv>;
	try {
		range = loadPreviewPortRangeFromEnv(env);
	} catch (err) {
		if (err instanceof ValidationError) {
			return {
				name: "preview_port_allocator",
				ok: false,
				message: err.message,
				...(err.recoveryHint !== undefined ? { hint: err.recoveryHint } : {}),
			};
		}
		return {
			name: "preview_port_allocator",
			ok: false,
			message: err instanceof Error ? err.message : String(err),
		};
	}
	if (db === undefined) {
		return {
			name: "preview_port_allocator",
			ok: true,
			message: `no db handle wired (range ${range.start}-${range.end})`,
		};
	}
	// Allocator construction is non-destructive — usage() is a pure read
	// against the runs table. Dialect-polymorphic since warren-adfb.
	const allocator = new PreviewPortAllocator(DrizzleAdapter.for(db), range);
	return checkPreviewPortAllocator({ probe: allocator });
}

async function burrowCheck(
	env: EnvLike,
	override?: (env: EnvLike) => Promise<void>,
): Promise<DoctorCheck> {
	if (override !== undefined) {
		try {
			await override(env);
			return { name: "burrow_reachable", ok: true };
		} catch (err) {
			if (err instanceof ValidationError) {
				return {
					name: "burrow_reachable",
					ok: false,
					message: err.message,
					...(err.recoveryHint !== undefined ? { hint: err.recoveryHint } : {}),
				};
			}
			return {
				name: "burrow_reachable",
				ok: false,
				message: err instanceof Error ? err.message : String(err),
				hint: "check that burrow serve is running and WARREN_BURROW_SOCKET / WARREN_BURROW_HOST point to it",
			};
		}
	}
	let client: BurrowClient;
	try {
		const config = loadBurrowClientConfigFromEnv(env);
		client = new BurrowClient({ config });
	} catch (err) {
		if (err instanceof ValidationError) {
			return {
				name: "burrow_reachable",
				ok: false,
				message: err.message,
				...(err.recoveryHint !== undefined ? { hint: err.recoveryHint } : {}),
			};
		}
		return {
			name: "burrow_reachable",
			ok: false,
			message: err instanceof Error ? err.message : String(err),
			hint: "check that burrow serve is running and WARREN_BURROW_SOCKET / WARREN_BURROW_HOST point to it",
		};
	}
	try {
		return await checkBurrowReachable({ burrowClient: client });
	} finally {
		await client.close().catch(() => undefined);
	}
}
