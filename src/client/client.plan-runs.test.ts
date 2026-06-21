import { describe, expect, test } from "bun:test";
import { WarrenClient } from "./index.ts";
import { jsonResponse, stub } from "./test-helpers.ts";

// Plan-runs — warren-8ffc.
describe("WarrenClient plan-runs", () => {
	test("createPlanRun POSTs the camelCase body verbatim", async () => {
		let observedUrl: string | undefined;
		let observedBody: string | undefined;
		const c = new WarrenClient({
			config: { baseUrl: "https://w.local" },
			fetch: stub(async (input, init) => {
				observedUrl = String(input);
				observedBody = init?.body as string;
				return jsonResponse(201, {
					planRun: { id: "pr-1", state: "queued" },
					children: [],
				});
			}),
		});
		const res = await c.createPlanRun({
			project: "prj_1",
			planId: "pl-abc",
			agent: "claude-code",
			plotId: "plot-x",
		});
		expect(observedUrl).toBe("https://w.local/plan-runs");
		expect(JSON.parse(observedBody || "{}")).toEqual({
			project: "prj_1",
			planId: "pl-abc",
			agent: "claude-code",
			plotId: "plot-x",
		});
		expect(res.planRun.id).toBe("pr-1");
	});

	test("getPlanRun fetches the detail envelope", async () => {
		let observedUrl: string | undefined;
		const c = new WarrenClient({
			config: { baseUrl: "https://w.local" },
			fetch: stub(async (input) => {
				observedUrl = String(input);
				return jsonResponse(200, {
					planRun: { id: "pr-1", state: "running" },
					children: [],
					runs: [],
				});
			}),
		});
		const res = await c.getPlanRun("pr-1");
		expect(observedUrl).toBe("https://w.local/plan-runs/pr-1");
		expect(res.planRun.state).toBe("running");
	});

	test("listPlanRuns forwards project + state filters", async () => {
		let observedUrl: string | undefined;
		const c = new WarrenClient({
			config: { baseUrl: "https://w.local" },
			fetch: stub(async (input) => {
				observedUrl = String(input);
				return jsonResponse(200, { planRuns: [] });
			}),
		});
		await c.listPlanRuns();
		expect(observedUrl).toBe("https://w.local/plan-runs");
		await c.listPlanRuns({ project: "prj_1", state: "running" });
		expect(observedUrl).toBe("https://w.local/plan-runs?project=prj_1&state=running");
	});

	test("cancelPlanRun POSTs to the cancel endpoint", async () => {
		let observedUrl: string | undefined;
		let observedMethod: string | undefined;
		const c = new WarrenClient({
			config: { baseUrl: "https://w.local" },
			fetch: stub(async (input, init) => {
				observedUrl = String(input);
				observedMethod = init?.method;
				return jsonResponse(200, {
					planRun: { id: "pr 1", state: "cancelled" },
					cancelledChild: { childSeq: 2, runId: "run-9" },
					alreadyTerminal: false,
				});
			}),
		});
		const res = await c.cancelPlanRun("pr 1");
		expect(observedUrl).toBe("https://w.local/plan-runs/pr%201/cancel");
		expect(observedMethod).toBe("POST");
		expect(res.planRun.state).toBe("cancelled");
		expect(res.cancelledChild).toEqual({ childSeq: 2, runId: "run-9" });
		expect(res.alreadyTerminal).toBe(false);
	});

	test("streamPlanRunEvents yields parsed NDJSON without a since param", async () => {
		let observedUrl: string | undefined;
		const enc = new TextEncoder();
		const body = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(
					enc.encode(
						`${JSON.stringify({ id: 1, runId: "run-a", seq: 1, ts: "t", kind: "tool_use", stream: "stdout", payload: {}, plotId: null })}\n`,
					),
				);
				controller.enqueue(
					enc.encode(
						`${JSON.stringify({ id: 2, runId: "run-b", seq: 1, ts: "t", kind: "result", stream: null, payload: {}, plotId: "plot-x" })}\n`,
					),
				);
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
		const out: Array<{ runId: string; seq: number }> = [];
		for await (const ev of c.streamPlanRunEvents("pr 1", { follow: true })) {
			out.push({ runId: ev.runId, seq: ev.seq });
		}
		expect(observedUrl).toBe("https://w.local/plan-runs/pr%201/events?follow=1");
		expect(out).toEqual([
			{ runId: "run-a", seq: 1 },
			{ runId: "run-b", seq: 1 },
		]);
	});

	test("streamPlanRunEvents omits follow when default", async () => {
		let observedUrl: string | undefined;
		const c = new WarrenClient({
			config: { baseUrl: "https://w.local" },
			fetch: stub(async (input) => {
				observedUrl = String(input);
				return new Response(new ReadableStream<Uint8Array>({ start: (ctl) => ctl.close() }), {
					status: 200,
				});
			}),
		});
		for await (const _ of c.streamPlanRunEvents("pr-1")) {
			// no events
		}
		expect(observedUrl).toBe("https://w.local/plan-runs/pr-1/events");
	});

	test("waitForPlanRun polls until terminal state", async () => {
		const states = ["queued", "running", "succeeded"];
		let i = 0;
		const ticks: string[] = [];
		const c = new WarrenClient({
			config: { baseUrl: "https://w.local" },
			fetch: stub(async () => {
				const state = states[Math.min(i, states.length - 1)];
				i += 1;
				return jsonResponse(200, {
					planRun: { id: "pr-1", state },
					children: [],
					runs: [],
				});
			}),
		});
		const row = await c.waitForPlanRun("pr-1", {
			intervalMs: 1,
			onTick: (r) => ticks.push(r.state),
		});
		expect(row.state).toBe("succeeded");
		expect(ticks).toEqual(["queued", "running", "succeeded"]);
	});

	test("waitForPlanRun rejects when already aborted", async () => {
		const c = new WarrenClient({
			config: { baseUrl: "https://w.local" },
			fetch: stub(async () => jsonResponse(200, { planRun: { id: "pr-1", state: "queued" } })),
		});
		const ctrl = new AbortController();
		ctrl.abort();
		await expect(c.waitForPlanRun("pr-1", { signal: ctrl.signal })).rejects.toThrow();
	});
});
