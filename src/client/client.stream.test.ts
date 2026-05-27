import { describe, expect, test } from "bun:test";
import { WarrenClient, WarrenClientError, WarrenUnreachableError } from "./index.ts";
import { jsonResponse, stub } from "./test-helpers.ts";

describe("WarrenClient.streamRunEvents", () => {
	test("yields parsed NDJSON envelopes", async () => {
		let observedUrl: string | undefined;
		let observedAccept: string | null = "" as string | null;
		const body = new ReadableStream<Uint8Array>({
			start(controller) {
				const enc = new TextEncoder();
				controller.enqueue(
					enc.encode(
						`${JSON.stringify({ id: 1, runId: "r1", seq: 1, ts: "t", kind: "tool_use", stream: "stdout", payload: { a: 1 }, plotId: null })}\n`,
					),
				);
				// chunked + partial-line split across reads
				controller.enqueue(
					enc.encode(
						`${JSON.stringify({ id: 2, runId: "r1", seq: 2, ts: "t", kind: "tool_result", stream: "stdout", payload: { ok: true }, plotId: "plot-abc" })}\n`,
					),
				);
				controller.close();
			},
		});
		const stubFetch = stub(async (input, init) => {
			observedUrl = String(input);
			observedAccept = init?.headers ? new Headers(init.headers).get("accept") : null;
			return new Response(body, {
				status: 200,
				headers: { "content-type": "application/x-ndjson" },
			});
		});
		const c = new WarrenClient({
			config: { baseUrl: "https://w.local" },
			fetch: stubFetch,
		});
		const out: Array<{ seq: number; kind: string; plotId: string | null }> = [];
		for await (const ev of c.streamRunEvents("r 1", { follow: true, sinceSeq: 7 })) {
			out.push({ seq: ev.seq, kind: ev.kind, plotId: ev.plotId });
		}
		expect(observedUrl).toBe("https://w.local/runs/r%201/events?follow=1&since=7");
		expect(observedAccept).toBe("application/x-ndjson");
		expect(out).toEqual([
			{ seq: 1, kind: "tool_use", plotId: null },
			{ seq: 2, kind: "tool_result", plotId: "plot-abc" },
		]);
	});

	test("handles partial lines split across chunks", async () => {
		const enc = new TextEncoder();
		const line = `${JSON.stringify({ id: 1, runId: "r1", seq: 1, ts: "t", kind: "k", stream: null, payload: {}, plotId: null })}\n`;
		const mid = Math.floor(line.length / 2);
		const body = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(enc.encode(line.slice(0, mid)));
				controller.enqueue(enc.encode(line.slice(mid)));
				controller.close();
			},
		});
		const c = new WarrenClient({
			config: { baseUrl: "https://w.local" },
			fetch: stub(async () => new Response(body, { status: 200 })),
		});
		const out: number[] = [];
		for await (const ev of c.streamRunEvents("r1")) out.push(ev.seq);
		expect(out).toEqual([1]);
	});

	test("flushes trailing line without newline", async () => {
		const enc = new TextEncoder();
		const body = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(
					enc.encode(
						JSON.stringify({
							id: 9,
							runId: "r1",
							seq: 9,
							ts: "t",
							kind: "k",
							stream: null,
							payload: {},
							plotId: null,
						}),
					),
				);
				controller.close();
			},
		});
		const c = new WarrenClient({
			config: { baseUrl: "https://w.local" },
			fetch: stub(async () => new Response(body, { status: 200 })),
		});
		const out: number[] = [];
		for await (const ev of c.streamRunEvents("r1")) out.push(ev.seq);
		expect(out).toEqual([9]);
	});

	test("drops malformed lines and keeps streaming", async () => {
		const enc = new TextEncoder();
		const body = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(enc.encode("this is not json\n"));
				controller.enqueue(
					enc.encode(
						`${JSON.stringify({ id: 1, runId: "r1", seq: 1, ts: "t", kind: "ok", stream: null, payload: {}, plotId: null })}\n`,
					),
				);
				controller.close();
			},
		});
		const c = new WarrenClient({
			config: { baseUrl: "https://w.local" },
			fetch: stub(async () => new Response(body, { status: 200 })),
		});
		const out: string[] = [];
		for await (const ev of c.streamRunEvents("r1")) out.push(ev.kind);
		expect(out).toEqual(["ok"]);
	});

	test("throws WarrenClientError on non-OK response", async () => {
		const c = new WarrenClient({
			config: { baseUrl: "https://w.local" },
			fetch: stub(async () =>
				jsonResponse(404, { error: { code: "not_found", message: "no such run" } }),
			),
		});
		try {
			for await (const _ of c.streamRunEvents("r1")) {
				throw new Error("expected error before any yield");
			}
			throw new Error("expected error");
		} catch (err) {
			expect(err).toBeInstanceOf(WarrenClientError);
			expect((err as WarrenClientError).status).toBe(404);
			expect((err as WarrenClientError).code).toBe("not_found");
		}
	});

	test("wraps transport failures as WarrenUnreachableError", async () => {
		const c = new WarrenClient({
			config: { baseUrl: "http://warren.local" },
			fetch: stub(async () => {
				throw new TypeError("fetch failed");
			}),
		});
		try {
			for await (const _ of c.streamRunEvents("r1")) {
				throw new Error("unexpected yield");
			}
			throw new Error("expected error");
		} catch (err) {
			expect(err).toBeInstanceOf(WarrenUnreachableError);
		}
	});

	test("omits query params when defaults", async () => {
		let observedUrl: string | undefined;
		const body = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.close();
			},
		});
		const c = new WarrenClient({
			config: { baseUrl: "https://w.local" },
			fetch: stub(async (input) => {
				observedUrl = String(input);
				return new Response(body, { status: 200 });
			}),
		});
		for await (const _ of c.streamRunEvents("r1")) {
			// no events
		}
		expect(observedUrl).toBe("https://w.local/runs/r1/events");
	});
});
