import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { RunEvent } from "../api/types.ts";
import { runEventStreamLoop, type StreamStatus } from "./use-event-stream.helpers.ts";

/**
 * Reconnect-policy tests for the stream loop behind `useEventStream`
 * (warren-3995). The loop is driven against the REAL `streamRunEvents` /
 * `runsApi.get` with the same streaming-fetch stub harness as
 * `src/ui/src/api/client.stream.test.ts`, so a test asserts on the exact
 * URLs a lifetime-capped reconnect produces (`?follow=1&since=N`).
 */

const TOKEN = "warren-test-bearer-0123456789abcdef";

interface Capture {
	url: string;
	init: RequestInit | undefined;
}

const originalFetch = globalThis.fetch;
const originalLocalStorage = (globalThis as { localStorage?: unknown }).localStorage;

let captured: Capture[] = [];
/** Response queue; each fetch shifts one. A test must queue enough. */
let queue: (() => Response)[] = [];

function enqueue(response: () => Response): void {
	queue.push(response);
}

function ndjsonResponse(chunks: readonly string[]): Response {
	const encoder = new TextEncoder();
	const stream = new ReadableStream<Uint8Array>({
		start(controller) {
			for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
			controller.close();
		},
	});
	return new Response(stream, {
		status: 200,
		headers: { "content-type": "application/x-ndjson" },
	});
}

function eventLine(seq: number, kind = "stdout"): string {
	return `${JSON.stringify({ id: seq, runId: "run_abc", seq, ts: "2026-01-01T00:00:00Z", kind, stream: null, payload: {} })}\n`;
}

function runStateResponse(state: string): Response {
	// warren-7d84: `GET /runs/:id` wraps the row in `{run}`.
	return new Response(JSON.stringify({ run: { id: "run_abc", state } }), {
		status: 200,
		headers: { "content-type": "application/json" },
	});
}

beforeEach(() => {
	captured = [];
	queue = [];
	const store = new Map<string, string>([["warren.apiToken", TOKEN]]);
	(globalThis as { localStorage?: unknown }).localStorage = {
		getItem: (k: string) => store.get(k) ?? null,
		setItem: (k: string, v: string) => void store.set(k, v),
		removeItem: (k: string) => void store.delete(k),
	};
	globalThis.fetch = ((url: string, init?: RequestInit) => {
		captured.push({ url, init });
		const next = queue.shift();
		if (next === undefined) return Promise.reject(new Error(`unexpected fetch: ${url}`));
		try {
			return Promise.resolve(next());
		} catch (err) {
			// a queued thunk may simulate a transport failure by throwing
			return Promise.reject(err instanceof Error ? err : new Error(String(err)));
		}
	}) as typeof fetch;
});

afterEach(() => {
	globalThis.fetch = originalFetch;
	(globalThis as { localStorage?: unknown }).localStorage = originalLocalStorage;
});

interface Outcome {
	events: RunEvent[];
	statuses: StreamStatus[];
}

/**
 * Drive the loop over the real client helpers. `sleeps` records backoff
 * instead of waiting. The loop is expected to terminate on its own in
 * every test (terminal run, follow=false, or auth error).
 */
async function driveLoop(follow: boolean): Promise<Outcome> {
	const { runsApi, streamRunEvents, UnauthorizedError } = await import("../api/client.ts");
	const { isTerminalRunState } = await import("../api/types.ts");
	const outcome: Outcome = { events: [], statuses: [] };
	const sleeps: number[] = [];
	await runEventStreamLoop({
		follow,
		isCancelled: () => false,
		openStream: (sinceSeq) =>
			streamRunEvents("run_abc", {
				follow,
				...(sinceSeq !== undefined ? { sinceSeq } : {}),
			}),
		hasRunEnded: async () => {
			try {
				const run = await runsApi.get("run_abc");
				return isTerminalRunState(run.state);
			} catch {
				// mirrors the hook: a failed state read must not kill the tail
				return false;
			}
		},
		isAuthError: (err) => err instanceof UnauthorizedError,
		onEvent: (evt) => outcome.events.push(evt),
		onStatus: (status) => outcome.statuses.push(status),
		sleep: (ms) => {
			sleeps.push(ms);
			return Promise.resolve();
		},
	});
	return outcome;
}

describe("runEventStreamLoop", () => {
	test("resumes with sinceSeq after a clean close while the run is still active", async () => {
		// Lifetime-capped server: first connection delivers seq 1-2 then
		// closes cleanly; the run is still running; the reconnect resumes
		// at since=3 and the second close happens once the run is terminal.
		enqueue(() => ndjsonResponse([eventLine(1), eventLine(2)]));
		enqueue(() => runStateResponse("running"));
		enqueue(() => ndjsonResponse([eventLine(3)]));
		enqueue(() => runStateResponse("succeeded"));

		const outcome = await driveLoop(true);

		expect(captured.map((c) => c.url)).toEqual([
			"/runs/run_abc/events?follow=1",
			"/runs/run_abc",
			"/runs/run_abc/events?follow=1&since=3",
			"/runs/run_abc",
		]);
		expect(outcome.events.map((e) => e.seq)).toEqual([1, 2, 3]);
		expect(outcome.statuses).toEqual(["connecting", "live", "connecting", "live", "ended"]);
	});

	test("a clean close on a terminal run ends without reconnecting", async () => {
		enqueue(() => ndjsonResponse([eventLine(1)]));
		enqueue(() => runStateResponse("failed"));

		const outcome = await driveLoop(true);

		expect(captured.map((c) => c.url)).toEqual(["/runs/run_abc/events?follow=1", "/runs/run_abc"]);
		expect(outcome.statuses).toEqual(["connecting", "live", "ended"]);
	});

	test("replay-only mode (follow=false) never consults run state on clean close", async () => {
		enqueue(() => ndjsonResponse([eventLine(1)]));

		const outcome = await driveLoop(false);

		expect(captured.map((c) => c.url)).toEqual(["/runs/run_abc/events"]);
		expect(outcome.statuses).toEqual(["connecting", "live", "ended"]);
	});

	test("a transport error while following reconnects with sinceSeq", async () => {
		enqueue(() => ndjsonResponse([eventLine(1)]));
		enqueue(() => runStateResponse("running"));
		enqueue(() => {
			throw new Error("socket reset");
		});
		enqueue(() => ndjsonResponse([eventLine(2)]));
		enqueue(() => runStateResponse("succeeded"));

		const outcome = await driveLoop(true);

		expect(captured.map((c) => c.url)).toEqual([
			"/runs/run_abc/events?follow=1",
			"/runs/run_abc",
			"/runs/run_abc/events?follow=1&since=2",
			"/runs/run_abc/events?follow=1&since=2",
			"/runs/run_abc",
		]);
		expect(outcome.events.map((e) => e.seq)).toEqual([1, 2]);
		expect(outcome.statuses).toContain("error");
		expect(outcome.statuses[outcome.statuses.length - 1]).toBe("ended");
	});

	test("an auth error stops the loop permanently", async () => {
		enqueue(() => new Response("", { status: 401 }));

		const outcome = await driveLoop(true);

		expect(captured.map((c) => c.url)).toEqual(["/runs/run_abc/events?follow=1"]);
		expect(outcome.statuses).toEqual(["connecting", "live", "error"]);
	});

	test("a failed run-state read is treated as still-active and the reconnect proceeds", async () => {
		enqueue(() => ndjsonResponse([eventLine(1)]));
		enqueue(() => new Response("boom", { status: 500 }));
		enqueue(() => ndjsonResponse([eventLine(2)]));
		enqueue(() => runStateResponse("succeeded"));

		const outcome = await driveLoop(true);

		expect(captured.map((c) => c.url)).toEqual([
			"/runs/run_abc/events?follow=1",
			"/runs/run_abc",
			"/runs/run_abc/events?follow=1&since=2",
			"/runs/run_abc",
		]);
		expect(outcome.events.map((e) => e.seq)).toEqual([1, 2]);
		expect(outcome.statuses[outcome.statuses.length - 1]).toBe("ended");
	});
});
