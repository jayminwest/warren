import { describe, expect, test } from "bun:test";
import { WarrenClient, WarrenClientError, WarrenUnreachableError } from "./index.ts";

function jsonResponse(status: number, body: unknown): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json" },
	});
}

function stub(
	impl: (input: URL | RequestInfo, init?: RequestInit) => Promise<Response>,
): typeof fetch {
	return impl as unknown as typeof fetch;
}

describe("WarrenClient", () => {
	test("fromEnv resolves default base URL", () => {
		const c = WarrenClient.fromEnv({});
		expect(c.config.baseUrl).toBe("http://localhost:8080");
		expect(c.config.token).toBeUndefined();
	});

	test("fromEnv accepts overrides and token", () => {
		const c = WarrenClient.fromEnv({
			WARREN_BASE_URL: "https://warren.example.com",
			WARREN_API_TOKEN: "abc-token",
		});
		expect(c.config.baseUrl).toBe("https://warren.example.com");
		expect(c.config.token).toBe("abc-token");
	});

	test("performs simple getProject request", async () => {
		let observedUrl: string | undefined;
		let observedAuth: string | null = "" as string | null;

		const stubFetch = stub(async (input, init) => {
			observedUrl = String(input);
			observedAuth = init?.headers ? new Headers(init.headers).get("authorization") : null;
			return jsonResponse(200, { id: "p1", gitUrl: "git@github.com:foo/bar.git" });
		});

		const client = new WarrenClient({
			config: { baseUrl: "https://warren.local/", token: "my-token" },
			fetch: stubFetch,
		});

		const project = await client.getProject("p1");
		expect(project.id).toBe("p1");
		expect(observedUrl).toBe("https://warren.local/projects/p1");
		expect(observedAuth).toBe("Bearer my-token");
	});

	test("performs createRun request", async () => {
		let observedUrl: string | undefined;
		let observedMethod: string | undefined;
		let observedBody: string | undefined;

		const stubFetch = stub(async (input, init) => {
			observedUrl = String(input);
			observedMethod = init?.method;
			observedBody = init?.body as string;
			return jsonResponse(201, { run: { id: "r1" }, burrow: { id: "b1" } });
		});

		const client = new WarrenClient({
			config: { baseUrl: "https://warren.local" },
			fetch: stubFetch,
		});

		const res = await client.createRun({
			agent: "claude-code",
			project: "p1",
			prompt: "hello",
		});

		expect(res.run.id).toBe("r1");
		expect(observedUrl).toBe("https://warren.local/runs");
		expect(observedMethod).toBe("POST");
		expect(JSON.parse(observedBody || "{}")).toEqual({
			agent: "claude-code",
			project: "p1",
			prompt: "hello",
		});
	});

	test("rehydrates error response as WarrenClientError", async () => {
		const stubFetch = stub(async () => {
			return jsonResponse(400, {
				error: { code: "validation_error", message: "invalid prompt", hint: "write a prompt" },
			});
		});

		const client = new WarrenClient({
			config: { baseUrl: "https://warren.local" },
			fetch: stubFetch,
		});

		try {
			await client.listRuns();
			throw new Error("expected to fail");
		} catch (err) {
			expect(err).toBeInstanceOf(WarrenClientError);
			const clientErr = err as WarrenClientError;
			expect(clientErr.status).toBe(400);
			expect(clientErr.code).toBe("validation_error");
			expect(clientErr.message).toBe("invalid prompt");
			expect(clientErr.hint).toBe("write a prompt");
		}
	});

	test("rehydrates non-JSON error response", async () => {
		const stubFetch = stub(async () => {
			return new Response("internal error message", { status: 500 });
		});

		const client = new WarrenClient({
			config: { baseUrl: "https://warren.local" },
			fetch: stubFetch,
		});

		try {
			await client.listRuns();
			throw new Error("expected to fail");
		} catch (err) {
			expect(err).toBeInstanceOf(WarrenClientError);
			const clientErr = err as WarrenClientError;
			expect(clientErr.status).toBe(500);
			expect(clientErr.code).toBe("http_500");
			expect(clientErr.message).toContain("warren request failed with status 500");
		}
	});
});

describe("WarrenClient projects/agents", () => {
	test("listProjects GETs /projects", async () => {
		let observedUrl: string | undefined;
		const stubFetch = stub(async (input) => {
			observedUrl = String(input);
			return jsonResponse(200, { projects: [{ id: "p1" }] });
		});
		const c = new WarrenClient({
			config: { baseUrl: "https://w.local" },
			fetch: stubFetch,
		});
		const res = await c.listProjects();
		expect(observedUrl).toBe("https://w.local/projects");
		expect(res.projects.length).toBe(1);
	});

	test("createProject POSTs gitUrl + defaultBranch", async () => {
		let observedUrl: string | undefined;
		let observedMethod: string | undefined;
		let observedBody: string | undefined;
		const stubFetch = stub(async (input, init) => {
			observedUrl = String(input);
			observedMethod = init?.method;
			observedBody = init?.body as string;
			return jsonResponse(201, { id: "p1", gitUrl: "git@github.com:foo/bar.git" });
		});
		const c = new WarrenClient({
			config: { baseUrl: "https://w.local" },
			fetch: stubFetch,
		});
		const row = await c.createProject({
			gitUrl: "git@github.com:foo/bar.git",
			defaultBranch: "main",
		});
		expect(observedUrl).toBe("https://w.local/projects");
		expect(observedMethod).toBe("POST");
		expect(JSON.parse(observedBody || "{}")).toEqual({
			gitUrl: "git@github.com:foo/bar.git",
			defaultBranch: "main",
		});
		expect(row.id).toBe("p1");
	});

	test("refreshProject POSTs /projects/:id/refresh with ref", async () => {
		let observedUrl: string | undefined;
		let observedBody: string | undefined;
		const stubFetch = stub(async (input, init) => {
			observedUrl = String(input);
			observedBody = init?.body as string;
			return jsonResponse(200, {
				project: { id: "p1" },
				headSha: "deadbeef",
				ref: "main",
			});
		});
		const c = new WarrenClient({
			config: { baseUrl: "https://w.local" },
			fetch: stubFetch,
		});
		const res = await c.refreshProject("p1", { ref: "main" });
		expect(observedUrl).toBe("https://w.local/projects/p1/refresh");
		expect(JSON.parse(observedBody || "{}")).toEqual({ ref: "main" });
		expect(res.headSha).toBe("deadbeef");
	});

	test("refreshProject sends empty body when no ref", async () => {
		let observedBody: string | undefined;
		const stubFetch = stub(async (_input, init) => {
			observedBody = init?.body as string;
			return jsonResponse(200, { project: { id: "p1" }, headSha: "x", ref: "main" });
		});
		const c = new WarrenClient({
			config: { baseUrl: "https://w.local" },
			fetch: stubFetch,
		});
		await c.refreshProject("p1");
		expect(JSON.parse(observedBody || "{}")).toEqual({});
	});

	test("listAgents GETs /agents and forwards projectId", async () => {
		const urls: string[] = [];
		const stubFetch = stub(async (input) => {
			urls.push(String(input));
			return jsonResponse(200, { agents: [] });
		});
		const c = new WarrenClient({
			config: { baseUrl: "https://w.local" },
			fetch: stubFetch,
		});
		await c.listAgents();
		await c.listAgents({ projectId: "p 1" });
		expect(urls[0]).toBe("https://w.local/agents");
		expect(urls[1]).toBe("https://w.local/agents?projectId=p%201");
	});

	test("getAgent GETs /agents/:name and url-encodes", async () => {
		let observedUrl: string | undefined;
		const stubFetch = stub(async (input) => {
			observedUrl = String(input);
			return jsonResponse(200, {
				name: "claude-code",
				renderedJson: {},
				registeredAt: "t",
				lastRefreshed: "t",
				source: "builtin",
			});
		});
		const c = new WarrenClient({
			config: { baseUrl: "https://w.local" },
			fetch: stubFetch,
		});
		const row = await c.getAgent("claude-code", { projectId: "p1" });
		expect(observedUrl).toBe("https://w.local/agents/claude-code?projectId=p1");
		expect(row.source).toBe("builtin");
	});

	test("refreshAgents POSTs /agents/refresh", async () => {
		let observedUrl: string | undefined;
		let observedMethod: string | undefined;
		const stubFetch = stub(async (input, init) => {
			observedUrl = String(input);
			observedMethod = init?.method;
			return jsonResponse(200, {
				clone: { cloned: false, localDir: "/x" },
				registered: [],
				skipped: [],
				removed: [],
				projects: [],
				projectErrors: [],
			});
		});
		const c = new WarrenClient({
			config: { baseUrl: "https://w.local" },
			fetch: stubFetch,
		});
		const res = await c.refreshAgents();
		expect(observedUrl).toBe("https://w.local/agents/refresh");
		expect(observedMethod).toBe("POST");
		expect(res.clone.cloned).toBe(false);
	});

	test("refreshProjectAgents POSTs /projects/:id/agents/refresh", async () => {
		let observedUrl: string | undefined;
		let observedMethod: string | undefined;
		const stubFetch = stub(async (input, init) => {
			observedUrl = String(input);
			observedMethod = init?.method;
			return jsonResponse(200, {
				projectId: "p1",
				registered: [],
				skipped: [],
				removed: [],
			});
		});
		const c = new WarrenClient({
			config: { baseUrl: "https://w.local" },
			fetch: stubFetch,
		});
		const res = await c.refreshProjectAgents("p1");
		expect(observedUrl).toBe("https://w.local/projects/p1/agents/refresh");
		expect(observedMethod).toBe("POST");
		expect(res.projectId).toBe("p1");
	});
});

describe("WarrenClient.probe", () => {
	test("resolves when warren returns 200 from /healthz", async () => {
		const stubFetch = stub(async (input) => {
			expect(String(input)).toContain("/healthz");
			return jsonResponse(200, { ok: true });
		});
		const c = new WarrenClient({
			config: { baseUrl: "http://warren.local" },
			fetch: stubFetch,
		});
		await expect(c.probe()).resolves.toBeUndefined();
	});

	test("throws WarrenUnreachableError when fetch rejects (connection refused)", async () => {
		const stubFetch = stub(async () => {
			throw new TypeError("fetch failed");
		});
		const c = new WarrenClient({
			config: { baseUrl: "http://warren.local" },
			fetch: stubFetch,
		});
		const promise = c.probe();
		await expect(promise).rejects.toBeInstanceOf(WarrenUnreachableError);
		await expect(promise).rejects.toMatchObject({
			message: expect.stringContaining("warren unreachable at http://warren.local"),
		});
	});

	test("times out and throws WarrenUnreachableError when warren hangs", async () => {
		const stubFetch = stub(() => new Promise<Response>(() => {}));
		const c = new WarrenClient({
			config: { baseUrl: "http://warren.local" },
			fetch: stubFetch,
		});
		await expect(c.probe(50)).rejects.toBeInstanceOf(WarrenUnreachableError);
	});
});

describe("WarrenClient.dispatch + waitForRun", () => {
	test("dispatch POSTs /runs and maps branch/model/provider to wire fields", async () => {
		let observedBody: string | undefined;
		const stubFetch = stub(async (_input, init) => {
			observedBody = init?.body as string;
			return jsonResponse(201, { run: { id: "r1" }, burrow: { id: "b1" } });
		});
		const c = new WarrenClient({
			config: { baseUrl: "https://w.local" },
			fetch: stubFetch,
		});
		await c.dispatch({
			agent: "claude-code",
			project: "p1",
			prompt: "do thing",
			branch: "feature/x",
			model: "claude-sonnet-4-5",
			provider: "anthropic",
		});
		expect(JSON.parse(observedBody || "{}")).toEqual({
			agent: "claude-code",
			project: "p1",
			prompt: "do thing",
			ref: "feature/x",
			modelOverride: "claude-sonnet-4-5",
			providerOverride: "anthropic",
		});
	});

	test("dispatch omits optional fields when not provided", async () => {
		let observedBody: string | undefined;
		const stubFetch = stub(async (_input, init) => {
			observedBody = init?.body as string;
			return jsonResponse(201, { run: { id: "r1" }, burrow: { id: "b1" } });
		});
		const c = new WarrenClient({
			config: { baseUrl: "https://w.local" },
			fetch: stubFetch,
		});
		await c.dispatch({ agent: "a", project: "p", prompt: "go" });
		expect(JSON.parse(observedBody || "{}")).toEqual({
			agent: "a",
			project: "p",
			prompt: "go",
		});
	});

	test("steer POSTs /runs/:id/steer with body and optional priority/fromActor", async () => {
		let observedUrl: string | undefined;
		let observedMethod: string | undefined;
		let observedBody: string | undefined;
		const stubFetch = stub(async (input, init) => {
			observedUrl = String(input);
			observedMethod = init?.method;
			observedBody = init?.body as string;
			return jsonResponse(200, {
				message: {
					id: "m1",
					burrowId: "b1",
					fromActor: "operator",
					body: "focus on tests",
					priority: "high",
					state: "unread",
					deliveredAtRunId: null,
					createdAt: "2026-05-25T00:00:00.000Z",
					deliveredAt: null,
				},
			});
		});
		const c = new WarrenClient({
			config: { baseUrl: "https://w.local" },
			fetch: stubFetch,
		});
		const res = await c.steer("r 1", {
			body: "focus on tests",
			priority: "high",
			fromActor: "operator",
		});
		expect(observedUrl).toBe("https://w.local/runs/r%201/steer");
		expect(observedMethod).toBe("POST");
		expect(JSON.parse(observedBody as string)).toEqual({
			body: "focus on tests",
			priority: "high",
			fromActor: "operator",
		});
		expect(res.message.id).toBe("m1");
		expect(res.message.priority).toBe("high");
	});

	test("steer omits priority and fromActor when not provided", async () => {
		let observedBody: string | undefined;
		const stubFetch = stub(async (_input, init) => {
			observedBody = init?.body as string;
			return jsonResponse(200, {
				message: {
					id: "m2",
					burrowId: "b1",
					fromActor: "warren",
					body: "nudge",
					priority: "normal",
					state: "unread",
					deliveredAtRunId: null,
					createdAt: "2026-05-25T00:00:00.000Z",
					deliveredAt: null,
				},
			});
		});
		const c = new WarrenClient({
			config: { baseUrl: "https://w.local" },
			fetch: stubFetch,
		});
		await c.steer("r1", { body: "nudge" });
		expect(JSON.parse(observedBody as string)).toEqual({ body: "nudge" });
	});

	test("steer surfaces server validation errors as WarrenClientError", async () => {
		const stubFetch = stub(async () =>
			jsonResponse(400, {
				error: {
					code: "validation_error",
					message: "cannot steer a succeeded run",
					hint: "steering is only valid while the run is queued or running",
				},
			}),
		);
		const c = new WarrenClient({
			config: { baseUrl: "https://w.local" },
			fetch: stubFetch,
		});
		let caught: unknown;
		try {
			await c.steer("r1", { body: "late" });
		} catch (err) {
			caught = err;
		}
		expect(caught).toBeInstanceOf(WarrenClientError);
		const e = caught as WarrenClientError;
		expect(e.status).toBe(400);
		expect(e.code).toBe("validation_error");
	});

	test("getRun GETs /runs/:id and url-encodes", async () => {
		let observedUrl: string | undefined;
		const stubFetch = stub(async (input) => {
			observedUrl = String(input);
			return jsonResponse(200, { id: "r 1", state: "running" });
		});
		const c = new WarrenClient({
			config: { baseUrl: "https://w.local" },
			fetch: stubFetch,
		});
		const row = await c.getRun("r 1");
		expect(observedUrl).toBe("https://w.local/runs/r%201");
		expect(row.state).toBe("running");
	});

	test("waitForRun polls until terminal state", async () => {
		const sequence: string[] = ["queued", "running", "running", "succeeded"];
		let idx = 0;
		const stubFetch = stub(async () => {
			const state = sequence[idx++] ?? "succeeded";
			return jsonResponse(200, { id: "r1", state });
		});
		const c = new WarrenClient({
			config: { baseUrl: "https://w.local" },
			fetch: stubFetch,
		});
		const ticks: string[] = [];
		const row = await c.waitForRun("r1", {
			intervalMs: 1,
			timeoutMs: 5_000,
			onTick: (r) => ticks.push(r.state),
		});
		expect(row.state).toBe("succeeded");
		expect(ticks).toEqual(["queued", "running", "running", "succeeded"]);
	});

	test("waitForRun returns immediately when run is already terminal", async () => {
		let calls = 0;
		const stubFetch = stub(async () => {
			calls++;
			return jsonResponse(200, { id: "r1", state: "failed" });
		});
		const c = new WarrenClient({
			config: { baseUrl: "https://w.local" },
			fetch: stubFetch,
		});
		const row = await c.waitForRun("r1", { intervalMs: 1, timeoutMs: 1_000 });
		expect(row.state).toBe("failed");
		expect(calls).toBe(1);
	});

	test("waitForRun throws WarrenClientError(408) on timeout", async () => {
		const stubFetch = stub(async () => jsonResponse(200, { id: "r1", state: "running" }));
		const c = new WarrenClient({
			config: { baseUrl: "https://w.local" },
			fetch: stubFetch,
		});
		try {
			await c.waitForRun("r1", { intervalMs: 5, timeoutMs: 10 });
			throw new Error("expected timeout");
		} catch (err) {
			expect(err).toBeInstanceOf(WarrenClientError);
			expect((err as WarrenClientError).status).toBe(408);
			expect((err as WarrenClientError).code).toBe("wait_timeout");
		}
	});

	test("streamRunEvents yields parsed NDJSON envelopes", async () => {
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

	test("streamRunEvents handles partial lines split across chunks", async () => {
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

	test("streamRunEvents flushes trailing line without newline", async () => {
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

	test("streamRunEvents drops malformed lines and keeps streaming", async () => {
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

	test("streamRunEvents throws WarrenClientError on non-OK response", async () => {
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

	test("streamRunEvents wraps transport failures as WarrenUnreachableError", async () => {
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

	test("streamRunEvents omits query params when defaults", async () => {
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

	test("waitForRun aborts when signal fires", async () => {
		const stubFetch = stub(async () => jsonResponse(200, { id: "r1", state: "running" }));
		const c = new WarrenClient({
			config: { baseUrl: "https://w.local" },
			fetch: stubFetch,
		});
		const ctrl = new AbortController();
		setTimeout(() => ctrl.abort(), 5);
		const promise = c.waitForRun("r1", {
			intervalMs: 50,
			timeoutMs: 5_000,
			signal: ctrl.signal,
		});
		await expect(promise).rejects.toMatchObject({ name: "AbortError" });
	});

	/* --------------------------------------------------------------- */
	/* Plots — warren-8ffc.                                            */
	/* --------------------------------------------------------------- */

	test("listPlots forwards status + needsAttention into the querystring", async () => {
		let observedUrl: string | undefined;
		const c = new WarrenClient({
			config: { baseUrl: "https://w.local" },
			fetch: stub(async (input) => {
				observedUrl = String(input);
				return jsonResponse(200, { plots: [] });
			}),
		});
		await c.listPlots();
		expect(observedUrl).toBe("https://w.local/plots");

		await c.listPlots({ status: "drafting", needsAttention: true });
		expect(observedUrl).toBe("https://w.local/plots?status=drafting&filter=needs_attention");
	});

	test("getPlot fetches the envelope", async () => {
		let observedUrl: string | undefined;
		const envelope = {
			id: "plot-abc",
			name: "My Plot",
			status: "drafting",
			intent: { goal: "", non_goals: [], constraints: [], success_criteria: [] },
			attachments: [],
			event_log: [],
			project_id: "prj_1",
			paused_runs: [],
		};
		const c = new WarrenClient({
			config: { baseUrl: "https://w.local" },
			fetch: stub(async (input) => {
				observedUrl = String(input);
				return jsonResponse(200, envelope);
			}),
		});
		const got = await c.getPlot("plot-abc");
		expect(observedUrl).toBe("https://w.local/plots/plot-abc");
		expect(got.id).toBe("plot-abc");
		expect(got.status).toBe("drafting");
	});

	test("createPlot maps camelCase input onto snake_case wire body", async () => {
		let observedUrl: string | undefined;
		let observedBody: string | undefined;
		const c = new WarrenClient({
			config: { baseUrl: "https://w.local" },
			fetch: stub(async (input, init) => {
				observedUrl = String(input);
				observedBody = init?.body as string;
				return jsonResponse(201, {
					id: "plot-new",
					name: "My Plot",
					status: "drafting",
					intent_goal_preview: "build it",
					attachments_count: 0,
					last_event_ts: "2026-01-01T00:00:00Z",
					last_event_actor: "user:alice",
					project_id: "prj_1",
				});
			}),
		});
		const summary = await c.createPlot({
			projectId: "prj_1",
			name: "My Plot",
			intent: { goal: "build it" },
			dispatcherHandle: "user:alice",
		});
		expect(observedUrl).toBe("https://w.local/plots");
		expect(JSON.parse(observedBody || "{}")).toEqual({
			project_id: "prj_1",
			name: "My Plot",
			intent: { goal: "build it" },
			dispatcher_handle: "user:alice",
		});
		expect(summary.id).toBe("plot-new");
	});

	test("createPlot omits undefined optional fields from the body", async () => {
		let observedBody: string | undefined;
		const c = new WarrenClient({
			config: { baseUrl: "https://w.local" },
			fetch: stub(async (_input, init) => {
				observedBody = init?.body as string;
				return jsonResponse(201, {
					id: "p",
					name: "Untitled Plot",
					status: "drafting",
					intent_goal_preview: "",
					attachments_count: 0,
					last_event_ts: "2026-01-01T00:00:00Z",
					last_event_actor: "user:alice",
					project_id: "prj_1",
				});
			}),
		});
		await c.createPlot({ projectId: "prj_1" });
		expect(JSON.parse(observedBody || "{}")).toEqual({ project_id: "prj_1" });
	});

	test("editPlotIntent posts flat top-level fields with snake_case dispatcher_handle", async () => {
		let observedUrl: string | undefined;
		let observedBody: string | undefined;
		const c = new WarrenClient({
			config: { baseUrl: "https://w.local" },
			fetch: stub(async (input, init) => {
				observedUrl = String(input);
				observedBody = init?.body as string;
				return jsonResponse(200, {
					id: "plot-x",
					name: "x",
					status: "drafting",
					intent: { goal: "new", non_goals: [], constraints: [], success_criteria: [] },
					attachments: [],
					event_log: [],
					project_id: "prj_1",
					paused_runs: [],
				});
			}),
		});
		await c.editPlotIntent("plot-x", {
			goal: "new",
			non_goals: ["don't"],
			dispatcherHandle: "user:alice",
		});
		expect(observedUrl).toBe("https://w.local/plots/plot-x/intent");
		expect(JSON.parse(observedBody || "{}")).toEqual({
			goal: "new",
			non_goals: ["don't"],
			dispatcher_handle: "user:alice",
		});
	});

	test("changePlotStatus posts {next, dispatcher_handle}", async () => {
		let observedUrl: string | undefined;
		let observedBody: string | undefined;
		const c = new WarrenClient({
			config: { baseUrl: "https://w.local" },
			fetch: stub(async (input, init) => {
				observedUrl = String(input);
				observedBody = init?.body as string;
				return jsonResponse(200, {
					summary: {
						id: "plot-x",
						name: "x",
						status: "ready",
						intent_goal_preview: "",
						attachments_count: 0,
						last_event_ts: "2026-01-01T00:00:00Z",
						last_event_actor: "user:alice",
						project_id: "prj_1",
					},
					event: {
						type: "status_changed",
						actor: "user:alice",
						at: "2026-01-01T00:00:00Z",
						data: { from: "drafting", to: "ready" },
					},
				});
			}),
		});
		const res = await c.changePlotStatus("plot-x", {
			next: "ready",
			dispatcherHandle: "user:alice",
		});
		expect(observedUrl).toBe("https://w.local/plots/plot-x/status");
		expect(JSON.parse(observedBody || "{}")).toEqual({
			next: "ready",
			dispatcher_handle: "user:alice",
		});
		expect(res.summary.status).toBe("ready");
	});

	test("syncPlot POSTs to /plots/:id/sync with no body", async () => {
		let observedUrl: string | undefined;
		let observedMethod: string | undefined;
		const c = new WarrenClient({
			config: { baseUrl: "https://w.local" },
			fetch: stub(async (input, init) => {
				observedUrl = String(input);
				observedMethod = init?.method;
				return jsonResponse(200, { kind: "no_op" });
			}),
		});
		const res = await c.syncPlot("plot-x");
		expect(observedUrl).toBe("https://w.local/plots/plot-x/sync");
		expect(observedMethod).toBe("POST");
		expect(res).toEqual({ kind: "no_op" });
	});

	/* --------------------------------------------------------------- */
	/* Plan-runs — warren-8ffc.                                        */
	/* --------------------------------------------------------------- */

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
});
