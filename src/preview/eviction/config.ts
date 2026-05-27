/**
 * Env-driven config for the preview eviction worker (warren-d0a9 split
 * of src/preview/eviction.ts). Defaults match SPEC §11.L; malformed
 * values fail loudly at boot rather than silently degrading at tick
 * time.
 */

import { ValidationError } from "../../core/errors.ts";
import { parseDurationMs } from "../duration.ts";
import type { PreviewEvictionConfig } from "./types.ts";

export const WARREN_PREVIEW_IDLE_TTL_ENV = "WARREN_PREVIEW_IDLE_TTL" as const;
export const WARREN_PREVIEW_MAX_LIFETIME_ENV = "WARREN_PREVIEW_MAX_LIFETIME" as const;
export const WARREN_PREVIEW_MAX_LIVE_ENV = "WARREN_PREVIEW_MAX_LIVE" as const;
export const WARREN_PREVIEW_EVICTION_TICK_MS_ENV = "WARREN_PREVIEW_EVICTION_TICK_MS" as const;
export const WARREN_PREVIEW_EVICTION_DISABLED_ENV = "WARREN_PREVIEW_EVICTION_DISABLED" as const;

/** SPEC §11.L: idle-TTL default 30 minutes. */
export const DEFAULT_IDLE_TTL_MS = 30 * 60_000;
/** SPEC §11.L: max-lifetime default 8 hours. */
export const DEFAULT_MAX_LIFETIME_MS = 8 * 3_600_000;
/** SPEC §11.L: max live cap default 20. */
export const DEFAULT_MAX_LIVE = 20;
/** Default tick cadence; ~10s keeps responsiveness without hammering the db. */
export const DEFAULT_TICK_MS = 10_000;
/** `/readyz` saturation threshold for the live-count check. */
export const PREVIEW_MAX_LIVE_WARN_RATIO = 0.8;

export type EnvLike = Readonly<Record<string, string | undefined>>;

/**
 * Resolve eviction config from env. Defaults match SPEC §11.L; malformed
 * values fail loudly at boot rather than silently degrading at tick time.
 */
export function loadPreviewEvictionConfigFromEnv(
	env: EnvLike = process.env,
): PreviewEvictionConfig {
	const idleTtlMs = parseEnvDuration(env, WARREN_PREVIEW_IDLE_TTL_ENV, DEFAULT_IDLE_TTL_MS);
	const maxLifetimeMs = parseEnvDuration(
		env,
		WARREN_PREVIEW_MAX_LIFETIME_ENV,
		DEFAULT_MAX_LIFETIME_MS,
	);
	const maxLive = parseEnvPositiveInt(env, WARREN_PREVIEW_MAX_LIVE_ENV, DEFAULT_MAX_LIVE);
	const tickMs = parseEnvPositiveInt(env, WARREN_PREVIEW_EVICTION_TICK_MS_ENV, DEFAULT_TICK_MS);
	const disabled = isTruthy(env[WARREN_PREVIEW_EVICTION_DISABLED_ENV]);
	return { idleTtlMs, maxLifetimeMs, maxLive, tickMs, disabled };
}

function parseEnvDuration(env: EnvLike, name: string, fallback: number): number {
	const raw = env[name];
	if (raw === undefined || raw.trim() === "") return fallback;
	try {
		return parseDurationMs(raw);
	} catch (err) {
		const message = err instanceof ValidationError ? err.message : String(err);
		throw new ValidationError(`${name}: ${message}`);
	}
}

function parseEnvPositiveInt(env: EnvLike, name: string, fallback: number): number {
	const raw = env[name];
	if (raw === undefined || raw.trim() === "") return fallback;
	const parsed = Number.parseInt(raw, 10);
	if (!Number.isInteger(parsed) || parsed <= 0 || String(parsed) !== raw.trim()) {
		throw new ValidationError(`${name} must be a positive integer (got ${JSON.stringify(raw)})`);
	}
	return parsed;
}

function isTruthy(raw: string | undefined): boolean {
	if (raw === undefined) return false;
	const lower = raw.trim().toLowerCase();
	return lower === "1" || lower === "true" || lower === "yes" || lower === "on";
}
