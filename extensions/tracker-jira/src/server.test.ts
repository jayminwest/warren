/**
 * The warren-tracker/v1 surface, driven against FakeJira.
 *
 * These cover the protocol obligations that are easy to get wrong on a
 * tracker with no close verb: idempotent close, the reserved
 * `issue_not_found` code on both paths, and the error mapping that keeps
 * a Jira credential failure from reading as a warren credential failure.
 * The suite in `@warren-ext/tracker-conformance` is the authority; these
 * are the cases worth failing fast on before it runs.
 */

import { describe, expect, test } from "bun:test";
import { loadConfig } from "./config.ts";
import { createFakeJira, type FakeJiraOptions, SAMPLE_ISSUES } from "./fake-jira.ts";
import { createJiraTrackerHandler } from "./server.ts";

function harness(options: Partial<FakeJiraOptions> = {}, env: Record<string, string> = {}) {
	const jira = createFakeJira({ issues: SAMPLE_ISSUES, ...options });
	const config = loadConfig({
		JIRA_BASE_URL: "https://acme.atlassian.net",
		JIRA_EMAIL: "bot@acme.example",
		JIRA_API_TOKEN: "token-123",
		JIRA_JQL: "project = WAR",
		...env,
	});
	const handler = createJiraTrackerHandler({ config, fetchImpl: jira.fetchImpl });
	const call = (method: string, path: string, headers: Record<string, string> = {}) =>
		handler(new Request(`http://tracker${path}`, { method, headers }));
	return { jira, call };
}

describe("GET /capabilities", () => {
	test("negotiates warren-tracker/v1 and declares the base contract only", async () => {
		const { call } = harness();
		const response = await call("GET", "/capabilities");
		expect(response.status).toBe(200);
		expect(response.headers.get("content-type")).toContain("application/json");
		expect(await response.json()).toEqual({
			protocolVersion: "warren-tracker/v1",
			capabilities: {
				supportsPlans: false,
				supportsMetadata: false,
				supportsScheduledIssues: false,
				isGitNative: false,
			},
		});
	});

	test("answers without touching Jira, so a boot probe needs no credential round trip", async () => {
		const { jira, call } = harness();
		await call("GET", "/capabilities");
		expect(jira.calls).toEqual([]);
	});
});

describe("GET /issues/{id}", () => {
	test("maps a Jira issue onto the wire shape", async () => {
		const { call } = harness();
		const body = await (await call("GET", "/issues/WAR-1")).json();
		expect(body).toEqual({
			id: "WAR-1",
			status: "To Do",
			title: "Redis connection pool leaks under load",
			description: "Connections are never returned after a timeout.\n\nReproduced on staging twice.",
			blockedBy: ["WAR-2"],
		});
	});

	test("answers a missing id with the reserved code", async () => {
		const { call } = harness();
		const response = await call("GET", "/issues/WAR-404");
		expect(response.status).toBe(404);
		expect(await response.json()).toEqual({
			error: { code: "issue_not_found", message: "issue not found: WAR-404" },
		});
	});
});

describe("GET /issue-statuses", () => {
	test("returns the raw id to status map for the configured query", async () => {
		const { call } = harness();
		const body = (await (await call("GET", "/issue-statuses")).json()) as {
			statuses: Record<string, string>;
		};
		expect(body.statuses).toEqual({ "WAR-1": "To Do", "WAR-2": "In Progress", "WAR-3": "Done" });
	});

	test("walks every page rather than returning the first one", async () => {
		const { jira, call } = harness({ pageSize: 1 });
		const body = (await (await call("GET", "/issue-statuses")).json()) as {
			statuses: Record<string, string>;
		};
		expect(Object.keys(body.statuses)).toHaveLength(3);
		expect(jira.calls.filter((c) => c.includes("/search/jql"))).toHaveLength(3);
	});

	test("fails loud rather than truncating when the query never stops paginating", async () => {
		const { call } = harness({ pageSize: 1 }, { JIRA_MAX_SEARCH_PAGES: "2" });
		const response = await call("GET", "/issue-statuses");
		expect(response.status).toBe(502);
		expect(((await response.json()) as { error: { message: string } }).error.message).toMatch(
			/JIRA_MAX_SEARCH_PAGES/,
		);
	});
});

describe("POST /issues/{id}/close", () => {
	test("transitions the issue into the done category", async () => {
		const { jira, call } = harness();
		const response = await call("POST", "/issues/WAR-1/close");
		expect(response.status).toBe(200);
		expect(await response.json()).toMatchObject({ id: "WAR-1", status: "Done" });
		expect(jira.issues.get("WAR-1")?.statusCategory).toBe("done");
	});

	test("closing an already-closed issue is 200 and transitions nothing", async () => {
		const { jira, call } = harness();
		const first = await call("POST", "/issues/WAR-1/close");
		const before = jira.calls.length;
		const second = await call("POST", "/issues/WAR-1/close");

		expect(first.status).toBe(200);
		expect(second.status).toBe(200);
		expect(await second.json()).toMatchObject({ id: "WAR-1", status: "Done" });
		// The second close reads the issue and stops there: no transition
		// list, no transition POST.
		expect(jira.calls.slice(before)).toEqual(["GET /rest/api/3/issue/WAR-1"]);
	});

	test("uses the transition an operator named", async () => {
		const { jira, call } = harness({}, { JIRA_DONE_TRANSITION: "Reject" });
		await call("POST", "/issues/WAR-1/close");
		expect(jira.issues.get("WAR-1")?.status).toBe("Rejected");
	});

	test("answers 409 when the workflow offers no way to a terminal status", async () => {
		const { call } = harness({
			transitions: [
				{ id: "11", name: "Start", toStatus: "In Progress", toCategory: "indeterminate" },
			],
		});
		const response = await call("POST", "/issues/WAR-1/close");
		expect(response.status).toBe(409);
		expect((await response.json()) as unknown).toMatchObject({
			error: { code: "no_close_transition" },
		});
	});

	test("answers a missing id with the reserved code", async () => {
		const { call } = harness();
		const response = await call("POST", "/issues/WAR-404/close");
		expect(response.status).toBe(404);
		expect((await response.json()) as unknown).toMatchObject({
			error: { code: "issue_not_found" },
		});
	});
});

describe("upstream failures", () => {
	test("a rejected Jira credential is 502, never 401", async () => {
		const { call } = harness({ failWith: { status: 401 } });
		const response = await call("GET", "/issues/WAR-1");
		expect(response.status).toBe(502);
		expect((await response.json()) as unknown).toMatchObject({
			error: { code: "upstream_unauthorized" },
		});
	});

	test("a Jira rate limit passes through with its Retry-After", async () => {
		const { call } = harness({ failWith: { status: 429, retryAfter: "30" } });
		const response = await call("GET", "/issues/WAR-1");
		expect(response.status).toBe(429);
		expect(response.headers.get("retry-after")).toBe("30");
		expect((await response.json()) as unknown).toMatchObject({
			error: { code: "upstream_rate_limited" },
		});
	});

	test("a Jira 5xx is 502", async () => {
		const { call } = harness({ failWith: { status: 503 } });
		const response = await call("GET", "/issues/WAR-1");
		expect(response.status).toBe(502);
		expect((await response.json()) as unknown).toMatchObject({ error: { code: "upstream_error" } });
	});
});

describe("the warren-facing bearer", () => {
	test("rejects a request without the configured token", async () => {
		const { call } = harness({}, { TRACKER_BEARER: "secret" });
		const response = await call("GET", "/capabilities");
		expect(response.status).toBe(401);
		expect((await response.json()) as unknown).toMatchObject({ error: { code: "unauthorized" } });
	});

	test("admits a request carrying it", async () => {
		const { call } = harness({}, { TRACKER_BEARER: "secret" });
		const response = await call("GET", "/capabilities", { authorization: "Bearer secret" });
		expect(response.status).toBe(200);
	});
});

describe("the undeclared surfaces", () => {
	test("answer 404 capability_not_supported instead of a bare no-route", async () => {
		const { call } = harness();
		for (const [method, path] of [
			["GET", "/plans"],
			["GET", "/plans/pl-1"],
			["POST", "/issues/WAR-1/metadata"],
			["GET", "/scheduled-issues"],
		] as const) {
			const response = await call(method, path);
			expect(response.status, `${method} ${path}`).toBe(404);
			expect((await response.json()) as unknown, `${method} ${path}`).toMatchObject({
				error: { code: "capability_not_supported" },
			});
		}
	});

	test("an unknown route is a plain not_found", async () => {
		const { call } = harness();
		const response = await call("GET", "/nope");
		expect(response.status).toBe(404);
		expect((await response.json()) as unknown).toMatchObject({ error: { code: "not_found" } });
	});
});

describe("a malformed path segment", () => {
	test("leaves through the error envelope instead of a URIError", async () => {
		const { call } = harness();
		for (const [method, path] of [
			["GET", "/issues/%"],
			["GET", "/issues/%zz"],
			["POST", "/issues/%/close"],
			["POST", "/issues/%e0%a4%a/close"],
		] as const) {
			const response = await call(method, path);
			expect(response.status, `${method} ${path}`).toBe(400);
			expect(response.headers.get("content-type"), `${method} ${path}`).toContain(
				"application/json",
			);
			expect((await response.json()) as unknown, `${method} ${path}`).toMatchObject({
				error: { code: "invalid_issue_id" },
			});
		}
	});

	test("still decodes a well-formed escape", async () => {
		const { call } = harness();
		const response = await call("GET", `/issues/${encodeURIComponent("WAR-1")}`);
		expect(response.status).toBe(200);
	});
});
