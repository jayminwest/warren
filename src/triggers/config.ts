/**
 * Resolve the scheduler module's environment-driven config (SPEC §13).
 *
 * Env contract:
 *   WARREN_SCHEDULER_TICK_MS   tick interval in ms — default 60_000 (one minute)
 *   WARREN_SCHEDULER_DISABLED  disable the scheduler entirely — accepts the
 *                              standard warren truthy set ("1"/"true"/"yes"/"on")
 *   WARREN_SD_BINARY           seeds CLI binary path — default "sd"
 *
 * One minute is the natural floor for cron grammar (5-token expressions
 * resolve to minute-level slots); ticking faster wastes work, ticking
 * slower means cron slots can be missed if a tick straddles them.
 * Acceptance + tests inject smaller intervals via the API directly rather
 * than the env var so production never accidentally subminute-ticks.
 */

import { ValidationError } from "../core/errors.ts";

export const DEFAULT_SCHEDULER_TICK_MS = 60_000;
export const DEFAULT_SD_BINARY = "sd";

export interface TriggerSchedulerConfig {
	readonly tickMs: number;
	readonly disabled: boolean;
	readonly sdBinary: string;
}

export type EnvLike = Readonly<Record<string, string | undefined>>;

export function loadTriggerSchedulerConfigFromEnv(
	env: EnvLike = process.env,
): TriggerSchedulerConfig {
	const tickMs = parseTickMs(env.WARREN_SCHEDULER_TICK_MS);
	const disabled = parseBoolFlag(env.WARREN_SCHEDULER_DISABLED);
	const sdBinary = env.WARREN_SD_BINARY ?? DEFAULT_SD_BINARY;

	if (sdBinary === "") {
		throw new ValidationError("WARREN_SD_BINARY is set to an empty string", {
			recoveryHint: `unset WARREN_SD_BINARY to fall back to "${DEFAULT_SD_BINARY}"`,
		});
	}

	return { tickMs, disabled, sdBinary };
}

function parseTickMs(raw: string | undefined): number {
	if (raw === undefined || raw === "") return DEFAULT_SCHEDULER_TICK_MS;
	const parsed = Number(raw);
	if (!Number.isFinite(parsed) || parsed <= 0) {
		throw new ValidationError(`WARREN_SCHEDULER_TICK_MS must be a positive integer, got "${raw}"`, {
			recoveryHint: `unset or set to a positive integer (default ${DEFAULT_SCHEDULER_TICK_MS})`,
		});
	}
	return Math.trunc(parsed);
}

// Default-OFF opt-in flag: use the canonical allow-list truthy set from
// PR #340 ("1"/"true"/"yes"/"on", case-insensitive) so out-of-set garbage
// resolves to false (fail-safe) and matches the documented env contract.
// (Unlike the default-ON WARREN_AUTO_OPEN_PR, which correctly uses a
// deny-list opt-out posture.)
function parseBoolFlag(raw: string | undefined): boolean {
	if (raw === undefined) return false;
	const t = raw.trim().toLowerCase();
	return t === "1" || t === "true" || t === "yes" || t === "on";
}
