import { describe, expect, test } from "bun:test";
import { WarrenClient } from "./index.ts";
import { jsonResponse, stub } from "./test-helpers.ts";

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

	test("listReadyPlans GETs /projects/:id/ready-plans and parses shape", async () => {
		let observedUrl: string | undefined;
		const stubFetch = stub(async (input) => {
			observedUrl = String(input);
			return jsonResponse(200, {
				plans: [{ id: "pl-1", name: "Ship it", status: "approved", openChildCount: 2 }],
			});
		});
		const c = new WarrenClient({
			config: { baseUrl: "https://w.local" },
			fetch: stubFetch,
		});
		const res = await c.listReadyPlans("p 1");
		expect(observedUrl).toBe("https://w.local/projects/p%201/ready-plans");
		expect(res.plans).toEqual([
			{ id: "pl-1", name: "Ship it", status: "approved", openChildCount: 2 },
		]);
	});

	test("listReadyPlans forwards an AbortSignal", async () => {
		let observedSignal: AbortSignal | null | undefined;
		const stubFetch = stub(async (_input, init) => {
			observedSignal = init?.signal;
			return jsonResponse(200, { plans: [] });
		});
		const c = new WarrenClient({
			config: { baseUrl: "https://w.local" },
			fetch: stubFetch,
		});
		const ctrl = new AbortController();
		await c.listReadyPlans("p1", ctrl.signal);
		expect(observedSignal).toBe(ctrl.signal);
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
