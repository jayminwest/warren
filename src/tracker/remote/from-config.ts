/**
 * Building a RemoteTracker from the per-project `.warren/config.yaml`
 * `tracker` block (warren-d3a9).
 *
 * Credential posture: `tracker.tokenEnv` NAMES an environment variable.
 * The token is read from the operator's environment at build time and
 * held only in memory on the tracker instance — warren never persists
 * it. A `tokenEnv` whose variable is unset fails loud: the operator
 * declared a credential source, and silently calling the container
 * unauthenticated would surface as a confusing 401 three layers away.
 *
 * The returned tracker is NOT connected — callers must `await
 * tracker.connect()` at wiring time so a protocol-version mismatch
 * fails at boot, not on the first call (the loud-at-boot rule from the
 * warren-d3a9 spec).
 */

import { TrackerError } from "../../core/wire.ts";
import type { TrackerConfig } from "../../warren-config/schema.ts";
import { RemoteTracker } from "./remote-tracker.ts";

/** The env-shaped input, injectable for tests. */
export type EnvLike = Readonly<Record<string, string | undefined>>;

export interface RemoteTrackerBuildOptions {
	readonly config: TrackerConfig;
	readonly env: EnvLike;
	/** Passed through to RemoteTracker (tests only). */
	readonly overrides?: {
		readonly fetchImpl?: typeof fetch;
		readonly now?: () => number;
		readonly cacheTtlMs?: number;
		readonly maxAttempts?: number;
		readonly initialBackoffMs?: number;
	};
}

/**
 * Resolve the optional bearer for a tracker config. Returns `undefined`
 * when no `tokenEnv` is configured. Throws when `tokenEnv` is configured
 * but the variable is unset or empty.
 */
export function resolveTrackerBearer(config: TrackerConfig, env: EnvLike): string | undefined {
	if (config.tokenEnv === undefined) return undefined;
	const value = env[config.tokenEnv];
	if (value === undefined || value === "") {
		throw new TrackerError(
			`tracker.tokenEnv names "${config.tokenEnv}" but that environment variable is not set — ` +
				"warren refuses to call the tracker container unauthenticated when a credential " +
				"source was declared. Set the variable or drop tracker.tokenEnv.",
		);
	}
	return value;
}

/** Build an (unconnected) RemoteTracker from a parsed `tracker` config block. */
export function buildRemoteTracker(options: RemoteTrackerBuildOptions): RemoteTracker {
	const bearerToken = resolveTrackerBearer(options.config, options.env);
	return new RemoteTracker({
		baseUrl: options.config.url,
		...(bearerToken !== undefined ? { bearerToken } : {}),
		...(options.overrides?.fetchImpl !== undefined
			? { fetchImpl: options.overrides.fetchImpl }
			: {}),
		...(options.overrides?.now !== undefined ? { now: options.overrides.now } : {}),
		...(options.overrides?.cacheTtlMs !== undefined
			? { cacheTtlMs: options.overrides.cacheTtlMs }
			: {}),
		...(options.overrides?.maxAttempts !== undefined
			? { maxAttempts: options.overrides.maxAttempts }
			: {}),
		...(options.overrides?.initialBackoffMs !== undefined
			? { initialBackoffMs: options.overrides.initialBackoffMs }
			: {}),
	});
}
