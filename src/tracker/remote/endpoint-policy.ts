import { TrackerError } from "../../core/wire.ts";
import type { TrackerConfig } from "../../warren-config/schema.ts";
import type { EnvLike } from "./from-config.ts";

function names(env: EnvLike, key: string, fallback: readonly string[]): readonly string[] {
	if (env[key] === undefined) return fallback;
	let parsed: unknown;
	try {
		parsed = JSON.parse(env[key]);
	} catch {
		throw new TrackerError(`${key} must be a JSON string array`);
	}
	if (
		!Array.isArray(parsed) ||
		parsed.some((entry: unknown) => typeof entry !== "string" || !entry)
	)
		throw new TrackerError(`${key} must be a JSON string array`);
	return parsed as string[];
}

/** A repository cannot grant itself host network access or choose arbitrary host secrets. */
export function assertTrackerEndpointAllowed(config: TrackerConfig, env: EnvLike): void {
	const url = new URL(config.url);
	if (
		!["https:", "http:"].includes(url.protocol) ||
		url.username ||
		url.password ||
		url.search ||
		url.hash
	) {
		throw new TrackerError("Tracker URL must be HTTP(S), without credentials, query or fragment");
	}
	const allowed = names(env, "WARREN_TRACKER_ALLOWED_URLS", []);
	if (!allowed.some((entry) => entry.replace(/\/+$/, "") === config.url.replace(/\/+$/, ""))) {
		throw new TrackerError(
			"Tracker endpoint is not in the operator's WARREN_TRACKER_ALLOWED_URLS allowlist",
		);
	}
	if (
		config.tokenEnv &&
		!names(env, "WARREN_TRACKER_ALLOWED_TOKEN_ENVS", ["WARREN_TRACKER_BEARER"]).includes(
			config.tokenEnv,
		)
	) {
		throw new TrackerError("Tracker credential name is not in WARREN_TRACKER_ALLOWED_TOKEN_ENVS");
	}
}
