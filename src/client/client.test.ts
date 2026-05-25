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
});
