import { afterEach, beforeEach, describe, expect, test } from "bun:test";

/**
 * Streaming-helper tests for the UI's fetch wrapper (`src/ui/src/api/client.ts`):
 * `streamRunEvents`, `streamPlanRunEvents` and the shared
 * `streamNdjsonEvents` behind them. Companion to `client.test.ts`, which
 * covers the non-streaming request paths — the harness (fetch +
 * localStorage stubs, captured-request helper) is intentionally the same
 * shape so a reader can diff the two files' setup at a glance.
 */

const TOKEN = "warren-test-bearer-0123456789abcdef";

interface Capture {
	url: string;
	init: RequestInit | undefined;
}

const originalFetch = globalThis.fetch;
const originalLocalStorage = (globalThis as { localStorage?: unknown }).localStorage;

let captured: Capture[] = [];
let nextResponse: () => Response;

/** The single captured request, or a hard failure if none was made. */
function onlyCall(): Capture {
	const call = captured[0];
	if (call === undefined) throw new Error("no request captured");
	return call;
}

beforeEach(() => {
	captured = [];
	nextResponse = () => ndjsonResponse([]);
	const store = new Map<string, string>([["warren.apiToken", TOKEN]]);
	(globalThis as { localStorage?: unknown }).localStorage = {
		getItem: (k: string) => store.get(k) ?? null,
		setItem: (k: string, v: string) => void store.set(k, v),
		removeItem: (k: string) => void store.delete(k),
	};
	globalThis.fetch = ((url: string, init?: RequestInit) => {
		captured.push({ url, init });
		return Promise.resolve(nextResponse());
	}) as typeof fetch;
});

afterEach(() => {
	globalThis.fetch = originalFetch;
	(globalThis as { localStorage?: unknown }).localStorage = originalLocalStorage;
});

/**
 * Streaming helpers (`streamNdjsonEvents` behind `streamRunEvents` /
 * `streamPlanRunEvents`). The fetch stub returns a `Response` over a
 * hand-rolled `ReadableStream` so chunk boundaries are under the test's
 * control — that is the whole point, since NDJSON framing bugs only
 * show up when a JSON line straddles two chunks or the server closes
 * without a trailing newline.
 */
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

describe("NDJSON event streams", () => {
	test("yields parsed events in order across chunk splits, keepalives and a final partial line", async () => {
		const { streamRunEvents } = await import("./client.ts");
		const e1 = JSON.stringify({ runId: "run_abc", seq: 1, stream: "stdout", data: "hel" });
		const e2 = JSON.stringify({ runId: "run_abc", seq: 2, stream: "stdout", data: "lo" });
		const e3 = JSON.stringify({ runId: "run_abc", seq: 3, stream: "system", data: "bye" });
		const e4 = JSON.stringify({ runId: "run_abc", seq: 4, stream: "system", data: "tail" });
		nextResponse = () =>
			ndjsonResponse([
				// chunk boundary splits e1's JSON line in half
				`${e1.slice(0, 10)}`,
				// remainder of e1, then an empty keepalive line, then e2
				`${e1.slice(10)}\n\n${e2}\n`,
				// a malformed line is dropped, the stream continues
				`{not-json\n${e3}\n`,
				// final partial line: server closed without a trailing newline
				e4,
			]);

		const events: unknown[] = [];
		for await (const ev of streamRunEvents("run_abc", { follow: true })) events.push(ev);
		expect(events.map((e) => (e as { seq: number }).seq)).toEqual([1, 2, 3, 4]);
	});

	test("propagates follow/sinceSeq onto the URL and sends ndjson accept + bearer headers", async () => {
		const { streamRunEvents } = await import("./client.ts");
		nextResponse = () => ndjsonResponse([]);
		for await (const _ of streamRunEvents("run abc", { follow: true, sinceSeq: 42 })) {
			// drain
		}
		const call = onlyCall();
		expect(call.url).toBe("/runs/run%20abc/events?follow=1&since=42");
		expect(call.url).not.toContain(TOKEN);
		const headers = call.init?.headers as Record<string, string>;
		expect(headers.accept).toBe("application/x-ndjson");
		expect(headers.authorization).toBe(`Bearer ${TOKEN}`);
	});

	test("streamPlanRunEvents hits the plan-run route with the same query params", async () => {
		const { streamPlanRunEvents } = await import("./client.ts");
		const e1 = JSON.stringify({ runId: "run_1", seq: 7, stream: "stdout", data: "x" });
		nextResponse = () => ndjsonResponse([`${e1}\n`]);
		const events: unknown[] = [];
		for await (const ev of streamPlanRunEvents("pr_1", { sinceSeq: 6 })) events.push(ev);
		expect(onlyCall().url).toBe("/plan-runs/pr_1/events?since=6");
		expect(events).toHaveLength(1);
	});

	test("planRunsApi.events delegates to the plan-run NDJSON stream", async () => {
		const { planRunsApi } = await import("./client.ts");
		nextResponse = () => ndjsonResponse([]);
		for await (const _ of planRunsApi.events("pr_9")) {
			// drain
		}
		expect(onlyCall().url).toBe("/plan-runs/pr_9/events");
	});

	test("forwards the caller's AbortSignal to fetch", async () => {
		const { streamRunEvents } = await import("./client.ts");
		const controller = new AbortController();
		nextResponse = () => ndjsonResponse([]);
		for await (const _ of streamRunEvents("run_abc", { signal: controller.signal })) {
			// drain
		}
		expect(onlyCall().init?.signal).toBe(controller.signal);
	});

	test("an abort mid-stream surfaces as an AbortError, not a hang", async () => {
		const { streamRunEvents } = await import("./client.ts");
		const controller = new AbortController();
		nextResponse = () => {
			const stream = new ReadableStream<Uint8Array>({
				start(c) {
					controller.signal.addEventListener("abort", () => {
						c.error(new DOMException("The operation was aborted", "AbortError"));
					});
				},
			});
			return new Response(stream, { status: 200 });
		};
		const iter = streamRunEvents("run_abc", { follow: true, signal: controller.signal });
		const pending = iter.next();
		controller.abort();
		await expect(pending).rejects.toMatchObject({ name: "AbortError" });
	});

	test("breaking out of the consumer loop tears the stream down cleanly", async () => {
		const { streamRunEvents } = await import("./client.ts");
		const e1 = JSON.stringify({ runId: "run_abc", seq: 1 });
		// a stream that never closes; the generator's finally must release the reader
		nextResponse = () => {
			const encoder = new TextEncoder();
			const stream = new ReadableStream<Uint8Array>({
				start(c) {
					c.enqueue(encoder.encode(`${e1}\n`));
				},
			});
			return new Response(stream, { status: 200 });
		};
		const iter = streamRunEvents("run_abc", { follow: true });
		const first = await iter.next();
		expect((first.value as { seq: number }).seq).toBe(1);
		await expect(iter.return(undefined)).resolves.toMatchObject({ done: true });
	});

	test("401 clears the cached token and raises UnauthorizedError", async () => {
		const { getApiToken, streamRunEvents, UnauthorizedError } = await import("./client.ts");
		nextResponse = () => new Response("", { status: 401 });
		const iter = streamRunEvents("run_abc");
		await expect(iter.next()).rejects.toBeInstanceOf(UnauthorizedError);
		expect(getApiToken()).toBeNull();
	});

	test("a structured error envelope becomes an ApiError carrying the server code", async () => {
		const { ApiError, streamRunEvents } = await import("./client.ts");
		nextResponse = () =>
			new Response(JSON.stringify({ error: { code: "run_not_found", message: "no such run" } }), {
				status: 404,
				headers: { "content-type": "application/json" },
			});
		const iter = streamRunEvents("run_missing");
		try {
			await iter.next();
			throw new Error("expected the stream to reject");
		} catch (err) {
			expect(err).toBeInstanceOf(ApiError);
			const e = err as InstanceType<typeof ApiError>;
			expect(e.status).toBe(404);
			expect(e.code).toBe("run_not_found");
		}
	});

	test("a non-JSON error body falls back to an http_<status> code", async () => {
		const { ApiError, streamPlanRunEvents } = await import("./client.ts");
		nextResponse = () => new Response("proxy died", { status: 502 });
		const iter = streamPlanRunEvents("pr_1");
		try {
			await iter.next();
			throw new Error("expected the stream to reject");
		} catch (err) {
			expect(err).toBeInstanceOf(ApiError);
			expect((err as InstanceType<typeof ApiError>).code).toBe("http_502");
		}
	});

	test("a null response body yields no events", async () => {
		const { streamRunEvents } = await import("./client.ts");
		nextResponse = () => new Response(null, { status: 200 });
		const events: unknown[] = [];
		for await (const ev of streamRunEvents("run_abc")) events.push(ev);
		expect(events).toEqual([]);
	});
});
