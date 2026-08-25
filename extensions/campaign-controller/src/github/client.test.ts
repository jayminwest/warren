import { describe, expect, test } from "bun:test";
import { ReadOnlyGithubClient } from "./client.ts";
import { dedupeByNodeId } from "./dedupe.ts";
import { FakeGithubServer } from "./fake-server.ts";
import type { GithubReadResult } from "./types.ts";

const TOKEN = "ghp_test-token-value-123";

function newServer(): FakeGithubServer {
	return new FakeGithubServer({ redactionSecret: TOKEN });
}

function repoBody(): Record<string, unknown> {
	return {
		id: 1,
		node_id: "R_repo_1",
		name: "openclaw",
		full_name: "openclaw/openclaw",
		owner: { login: "openclaw", id: 10 },
		default_branch: "main",
		fork: false,
		archived: false,
		pushed_at: "2026-08-01T00:00:00Z",
		html_url: "https://github.com/openclaw/openclaw",
		secret_field: "should-not-survive",
	};
}

function issueBody(number: number): Record<string, unknown> {
	return {
		id: 100 + number,
		node_id: `I_issue_${number}`,
		number,
		state: "open",
		title: `Issue ${number}`,
		user: { login: "contributor" },
		labels: [{ name: "bug" }, { name: "help wanted" }],
		created_at: "2026-08-01T00:00:00Z",
		updated_at: "2026-08-02T00:00:00Z",
		closed_at: null,
		html_url: `https://github.com/openclaw/openclaw/issues/${number}`,
		untrusted_extra: { shell: "rm -rf /" },
	};
}

function prBody(): Record<string, unknown> {
	return {
		id: 900,
		node_id: "PR_1",
		number: 7,
		state: "open",
		draft: true,
		title: "Fix the thing",
		user: { login: "warren-run-bot" },
		head: { ref: "warren/issue-42", sha: "abc123", repo: { full_name: "warren-run-bot/openclaw" } },
		base: { ref: "main", sha: "def456", repo: { full_name: "openclaw/openclaw" } },
		merged_at: null,
		closed_at: null,
		created_at: "2026-08-01T00:00:00Z",
		updated_at: "2026-08-02T00:00:00Z",
		html_url: "https://github.com/openclaw/openclaw/pull/7",
	};
}

describe("ReadOnlyGithubClient reads", () => {
	test("reads repository metadata and narrows the response", async () => {
		const server = newServer().setResource("/repos/openclaw/openclaw", repoBody());
		const client = new ReadOnlyGithubClient(server);
		const result = await client.getRepository("openclaw", "openclaw");
		expect(result.notModified).toBe(false);
		expect(result.data).toEqual({
			nodeId: "R_repo_1",
			name: "openclaw",
			fullName: "openclaw/openclaw",
			ownerLogin: "openclaw",
			defaultBranch: "main",
			isFork: false,
			isArchived: false,
			pushedAt: "2026-08-01T00:00:00Z",
			htmlUrl: "https://github.com/openclaw/openclaw",
		});
		expect(JSON.stringify(result)).not.toContain("secret_field");
	});

	test("decodes base64 repository content", async () => {
		const content = btoa("contribution guide");
		const server = newServer().setResource("/repos/openclaw/openclaw/contents/CONTRIBUTING.md", {
			path: "CONTRIBUTING.md",
			encoding: "base64",
			content: content,
		});
		const client = new ReadOnlyGithubClient(server);
		const result = await client.getContent("openclaw", "openclaw", "CONTRIBUTING.md");
		expect(result.data?.text).toBe("contribution guide");
	});

	test("reads a single issue and drops untrusted extra fields", async () => {
		const server = newServer().setResource("/repos/openclaw/openclaw/issues/42", issueBody(42));
		const client = new ReadOnlyGithubClient(server);
		const result = await client.getIssue("openclaw", "openclaw", 42);
		expect(result.data?.nodeId).toBe("I_issue_42");
		expect(result.data?.labels).toEqual(["bug", "help wanted"]);
		expect(JSON.stringify(result)).not.toContain("untrusted_extra");
	});

	test("reads a pull request with cross-fork head and base coordinates", async () => {
		const server = newServer().setResource("/repos/openclaw/openclaw/pulls/7", prBody());
		const client = new ReadOnlyGithubClient(server);
		const result = await client.getPullRequest("openclaw", "openclaw", 7);
		expect(result.data?.headRepoFullName).toBe("warren-run-bot/openclaw");
		expect(result.data?.baseRepoFullName).toBe("openclaw/openclaw");
		expect(result.data?.draft).toBe(true);
	});

	test("reads notifications, comments, reviews, review comments, checks, and status", async () => {
		const server = newServer()
			.setResource("/notifications", [
				{
					id: "N_1",
					reason: "review_requested",
					updated_at: "2026-08-02T00:00:00Z",
					subject: {
						type: "PullRequest",
						title: "Fix the thing",
						url: "https://api.github.com/repos/openclaw/openclaw/pulls/7",
					},
					repository: { full_name: "openclaw/openclaw" },
				},
			])
			.setResource("/repos/openclaw/openclaw/issues/7/comments", [
				{
					id: 1,
					node_id: "IC_1",
					user: { login: "maintainer" },
					body: "thanks",
					created_at: "t",
					updated_at: "t",
					html_url: "u",
				},
			])
			.setResource("/repos/openclaw/openclaw/pulls/7/reviews", [
				{
					id: 1,
					node_id: "RV_1",
					user: { login: "maintainer" },
					state: "CHANGES_REQUESTED",
					body: "",
					submitted_at: "t",
					commit_id: "abc",
					html_url: "u",
				},
			])
			.setResource("/repos/openclaw/openclaw/pulls/7/comments", [
				{
					id: 1,
					node_id: "RC_1",
					user: { login: "maintainer" },
					body: "nit",
					created_at: "t",
					updated_at: "t",
					html_url: "u",
				},
			])
			.setResource("/repos/openclaw/openclaw/commits/abc123/check-runs", {
				total_count: 1,
				check_runs: [
					{
						id: 1,
						node_id: "CR_1",
						name: "ci",
						status: "completed",
						conclusion: "success",
						started_at: "t",
						completed_at: "t",
						html_url: "u",
					},
				],
			})
			.setResource("/repos/openclaw/openclaw/commits/abc123/status", {
				state: "success",
				total_count: 1,
				sha: "abc123",
				statuses: [{ context: "ci", state: "success", description: "passed" }],
			});
		const client = new ReadOnlyGithubClient(server);
		expect((await client.listNotifications({ participating: true })).items.length).toBe(1);
		expect((await client.listIssueComments("openclaw", "openclaw", 7)).items[0]?.nodeId).toBe(
			"IC_1",
		);
		expect((await client.listReviews("openclaw", "openclaw", 7)).items[0]?.state).toBe(
			"CHANGES_REQUESTED",
		);
		expect((await client.listReviewComments("openclaw", "openclaw", 7)).items[0]?.body).toBe("nit");
		expect(
			(await client.listCheckRunsForRef("openclaw", "openclaw", "abc123")).data?.[0]?.conclusion,
		).toBe("success");
		expect(
			(await client.getCombinedStatus("openclaw", "openclaw", "abc123")).data?.contexts,
		).toEqual([{ context: "ci", state: "success", description: "passed" }]);
	});

	test("listNotifications sends the participating flag and since filter", async () => {
		const server = newServer().setResource("/notifications", []);
		const client = new ReadOnlyGithubClient(server);
		await client.listNotifications({ participating: true, since: "2026-08-01T00:00:00Z" });
		const query = server.recordedRequests()[0]?.query;
		expect(query?.participating).toBe("true");
		expect(query?.since).toBe("2026-08-01T00:00:00Z");
	});
});

describe("ReadOnlyGithubClient pagination", () => {
	test("walks all pages and reports not truncated", async () => {
		const items = Array.from({ length: 250 }, (_, i) => issueBody(i + 1));
		const server = newServer().setPaginatedCollection("/repos/openclaw/openclaw/issues", items);
		const client = new ReadOnlyGithubClient(server, { perPage: 100, maxPages: 10 });
		const result = await client.listIssues("openclaw", "openclaw");
		expect(result.items.length).toBe(250);
		expect(result.truncated).toBe(false);
		expect(server.requestCount).toBe(3);
	});

	test("stops at the page bound and reports truncated", async () => {
		const items = Array.from({ length: 250 }, (_, i) => issueBody(i + 1));
		const server = newServer().setPaginatedCollection("/repos/openclaw/openclaw/issues", items);
		const client = new ReadOnlyGithubClient(server, { perPage: 100, maxPages: 2 });
		const result = await client.listIssues("openclaw", "openclaw");
		expect(result.items.length).toBe(200);
		expect(result.truncated).toBe(true);
	});

	test("a short final page ends pagination without another request", async () => {
		const items = Array.from({ length: 150 }, (_, i) => issueBody(i + 1));
		const server = newServer().setPaginatedCollection("/repos/openclaw/openclaw/issues", items);
		const client = new ReadOnlyGithubClient(server, { perPage: 100, maxPages: 10 });
		const result = await client.listIssues("openclaw", "openclaw");
		expect(result.items.length).toBe(150);
		expect(server.requestCount).toBe(2);
	});

	test("deduplicates duplicate node ids delivered across pages", async () => {
		const items = [issueBody(1), issueBody(2), issueBody(1), issueBody(3), issueBody(2)];
		const server = newServer().setPaginatedCollection("/repos/openclaw/openclaw/issues", items);
		const client = new ReadOnlyGithubClient(server);
		const result = await client.listIssues("openclaw", "openclaw");
		const deduped = dedupeByNodeId(result.items);
		expect(result.items.length).toBe(5);
		expect(deduped.items.length).toBe(3);
		expect(deduped.duplicateCount).toBe(2);
		expect(deduped.duplicateNodeIds).toEqual(["I_issue_1", "I_issue_2"]);
	});
});

describe("ReadOnlyGithubClient conditional requests", () => {
	test("replays an ETag and honors a 304 Not Modified", async () => {
		const server = newServer().setResource("/repos/openclaw/openclaw", repoBody());
		const client = new ReadOnlyGithubClient(server);
		const first = await client.getRepository("openclaw", "openclaw");
		expect(first.notModified).toBe(false);
		expect(first.etag).not.toBeNull();
		const second = await client.getRepository("openclaw", "openclaw", {
			etag: first.etag ?? undefined,
		});
		expect(second.notModified).toBe(true);
		expect(second.data).toBeUndefined();
		const conditionalRequest = server.recordedRequests()[1];
		expect(conditionalRequest?.headers["if-none-match"]).toBe(first.etag ?? undefined);
	});

	test("a bumped version produces a fresh 200 read", async () => {
		const server = newServer().setResource("/repos/openclaw/openclaw", repoBody());
		const client = new ReadOnlyGithubClient(server);
		const first = await client.getRepository("openclaw", "openclaw");
		server.mutateResource("/repos/openclaw/openclaw", { ...repoBody(), archived: true });
		const second = await client.getRepository("openclaw", "openclaw", {
			etag: first.etag ?? undefined,
		});
		expect(second.notModified).toBe(false);
		expect(second.data?.isArchived).toBe(true);
	});

	test("replays Last-Modified via If-Modified-Since and honors 304", async () => {
		const server = newServer().setResource("/repos/openclaw/openclaw/issues/42", issueBody(42));
		const client = new ReadOnlyGithubClient(server);
		const first = await client.getIssue("openclaw", "openclaw", 42);
		const second = await client.getIssue("openclaw", "openclaw", 42, {
			lastModified: first.lastModified ?? undefined,
		});
		expect(second.notModified).toBe(true);
		expect(server.recordedRequests()[1]?.headers["if-modified-since"]).toBe(
			first.lastModified ?? undefined,
		);
	});

	test("paginated reads short-circuit on a first-page 304", async () => {
		const server = newServer().setPaginatedCollection(
			"/repos/openclaw/openclaw/issues/7/comments",
			[],
		);
		const client = new ReadOnlyGithubClient(server);
		const first = await client.listIssueComments("openclaw", "openclaw", 7);
		const second = await client.listIssueComments("openclaw", "openclaw", 7, {
			etag: first.etag ?? undefined,
		});
		expect(second.notModified).toBe(true);
		expect(second.items).toEqual([]);
	});

	test("HEAD probe returns validators without a body", async () => {
		const server = newServer().setResource("/repos/openclaw/openclaw", repoBody());
		const client = new ReadOnlyGithubClient(server);
		const probe = await client.probeHead("/repos/openclaw/openclaw");
		expect(probe.status).toBe(200);
		expect(probe.etag).not.toBeNull();
		expect(server.recordedRequests()[0]?.method).toBe("HEAD");
	});
});

describe("ReadOnlyGithubClient error surface", () => {
	test("a 404 raises GithubApiError with status and path", async () => {
		const server = newServer();
		const client = new ReadOnlyGithubClient(server);
		await expect(client.getRepository("openclaw", "missing")).rejects.toMatchObject({
			name: "GithubApiError",
			status: 404,
			path: "/repos/openclaw/missing",
		});
	});

	test("reports the rate snapshot from response headers", async () => {
		const server = newServer()
			.setRateLimit({ limit: 5000, remaining: 42, resetEpochSeconds: 1_800_000_000 })
			.setResource("/repos/openclaw/openclaw", repoBody());
		const client = new ReadOnlyGithubClient(server);
		const result = await client.getRepository("openclaw", "openclaw");
		expect(result.rate).toEqual({ limit: 5000, remaining: 42, resetEpochSeconds: 1_800_000_000 });
	});

	test("missing required fields fail as ValidationError, never pass raw shapes", async () => {
		const server = newServer().setResource("/repos/openclaw/openclaw", { name: "openclaw" });
		const client = new ReadOnlyGithubClient(server);
		const result: unknown = client.getRepository("openclaw", "openclaw");
		await expect(result).rejects.toMatchObject({ name: "ValidationError" });
	});
});

describe("ReadOnlyGithubClient structural read-only proof", () => {
	test("the client surface contains no mutation-shaped operation", () => {
		const client = new ReadOnlyGithubClient(newServer());
		const proto = Object.getPrototypeOf(client) as Record<string, unknown>;
		const methodNames = [
			...Object.getOwnPropertyNames(proto),
			...Object.getOwnPropertyNames(client),
		].filter((name) => name !== "constructor");
		const mutationWords = [
			"post",
			"create",
			"update",
			"patch",
			"delete",
			"merge",
			"write",
			"submit",
			"reply",
			"assign",
			"close",
			"reopen",
			"push",
		];
		for (const name of methodNames) {
			for (const word of mutationWords) {
				expect(name.toLowerCase().includes(word)).toBe(false);
			}
		}
	});

	test("every request the client issues is GET or HEAD", async () => {
		const server = newServer()
			.setResource("/repos/openclaw/openclaw", repoBody())
			.setPaginatedCollection("/repos/openclaw/openclaw/issues", [issueBody(1)]);
		const client = new ReadOnlyGithubClient(server);
		await client.getRepository("openclaw", "openclaw");
		await client.listIssues("openclaw", "openclaw");
		await client.probeHead("/repos/openclaw/openclaw");
		for (const request of server.recordedRequests()) {
			expect(request.method === "GET" || request.method === "HEAD").toBe(true);
		}
	});

	test("every read result carries only narrowed, non-raw data", async () => {
		const server = newServer().setResource("/repos/openclaw/openclaw", repoBody());
		const client = new ReadOnlyGithubClient(server);
		const result: GithubReadResult<unknown> = await client.getRepository("openclaw", "openclaw");
		expect(Object.keys(result.data ?? {})).toEqual([
			"nodeId",
			"name",
			"fullName",
			"ownerLogin",
			"defaultBranch",
			"isFork",
			"isArchived",
			"pushedAt",
			"htmlUrl",
		]);
	});
});
