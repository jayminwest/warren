import { afterEach, beforeEach, describe, expect, test } from "bun:test";

/**
 * Wire-shape tests for the UI's fetch wrapper (`src/ui/src/api/client.ts`).
 *
 * The headline guarantee is negative and belongs to warren-e1b0: the
 * warren bearer must never appear in a URL, a query string, or an
 * `href`, because a credential in a URL lands in browser history, in the
 * `Referer` of every sub-resource, and in any proxy or analytics log on
 * the path. It rides the `Authorization` header instead, and the preview
 * handshake hands the target back in the response body rather than a
 * `Location`.
 *
 * `client.ts` only touches `localStorage` / `fetch` from inside function
 * bodies, so stubbing both globals before the dynamic import is enough —
 * no DOM shim needed.
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

function jsonOk(body: unknown): Response {
	return new Response(JSON.stringify(body), {
		status: 200,
		headers: { "content-type": "application/json" },
	});
}

beforeEach(() => {
	captured = [];
	nextResponse = () => jsonOk({ url: "https://run-run_abc.preview.example.com/" });
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

describe("runsApi.previewLogin (warren-e1b0)", () => {
	test("sends the bearer in the Authorization header, never in the URL", async () => {
		const { runsApi } = await import("./client.ts");
		await runsApi.previewLogin("run_abc");

		expect(captured).toHaveLength(1);
		const call = onlyCall();
		expect(call.url).toBe("/runs/run_abc/preview/login");
		// No query string at all — so no token-shaped value can hide in one.
		expect(call.url).not.toContain("?");
		expect(call.url).not.toContain(TOKEN);
		expect(call.init?.method).toBe("POST");
		const headers = call.init?.headers as Record<string, string>;
		expect(headers.authorization).toBe(`Bearer ${TOKEN}`);
	});

	test("returns the server-chosen preview URL", async () => {
		const { runsApi } = await import("./client.ts");
		const res = await runsApi.previewLogin("run_abc");
		expect(res.url).toBe("https://run-run_abc.preview.example.com/");
	});

	test("forwards an explicit redirect in the JSON body, not the query string", async () => {
		const { runsApi } = await import("./client.ts");
		await runsApi.previewLogin("run_abc", { redirect: "/p/run_abc/inner" });

		const call = onlyCall();
		expect(call.url).toBe("/runs/run_abc/preview/login");
		expect(call.init?.body).toBe(JSON.stringify({ redirect: "/p/run_abc/inner" }));
	});
});

describe("api token storage", () => {
	test("getApiToken reads the cached bearer; setApiToken(null) clears it", async () => {
		const { getApiToken, setApiToken } = await import("./client.ts");
		expect(getApiToken()).toBe(TOKEN);
		setApiToken("replacement");
		expect(getApiToken()).toBe("replacement");
		setApiToken(null);
		expect(getApiToken()).toBeNull();
	});

	test("an unavailable localStorage degrades to a null token, not a throw", async () => {
		const { getApiToken, setApiToken } = await import("./client.ts");
		(globalThis as { localStorage?: unknown }).localStorage = {
			getItem: () => {
				throw new Error("private mode");
			},
			setItem: () => {
				throw new Error("private mode");
			},
			removeItem: () => {
				throw new Error("private mode");
			},
		};
		expect(getApiToken()).toBeNull();
		expect(() => setApiToken("x")).not.toThrow();
	});
});

describe("request error mapping", () => {
	test("401 clears the cached token and raises UnauthorizedError", async () => {
		const { getApiToken, runsApi, UnauthorizedError } = await import("./client.ts");
		nextResponse = () => new Response("", { status: 401 });
		await expect(runsApi.previewLogin("run_abc")).rejects.toBeInstanceOf(UnauthorizedError);
		expect(getApiToken()).toBeNull();
	});

	test("a structured error envelope becomes an ApiError carrying code + hint", async () => {
		const { ApiError, runsApi } = await import("./client.ts");
		nextResponse = () =>
			new Response(
				JSON.stringify({
					error: { code: "preview_redirect_invalid", message: "bad redirect", hint: "use /p/" },
				}),
				{ status: 400, headers: { "content-type": "application/json" } },
			);
		try {
			await runsApi.previewLogin("run_abc");
			throw new Error("expected previewLogin to reject");
		} catch (err) {
			expect(err).toBeInstanceOf(ApiError);
			const e = err as InstanceType<typeof ApiError>;
			expect(e.status).toBe(400);
			expect(e.code).toBe("preview_redirect_invalid");
			expect(e.hint).toBe("use /p/");
			expect(e.message).toBe("bad redirect");
		}
	});

	test("a non-JSON error body falls back to an http_<status> code", async () => {
		const { ApiError, runsApi } = await import("./client.ts");
		nextResponse = () => new Response("gateway exploded", { status: 502 });
		try {
			await runsApi.previewLogin("run_abc");
			throw new Error("expected previewLogin to reject");
		} catch (err) {
			expect(err).toBeInstanceOf(ApiError);
			expect((err as InstanceType<typeof ApiError>).code).toBe("http_502");
		}
	});
});

/**
 * Every method in this module is a one-line `request()` wrapper whose only
 * real content is the path it builds. Table-driven so a renamed or
 * mistyped route shows up as a failing row rather than a 404 in the
 * browser — and so no future method can quietly smuggle a credential into
 * a query string (the shared assertion at the bottom).
 */
describe("wire paths", () => {
	const rows: readonly {
		name: string;
		call: (api: typeof import("./client.ts")) => Promise<unknown>;
		url: string;
		method?: string;
	}[] = [
		{ name: "agents.list", call: (a) => a.agentsApi.list(), url: "/agents" },
		{
			name: "agents.list (filtered)",
			call: (a) => a.agentsApi.list({ projectId: "p1" }),
			url: "/agents?projectId=p1",
		},
		{ name: "agents.get", call: (a) => a.agentsApi.get("claude-code"), url: "/agents/claude-code" },
		{ name: "projects.list", call: (a) => a.projectsApi.list(), url: "/projects" },
		{
			name: "projects.create",
			call: (a) => a.projectsApi.create({ gitUrl: "https://github.com/x/y.git" }),
			url: "/projects",
			method: "POST",
		},
		{
			name: "projects.delete",
			call: (a) => a.projectsApi.delete("p1"),
			url: "/projects/p1",
			method: "DELETE",
		},
		{
			name: "projects.refresh",
			call: (a) => a.projectsApi.refresh("p1"),
			url: "/projects/p1/refresh",
			method: "POST",
		},
		{
			name: "projects.warrenConfig",
			call: (a) => a.projectsApi.warrenConfig("p1"),
			url: "/projects/p1/warren-config",
		},
		{
			name: "projects.triggers",
			call: (a) => a.projectsApi.triggers("p1"),
			url: "/projects/p1/triggers",
		},
		{
			name: "projects.runTrigger",
			call: (a) => a.projectsApi.runTrigger("p1", "t1"),
			url: "/projects/p1/triggers/t1/run",
			method: "POST",
		},
		{
			name: "projects.seedStatus",
			call: (a) => a.projectsApi.seedStatus("p1", "warren-e1b0"),
			url: "/projects/p1/seeds/warren-e1b0",
		},
		{
			name: "projects.seedPlans",
			call: (a) => a.projectsApi.seedPlans("p1"),
			url: "/projects/p1/seeds/plans",
		},
		{
			name: "projects.readyPlans",
			call: (a) => a.projectsApi.readyPlans("p1"),
			url: "/projects/p1/ready-plans",
		},
		{ name: "runs.list", call: (a) => a.runsApi.list(), url: "/runs" },
		{
			name: "runs.list (filtered)",
			call: (a) => a.runsApi.list({ project: "p1", agent: "claude-code", sort: "cost", limit: 10 }),
			url: "/runs?project=p1&agent=claude-code&sort=cost&limit=10",
		},
		{ name: "runs.get", call: (a) => a.runsApi.get("run_abc"), url: "/runs/run_abc" },
		{
			name: "runs.create",
			call: (a) => a.runsApi.create({ agent: "claude-code", project: "p1", prompt: "go" }),
			url: "/runs",
			method: "POST",
		},
		{
			name: "runs.steer",
			call: (a) => a.runsApi.steer("run_abc", { body: "stop" }),
			url: "/runs/run_abc/steer",
			method: "POST",
		},
		{
			name: "runs.cancel",
			call: (a) => a.runsApi.cancel("run_abc"),
			url: "/runs/run_abc/cancel",
			method: "POST",
		},
		{
			name: "runs.previewTeardown",
			call: (a) => a.runsApi.previewTeardown("run_abc"),
			url: "/runs/run_abc/preview/teardown",
			method: "POST",
		},
		{ name: "preview.config", call: (a) => a.previewApi.config(), url: "/preview/config" },
		{ name: "planRuns.list", call: (a) => a.planRunsApi.list(), url: "/plan-runs" },
		{
			name: "planRuns.list (filtered)",
			call: (a) => a.planRunsApi.list({ project: "p1", state: "running" }),
			url: "/plan-runs?project=p1&state=running",
		},
		{ name: "planRuns.get", call: (a) => a.planRunsApi.get("pr_1"), url: "/plan-runs/pr_1" },
		{
			name: "planRuns.create",
			call: (a) => a.planRunsApi.create({ project: "p1", planId: "pl-b82d", agent: "claude-code" }),
			url: "/plan-runs",
			method: "POST",
		},
		{
			name: "planRuns.cancel",
			call: (a) => a.planRunsApi.cancel("pr_1"),
			url: "/plan-runs/pr_1/cancel",
			method: "POST",
		},
		{ name: "meta.healthz", call: (a) => a.metaApi.healthz(), url: "/healthz" },
		{ name: "meta.readyz", call: (a) => a.metaApi.readyz(), url: "/readyz" },
		{ name: "meta.version", call: (a) => a.metaApi.version(), url: "/version" },
		{ name: "analytics.cost", call: (a) => a.analyticsApi.cost(), url: "/analytics/cost" },
		{
			name: "analytics.cost (filtered)",
			call: (a) => a.analyticsApi.cost({ projectId: "p1", from: "2026-01-01" }),
			url: "/analytics/cost?projectId=p1&from=2026-01-01",
		},
		{ name: "runAnalytics.runs", call: (a) => a.runAnalyticsApi.runs(), url: "/analytics/runs" },
		{
			name: "runAnalytics.behavior",
			call: (a) => a.runAnalyticsApi.behavior({ projectId: "p1", to: "2026-02-01" }),
			url: "/analytics/behavior?projectId=p1&to=2026-02-01",
		},
	];

	for (const row of rows) {
		test(`${row.name} → ${row.method ?? "GET"} ${row.url}`, async () => {
			const api = await import("./client.ts");
			nextResponse = () => jsonOk({});
			await row.call(api);
			const call = onlyCall();
			expect(call.url).toBe(row.url);
			expect(call.init?.method).toBe(row.method ?? "GET");
			// warren-e1b0: the bearer belongs in the header on every route.
			expect(call.url).not.toContain(TOKEN);
			expect((call.init?.headers as Record<string, string>).authorization).toBe(`Bearer ${TOKEN}`);
		});
	}
});

describe("formatPreviewUrl", () => {
	test("path mode prefers the configured host over the browser origin", async () => {
		const { formatPreviewUrl } = await import("./client.ts");
		expect(
			formatPreviewUrl(
				"run_abc",
				{ mode: "path", host: "warren.example.com", port: null },
				"http://local",
			),
		).toBe("https://warren.example.com/p/run_abc/");
	});

	test("path mode falls back to the current origin when no host is configured", async () => {
		const { formatPreviewUrl } = await import("./client.ts");
		expect(
			formatPreviewUrl("run_abc", { mode: "path", host: null, port: null }, "http://local:7777"),
		).toBe("http://local:7777/p/run_abc/");
	});

	test("path mode swaps in the dedicated preview listener port (warren-3f8a)", async () => {
		const { formatPreviewUrl } = await import("./client.ts");
		expect(
			formatPreviewUrl("run_abc", { mode: "path", host: null, port: 8081 }, "http://local:8080"),
		).toBe("http://local:8081/p/run_abc/");
		expect(
			formatPreviewUrl(
				"run_abc",
				{ mode: "path", host: "warren.example.com", port: 8081 },
				"http://x",
			),
		).toBe("https://warren.example.com:8081/p/run_abc/");
	});

	test("subdomain mode keys off the configured host", async () => {
		const { formatPreviewUrl } = await import("./client.ts");
		expect(
			formatPreviewUrl(
				"run_abc",
				{ mode: "subdomain", host: "preview.example.com", port: null },
				"http://x",
			),
		).toBe("https://run-run_abc.preview.example.com/");
	});
});
