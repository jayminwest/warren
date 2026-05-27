/**
 * Shared readiness checks for `warren doctor` and `GET /readyz`.
 *
 * Phase 13 (warren-a29f) wires three new probes into both surfaces:
 *   - `bwrap --version` — sandbox bring-up readiness (SPEC §5.3).
 *   - canopy clone exists on disk (SPEC §10.1).
 *   - canopy clone is "clean" (no working-tree mutations) — warren
 *     hard-resets the clone on every refresh (mx-4afd87), so a dirty
 *     tree means an operator (or bug) has touched the cache.
 *   - burrow socket reachable — already used by /readyz; lifted here
 *     so doctor and readyz share one probe path.
 *
 * Each check returns `{ name, ok, message?, hint? }`. Callers decide
 * how to render (newline-delimited JSON for doctor, one envelope for
 * readyz). The functions themselves are pure modulo their injected
 * `spawn` / `exists` / `burrowClient` seams — tests can stub all I/O.
 */

import { existsSync } from "node:fs";
import type { BurrowClient } from "../burrow-client/client.ts";
import { withTransportMapping } from "../burrow-client/client.ts";
import type { BurrowClientPool } from "../burrow-client/pool.ts";
import { ValidationError } from "../core/errors.ts";
import { type AnyWarrenDb, pingDatabase } from "../db/client.ts";
import { parseDatabaseUrl, sqliteUrlForPath } from "../db/url.ts";
import { PREVIEW_MAX_LIVE_WARN_RATIO } from "../preview/eviction/index.ts";
import { type PortUsage, PREVIEW_PORT_USAGE_WARN_RATIO } from "../preview/port-allocator.ts";
import type { SpawnFn } from "../projects/clone.ts";
import { type CanopyRegistryConfig, loadCanopyRegistryConfigFromEnv } from "../registry/config.ts";
import {
	type LoadedWarrenConfig,
	loadWarrenConfig,
	type WarrenConfigCache,
	WarrenConfigUnavailableError,
} from "../warren-config/index.ts";

export interface DiagnosticCheck {
	readonly name: string;
	readonly ok: boolean;
	readonly message?: string;
	readonly hint?: string;
}

export type EnvLike = Readonly<Record<string, string | undefined>>;
export type ExistsFn = (path: string) => boolean;

export const BWRAP_PROBE_TIMEOUT_MS = 5_000;
export const CANOPY_GIT_TIMEOUT_MS = 10_000;

/**
 * Probe `bwrap --version`. A non-zero exit, missing binary, or timeout
 * fails the check — burrow can't spawn agents without bwrap, so this
 * is the most operationally-useful "is the host wired right" signal.
 */
export async function checkBwrap(deps: {
	readonly spawn: SpawnFn;
	readonly bwrapBinary?: string;
	readonly timeoutMs?: number;
}): Promise<DiagnosticCheck> {
	const binary = deps.bwrapBinary ?? "bwrap";
	const timeoutMs = deps.timeoutMs ?? BWRAP_PROBE_TIMEOUT_MS;
	try {
		const result = await deps.spawn([binary, "--version"], {
			cwd: process.cwd(),
			timeoutMs,
		});
		if (result.exitCode !== 0) {
			return {
				name: "bwrap",
				ok: false,
				message: `bwrap --version exited ${result.exitCode}: ${result.stderr.trim() || result.stdout.trim()}`,
				hint: "install bwrap (e.g. apt-get install bubblewrap) and ensure it is on $PATH",
			};
		}
		return { name: "bwrap", ok: true, message: result.stdout.trim() || result.stderr.trim() };
	} catch (err) {
		return {
			name: "bwrap",
			ok: false,
			message: err instanceof Error ? err.message : String(err),
			hint: "install bwrap (e.g. apt-get install bubblewrap) and ensure it is on $PATH",
		};
	}
}

/**
 * Verify the canopy clone directory exists. Returns `ok: true` with an
 * informational message when no canopy library is configured — built-in
 * agents (src/registry/builtins/) cover the common case, so a missing
 * `CANOPY_REPO_URL` is no longer a failure (warren-d3e9). Failing means
 * `CANOPY_REPO_URL` *is* set but `POST /agents/refresh` has never run
 * successfully on this host.
 */
export function checkCanopyClone(deps: {
	readonly env: EnvLike;
	readonly exists?: ExistsFn;
}): DiagnosticCheck {
	const exists = deps.exists ?? existsSync;
	let config: CanopyRegistryConfig | null;
	try {
		config = loadCanopyRegistryConfigFromEnv(deps.env);
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		return {
			name: "canopy_clone",
			ok: false,
			message,
			hint: "set CANOPY_REPO_URL and (optionally) WARREN_CANOPY_DIR",
		};
	}
	if (config === null) {
		return {
			name: "canopy_clone",
			ok: true,
			message: "no canopy library configured (using built-in agents only)",
		};
	}
	if (!exists(config.localDir)) {
		return {
			name: "canopy_clone",
			ok: false,
			message: `canopy clone directory does not exist: ${config.localDir}`,
			hint: "POST /agents/refresh or run `warren register-agent <name>` to clone",
		};
	}
	return { name: "canopy_clone", ok: true, message: config.localDir };
}

/**
 * Verify the canopy clone has no local mutations. `git status
 * --porcelain` returns one line per dirty path; an empty stdout means
 * clean. We skip the probe (and report `ok: false`) when the clone
 * does not exist, since `git status` outside a repo would otherwise
 * print a confusing fatal-error message.
 */
export async function checkCanopyClean(deps: {
	readonly env: EnvLike;
	readonly spawn: SpawnFn;
	readonly exists?: ExistsFn;
	readonly timeoutMs?: number;
}): Promise<DiagnosticCheck> {
	const exists = deps.exists ?? existsSync;
	let config: CanopyRegistryConfig | null;
	try {
		config = loadCanopyRegistryConfigFromEnv(deps.env);
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		return {
			name: "canopy_clean",
			ok: false,
			message,
			hint: "set CANOPY_REPO_URL and (optionally) WARREN_CANOPY_DIR",
		};
	}
	if (config === null) {
		return {
			name: "canopy_clean",
			ok: true,
			message: "no canopy library configured (using built-in agents only)",
		};
	}
	if (!exists(config.localDir)) {
		return {
			name: "canopy_clean",
			ok: false,
			message: `canopy clone directory does not exist: ${config.localDir}`,
			hint: "POST /agents/refresh or run `warren register-agent <name>` to clone",
		};
	}
	const timeoutMs = deps.timeoutMs ?? CANOPY_GIT_TIMEOUT_MS;
	try {
		const result = await deps.spawn([config.gitBinary, "status", "--porcelain"], {
			cwd: config.localDir,
			timeoutMs,
		});
		if (result.exitCode !== 0) {
			return {
				name: "canopy_clean",
				ok: false,
				message: `git status exited ${result.exitCode}: ${result.stderr.trim() || result.stdout.trim()}`,
				hint: "POST /agents/refresh to hard-reset the canopy clone to origin/HEAD",
			};
		}
		const dirty = result.stdout.split("\n").filter((line) => line.length > 0);
		if (dirty.length > 0) {
			return {
				name: "canopy_clean",
				ok: false,
				message: `${dirty.length} local mutation(s) in ${config.localDir}`,
				hint: "POST /agents/refresh to hard-reset the canopy clone to origin/HEAD",
			};
		}
		return { name: "canopy_clean", ok: true, message: config.localDir };
	} catch (err) {
		return {
			name: "canopy_clean",
			ok: false,
			message: err instanceof Error ? err.message : String(err),
			hint: "POST /agents/refresh to hard-reset the canopy clone to origin/HEAD",
		};
	}
}

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
 * Probe burrow's socket via `BurrowClient.probe()`. Wraps transport
 * errors into the same readable shape `withTransportMapping` produces
 * for §4.3 spawn-flow callers. Used by `warren doctor`, which probes a
 * single env-derived client. The server's /readyz handler uses
 * `checkBurrowPoolReachable` instead so a multi-worker deploy surfaces
 * every failing worker.
 */
export async function checkBurrowReachable(deps: {
	readonly burrowClient: BurrowClient;
}): Promise<DiagnosticCheck> {
	try {
		await withTransportMapping(deps.burrowClient.config, () => deps.burrowClient.probe());
		return { name: "burrow_reachable", ok: true };
	} catch (err) {
		return {
			name: "burrow_reachable",
			ok: false,
			message: err instanceof Error ? err.message : String(err),
			hint: "check that burrow serve is running and WARREN_BURROW_SOCKET / WARREN_BURROW_HOST point to it",
		};
	}
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

/**
 * Preview port allocator saturation (R-19 / SPEC §11.L, warren-2277). Fails
 * when ≥ `warnRatio` of the configured port range is in use by `starting`
 * or `live` runs — operators can either raise `WARREN_PREVIEW_PORT_RANGE`
 * or tighten idle-TTL / max-lifetime so the eviction worker reclaims
 * faster. Pure: takes a `usage()` probe (the allocator implements it) so
 * tests don't need a live db handle.
 */
export interface PreviewPortUsageProbe {
	usage(): Promise<PortUsage>;
}

export async function checkPreviewPortAllocator(deps: {
	readonly probe: PreviewPortUsageProbe;
	readonly warnRatio?: number;
}): Promise<DiagnosticCheck> {
	const warnRatio = deps.warnRatio ?? PREVIEW_PORT_USAGE_WARN_RATIO;
	let usage: PortUsage;
	try {
		usage = await deps.probe.usage();
	} catch (err) {
		return {
			name: "preview_port_allocator",
			ok: false,
			message: err instanceof Error ? err.message : String(err),
			hint: "verify WARREN_DB_URL is reachable and the runs table has the preview columns (migration 0009)",
		};
	}
	const ratio = usage.total === 0 ? 1 : usage.inUse / usage.total;
	const summary = `${usage.inUse}/${usage.total} ports in use (range ${usage.range.start}-${usage.range.end})`;
	if (ratio >= warnRatio) {
		return {
			name: "preview_port_allocator",
			ok: false,
			message: `${summary}, ≥ ${Math.round(warnRatio * 100)}% saturation`,
			hint: "raise WARREN_PREVIEW_PORT_RANGE or tighten WARREN_PREVIEW_IDLE_TTL / WARREN_PREVIEW_MAX_LIFETIME so the eviction worker reclaims faster",
		};
	}
	return { name: "preview_port_allocator", ok: true, message: summary };
}

/**
 * Live-preview saturation against the global cap (R-19 / SPEC §11.L,
 * warren-ea6b). Fails when the count of `starting`/`live` previews is at
 * or above `warnRatio` of `WARREN_PREVIEW_MAX_LIVE`. Operators tighten
 * `WARREN_PREVIEW_IDLE_TTL` / `WARREN_PREVIEW_MAX_LIFETIME` so the
 * eviction worker reclaims faster, or raise the cap if the deploy needs
 * more concurrent previews. Pure: takes a `count()` probe so tests don't
 * need a live db handle.
 */
export interface PreviewLiveCountProbe {
	count(): Promise<number>;
}

export async function checkPreviewMaxLive(deps: {
	readonly probe: PreviewLiveCountProbe;
	readonly maxLive: number;
	readonly warnRatio?: number;
}): Promise<DiagnosticCheck> {
	const warnRatio = deps.warnRatio ?? PREVIEW_MAX_LIVE_WARN_RATIO;
	let live: number;
	try {
		live = await deps.probe.count();
	} catch (err) {
		return {
			name: "preview_max_live",
			ok: false,
			message: err instanceof Error ? err.message : String(err),
			hint: "verify WARREN_DB_URL is reachable and the runs table has the preview columns (migration 0009)",
		};
	}
	const ratio = deps.maxLive === 0 ? 1 : live / deps.maxLive;
	const summary = `${live}/${deps.maxLive} live previews`;
	if (ratio >= warnRatio) {
		return {
			name: "preview_max_live",
			ok: false,
			message: `${summary}, ≥ ${Math.round(warnRatio * 100)}% of WARREN_PREVIEW_MAX_LIVE`,
			hint: "raise WARREN_PREVIEW_MAX_LIVE or tighten WARREN_PREVIEW_IDLE_TTL / WARREN_PREVIEW_MAX_LIFETIME so the eviction worker reclaims faster",
		};
	}
	return { name: "preview_max_live", ok: true, message: summary };
}

/**
 * Preview signed-cookie auth strength check (R-19 / SPEC §11.L,
 * warren-8a10). When `WARREN_PREVIEW_HOST` is set, the proxy preamble
 * is gated by an HMAC derived from `WARREN_API_TOKEN`. A weak token
 * ("changeme", "warren-token", a tutorial copy-paste) leaves a
 * private-code preview accessible to anyone who can guess the token —
 * the SPEC's risk #2 mitigation. Warns when the token matches a
 * placeholder or is shorter than `MIN_TOKEN_LENGTH`. No-ops when
 * `WARREN_PREVIEW_HOST` is absent (the proxy surface is off).
 */
export const PREVIEW_TOKEN_PLACEHOLDERS: readonly string[] = [
	"changeme",
	"placeholder",
	"warren-token",
	"your-token-here",
	"insecure",
	"secret",
];
/** Below this length the token is considered weak even if not a known placeholder. */
export const PREVIEW_MIN_TOKEN_LENGTH = 16;

export function checkPreviewAuthStrength(deps: { readonly env: EnvLike }): DiagnosticCheck {
	const host = deps.env.WARREN_PREVIEW_HOST?.trim() ?? "";
	if (host === "") {
		return {
			name: "preview_auth_strength",
			ok: true,
			message: "WARREN_PREVIEW_HOST unset (preview proxy disabled)",
		};
	}
	const token = deps.env.WARREN_API_TOKEN ?? "";
	if (token === "") {
		return {
			name: "preview_auth_strength",
			ok: false,
			message: "WARREN_PREVIEW_HOST is set but WARREN_API_TOKEN is empty",
			hint: "set WARREN_API_TOKEN to a strong random value (e.g. `openssl rand -hex 32`)",
		};
	}
	if (PREVIEW_TOKEN_PLACEHOLDERS.includes(token.toLowerCase())) {
		return {
			name: "preview_auth_strength",
			ok: false,
			message: "WARREN_API_TOKEN looks like a placeholder copy-pasted from docs",
			hint: "rotate WARREN_API_TOKEN to a strong random value (e.g. `openssl rand -hex 32`); the preview proxy uses it as the signed-cookie secret",
		};
	}
	if (token.length < PREVIEW_MIN_TOKEN_LENGTH) {
		return {
			name: "preview_auth_strength",
			ok: false,
			message: `WARREN_API_TOKEN is ${token.length} chars; preview surface needs ≥${PREVIEW_MIN_TOKEN_LENGTH}`,
			hint: "rotate WARREN_API_TOKEN to a strong random value (e.g. `openssl rand -hex 32`)",
		};
	}
	return { name: "preview_auth_strength", ok: true, message: `host=${host}` };
}

/**
 * Aggregate `BurrowClientPool.probe()` across every registered worker
 * (warren-c0c9 / pl-9ba1 step 5). One ok=true iff every worker probed
 * cleanly; on partial failure the message lists every failing worker by
 * name. Used by the server's /readyz handler so a single failing worker
 * in a multi-worker deploy degrades the global readyz envelope without
 * masking the healthy workers' probe results.
 */
export async function checkBurrowPoolReachable(pool: BurrowClientPool): Promise<DiagnosticCheck> {
	const results = await pool.probe();
	const failed = results.filter((r) => !r.ok);
	if (failed.length === 0) {
		return { name: "burrow_reachable", ok: true };
	}
	const message = failed.map((r) => `${r.workerName}: ${r.error?.message ?? "unknown"}`).join("; ");
	return {
		name: "burrow_reachable",
		ok: false,
		message,
		hint: "check `GET /workers` for state; bring the listed workers back online or drain them",
	};
}
