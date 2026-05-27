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

import type { BurrowClient } from "../../burrow-client/client.ts";
import { withTransportMapping } from "../../burrow-client/client.ts";
import type { RunTerminalState } from "../../db/schema.ts";
import type { BridgeLogger, BurrowTerminalSnapshot, RunStateProbe } from "./types.ts";

const BURROW_TERMINAL_STATES = new Set<RunTerminalState>(["succeeded", "failed", "cancelled"]);

/**
 * Default run-state probe: project burrow's `runs.get` to the
 * {state, exitCode} pair the poller needs. `BurrowNotFoundError` bubbles
 * up so the bridge's main catch block records `burrowRunMissing` exactly
 * once instead of fighting with the stream's own 404. Other transport
 * errors return null and the poller retries on the next tick.
 */
export function defaultRunStateProbe(client: BurrowClient): RunStateProbe {
	return async (burrowRunId, _signal) => {
		const run = await withTransportMapping(client.config, () => client.http.runs.get(burrowRunId));
		return { state: run.state, exitCode: run.exitCode };
	};
}

export interface RunStatePollerInput {
	readonly probe: RunStateProbe;
	readonly burrowRunId: string;
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
	const { probe, burrowRunId, ctrl, pollIntervalMs, drainMs, observed, runId, logger } = input;
	while (!ctrl.signal.aborted) {
		try {
			const row = await probe(burrowRunId, ctrl.signal);
			if (row !== null && isBurrowTerminal(row.state)) {
				observed.value = { state: row.state, exitCode: row.exitCode };
				logger?.info?.(
					{ runId, burrowRunId, burrowState: row.state, exitCode: row.exitCode },
					"run-state poller observed burrow terminal; draining stream before abort",
				);
				await sleepMs(drainMs, ctrl.signal);
				ctrl.abort();
				return;
			}
		} catch (err) {
			// BurrowNotFoundError or transport failure — let the main stream
			// loop classify (404 → burrowRunMissing, others → errored). The
			// poller doesn't make those calls itself; it just keeps trying
			// until the stream aborts.
			logger?.warn?.(
				{
					runId,
					burrowRunId,
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
