import { WarrenClientError } from "./errors.ts";

/** Default poll cadence for {@link WarrenClient.waitForRun}. */
export const DEFAULT_POLL_INTERVAL_MS = 2_000;

/** Default overall budget for {@link WarrenClient.waitForRun}. */
export const DEFAULT_POLL_TIMEOUT_MS = 30 * 60 * 1_000;

export interface PollUntilTerminalInput<Row> {
	readonly label: string;
	readonly id: string;
	readonly opts: {
		intervalMs?: number;
		timeoutMs?: number;
		signal?: AbortSignal;
		onTick?: (row: Row) => void;
	};
	readonly fetchRow: () => Promise<Row>;
	readonly isTerminal: (row: Row) => boolean;
	readonly stateOf: (row: Row) => string;
}

/**
 * Generic poll loop shared by {@link WarrenClient.waitForRun} and
 * {@link WarrenClient.waitForPlanRun}: fetch a row, fire `onTick`, return
 * once terminal, else sleep and retry until the timeout/abort fires.
 */
export async function pollUntilTerminal<Row>(input: PollUntilTerminalInput<Row>): Promise<Row> {
	const { label, id, opts } = input;
	const interval = opts.intervalMs ?? DEFAULT_POLL_INTERVAL_MS;
	const timeout = opts.timeoutMs ?? DEFAULT_POLL_TIMEOUT_MS;
	const deadline = Date.now() + timeout;
	for (;;) {
		if (opts.signal?.aborted) {
			throw new DOMException(`waitFor ${label} aborted`, "AbortError");
		}
		const row = await input.fetchRow();
		opts.onTick?.(row);
		if (input.isTerminal(row)) return row;
		if (Date.now() + interval >= deadline) {
			throw new WarrenClientError(
				408,
				"wait_timeout",
				`${label} ${id} did not reach a terminal state within ${timeout}ms (last state: ${input.stateOf(row)})`,
			);
		}
		await sleepWithSignal(interval, opts.signal);
	}
}

/**
 * Promise-based delay that resolves early if `signal` aborts. Used by
 * {@link WarrenClient.waitForRun}. Throws `AbortError` on abort so the
 * outer poll loop can propagate the cancellation.
 */
export function sleepWithSignal(ms: number, signal?: AbortSignal): Promise<void> {
	return new Promise<void>((resolve, reject) => {
		if (signal?.aborted) {
			reject(new DOMException("waitForRun aborted", "AbortError"));
			return;
		}
		const timer = setTimeout(() => {
			signal?.removeEventListener("abort", onAbort);
			resolve();
		}, ms);
		const onAbort = () => {
			clearTimeout(timer);
			reject(new DOMException("waitForRun aborted", "AbortError"));
		};
		signal?.addEventListener("abort", onAbort, { once: true });
	});
}
