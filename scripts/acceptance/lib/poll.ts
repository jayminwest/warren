/**
 * Shared poll primitives for the acceptance harness (warren-bb51).
 *
 * Every "wait until X" in the harness funnels through {@link pollAcceptance},
 * a thin AcceptanceError-flavored wrapper over the SDK's `pollUntilTerminal`
 * (src/client/client-helpers.ts), so poll cadence, timeout math, and the
 * sleep inside the loop live in exactly one place. Scenarios wait on run
 * terminality through the SDK's `waitForRun` (see
 * scenarios/lib/poll-helpers.ts); everything else composes pollAcceptance.
 */
import { existsSync } from "node:fs";

import { pollUntilTerminal } from "../../../src/client/client-helpers.ts";
import { WarrenClientError } from "../../../src/client/errors.ts";
import { AcceptanceError } from "./assert.ts";

/** Default harness poll cadence. */
export const ACCEPTANCE_POLL_INTERVAL_MS = 500;

interface PollAcceptanceBase<T> {
	/** Noun used in the timeout message, e.g. "run", "healthz". */
	readonly label: string;
	/** Identifier used in the timeout message (run id, URL, path). */
	readonly id: string;
	readonly timeoutMs: number;
	readonly intervalMs?: number;
	readonly fetchRow: () => Promise<T>;
	/** Render the last-seen row for the timeout message. */
	readonly describe: (row: T) => string;
	/**
	 * Inspect each fetched row; throw (e.g. AcceptanceError) to fail fast
	 * when the row proves the wait can never succeed, like a run reaching a
	 * terminal state other than the target.
	 */
	readonly onRow?: (row: T) => void;
}

export interface PollAcceptanceInput<T> extends PollAcceptanceBase<T> {
	readonly isDone: (row: T) => boolean;
}

export interface PollAcceptanceGuardInput<T, D extends T> extends PollAcceptanceBase<T> {
	/** Type-guard form: the resolved value is narrowed to `D`. */
	readonly isDone: (row: T) => row is D;
}

/**
 * Poll `fetchRow` until `isDone`, the timeout fires, or `onRow` throws.
 * The SDK's 408 `wait_timeout` is re-thrown as an AcceptanceError so
 * scenario failures carry the harness error type.
 */
export async function pollAcceptance<T, D extends T>(
	input: PollAcceptanceGuardInput<T, D>,
): Promise<D>;
export async function pollAcceptance<T>(input: PollAcceptanceInput<T>): Promise<T>;
export async function pollAcceptance<T>(input: PollAcceptanceInput<T>): Promise<T> {
	try {
		return await pollUntilTerminal({
			label: input.label,
			id: input.id,
			opts: {
				intervalMs: input.intervalMs ?? ACCEPTANCE_POLL_INTERVAL_MS,
				timeoutMs: input.timeoutMs,
				...(input.onRow !== undefined ? { onTick: input.onRow } : {}),
			},
			fetchRow: input.fetchRow,
			isTerminal: input.isDone,
			stateOf: input.describe,
		});
	} catch (err) {
		if (err instanceof WarrenClientError && err.status === 408) {
			throw new AcceptanceError(err.message);
		}
		throw err;
	}
}

/**
 * Poll `GET <baseUrl>/healthz` until it answers 200 (warren boot).
 *
 * Uses its own backoff loop instead of the fixed-cadence pollAcceptance
 * (warren-f074): the happy path is a boot that answers within the first
 * few hundred ms, so the loop starts at 100ms and doubles up to a 1s
 * cap. Slow CI runners get the full timeout window without paying a
 * fixed 500ms cadence; local runs stay fast. The timeout error mirrors
 * pollUntilTerminal's message shape so scenario output reads the same.
 */
export async function waitForHealthz(baseUrl: string, timeoutMs: number): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	let intervalMs = 100;
	let last = "no probe completed";
	for (;;) {
		try {
			const res = await fetch(`${baseUrl}/healthz`, { method: "GET" });
			last = res.status === 200 ? "ok" : `status ${res.status}`;
		} catch (err) {
			last = `error: ${err instanceof Error ? err.message : String(err)}`;
		}
		if (last === "ok") return;
		const remaining = deadline - Date.now();
		if (remaining <= 0) {
			throw new AcceptanceError(
				`healthz did not reach a terminal state within ${timeoutMs}ms (last state: ${last})`,
			);
		}
		await new Promise((resolve) => setTimeout(resolve, Math.min(intervalMs, remaining)));
		intervalMs = Math.min(intervalMs * 2, 1_000);
	}
}

/**
 * Poll `GET <baseUrl>/healthz` until the server stops answering. Used by
 * the kill-and-restart scenarios (06, 19) in place of a fixed post-kill
 * sleep: the restart may begin the moment the old process is actually
 * down, and the post-restart assertions poll for the resumed bridge.
 */
export async function waitForServerDown(baseUrl: string, timeoutMs: number): Promise<void> {
	await pollAcceptance({
		label: "server-down",
		id: baseUrl,
		timeoutMs,
		intervalMs: 100,
		fetchRow: async () => {
			try {
				await fetch(`${baseUrl}/healthz`, { method: "GET" });
				return "up";
			} catch {
				return "down";
			}
		},
		isDone: (probe) => probe === "down",
		describe: (probe) => probe,
	});
}

/** Poll the filesystem until `path` exists (burrow socket, pid file). */
export async function waitForPathExists(path: string, timeoutMs: number): Promise<void> {
	await pollAcceptance({
		label: "path",
		id: path,
		timeoutMs,
		intervalMs: 100,
		fetchRow: () => Promise.resolve(existsSync(path)),
		isDone: (exists) => exists,
		describe: (exists) => (exists ? "present" : "missing"),
	});
}
