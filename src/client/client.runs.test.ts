import { describe, expect, test } from "bun:test";
import { WarrenClient, WarrenClientError } from "./index.ts";
import { jsonResponse, stub } from "./test-helpers.ts";

describe("WarrenClient.dispatch", () => {
	test("dispatch POSTs /runs and maps branch/model/provider to wire fields", async () => {
		let observedBody: string | undefined;
		const stubFetch = stub(async (_input, init) => {
			observedBody = init?.body as string;
			return jsonResponse(201, { run: { id: "r1" }, sandbox: { id: "b1" } });
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
			targetBranch: "feature/x",
			model: "claude-sonnet-4-5",
			provider: "anthropic",
		});
		expect(JSON.parse(observedBody || "{}")).toEqual({
			agent: "claude-code",
			project: "p1",
			prompt: "do thing",
			ref: "feature/x",
			targetBranch: "feature/x",
			modelOverride: "claude-sonnet-4-5",
			providerOverride: "anthropic",
		});
	});

	test("dispatch omits optional fields when not provided", async () => {
		let observedBody: string | undefined;
		const stubFetch = stub(async (_input, init) => {
			observedBody = init?.body as string;
			return jsonResponse(201, { run: { id: "r1" }, sandbox: { id: "b1" } });
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
});

describe("WarrenClient.steer", () => {
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
					sandboxId: "b1",
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
					sandboxId: "b1",
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
});

describe("WarrenClient.getRun + waitForRun", () => {
	test("getRun GETs /runs/:id and url-encodes", async () => {
		let observedUrl: string | undefined;
		const stubFetch = stub(async (input) => {
			observedUrl = String(input);
			return jsonResponse(200, { run: { id: "r 1", state: "running" } });
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
			return jsonResponse(200, { run: { id: "r1", state } });
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
			return jsonResponse(200, { run: { id: "r1", state: "failed" } });
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
		const stubFetch = stub(async () => jsonResponse(200, { run: { id: "r1", state: "running" } }));
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

	test("waitForRun retries a transient 500 and a network error (gh #1305)", async () => {
		const steps: Array<() => Response> = [
			() => jsonResponse(500, { error: { code: "internal", message: "db down" } }),
			() => {
				throw new TypeError("fetch failed: ECONNRESET");
			},
			() => jsonResponse(200, { run: { id: "r1", state: "running" } }),
			() => jsonResponse(200, { run: { id: "r1", state: "succeeded" } }),
		];
		let idx = 0;
		const stubFetch = stub(async () => (steps[idx++] ?? (steps[3] as () => Response))());
		const c = new WarrenClient({ config: { baseUrl: "https://w.local" }, fetch: stubFetch });
		const row = await c.waitForRun("r1", { intervalMs: 1, timeoutMs: 5_000 });
		expect(row.state).toBe("succeeded");
		expect(idx).toBe(4);
	});

	test("waitForRun fails fast on a 404 (gh #1305)", async () => {
		let calls = 0;
		const stubFetch = stub(async () => {
			calls++;
			return jsonResponse(404, { error: { code: "not_found", message: "no run" } });
		});
		const c = new WarrenClient({ config: { baseUrl: "https://w.local" }, fetch: stubFetch });
		const promise = c.waitForRun("r1", { intervalMs: 1, timeoutMs: 5_000 });
		await expect(promise).rejects.toMatchObject({ status: 404 });
		expect(calls).toBe(1);
	});

	test("waitForRun throws wait_timeout naming the last error when only transient errors occur", async () => {
		const stubFetch = stub(async () => {
			throw new TypeError("fetch failed: ECONNREFUSED");
		});
		const c = new WarrenClient({ config: { baseUrl: "https://w.local" }, fetch: stubFetch });
		try {
			await c.waitForRun("r1", { intervalMs: 5, timeoutMs: 20 });
			throw new Error("expected timeout");
		} catch (err) {
			expect(err).toBeInstanceOf(WarrenClientError);
			expect((err as WarrenClientError).code).toBe("wait_timeout");
			expect((err as WarrenClientError).message).toContain("last error:");
			expect((err as WarrenClientError).message).toContain("ECONNREFUSED");
		}
	});

	test("waitForRun aborts when signal fires", async () => {
		const stubFetch = stub(async () => jsonResponse(200, { run: { id: "r1", state: "running" } }));
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
});
