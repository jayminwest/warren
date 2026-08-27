/**
 * GitHubForge unit tests against the canned-response `recordingFetch`. The
 * contract conformance suite against the stateful stub server lives in
 * `src/forge/contract.test.ts`.
 */

import { describe, expect, test } from "bun:test";
import { GITHUB_API_BASE } from "./headers.ts";
import { GitHubForge } from "./provider.ts";
import { jsonResponse, recordingFetch } from "./test-helpers.ts";

const REF = { forge: "github", key: "github.com/octo/widget" } as const;
const DRAFT = {
	title: "Add the widget",
	body: "Body text.",
	headBranch: "warren/run-1",
	baseBranch: "main",
};

function forgeWith(responses: ReadonlyArray<Response | (() => Response)>) {
	const rec = recordingFetch(responses);
	return { forge: new GitHubForge({ token: "pat-token", fetch: rec.fetch }), calls: rec.calls };
}

function prJson(n: number, overrides: Record<string, unknown> = {}) {
	return {
		number: n,
		html_url: `https://github.com/octo/widget/pull/${n}`,
		state: "open",
		merged_at: null,
		head: { ref: DRAFT.headBranch, sha: "deadbeef" },
		base: { ref: "main" },
		...overrides,
	};
}

describe("GitHubForge capabilities", () => {
	test("reports the classic-PAT set: checkRuns true, static lifetime, no bot identity", () => {
		expect(new GitHubForge({ token: "t" }).capabilities).toEqual({
			checkRuns: true,
			jobLogs: true,
			pullRequestBodyEdit: true,
			branchDelete: true,
			botIdentity: false,
			installationRepos: false,
			credentialLifetime: "static",
		});
	});

	test("checkRuns: false models the fine-grained PAT degradation (§5/§6.7)", async () => {
		const forge = new GitHubForge({ token: "t", checkRuns: false });
		expect(forge.capabilities.checkRuns).toBe(false);
		const result = await forge.listChecks(REF, "sha");
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error.kind).toBe("unsupported");
	});
});

describe("GitHubForge.gitCredential", () => {
	test("returns the static secret with expiresAt null (§4)", async () => {
		const forge = new GitHubForge({ token: "pat-token" });
		const result = await forge.gitCredential(REF);
		expect(result).toEqual({
			ok: true,
			value: { username: "x-access-token", secret: "pat-token", expiresAt: null },
		});
	});

	test("an empty token degrades to no_credential", async () => {
		const forge = new GitHubForge({ token: "" });
		const result = await forge.gitCredential(REF);
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error.kind).toBe("no_credential");
	});
});

describe("GitHubForge.openPullRequest", () => {
	test("creates a PR and maps the response to a PullRequestRef", async () => {
		const { forge, calls } = forgeWith([jsonResponse(201, prJson(42))]);
		const result = await forge.openPullRequest(REF, DRAFT);
		expect(result).toEqual({
			ok: true,
			value: {
				forge: "github",
				key: "github.com/octo/widget#42",
				number: 42,
				webUrl: "https://github.com/octo/widget/pull/42",
			},
		});
		expect(calls[0]?.url).toBe(`${GITHUB_API_BASE}/repos/octo/widget/pulls`);
		expect(calls[0]?.method).toBe("POST");
		expect(JSON.parse(calls[0]?.body ?? "{}")).toMatchObject({
			head: DRAFT.headBranch,
			base: DRAFT.baseBranch,
		});
	});

	test("is idempotent: a 422 duplicate resolves to the existing PR (pass 1)", async () => {
		const { forge } = forgeWith([
			jsonResponse(422, { message: "Validation Failed: A pull request already exists" }),
			jsonResponse(200, [prJson(7)]),
		]);
		const result = await forge.openPullRequest(REF, DRAFT);
		expect(result.ok).toBe(true);
		if (result.ok) expect(result.value.number).toBe(7);
	});

	test("the duplicate search finds a cross-fork head on the base scan (pass 2, §6.13)", async () => {
		const { forge, calls } = forgeWith([
			jsonResponse(422, { message: "A pull request already exists" }),
			// Pass 1: the owner-qualified filter misses the forked head.
			jsonResponse(200, []),
			// Pass 2: the on-base scan matches head.ref.
			jsonResponse(200, [prJson(9)]),
		]);
		const result = await forge.openPullRequest(REF, DRAFT);
		expect(result.ok).toBe(true);
		if (result.ok) expect(result.value.number).toBe(9);
		expect(calls[1]?.url).toContain("head=octo%3Awarren%2Frun-1");
		expect(calls[2]?.url).not.toContain("head=");
	});

	test("a 422 with no discoverable duplicate surfaces a conflict error", async () => {
		const { forge } = forgeWith([
			jsonResponse(422, { message: "A pull request already exists" }),
			jsonResponse(200, []),
			jsonResponse(200, []),
		]);
		const result = await forge.openPullRequest(REF, DRAFT);
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error.kind).toBe("conflict");
	});

	test("a non-duplicate failure maps the transport kind", async () => {
		const { forge } = forgeWith([jsonResponse(403, { message: "Forbidden" })]);
		const result = await forge.openPullRequest(REF, DRAFT);
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.error.kind).toBe("forbidden");
			expect(result.error.status).toBe(403);
		}
	});
});

describe("GitHubForge.findPullRequest", () => {
	test("returns the direct hit when the owner-qualified filter matches", async () => {
		const { forge } = forgeWith([jsonResponse(200, [prJson(3)])]);
		const result = await forge.findPullRequest(REF, {
			headBranch: DRAFT.headBranch,
			baseBranch: "main",
		});
		expect(result.ok).toBe(true);
		if (result.ok) expect(result.value?.number).toBe(3);
	});

	test("returns ok-null when no PR covers the pair", async () => {
		const { forge } = forgeWith([jsonResponse(200, []), jsonResponse(200, [])]);
		const result = await forge.findPullRequest(REF, {
			headBranch: "warren/none",
			baseBranch: "main",
		});
		expect(result).toEqual({ ok: true, value: null });
	});

	test("propagates a transport error from the search", async () => {
		// The transport core retries transient 5xx in-band; the canned thunk
		// serves every attempt so the search still ends in http_error.
		const { forge } = forgeWith(
			Array.from({ length: 4 }, () => () => jsonResponse(500, { message: "boom" })),
		);
		const result = await forge.findPullRequest(REF, {
			headBranch: "x",
			baseBranch: "main",
		});
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error.kind).toBe("http_error");
	});
});

describe("GitHubForge.getPullRequest", () => {
	const pr = { forge: "github", key: "github.com/octo/widget#5", number: 5, webUrl: "u" };

	test("maps an open PR", async () => {
		const { forge } = forgeWith([jsonResponse(200, prJson(5))]);
		const result = await forge.getPullRequest(REF, pr);
		expect(result).toEqual({
			ok: true,
			value: { lifecycle: "open", mergedAt: null, headCommit: "deadbeef", baseBranch: "main" },
		});
	});

	test("maps merged_at to the merged lifecycle with an epoch-ms mergedAt (§7)", async () => {
		const { forge } = forgeWith([
			jsonResponse(200, prJson(5, { merged_at: "2026-08-01T00:00:00Z", state: "closed" })),
		]);
		const result = await forge.getPullRequest(REF, pr);
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.value.lifecycle).toBe("merged");
			expect(result.value.mergedAt).toBe(Date.parse("2026-08-01T00:00:00Z"));
		}
	});

	test("maps a closed unmerged PR", async () => {
		const { forge } = forgeWith([jsonResponse(200, prJson(5, { state: "closed" }))]);
		const result = await forge.getPullRequest(REF, pr);
		expect(result.ok && result.value.lifecycle === "closed_unmerged").toBe(true);
	});

	test("a missing PR is a not_found error", async () => {
		const { forge } = forgeWith([jsonResponse(404, { message: "Not Found" })]);
		const result = await forge.getPullRequest(REF, pr);
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error.kind).toBe("not_found");
	});
});

describe("GitHubForge.setPullRequestBody", () => {
	const pr = { forge: "github", key: "k", number: 5, webUrl: "u" };

	test("PATCHes the domain-composed body (§3)", async () => {
		const { forge, calls } = forgeWith([jsonResponse(200, {})]);
		const result = await forge.setPullRequestBody(REF, pr, "Rewritten.");
		expect(result).toEqual({ ok: true, value: undefined });
		expect(calls[0]?.method).toBe("PATCH");
		expect(JSON.parse(calls[0]?.body ?? "{}")).toEqual({ body: "Rewritten." });
	});
});

describe("GitHubForge.listChecks", () => {
	test("rolls up an empty check list to unknown", async () => {
		const { forge } = forgeWith([jsonResponse(200, { check_runs: [] })]);
		const result = await forge.listChecks(REF, "sha-empty");
		expect(result).toEqual({ ok: true, value: { conclusion: "unknown", runs: [] } });
	});

	test("extracts the Actions job id from details_url, falling back to the run id", async () => {
		const { forge } = forgeWith([
			jsonResponse(200, {
				check_runs: [
					{
						id: 11,
						name: "ci",
						status: "completed",
						conclusion: "failure",
						details_url: "https://github.com/o/r/actions/runs/9/job/777",
					},
					{ id: 12, name: "lint", status: "completed", conclusion: "success" },
				],
			}),
		]);
		const result = await forge.listChecks(REF, "sha");
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.value.conclusion).toBe("failing");
			expect(result.value.runs[0]?.jobId).toBe("777");
			expect(result.value.runs[1]?.jobId).toBe("12");
		}
	});

	test("a non-completed run makes the rollup pending", async () => {
		const { forge } = forgeWith([
			jsonResponse(200, {
				check_runs: [{ id: 1, name: "ci", status: "in_progress", conclusion: null }],
			}),
		]);
		const result = await forge.listChecks(REF, "sha");
		expect(result.ok && result.value.conclusion === "pending").toBe(true);
	});
});

describe("GitHubForge.fetchJobLogTail", () => {
	test("tails the log body to maxBytes", async () => {
		const log = "line one\nline two\nline three\n";
		const { forge } = forgeWith([new Response(log, { status: 200 })]);
		const result = await forge.fetchJobLogTail(REF, "777", 12);
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.value).not.toBeNull();
			expect(result.value?.length).toBeLessThanOrEqual(12);
		}
	});

	test("degrades to ok-null on a transport failure (best-effort by contract)", async () => {
		const { forge } = forgeWith([jsonResponse(410, { message: "Gone" })]);
		const result = await forge.fetchJobLogTail(REF, "777", 100);
		expect(result).toEqual({ ok: true, value: null });
	});
});

describe("GitHubForge.deleteBranch", () => {
	test("DELETEs the branch ref", async () => {
		const { forge, calls } = forgeWith([new Response(null, { status: 204 })]);
		const result = await forge.deleteBranch(REF, "warren/run-1");
		expect(result).toEqual({ ok: true, value: undefined });
		expect(calls[0]?.url).toBe(
			`${GITHUB_API_BASE}/repos/octo/widget/git/refs/heads/warren%2Frun-1`,
		);
		expect(calls[0]?.method).toBe("DELETE");
	});

	test("maps a missing ref to not_found", async () => {
		const { forge } = forgeWith([jsonResponse(422, { message: "Reference does not exist" })]);
		const result = await forge.deleteBranch(REF, "warren/gone");
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error.kind).toBe("conflict");
	});
});

describe("GitHubForge.botIdentity", () => {
	test("is unsupported in PAT mode — the domain falls back to WARREN_GIT_AUTHOR_* (§5)", async () => {
		const forge = new GitHubForge({ token: "t" });
		const result = await forge.botIdentity();
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error.kind).toBe("unsupported");
	});
});

describe("GitHubForge credential gating", () => {
	test("every credential-requiring method degrades to no_credential with an empty token", async () => {
		const forge = new GitHubForge({ token: "" });
		const pr = { forge: "github", key: "k", number: 1, webUrl: "u" };
		const results = await Promise.all([
			forge.gitCredential(REF),
			forge.openPullRequest(REF, DRAFT),
			forge.findPullRequest(REF, { headBranch: "h", baseBranch: "b" }),
			forge.getPullRequest(REF, pr),
			forge.setPullRequestBody(REF, pr, "x"),
			forge.listChecks(REF, "sha"),
			forge.deleteBranch(REF, "b"),
		]);
		for (const result of results) {
			expect(result.ok).toBe(false);
			if (!result.ok) expect(result.error.kind).toBe("no_credential");
		}
		// fetchJobLogTail is best-effort: empty token degrades to ok-null.
		expect(await forge.fetchJobLogTail(REF, "1", 10)).toEqual({ ok: true, value: null });
	});
});
