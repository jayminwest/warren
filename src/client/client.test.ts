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

	test("performs listProjects request", async () => {
		let observedUrl: string | undefined;
		let observedMethod: string | undefined;

		const stubFetch = stub(async (input, init) => {
			observedUrl = String(input);
			observedMethod = init?.method ?? "GET";
			return jsonResponse(200, {
				projects: [
					{ id: "p1", gitUrl: "git@github.com:foo/bar.git", localPath: "/foo", defaultBranch: "main", addedAt: "now", lastFetchedAt: null, lastHeadSha: null, hasPlot: false, hasSeeds: false }
				]
			});
		});

		const client = new WarrenClient({
			config: { baseUrl: "https://warren.local" },
			fetch: stubFetch,
		});

		const res = await client.listProjects();
		expect(res.projects).toHaveLength(1);
		expect(res.projects[0].id).toBe("p1");
		expect(observedUrl).toBe("https://warren.local/projects");
		expect(observedMethod).toBe("GET");
	});

	test("performs createProject request", async () => {
		let observedUrl: string | undefined;
		let observedMethod: string | undefined;
		let observedBody: string | undefined;

		const stubFetch = stub(async (input, init) => {
			observedUrl = String(input);
			observedMethod = init?.method;
			observedBody = init?.body as string;
			return jsonResponse(201, { id: "p1", gitUrl: "git@github.com:foo/bar.git", localPath: "/foo", defaultBranch: "main", addedAt: "now", lastFetchedAt: null, lastHeadSha: null, hasPlot: false, hasSeeds: false });
		});

		const client = new WarrenClient({
			config: { baseUrl: "https://warren.local" },
			fetch: stubFetch,
		});

		const res = await client.createProject({
			gitUrl: "git@github.com:foo/bar.git",
			defaultBranch: "main",
		});

		expect(res.id).toBe("p1");
		expect(observedUrl).toBe("https://warren.local/projects");
		expect(observedMethod).toBe("POST");
		expect(JSON.parse(observedBody || "{}")).toEqual({
			gitUrl: "git@github.com:foo/bar.git",
			defaultBranch: "main",
		});
	});

	test("performs refreshProject request with or without ref", async () => {
		let observedUrl: string | undefined;
		let observedMethod: string | undefined;
		let observedBody: string | undefined;

		const stubFetch = stub(async (input, init) => {
			observedUrl = String(input);
			observedMethod = init?.method;
			observedBody = init?.body as string;
			return jsonResponse(200, {
				project: { id: "p1", gitUrl: "git@github.com:foo/bar.git", localPath: "/foo", defaultBranch: "main", addedAt: "now", lastFetchedAt: "now", lastHeadSha: "sha-abc", hasPlot: false, hasSeeds: false },
				headSha: "sha-abc",
				ref: "main",
			});
		});

		const client = new WarrenClient({
			config: { baseUrl: "https://warren.local" },
			fetch: stubFetch,
		});

		// 1. Without input
		const res1 = await client.refreshProject("p1");
		expect(res1.project.id).toBe("p1");
		expect(res1.headSha).toBe("sha-abc");
		expect(observedUrl).toBe("https://warren.local/projects/p1/refresh");
		expect(observedMethod).toBe("POST");
		expect(observedBody).toBeUndefined();

		// 2. With input ref
		const res2 = await client.refreshProject("p1", { ref: "feature-branch" });
		expect(res2.project.id).toBe("p1");
		expect(observedUrl).toBe("https://warren.local/projects/p1/refresh");
		expect(observedMethod).toBe("POST");
		expect(JSON.parse(observedBody || "{}")).toEqual({ ref: "feature-branch" });
	});

	test("performs listAgents request with or without projectId", async () => {
		let observedUrl1: string | undefined;
		let observedUrl2: string | undefined;

		const stubFetch = stub(async (input) => {
			if (!observedUrl1) {
				observedUrl1 = String(input);
			} else {
				observedUrl2 = String(input);
			}
			return jsonResponse(200, {
				agents: [{ name: "claude-code", renderedJson: {}, registeredAt: "now", lastRefreshed: "now", source: "builtin" }]
			});
		});

		const client = new WarrenClient({
			config: { baseUrl: "https://warren.local" },
			fetch: stubFetch,
		});

		// 1. Without projectId
		const res1 = await client.listAgents();
		expect(res1.agents).toHaveLength(1);
		expect(res1.agents[0].name).toBe("claude-code");
		expect(observedUrl1).toBe("https://warren.local/agents");

		// 2. With projectId
		const res2 = await client.listAgents({ projectId: "p-abc" });
		expect(res2.agents).toHaveLength(1);
		expect(observedUrl2).toBe("https://warren.local/agents?projectId=p-abc");
	});

	test("performs getAgent request with or without projectId", async () => {
		let observedUrl1: string | undefined;
		let observedUrl2: string | undefined;

		const stubFetch = stub(async (input) => {
			if (!observedUrl1) {
				observedUrl1 = String(input);
			} else {
				observedUrl2 = String(input);
			}
			return jsonResponse(200, { name: "claude-code", renderedJson: {}, registeredAt: "now", lastRefreshed: "now", source: "builtin" });
		});

		const client = new WarrenClient({
			config: { baseUrl: "https://warren.local" },
			fetch: stubFetch,
		});

		// 1. Without projectId
		const res1 = await client.getAgent("claude-code");
		expect(res1.name).toBe("claude-code");
		expect(observedUrl1).toBe("https://warren.local/agents/claude-code");

		// 2. With projectId
		const res2 = await client.getAgent("claude-code", { projectId: "p-abc" });
		expect(res2.name).toBe("claude-code");
		expect(observedUrl2).toBe("https://warren.local/agents/claude-code?projectId=p-abc");
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
