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
 * Errors from the transport layer (`BurrowUnreachableError`) pass through
 * unchanged so the HTTP route can map them onto the response envelope; a lost
 * run (backend 404) is neutralized by the seam into `RuntimeRunNotFoundError`
 * and terminalized here (warren-1f56).
 */

import type { BurrowClient } from "../burrow-client/index.ts";
import { ValidationError } from "../core/errors.ts";
import type { Repos } from "../db/repos/index.ts";
import { RUN_TERMINAL_STATES, type RunState, type RunTerminalState } from "../db/schema.ts";
import type { RunHandle, RuntimeProvider } from "../runtime/contract.ts";
import { RuntimeRunNotFoundError } from "../runtime/errors.ts";
import { resolveRuntimeProvider } from "../runtime/registry.ts";
import type { RunEventBroker } from "./events.ts";
import type { AutoOpenPrConfig } from "./pr.ts";
import { type ReapRunInput, type ReapRunResult, reapRun } from "./reap/index.ts";
import type { BridgeLogger } from "./stream/index.ts";

export interface CancelRunInput {
	readonly runId: string;
	readonly reason?: string;
	readonly repos: Repos;
	/**
	 * Burrow-client pool (warren-c0c9 / pl-9ba1 step 5). Still threaded because
	 * the inline `reap` it forwards to resolves the burrow workspace through it,
	 * and it backs the default `runtimeProvider` fallback below.
	 */
	readonly burrowClient: BurrowClient;
	/**
	 * Runtime-provider seam (K8s migration pl-829f step 13 / warren-1f56). The
	 * graceful cancel is `provider.cancel(handle, reason?)` and the post-cancel
	 * state re-read is `provider.status(handle)` — the provider owns resolving
	 * its backend (LocalProvider resolves the sole burrow worker; placement is
	 * retired at the seam). Optional: defaults to a burrow-backed `LocalProvider`
	 * over `burrowClient` so callers that only wire the pool keep working
	 * (same fallback shape as `reapRun`).
	 */
	readonly runtimeProvider?: RuntimeProvider;
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
	/**
	 * Post-cancel backend run snapshot, or null when the wire call was bypassed
	 * (already-terminal / no-burrow_run_id / lost). Narrowed from burrow's full
	 * `Run` row to `{ id, state }` (warren-1f56) — the only fields the HTTP
	 * response and the UI (`CancelRunResponse.burrowRun`) read. `id` is the
	 * (warren-side) burrowRunId; `state` is sourced from `provider.status()`,
	 * since the seam returns `void` from `cancel()` and the domain re-reads the
	 * phase out-of-band.
	 */
	readonly burrowRun: { readonly id: string; readonly state: RunState } | null;
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
	// Runtime-provider seam (warren-1f56). When no provider is threaded, resolve
	// through the single registry selector (warren-aa4a) — honoring `WARREN_RUNTIME`
	// — instead of hardcoding a LocalProvider, so callers that only pass
	// `burrowClient` keep their behavior (same fallback shape as `reapRun`).
	const provider: RuntimeProvider =
		input.runtimeProvider ?? resolveRuntimeProvider({ burrowClient: () => input.burrowClient });
	// The seam handle: `sandboxId` is the burrowId, `providerRunId` the burrowRunId
	// cancel is scoped to.
	const handle: RunHandle = {
		runId: run.id,
		sandboxId: run.burrowId,
		providerRunId: burrowRunId,
	};
	try {
		await provider.cancel(handle, input.reason);
	} catch (err) {
		if (err instanceof RuntimeRunNotFoundError) {
			// warren-b1a9: the backend has no record of this run (ghost). Treat the
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

	// The seam's `cancel()` returns void (it discards burrow's post-cancel row),
	// so re-read the run's phase out-of-band via `status()` — the domain needs it
	// for the inline-reap decision and the HTTP response's `burrowRun.state`.
	const status = await provider.status(handle);
	const burrowState = status.phase;

	await emitCancelEvent(input, run.id, {
		reason: input.reason,
		mode: "forwarded",
		burrowRunId,
		burrowRunState: burrowState,
	});

	// warren-a69a: when the backend reports a terminal state for the cancelled
	// run, finalize the warren row inline rather than waiting for a
	// separate reap scheduler. reap is idempotent and best-effort, so
	// failures land on the run's event log without escaping the cancel
	// response.
	let stateAfter: RunState = run.state;
	if (isTerminalRunState(burrowState)) {
		const reap = input.reap ?? reapRun;
		try {
			const result = await reap({
				runId: run.id,
				outcome: burrowState,
				repos: input.repos,
				burrowClient: input.burrowClient,
				// warren-a7cb: route the cancel-path reap's finalize + terminate
				// through the active backend (in-pod under WARREN_RUNTIME=k8s).
				// Omitted ⇒ burrow-backed LocalProvider (self-host byte-identical).
				...(input.runtimeProvider !== undefined ? { runtimeProvider: input.runtimeProvider } : {}),
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

	return {
		state: stateAfter,
		burrowRun: { id: burrowRunId, state: burrowState },
		alreadyTerminal: false,
	};
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
