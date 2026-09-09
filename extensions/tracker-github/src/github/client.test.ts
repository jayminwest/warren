import { describe, expect, test } from "bun:test";
import { type Env, loadConfig } from "../config.ts";
import { FakeGitHub } from "../fake-github.ts";
import { GitHubClient } from "./client.ts";

const BASE = { GITHUB_TOKEN: "test-secret", GITHUB_REPOSITORY: "acme/web" };
const PROJECT = {
	...BASE,
	GITHUB_PROJECT_OWNER: "acme",
	GITHUB_PROJECT_NUMBER: "9",
	GITHUB_READY_STATUSES: '["Ready"]',
};
function client(fake: FakeGitHub, env: Env = BASE) {
	return new GitHubClient(loadConfig(env), fake.fetch);
}

describe("GitHubClient", () => {
	test("lists repository issues, excludes PRs and closed issues, and preserves actual closed status", async () => {
		const fake = new FakeGitHub();
		fake.pageSize = 1;
		fake.issues.push(
			{ number: 2, repository: "acme/web", type: "PullRequest" },
			{ number: 3, repository: "acme/web", state: "CLOSED" },
		);
		const c = client(fake);
		expect((await c.listIssues()).map((i) => i.id)).toEqual(["acme/web#1"]);
		expect((await c.listIssues(false)).map((i) => i.status)).toEqual(["open", "closed"]);
		expect(fake.requests.every((r) => new URL(r.url).host === "api.github.com")).toBe(true);
	});

	test("uses the selected Project's status and combines it with repository and all-label filters", async () => {
		const fake = new FakeGitHub();
		fake.pageSize = 1;
		fake.issues = [
			{ number: 1, repository: "acme/web", status: "Ready", labels: ["agent", "bug"] },
			{ number: 2, repository: "acme/web", status: "In review", labels: ["agent", "bug"] },
			{ number: 3, repository: "acme/other", status: "Ready", labels: ["agent", "bug"] },
			{ number: 4, repository: "acme/web", status: "Ready", labels: ["agent"] },
			{ number: 5, repository: "acme/web", status: null, labels: ["agent", "bug"] },
		];
		const c = client(fake, { ...PROJECT, GITHUB_LABELS: '["AGENT","bug"]' });
		expect((await c.listIssues()).map((i) => i.id)).toEqual(["acme/web#1"]);
		expect((await c.getIssue("acme/web#2")).ready).toBe(false);
		expect((await c.getIssue("acme/web#2")).status).toBe("open");
		const itemRequests = fake.requests.filter((r) =>
			JSON.stringify(r.body).includes("items(first:"),
		);
		expect(
			itemRequests.every((r) => (r.body as { variables: { id: string } }).variables.id === "P1"),
		).toBe(true);
	});

	test("supports user-owned cross-repository Projects without treating drafts, PRs, archived or redacted items as tasks", async () => {
		const fake = new FakeGitHub();
		fake.issues.push({ number: 2, repository: "acme/other", status: "Ready" });
		for (const type of ["DraftIssue", "PullRequest", "Redacted"] as const)
			fake.issues.push({ number: 3, repository: "acme/web", type, status: "Ready" });
		fake.issues.push({ number: 4, repository: "acme/web", archived: true, status: "Ready" });
		const { GITHUB_REPOSITORY: _repo, ...env } = PROJECT;
		const c = new GitHubClient(
			loadConfig({ ...env, GITHUB_PROJECT_OWNER_TYPE: "user" }),
			fake.fetch,
		);
		expect((await c.listIssues()).map((i) => i.id)).toEqual(["acme/other#2", "acme/web#1"]);
		expect(JSON.stringify(fake.requests[0]?.body)).toContain("user(login:");
	});

	test("supports any-label matching without interpolating labels or statuses into queries", async () => {
		const fake = new FakeGitHub();
		const c = client(fake, {
			...BASE,
			GITHUB_LABELS: '["needs help","agent"]',
			GITHUB_LABEL_MODE: "any",
		});
		expect((await c.listIssues()).length).toBe(1);
		expect(fake.requests[0]?.url).not.toContain("agent");
	});

	test("fails closed for nonexistent status options or fields and closed Projects", async () => {
		const fake = new FakeGitHub();
		await expect(
			client(fake, { ...PROJECT, GITHUB_READY_STATUSES: '["Typo"]' }).listIssues(),
		).rejects.toMatchObject({ code: "invalid_ready_status" });
		await expect(
			client(fake, { ...PROJECT, GITHUB_PROJECT_STATUS_FIELD: "Typo" }).listIssues(),
		).rejects.toMatchObject({ code: "invalid_status_field" });
		fake.projectClosed = true;
		await expect(client(fake, PROJECT).listIssues()).rejects.toMatchObject({
			code: "project_closed",
		});
	});

	test("refuses out-of-scope reads and closes, invalid ids, and PR ids", async () => {
		const fake = new FakeGitHub();
		fake.issues.push({ number: 2, repository: "acme/web", type: "PullRequest" });
		await expect(client(fake).getIssue("acme/other#1")).rejects.toMatchObject({
			code: "issue_not_found",
		});
		expect(fake.requests).toHaveLength(0);
		await expect(client(fake).getIssue("../web#1")).rejects.toMatchObject({
			code: "issue_not_found",
		});
		await expect(client(fake).getIssue("acme/web#2")).rejects.toMatchObject({
			code: "issue_not_found",
		});
		await expect(client(fake).closeIssue("acme/web#1")).rejects.toMatchObject({
			code: "close_disabled",
		});
		expect(fake.requests.some((r) => r.method === "PATCH")).toBe(false);
	});

	test("closes only with explicit opt-in and is idempotent without changing Project status", async () => {
		const fake = new FakeGitHub();
		const c = client(fake, { ...BASE, GITHUB_ALLOW_CLOSE: "true" });
		await c.closeIssue("acme/web#1");
		await c.closeIssue("acme/web#1");
		expect((await c.getIssue("acme/web#1")).status).toBe("closed");
		expect(fake.requests.filter((r) => r.method === "PATCH")).toHaveLength(1);
		expect(fake.issues[0]?.status).toBe("Ready");
	});

	test("never returns a truncated queue when a page limit or GraphQL partial error is encountered", async () => {
		const fake = new FakeGitHub();
		fake.pageSize = 1;
		fake.issues.push({ number: 2, repository: "acme/web", status: "Ready" });
		await expect(
			client(fake, { ...BASE, GITHUB_MAX_PAGES: "1" }).listIssues(),
		).rejects.toMatchObject({ code: "pagination_limit" });
		await expect(
			client(fake, { ...PROJECT, GITHUB_MAX_PAGES: "1" }).listIssues(),
		).rejects.toMatchObject({ code: "pagination_limit" });
		fake.error = Response.json({
			data: { node: null },
			errors: [{ message: "secret must not be echoed" }],
		});
		await expect(client(fake, PROJECT).listIssues()).rejects.toMatchObject({
			code: "upstream_graphql_error",
		});
	});

	test("distinguishes upstream permissions and rate limiting from the tracker's own auth", async () => {
		const fake = new FakeGitHub();
		fake.error = new Response("secret", { status: 401 });
		await expect(client(fake).listIssues()).rejects.toMatchObject({
			code: "upstream_unauthorized",
			status: 502,
		});
		fake.error = new Response("secret", { status: 403, headers: { "retry-after": "12" } });
		await expect(client(fake).listIssues()).rejects.toMatchObject({
			code: "upstream_rate_limited",
			retryAfter: "12",
			status: 429,
		});
	});
});
