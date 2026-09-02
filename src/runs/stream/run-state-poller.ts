/**
 * Run-state fallback (warren-6596). Polls burrow's `runs.get` in
 * parallel with the event stream so raw-text / declarative agents (no
 * in-stream terminal envelope) still reach terminal in warren.
 *
 * On the first terminal observation the poller records the snapshot,
 * sleeps a short drain window so tailBurrow's next 200ms cycle picks
 * up final events, then aborts the stream. Errors are swallowed — the
 * main stream's own error handling is authoritative for transport
 * failures.
 */

import type { RunFailureReason, RunTerminalState } from "../../db/schema.ts";
import type { RunHandle, RuntimeProvider, TerminalReason } from "../../runtime/contract.ts";
import type { BridgeLogger, BurrowTerminalSnapshot, RunStateProbe } from "./types.ts";

const BURROW_TERMINAL_STATES = new Set<RunTerminalState>(["succeeded", "failed", "cancelled"]);

/**
 * Default run-state probe (warren-1f56): project the run's
 * `provider.status(handle)` reconcile snapshot to the {state, exitCode,
 * terminalReason} triple the poller needs — the seam replacement for the raw
 * `runs.get` this used to call. `status()` never throws on a missing run: it
 * returns `exists:false`, which the probe maps to `null` so the poller keeps
 * polling (transient) and the event stream's own 404 path (now the neutralized
 * `RuntimeRunNotFoundError` → `sandboxRunMissing`) stays authoritative for the
 * ghost-run reconciliation — exactly as burrow's 404 bubbled before. Real
 * transport failures (`BurrowUnreachableError`) still throw out of `status()`
 * and are swallowed + retried by the poller's own catch. `terminalReason` rides
 * through so the poller can surface `oom_killed` (warren-9cce).
 *
 * SEAM SIGNAL (step 13): `provider.status()` pays an EXTRA burrow events replay
 * to compute its `lastEventSeq` cursor, which this poller does not consume (the
 * warren DB's `maxSeqForRun` is the authoritative resume cursor). The poll
 * cadence is deliberately light (1 status/run/2s), so the drain cost is
 * acceptable for the LocalProvider; a K8s backend would carry the state as cheap
 * pod metadata instead.
 */
export function defaultRunStateProbe(provider: RuntimeProvider, handle: RunHandle): RunStateProbe {
	return async (_sandboxRunId, _signal) => {
		const status = await provider.status(handle);
		// `exists:false` ⇒ the backend lost the run. Return null (transient) and
		// let the stream's own ghost-run path finalize it, mirroring today's
		// "probe 404 bubbles/swallowed; stream sets sandboxRunMissing" split.
		if (!status.exists) return null;
		return {
			state: status.phase,
			exitCode: status.exitCode,
			...(status.terminalReason !== undefined ? { terminalReason: status.terminalReason } : {}),
		};
	};
}

export interface RunStatePollerInput {
	readonly probe: RunStateProbe;
	readonly sandboxRunId: string;
	readonly ctrl: AbortController;
	readonly pollIntervalMs: number;
	readonly drainMs: number;
	readonly observed: { value: BurrowTerminalSnapshot | null };
	readonly runId: string;
	readonly logger?: BridgeLogger;
}

/**
 * Poll burrow's run state in parallel with the event stream. On first
 * terminal observation: record the snapshot, sleep the drain window so
 * tailBurrow's next 200ms cycle picks up final events, then abort the
 * stream. Errors are swallowed — the stream's own error handling is
 * authoritative for transport failures.
 */
export async function runStatePoller(input: RunStatePollerInput): Promise<void> {
	const { probe, sandboxRunId, ctrl, pollIntervalMs, drainMs, observed, runId, logger } = input;
	while (!ctrl.signal.aborted) {
		try {
			const row = await probe(sandboxRunId, ctrl.signal);
			if (row !== null && isBurrowTerminal(row.state)) {
				observed.value = toTerminalSnapshot(row.state, row.exitCode, row.terminalReason);
				logger?.info?.(
					{
						runId,
						sandboxRunId,
						sandboxState: row.state,
						exitCode: row.exitCode,
						terminalReason: row.terminalReason,
					},
					"run-state poller observed burrow terminal; draining stream before abort",
				);
				await sleepMs(drainMs, ctrl.signal);
				ctrl.abort();
				return;
			}
		} catch (err) {
			// BurrowNotFoundError or transport failure — let the main stream
			// loop classify (404 → sandboxRunMissing, others → errored). The
			// poller doesn't make those calls itself; it just keeps trying
			// until the stream aborts.
			logger?.warn?.(
				{
					runId,
					sandboxRunId,
					err: err instanceof Error ? err.message : String(err),
				},
				"run-state poller probe failed; retrying",
			);
		}
		if (await sleepMs(pollIntervalMs, ctrl.signal)) return;
	}
}

function isBurrowTerminal(state: string): state is RunTerminalState {
	return BURROW_TERMINAL_STATES.has(state as RunTerminalState);
}

/**
 * The seam `terminalReason` values that map 1:1 onto a domain `failure_reason`
 * the poller carries onto the finalized run (warren-9cce, warren-c0cd). Reasons
 * absent here are already covered by `state` (e.g. `completed` → succeeded,
 * `cancelled` → cancelled), so they need no distinct `failure_reason`.
 */
const TERMINAL_REASON_TO_FAILURE_REASON: Partial<Record<TerminalReason, RunFailureReason>> = {
	oom_killed: "oom_killed",
	evicted: "evicted",
	preempted: "preempted",
};

/**
 * Build the terminal snapshot the poller records, distilling the seam's coarse
 * `terminalReason` into a domain `failure_reason` (warren-9cce, warren-c0cd).
 * `oom_killed` (a cgroup kill), `evicted` (a kubelet pod eviction, most often
 * ephemeral-storage exhaustion) and `preempted` (a Spot-node reclamation,
 * warren-ea4b) all ride through to the finalized run's
 * `failure_reason` instead of collapsing into an anonymous error; every other
 * reason is already covered by `state`.
 */
function toTerminalSnapshot(
	state: RunTerminalState,
	exitCode: number | null,
	terminalReason: TerminalReason | undefined,
): BurrowTerminalSnapshot {
	const failureReason =
		terminalReason !== undefined ? TERMINAL_REASON_TO_FAILURE_REASON[terminalReason] : undefined;
	return {
		state,
		exitCode,
		...(failureReason !== undefined ? { failureReason } : {}),
	};
}

/** Resolve after `ms` or return true when the signal fires first. */
function sleepMs(ms: number, signal: AbortSignal): Promise<boolean> {
	if (ms <= 0) return Promise.resolve(signal.aborted);
	return new Promise<boolean>((resolve) => {
		const timer = setTimeout(() => {
			signal.removeEventListener("abort", onAbort);
			resolve(false);
		}, ms);
		const onAbort = (): void => {
			clearTimeout(timer);
			resolve(true);
		};
		if (signal.aborted) {
			clearTimeout(timer);
			resolve(true);
			return;
		}
		signal.addEventListener("abort", onAbort, { once: true });
	});
}
