/**
 * Plan-run wire types (warren-8ffc), split out of `./types.ts`
 * (warren-fcc8) to keep that file under its line budget.
 */
import type { RunRow } from "./types.ts";

/* Plan-runs — typed facade over /plan-runs (warren-8ffc).                 */
/* Wire envelope is camelCase, mirroring /runs.                            */
/* ----------------------------------------------------------------------- */

export type PlanRunState = "queued" | "running" | "succeeded" | "failed" | "cancelled";

export const PLAN_RUN_TERMINAL_STATES: ReadonlySet<PlanRunState> = new Set([
	"succeeded",
	"failed",
	"cancelled",
]);

export function isTerminalPlanRunState(
	state: PlanRunState,
): state is "succeeded" | "failed" | "cancelled" {
	return PLAN_RUN_TERMINAL_STATES.has(state);
}

export type PlanRunChildState =
	| "pending"
	| "dispatched"
	| "running"
	| "pr_open"
	| "merged"
	| "failed"
	| "skipped";

export interface PlanRunRow {
	id: string;
	planId: string;
	projectId: string;
	agentName: string;
	promptTemplate: string;
	ref: string | null;
	providerOverride: string | null;
	modelOverride: string | null;
	dispatcherHandle: string;
	trigger: string;
	state: PlanRunState;
	failureReason: string | null;
	createdAt: string;
	startedAt: string | null;
	endedAt: string | null;
	plotId: string | null;
}

export interface PlanRunChildRow {
	planRunId: string;
	seq: number;
	seedId: string;
	runId: string | null;
	state: PlanRunChildState;
	createdAt: string;
	updatedAt: string;
	startedAt: string | null;
	endedAt: string | null;
	prMergedAt: string | null;
	failureReason: string | null;
}

/** `POST /plan-runs` request body. Wire envelope is camelCase. */
export interface CreatePlanRunInput {
	project: string;
	planId: string;
	agent: string;
	promptTemplate?: string;
	ref?: string;
	providerOverride?: string;
	modelOverride?: string;
	dispatcherHandle?: string;
	plotId?: string;
}

export interface CreatePlanRunResponse {
	planRun: PlanRunRow;
	children: PlanRunChildRow[];
}

export interface PlanRunDetailResponse {
	planRun: PlanRunRow;
	children: PlanRunChildRow[];
	runs: RunRow[];
}

export interface ListPlanRunsFilter {
	project?: string;
	state?: PlanRunState;
}

export interface ListPlanRunsResponse {
	planRuns: PlanRunRow[];
}

/** `POST /plan-runs/:id/cancel` response envelope. */
export interface CancelPlanRunResponse {
	planRun: PlanRunRow;
	cancelledChild: { childSeq: number; runId: string } | null;
	alreadyTerminal: boolean;
}

/**
 * Options for {@link WarrenClient.streamPlanRunEvents}.
 *
 * Unlike {@link StreamRunEventsOptions}, there is **no `sinceSeq`** — the
 * `/plan-runs/:id/events` endpoint emits the union of every child run's
 * events and does not accept a `?since=` replay cursor. On reconnect,
 * callers must dedupe client-side by `(runId, seq)` since the snapshot is
 * replayed from the top each time the stream is (re)opened.
 */
export interface StreamPlanRunEventsOptions {
	/** Keep the connection open and emit new child events as they arrive. */
	follow?: boolean;
	/** External abort signal — closes the underlying HTTP body. */
	signal?: AbortSignal;
}
