/**
 * Sandbox + canopy readiness checks for `warren doctor` and
 * `GET /readyz`. Split out of `checks.ts` (warren-5bf4) so the barrel
 * stays under the 500-line global limit; re-exported verbatim from
 * `./checks.ts`, so every importer keeps resolving unchanged.
 *
 * Covers: bwrap bring-up, the canopy clone's existence + cleanliness,
 * and burrow socket reachability (single-client + pool variants).
 */

import { existsSync } from "node:fs";
import type { BurrowClient } from "../burrow-client/client.ts";
import { withTransportMapping } from "../burrow-client/client.ts";
import type { BurrowClientPool } from "../burrow-client/pool.ts";
import type { SpawnFn } from "../projects/clone.ts";
import { type CanopyRegistryConfig, loadCanopyRegistryConfigFromEnv } from "../registry/config.ts";
import type { DiagnosticCheck, EnvLike, ExistsFn } from "./checks.ts";

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
