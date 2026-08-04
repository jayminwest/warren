/**
 * Run- and event-centric wait helpers shared by the acceptance scenarios
 * (warren-bb51). Run terminality goes through the SDK's `waitForRun`;
 * every other wait composes `pollAcceptance` (lib/poll.ts), the harness
 * wrapper over the SDK's `pollUntilTerminal`. No hand-rolled sleep loops.
 */
import { readFile } from "node:fs/promises";

import { WarrenClientError } from "../../../../src/client/errors.ts";
import type { RunRow } from "../../../../src/client/types.ts";
import { isTerminalRunState } from "../../../../src/core/wire.ts";
import { AcceptanceError } from "../../lib/assert.ts";
import type { WarrenHttp } from "../../lib/http.ts";
import { pollAcceptance } from "../../lib/poll.ts";
import type { PlotSnapshot } from "./types.ts";

/** Scenario poll cadence for run-state waits. */
export const SCENARIO_POLL_INTERVAL_MS = 500;

/**
 * Wait for a run to reach a terminal state (`succeeded` | `failed` |
 * `cancelled`) through the SDK's `waitForRun`. The SDK's 408
 * `wait_timeout` surfaces as an AcceptanceError.
 */
export async function waitForRunTerminal(
	http: WarrenHttp,
	runId: string,
	timeoutMs: number,
): Promise<RunRow> {
	try {
		return await http
			.sdkClient()
			.waitForRun(runId, { intervalMs: SCENARIO_POLL_INTERVAL_MS, timeoutMs });
	} catch (err) {
		if (err instanceof WarrenClientError && err.status === 408) {
			throw new AcceptanceError(err.message);
		}
		throw err;
	}
}

/**
 * Poll `GET /runs/:id` until the run reaches `target`. Fails fast with an
 * AcceptanceError if the run reaches a terminal state first — a terminal
 * run can never reach `target`, so waiting out the timeout would only
 * obscure the failure.
 */
export async function waitForRunState(
	http: WarrenHttp,
	runId: string,
	target: RunRow["state"],
	timeoutMs: number,
	terminalBail?: (row: RunRow) => string,
): Promise<RunRow> {
	return pollAcceptance({
		label: "run",
		id: runId,
		timeoutMs,
		fetchRow: () => http.sdkClient().getRun(runId),
		isDone: (row) => row.state === target,
		describe: (row) => row.state,
		onRow: (row) => {
			if (row.state !== target && isTerminalRunState(row.state)) {
				throw new AcceptanceError(
					terminalBail?.(row) ??
						`run ${runId} reached terminal state '${row.state}' before '${target}'`,
				);
			}
		},
	});
}

/**
 * Poll `GET /runs/:id` until `isDone(row)` — for waits on columns other
 * than `state` (usage tokens, preview state, prUrl). `onRow` may throw to
 * fail fast on a row that proves the wait can never succeed.
 */
export async function waitForRunPredicate(
	http: WarrenHttp,
	runId: string,
	isDone: (row: RunRow) => boolean,
	timeoutMs: number,
	describe: (row: RunRow) => string,
	onRow?: (row: RunRow) => void,
): Promise<RunRow> {
	return pollAcceptance({
		label: "run",
		id: runId,
		timeoutMs,
		fetchRow: () => http.sdkClient().getRun(runId),
		isDone,
		describe,
		...(onRow !== undefined ? { onRow } : {}),
	});
}

/** Drain the non-follow `/runs/:id/events` NDJSON backlog into an array. */
export async function collectRunEvents<T>(http: WarrenHttp, runId: string): Promise<T[]> {
	const out: T[] = [];
	for await (const env of http.streamNdjson(`/runs/${encodeURIComponent(runId)}/events`)) {
		out.push(env as T);
	}
	return out;
}

interface SequencedEvent {
	readonly seq: number;
}

/** Poll the event backlog until at least `target` events have landed. */
export async function waitForEventCount<T extends SequencedEvent>(
	http: WarrenHttp,
	runId: string,
	target: number,
	timeoutMs: number,
): Promise<readonly T[]> {
	return pollAcceptance({
		label: "events",
		id: runId,
		timeoutMs,
		intervalMs: 200,
		fetchRow: () => collectRunEvents<T>(http, runId),
		isDone: (events) => events.length >= target,
		describe: (events) => `${events.length} events`,
	});
}

/** Poll the event backlog until an event with `seq > threshold` lands. */
export async function waitForSeqAbove<T extends SequencedEvent>(
	http: WarrenHttp,
	runId: string,
	threshold: number,
	timeoutMs: number,
): Promise<readonly T[]> {
	const maxSeq = (events: readonly T[]) => events.reduce((m, e) => (e.seq > m ? e.seq : m), 0);
	return pollAcceptance({
		label: "events",
		id: runId,
		timeoutMs,
		intervalMs: 200,
		fetchRow: () => collectRunEvents<T>(http, runId),
		isDone: (events) => maxSeq(events) > threshold,
		describe: (events) => `max seq ${maxSeq(events)} (events=${events.length})`,
	});
}

/** Poll the event backlog until the first event lands for the run. */
export async function waitForFirstEvent(
	http: WarrenHttp,
	runId: string,
	timeoutMs: number,
): Promise<void> {
	await pollAcceptance({
		label: "events",
		id: runId,
		timeoutMs,
		intervalMs: 100,
		fetchRow: () => collectRunEvents<unknown>(http, runId),
		isDone: (events) => events.length >= 1,
		describe: (events) => `${events.length} events`,
	});
}

export async function readPlotSnapshot(path: string): Promise<PlotSnapshot> {
	const body = await readFile(path, "utf8");
	return JSON.parse(body) as PlotSnapshot;
}

/** Poll an on-disk Plot snapshot until it reaches `target` status. */
export async function waitForPlotStatus(
	path: string,
	target: string,
	timeoutMs: number,
): Promise<PlotSnapshot> {
	return pollAcceptance({
		label: "plot",
		id: path,
		timeoutMs,
		intervalMs: 100,
		fetchRow: async () => {
			try {
				return await readPlotSnapshot(path);
			} catch {
				// not yet present or mid-write
				return null;
			}
		},
		isDone: (snap): snap is PlotSnapshot => snap?.status === target,
		describe: (snap) => snap?.status ?? "missing",
	});
}
