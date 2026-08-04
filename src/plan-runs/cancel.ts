/**
 * Plan-run cancellation orchestration (warren-e240 / pl-882c step 8).
 *
 * Moved out of `src/server/handlers/plan-runs.ts`: flip the plan-run to
 * `cancelled` and, if a child run is in-flight (dispatched / running /
 * pr_open), forward a cancel to that child via the existing `cancelRun`
 * seam. Idempotent against an already-terminal plan-run: returns the
 * current row without firing a second cancel.
 */

import type { Repos } from "../db/repos/index.ts";
import type { PlanRunRow } from "../db/schema.ts";
import {
	type AutoOpenPrConfig,
	type CancelReap,
	cancelRun,
	type RunEventBroker,
} from "../runs/index.ts";
import type { RuntimeProvider } from "../runtime/contract.ts";

/** Minimal logger shape — structurally satisfied by the server's pino-shaped Logger. */
export interface CancelPlanRunLogger {
	warn(obj: object, msg?: string): void;
}

export interface CancelPlanRunInput {
	readonly planRunId: string;
	readonly repos: Repos;
	readonly broker?: RunEventBroker;
	/** Runtime-provider + inline-reap seams `cancelRun` needs (warren-b223). */
	readonly runtimeProvider: RuntimeProvider;
	readonly reap?: CancelReap;
	readonly autoOpenPr?: AutoOpenPrConfig;
	readonly logger?: CancelPlanRunLogger;
	readonly now?: () => Date;
}

export interface CancelPlanRunResult {
	readonly planRun: PlanRunRow;
	readonly cancelledChild: { childSeq: number; runId: string } | null;
	readonly alreadyTerminal: boolean;
}

export async function cancelPlanRun(input: CancelPlanRunInput): Promise<CancelPlanRunResult> {
	const planRun = await input.repos.planRuns.require(input.planRunId);
	if (
		planRun.state === "cancelled" ||
		planRun.state === "succeeded" ||
		planRun.state === "failed"
	) {
		return { planRun, cancelledChild: null, alreadyTerminal: true };
	}

	const children = await input.repos.planRuns.listChildren(planRun.id);
	const inFlight = children.find(
		(c) => c.state === "dispatched" || c.state === "running" || c.state === "pr_open",
	);

	const endedAt = (input.now?.() ?? new Date()).toISOString();
	const cancelled = await input.repos.planRuns.transitionTo(planRun.id, "cancelled", {
		endedAt,
	});

	const cancelledChild = await cancelInFlightChild(input, planRun.id, inFlight);
	return { planRun: cancelled, cancelledChild, alreadyTerminal: false };
}

/**
 * Best-effort forward-cancel of the in-flight child run. The plan-run
 * itself is already in the cancelled state, and the child run will land
 * terminally via the bridge regardless, so a failure here degrades to a
 * warning on the result rather than a rejected cancel.
 */
async function cancelInFlightChild(
	input: CancelPlanRunInput,
	planRunId: string,
	inFlight: { seq: number; runId: string | null } | undefined,
): Promise<{ childSeq: number; runId: string } | null> {
	if (inFlight === undefined || inFlight.runId === null) return null;
	const runId = inFlight.runId;
	try {
		await cancelRun({
			runId,
			repos: input.repos,
			runtimeProvider: input.runtimeProvider,
			...(input.reap !== undefined ? { reap: input.reap } : {}),
			...(input.broker !== undefined ? { broker: input.broker } : {}),
			reason: `plan_run_cancelled:${planRunId}`,
			...(input.now !== undefined ? { now: input.now } : {}),
			...(input.autoOpenPr !== undefined ? { autoOpenPr: input.autoOpenPr } : {}),
		});
		return { childSeq: inFlight.seq, runId };
	} catch (err) {
		// Surface the failure via the log so operators can see why the
		// child didn't cancel cleanly.
		input.logger?.warn(
			{
				planRunId,
				childRunId: runId,
				err: err instanceof Error ? err.message : String(err),
			},
			"plan_run.cancel_child_failed",
		);
		return null;
	}
}
