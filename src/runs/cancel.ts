/**
 * `cancelRun` — SPEC §8.1 `POST /runs/:id/cancel`.
 *
 * Forwards a graceful cancel to burrow's `POST /runs/:burrow_run_id/cancel`
 * and emits a `cancel.requested` audit event on the warren run's event log.
 *
 * State transitions are deliberately *not* performed here directly. Reap
 * is the only path that takes a non-terminal warren run to a terminal
 * state, because the terminal transition is paired with the mulch merge,
 * seeds-close mirror, and branch push. If `cancelRun` finalized the row
 * inline, reap would skip those sub-steps via its `isTerminal`
 * short-circuit, and the operator would silently lose the agent's
 * partial work. The pipeline is:
 *
 *   warren cancelRun → burrow cancels run → reap finalizes warren row.
 *
 * The cancel response from burrow already carries the burrow run's
 * post-cancel state. When that state is in {succeeded, failed, cancelled}
 * — the typical case for a graceful cancel — `cancelRun` calls reap
 * inline rather than waiting for an external scheduler (warren-a69a).
 * If burrow returns a non-terminal state (rare, only seen if the agent
 * is mid-graceful-shutdown), the in-stream terminal detector in
 * `bridgeRunStream` will catch the eventual terminal event and reap
 * from there.
 *
 * Two corner cases bypass burrow:
 *   1. The run is already terminal. Burrow's cancel is itself idempotent
 *      (200 with the current row), but warren can answer locally without
 *      a wire call.
 *   2. The run is queued and has no `burrow_run_id`. This is the partial
 *      spawn window: a burrow was provisioned but `POST /burrows/:id/runs`
 *      never landed (or rolled back). The warren row is queued with
 *      burrow_run_id = null. There is nothing remote to cancel, so the
 *      warren row is transitioned queued → cancelled directly. Bypasses
 *      the reap pipeline because there's no burrow_run_id to read events
 *      from. Idempotent against a concurrent spawn rollback because
 *      the state-machine guard catches the race.
 *
 * Errors from burrow (`BurrowError`) and the transport layer
 * (`BurrowUnreachableError`) pass through unchanged so the HTTP route can
 * map them onto the response envelope.
 */

import { NotFoundError as BurrowNotFoundError, type Run as BurrowRun } from "@os-eco/burrow-cli";
import { withTransportMapping } from "../burrow-client/client.ts";
import type { BurrowClientPool } from "../burrow-client/pool.ts";
import { ValidationError } from "../core/errors.ts";
import type { Repos } from "../db/repos/index.ts";
import { RUN_TERMINAL_STATES, type RunState, type RunTerminalState } from "../db/schema.ts";
import type { RunEventBroker } from "./events.ts";
import type { AutoOpenPrConfig } from "./pr.ts";
import { type ReapRunInput, type ReapRunResult, reapRun } from "./reap/index.ts";
import type { BridgeLogger } from "./stream.ts";

export interface CancelRunInput {
	readonly runId: string;
	readonly reason?: string;
	readonly repos: Repos;
	/**
	 * Multi-worker burrow pool (warren-c0c9 / pl-9ba1 step 5). cancel resolves
	 * the owning worker via `pool.clientFor({burrowId: run.burrowId})` so the
	 * cancel POST routes to the worker that hosts the burrow. Propagates
	 * `StickyWorkerUnreachableError` (503 via src/server/errors.ts) when the
	 * pinned worker is `unreachable`.
	 */
	readonly burrowClientPool: BurrowClientPool;
	/** If supplied, the audit event is published here too. */
	readonly broker?: RunEventBroker;
	readonly now?: () => Date;
	/**
	 * Override reap (tests). Defaults to the live `reapRun`. Fired when
	 * the burrow cancel response carries a terminal `state` (warren-a69a)
	 * so the warren row finalizes inline without depending on an external
	 * reap scheduler.
	 */
	readonly reap?: (input: ReapRunInput) => Promise<ReapRunResult>;
	readonly logger?: BridgeLogger;
	/**
	 * Auto-open-PR config (warren-f6af). Forwarded to reap so a graceful
	 * cancel that reaches a terminal state still gets PR auto-open. Reap
	 * skips the step internally when `outcome !== "succeeded"`, so a
	 * cancel-to-cancelled transition won't open a PR even with this set.
	 */
	readonly autoOpenPr?: AutoOpenPrConfig;
}

export interface CancelRunResult {
	/** Warren run state after the call. Unchanged for the common path; only updated for the no-burrow_run_id direct cancel. */
	readonly state: RunState;
	/** The burrow run row returned by burrow's cancel endpoint, or null when the call was bypassed (terminal / no burrow_run_id). */
	readonly burrowRun: BurrowRun | null;
	/** True when the warren row was already terminal on entry — no work was done. */
	readonly alreadyTerminal: boolean;
}

export async function cancelRun(input: CancelRunInput): Promise<CancelRunResult> {
	const run = await input.repos.runs.require(input.runId);

	if (isTerminal(run.state)) {
		return { state: run.state, burrowRun: null, alreadyTerminal: true };
	}

	if (run.burrowRunId === null) {
		// Partial spawn — never made it to POST /burrows/:id/runs. The warren
		// state machine allows queued → cancelled directly. A running row
		// without a burrow_run_id is not a state the spawn flow can produce,
		// so reject it loudly.
		if (run.state !== "queued") {
			throw new ValidationError(
				`run is in state '${run.state}' but has no burrow_run_id; cannot cancel`,
			);
		}
		const updated = await input.repos.runs.finalize(run.id, "cancelled", input.now?.());
		await emitCancelEvent(input, run.id, { reason: input.reason, mode: "warren_only" });
		return { state: updated.state, burrowRun: null, alreadyTerminal: false };
	}

	const burrowRunId = run.burrowRunId;
	if (run.burrowId === null) {
		// A run with a burrowRunId always has a burrowId (spawn writes them
		// in that order). Defensive narrowing for noUncheckedIndexedAccess.
		throw new ValidationError(
			`run '${run.id}' has burrow_run_id but no burrow_id; cannot resolve worker`,
		);
	}
	const { client } = await input.burrowClientPool.clientFor({ burrowId: run.burrowId });
	let burrowRun: BurrowRun;
	try {
		burrowRun = await withTransportMapping(client.config, () =>
			client.http.runs.cancel(
				burrowRunId,
				input.reason !== undefined ? { reason: input.reason } : {},
			),
		);
	} catch (err) {
		if (err instanceof BurrowNotFoundError) {
			// warren-b1a9: burrow has no record of this run (ghost). Treat the
			// cancel intent as "terminalize this row now" — the user clicked
			// Cancel, the run is unrecoverable, give them a clean response
			// instead of the raw `run not found: run_xxx`.
			const now = (input.now ?? (() => new Date()))();
			if (run.state === "queued") {
				await input.repos.runs.markRunning(run.id, now);
			}
			const finalized = await input.repos.runs.finalize(run.id, "failed", now, "burrow_run_lost");
			await emitCancelEvent(input, run.id, {
				reason: input.reason,
				mode: "burrow_run_lost",
				burrowRunId,
			});
			return { state: finalized.state, burrowRun: null, alreadyTerminal: false };
		}
		throw err;
	}

	await emitCancelEvent(input, run.id, {
		reason: input.reason,
		mode: "forwarded",
		burrowRunId,
		burrowRunState: burrowRun.state,
	});

	// warren-a69a: when burrow returns a terminal state for the cancelled
	// run, finalize the warren row inline rather than waiting for a
	// separate reap scheduler. reap is idempotent and best-effort, so
	// failures land on the run's event log without escaping the cancel
	// response.
	let stateAfter: RunState = run.state;
	if (isTerminalRunState(burrowRun.state)) {
		const reap = input.reap ?? reapRun;
		try {
			const result = await reap({
				runId: run.id,
				outcome: burrowRun.state,
				repos: input.repos,
				burrowClientPool: input.burrowClientPool,
				...(input.broker !== undefined ? { broker: input.broker } : {}),
				...(input.now !== undefined ? { now: input.now } : {}),
				...(input.logger !== undefined ? { logger: input.logger } : {}),
				...(input.autoOpenPr !== undefined ? { autoOpenPr: input.autoOpenPr } : {}),
			});
			stateAfter = result.state;
		} catch (err) {
			input.logger?.error?.(
				{
					runId: run.id,
					burrowRunId,
					err: err instanceof Error ? err.message : String(err),
				},
				"reap threw out of cancel terminal-detect path",
			);
		}
	}

	return { state: stateAfter, burrowRun, alreadyTerminal: false };
}

function isTerminalRunState(state: RunState): state is RunTerminalState {
	return (RUN_TERMINAL_STATES as readonly RunState[]).includes(state);
}

async function emitCancelEvent(
	input: CancelRunInput,
	runId: string,
	payload: object,
): Promise<void> {
	const now = input.now ?? (() => new Date());
	const seq = ((await input.repos.events.maxSeqForRun(runId)) ?? 0) + 1;
	const row = await input.repos.events.append({
		runId,
		burrowEventSeq: seq,
		ts: now().toISOString(),
		kind: "cancel.requested",
		stream: "system",
		payload,
	});
	input.broker?.publish(runId, row);
}

function isTerminal(state: string): boolean {
	return state === "succeeded" || state === "failed" || state === "cancelled";
}
