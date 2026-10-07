import { WarrenClientError, WarrenUnreachableError } from "./errors.ts";

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
 * True for a poll failure worth retrying inside the wait budget (gh #1305):
 * a transport failure (`WarrenUnreachableError`) or a server-side 5xx. 4xx
 * (auth, not-found) and `AbortError` are not transient and fail fast.
 */
export function isTransientPollError(err: unknown): boolean {
	if (err instanceof WarrenUnreachableError) return true;
	return err instanceof WarrenClientError && err.status >= 500;
}

/**
 * Generic poll loop shared by {@link WarrenClient.waitForRun} and
 * {@link WarrenClient.waitForPlanRun}: fetch a row, fire `onTick`, return
 * once terminal, else sleep and retry until the timeout/abort fires. A
 * transient fetch failure (see {@link isTransientPollError}) is retried on
 * the same cadence until the deadline instead of aborting the wait (gh #1305).
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
		const last = await fetchRowOrTransient(input);
		if (last.kind === "row") {
			opts.onTick?.(last.row);
			if (input.isTerminal(last.row)) return last.row;
		}
		if (Date.now() + interval >= deadline) {
			const lastBit =
				last.kind === "row"
					? `last state: ${input.stateOf(last.row)}`
					: `last error: ${errorMessage(last.err)}`;
			throw new WarrenClientError(
				408,
				"wait_timeout",
				`${label} ${id} did not reach a terminal state within ${timeout}ms (${lastBit})`,
			);
		}
		await sleepWithSignal(interval, opts.signal);
	}
}

type PollAttempt<Row> =
	| { readonly kind: "row"; readonly row: Row }
	| { readonly kind: "transient"; readonly err: unknown };

async function fetchRowOrTransient<Row>(
	input: PollUntilTerminalInput<Row>,
): Promise<PollAttempt<Row>> {
	try {
		return { kind: "row", row: await input.fetchRow() };
	} catch (err) {
		if (!isTransientPollError(err)) throw err;
		return { kind: "transient", err };
	}
}

function errorMessage(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
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
