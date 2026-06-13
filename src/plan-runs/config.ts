/**
 * Resolve the PlanRun coordinator's environment-driven config (warren-2623).
 *
 * Env contract:
 *   WARREN_PLAN_RUN_TICK_MS   tick interval in ms — default 10_000 (10s),
 *                              faster than the cron scheduler (60s) because
 *                              plan progression is the operator's
 *                              interactive loop.
 *   WARREN_PLAN_RUN_DISABLED  disable the coordinator entirely — same
 *                              truthy set as WARREN_SCHEDULER_DISABLED
 *                              ("1"/"true"/"yes"/"on", case-insensitive).
 *   WARREN_PLAN_RUN_MERGE_TIMEOUT_MS
 *                              bounded wall-clock budget (ms) for a PR to
 *                              merge once its run has ended (warren-3937).
 *                              Guards both the parent-merge gate and the
 *                              child waiting_for_merge branch against a PR
 *                              that is open-but-unmergeable (failing
 *                              required checks, BLOCKED mergeStateStatus,
 *                              stuck auto-merge). Default 30 minutes; set
 *                              to 0 to disable the timeout (unbounded wait).
 */

import { ValidationError } from "../core/errors.ts";

export const DEFAULT_PLAN_RUN_TICK_MS = 10_000;
/** Default merge-wait budget: 30 minutes (warren-3937). */
export const DEFAULT_PLAN_RUN_MERGE_TIMEOUT_MS = 30 * 60 * 1000;

export interface PlanRunCoordinatorConfig {
	readonly tickMs: number;
	readonly disabled: boolean;
	/** Wall-clock merge-wait budget in ms; 0 disables the timeout. */
	readonly mergeTimeoutMs: number;
}

export type EnvLike = Readonly<Record<string, string | undefined>>;

export function loadPlanRunCoordinatorConfigFromEnv(
	env: EnvLike = process.env,
): PlanRunCoordinatorConfig {
	return {
		tickMs: parseTickMs(env.WARREN_PLAN_RUN_TICK_MS),
		disabled: parseBoolFlag(env.WARREN_PLAN_RUN_DISABLED),
		mergeTimeoutMs: parseMergeTimeoutMs(env.WARREN_PLAN_RUN_MERGE_TIMEOUT_MS),
	};
}

function parseMergeTimeoutMs(raw: string | undefined): number {
	if (raw === undefined || raw === "") return DEFAULT_PLAN_RUN_MERGE_TIMEOUT_MS;
	const parsed = Number(raw);
	if (!Number.isFinite(parsed) || parsed < 0) {
		throw new ValidationError(
			`WARREN_PLAN_RUN_MERGE_TIMEOUT_MS must be a non-negative integer, got "${raw}"`,
			{
				recoveryHint: `unset or set to a non-negative integer (default ${DEFAULT_PLAN_RUN_MERGE_TIMEOUT_MS}, 0 disables)`,
			},
		);
	}
	return Math.trunc(parsed);
}

function parseTickMs(raw: string | undefined): number {
	if (raw === undefined || raw === "") return DEFAULT_PLAN_RUN_TICK_MS;
	const parsed = Number(raw);
	if (!Number.isFinite(parsed) || parsed <= 0) {
		throw new ValidationError(`WARREN_PLAN_RUN_TICK_MS must be a positive integer, got "${raw}"`, {
			recoveryHint: `unset or set to a positive integer (default ${DEFAULT_PLAN_RUN_TICK_MS})`,
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
