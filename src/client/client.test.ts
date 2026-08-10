import { describe, expect, test } from "bun:test";
import { WarrenClient, WarrenClientError } from "./index.ts";
import { jsonResponse, stub } from "./test-helpers.ts";

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

	test("performs whoami request and returns the capability set", async () => {
		let observedUrl: string | undefined;

		const stubFetch = stub(async (input) => {
			observedUrl = String(input);
			return jsonResponse(200, { identity: "anonymous", capabilities: ["readPublic"] });
		});

		const client = new WarrenClient({
			config: { baseUrl: "https://warren.local" },
			fetch: stubFetch,
		});

		const who = await client.whoami();
		expect(observedUrl).toBe("https://warren.local/whoami");
		expect(who).toEqual({ identity: "anonymous", capabilities: ["readPublic"] });
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

	test("rejects a non-finite maxCostUsd before serialization (warren-a63d)", async () => {
		// JSON.stringify turns NaN/Infinity into null, which the server reads
		// as "no cap" — the SDK must fail loudly instead of dispatching uncapped.
		let fetched = false;
		const stubFetch = stub(async () => {
			fetched = true;
			return jsonResponse(201, { run: { id: "r1" }, burrow: { id: "b1" } });
		});
		const client = new WarrenClient({
			config: { baseUrl: "https://warren.local" },
			fetch: stubFetch,
		});
		const base = { agent: "claude-code", project: "p1", prompt: "hello" };
		for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, 0, -1]) {
			expect(client.createRun({ ...base, maxCostUsd: bad })).rejects.toThrow(
				/maxCostUsd must be a positive finite number/,
			);
			expect(client.createPlanRun({ ...base, planId: "pl-x", maxCostUsd: bad })).rejects.toThrow(
				/maxCostUsd must be a positive finite number/,
			);
		}
		expect(fetched).toBe(false);
	});

	test("performs cancelRun request with reason", async () => {
		let observedUrl: string | undefined;
		let observedMethod: string | undefined;
		let observedBody: string | undefined;

		const stubFetch = stub(async (input, init) => {
			observedUrl = String(input);
			observedMethod = init?.method;
			observedBody = init?.body as string;
			return jsonResponse(200, {
				state: "cancelled",
				alreadyTerminal: false,
				burrowRun: { id: "b1", state: "cancelled" },
			});
		});

		const client = new WarrenClient({
			config: { baseUrl: "https://warren.local" },
			fetch: stubFetch,
		});

		const res = await client.cancelRun("r1", { reason: "no longer needed" });
		expect(observedUrl).toBe("https://warren.local/runs/r1/cancel");
		expect(observedMethod).toBe("POST");
		expect(JSON.parse(observedBody || "{}")).toEqual({ reason: "no longer needed" });
		expect(res.state).toBe("cancelled");
		expect(res.alreadyTerminal).toBe(false);
		expect(res.burrowRun).toEqual({ id: "b1", state: "cancelled" });
	});

	test("cancelRun omits reason when not given and reports alreadyTerminal", async () => {
		let observedBody: string | undefined;

		const stubFetch = stub(async (_input, init) => {
			observedBody = init?.body as string;
			return jsonResponse(200, { state: "succeeded", alreadyTerminal: true, burrowRun: null });
		});

		const client = new WarrenClient({
			config: { baseUrl: "https://warren.local" },
			fetch: stubFetch,
		});

		const res = await client.cancelRun("r2");
		expect(JSON.parse(observedBody || "{}")).toEqual({});
		expect(res.alreadyTerminal).toBe(true);
		expect(res.burrowRun).toBeNull();
	});

	test("performs version request", async () => {
		let observedUrl: string | undefined;

		const stubFetch = stub(async (input) => {
			observedUrl = String(input);
			return jsonResponse(200, { version: "1.2.3" });
		});

		const client = new WarrenClient({
			config: { baseUrl: "https://warren.local" },
			fetch: stubFetch,
		});

		const res = await client.version();
		expect(observedUrl).toBe("https://warren.local/version");
		expect(res.version).toBe("1.2.3");
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
