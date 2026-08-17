/**
 * `cancelRun` — docs/http-api.md `POST /runs/:id/cancel`.
 *
 * Forwards a graceful cancel to the run's runtime backend via
 * `provider.cancel(handle, reason?)` and emits a `cancel.requested` audit event
 * on the warren run's event log. The domain speaks only the `RuntimeProvider`
 * seam here — no backend vocabulary crosses this file (warren-b223): the
 * LocalProvider maps the call onto burrow's `POST /runs/:id/cancel`, the
 * K8sProvider onto SIGTERM + grace; cancel neither knows nor cares which.
 *
 * State transitions are deliberately *not* performed here directly. Reap
 * is the only path that takes a non-terminal warren run to a terminal
 * state, because the terminal transition is paired with the mulch merge,
 * seeds-close mirror, and branch push. If `cancelRun` finalized the row
 * inline, reap would skip those sub-steps via its `isTerminal`
 * short-circuit, and the operator would silently lose the agent's
 * partial work. The pipeline is:
 *
 *   warren cancelRun → provider cancels run → reap finalizes warren row.
 *
 * After the cancel the post-cancel phase is re-read out-of-band via
 * `provider.status(handle)` — the seam's `cancel()` returns `void`, so the
 * domain reads the phase itself. When that phase is in {succeeded, failed,
 * cancelled} — the typical case for a graceful cancel — `cancelRun` calls reap
 * inline rather than waiting for an external scheduler (warren-a69a). If the
 * backend reports a non-terminal phase (rare, only seen if the agent is
 * mid-graceful-shutdown), the in-stream terminal detector in `bridgeRunStream`
 * will catch the eventual terminal event and reap from there.
 *
 * Two corner cases bypass the seam entirely:
 *   1. The run is already terminal. The provider's cancel is itself idempotent,
 *      but warren can answer locally without a wire call.
 *   2. The run is queued and has no `sandboxRunId`. This is the partial spawn
 *      window: a sandbox was provisioned but the backend never accepted a run
 *      handle (or rolled it back). The warren row is queued with
 *      `sandboxRunId = null`. There is nothing remote to cancel, so the warren
 *      row is transitioned queued → cancelled directly. Bypasses the reap
 *      pipeline because there is no backend run to read events from. Idempotent
 *      against a concurrent spawn rollback because the state-machine guard
 *      catches the race.
 *
 * A lost run (the backend has no record of this handle) surfaces from the seam
 * as the neutral `RuntimeRunNotFoundError` (the LocalProvider maps a backend 404
 * onto it); cancel terminalizes the row here (warren-1f56 / warren-b1a9). Every
 * other error — a transport failure (`RuntimeUnreachableError`, which
 * `BurrowUnreachableError` now extends) or a backend server envelope — passes
 * through unchanged so the HTTP route can map it onto the response envelope.
 */

import { ValidationError } from "../core/errors.ts";
import { isTerminalRunState, type RunState } from "../core/wire.ts";
import type { Repos } from "../db/repos/index.ts";
import type { RunHandle, RuntimeProvider } from "../runtime/contract.ts";
import { RuntimeRunNotFoundError } from "../runtime/errors.ts";
import type { RunEventBroker } from "./events.ts";
import type { AutoOpenPrConfig } from "./pr.ts";
import type { ReapRunInput, ReapRunResult } from "./reap/index.ts";
import type { BridgeLogger } from "./stream/index.ts";

/**
 * The inline-reap seam (warren-b223 — the `WatchdogReap` pattern from
 * warren-1fce). Reap no longer takes a burrow client (warren-e24d), so this is
 * the plain `ReapRunInput`; the wiring layer binds any provider-derived seams
 * into the boot closure it supplies as `reap`. cancel.ts
 * finalizes a terminal-cancelled run inline but no longer holds a burrow client
 * to build `reapRun` itself (reap still needs one for its workspace reads until
 * warren-fbbf sheds it), so the wiring layer binds the client and hands cancel a
 * closure that takes every reap input EXCEPT the client. Keeps this file free of
 * any `@os-eco/burrow-cli` / `burrow-client` import.
 */
export type CancelReap = (input: ReapRunInput) => Promise<ReapRunResult>;

export interface CancelRunInput {
	readonly runId: string;
	readonly reason?: string;
	readonly repos: Repos;
	/**
	 * Runtime-provider seam (K8s migration pl-829f step 13 / warren-1f56 /
	 * warren-b223). The graceful cancel is `provider.cancel(handle, reason?)` and
	 * the post-cancel phase re-read is `provider.status(handle)` — the provider
	 * owns resolving its backend (LocalProvider resolves the sole burrow worker;
	 * K8sProvider talks to the pod). Required: cancel no longer constructs a
	 * fallback provider of its own — the caller resolves it once from
	 * `WARREN_RUNTIME` (same posture as `steerRun`).
	 */
	readonly runtimeProvider: RuntimeProvider;
	/** If supplied, the audit event is published here too. */
	readonly broker?: RunEventBroker;
	readonly now?: () => Date;
	/**
	 * The inline-reap seam (warren-b223). Fired when the post-cancel phase is
	 * terminal (warren-a69a) so the warren row finalizes inline without depending
	 * on an external reap scheduler. Pre-bound with the runtime's burrow client by
	 * the wiring layer (see `CancelReap`); tests inject their own to capture the
	 * call. OPTIONAL only so callers on a non-terminal path need not wire it — a
	 * terminal cancel with no reap seam degrades to the bridge terminal-detect
	 * reap (the same graceful fallback as before warren-a69a).
	 */
	readonly reap?: CancelReap;
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
	/** Warren run state after the call. Unchanged for the common path; only updated for the no-sandboxRunId direct cancel. */
	readonly state: RunState;
	/**
	 * Post-cancel backend run snapshot, or null when the wire call was bypassed
	 * (already-terminal / no-sandboxRunId / lost). Narrowed to `{ id, state }`
	 * (warren-1f56) — the only fields the HTTP response and the UI
	 * (`CancelRunResponse.sandboxRun`) read. `id` is the (warren-side) sandboxRunId;
	 * `state` is sourced from `provider.status()`, since the seam returns `void`
	 * from `cancel()` and the domain re-reads the phase out-of-band.
	 */
	readonly sandboxRun: { readonly id: string; readonly state: RunState } | null;
	/** True when the warren row was already terminal on entry — no work was done. */
	readonly alreadyTerminal: boolean;
}

export async function cancelRun(input: CancelRunInput): Promise<CancelRunResult> {
	const run = await input.repos.runs.require(input.runId);

	if (isTerminal(run.state)) {
		return { state: run.state, sandboxRun: null, alreadyTerminal: true };
	}

	if (run.sandboxRunId === null) {
		// Partial spawn — the backend never accepted a run handle. The warren
		// state machine allows queued → cancelled directly. A running row
		// without a backend run id is not a state the spawn flow can produce,
		// so reject it loudly.
		if (run.state !== "queued") {
			throw new ValidationError(
				`run is in state '${run.state}' but has no sandbox_run_id; cannot cancel`,
			);
		}
		const updated = await input.repos.runs.finalize(run.id, "cancelled", input.now?.());
		await emitCancelEvent(input, run.id, { reason: input.reason, mode: "warren_only" });
		return { state: updated.state, sandboxRun: null, alreadyTerminal: false };
	}

	const sandboxRunId = run.sandboxRunId;
	if (run.sandboxId === null) {
		// A run with a sandboxRunId always has a sandboxId (spawn writes them
		// in that order). Defensive narrowing for noUncheckedIndexedAccess.
		throw new ValidationError(
			`run '${run.id}' has sandbox_run_id but no sandbox_id; cannot resolve worker`,
		);
	}
	// The seam handle: `sandboxId` is the sandbox/burrow id, `providerRunId` the
	// backend run id cancel is scoped to.
	const handle: RunHandle = {
		runId: run.id,
		sandboxId: run.sandboxId,
		providerRunId: sandboxRunId,
	};
	try {
		await input.runtimeProvider.cancel(handle, input.reason);
	} catch (err) {
		if (err instanceof RuntimeRunNotFoundError) {
			// warren-b1a9: the backend has no record of this run (ghost). Treat the
			// cancel intent as "terminalize this row now" — the user clicked
			// Cancel, the run is unrecoverable, give them a clean response
			// instead of the raw `run not found` error.
			const now = (input.now ?? (() => new Date()))();
			if (run.state === "queued") {
				await input.repos.runs.markRunning(run.id, now);
			}
			const finalized = await input.repos.runs.finalize(run.id, "failed", now, "sandbox_run_lost");
			await emitCancelEvent(input, run.id, {
				reason: input.reason,
				mode: "sandbox_run_lost",
				sandboxRunId,
			});
			return { state: finalized.state, sandboxRun: null, alreadyTerminal: false };
		}
		throw err;
	}

	// The seam's `cancel()` returns void (it discards the backend's post-cancel
	// row), so re-read the run's phase out-of-band via `status()` — the domain
	// needs it for the inline-reap decision and the HTTP response's
	// `sandboxRun.state`.
	const status = await input.runtimeProvider.status(handle);
	// warren-fe9b / warren-d15c: when the post-cancel read shows the run already
	// GONE (`exists:false`), that absence is our own delete landing — the cancel
	// intent wins over the lost mapping, so the row reaps to `cancelled`, never
	// `failed/sandbox_run_lost`. (On K8s the common case is a `Terminating` pod
	// still reading `running`; the watchdog's cancel fast path then finalizes
	// the row once the pod is confirmed gone.)
	const sandboxState: RunState = status.exists ? status.phase : "cancelled";

	await emitCancelEvent(input, run.id, {
		reason: input.reason,
		mode: "forwarded",
		sandboxRunId,
		sandboxRunState: sandboxState,
	});

	// warren-a69a: when the backend reports a terminal state for the cancelled
	// run, finalize the warren row inline rather than waiting for a
	// separate reap scheduler. reap is idempotent and best-effort, so
	// failures land on the run's event log without escaping the cancel
	// response.
	let stateAfter: RunState = run.state;
	if (isTerminalRunState(sandboxState)) {
		const reap = input.reap ?? reapSeamNotConfigured;
		try {
			const result = await reap({
				runId: run.id,
				outcome: sandboxState,
				repos: input.repos,
				// warren-a7cb: route the cancel-path reap's finalize + terminate
				// through the active backend (in-pod under WARREN_RUNTIME=k8s).
				runtimeProvider: input.runtimeProvider,
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
					sandboxRunId,
					err: err instanceof Error ? err.message : String(err),
				},
				"reap threw out of cancel terminal-detect path",
			);
		}
	}

	return {
		state: stateAfter,
		sandboxRun: { id: sandboxRunId, state: sandboxState },
		alreadyTerminal: false,
	};
}

/**
 * Default `reap` seam when a caller omits it on a path that turns out terminal.
 * Mirrors the bridge registry's boot-supplied-or-throw idiom (warren-5a3f): the
 * throw is caught + logged by the terminal-detect try/catch above, so a missing
 * reap seam degrades gracefully to the bridge reap rather than crashing cancel.
 */
function reapSeamNotConfigured(): Promise<ReapRunResult> {
	throw new Error("cancelRun: reap seam not configured (terminal cancel needs a pre-bound reap)");
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
		sandboxEventSeq: seq,
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
