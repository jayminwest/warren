/**
 * Unit tests for the GitHub auto-merge arm (plan pl-92a3, step 3). Every test
 * runs against the stub server — no network — and injects the sleep seam, so
 * no test waits on a clock: the §2.4 wait schedule and the transport retry
 * delays both land in `sleeps` as recorded milliseconds.
 */

import { describe, expect, test } from "bun:test";
import type { ArmAutoMergeResult, AutoMergeMethod, PullRequestRef, RepoRef } from "../contract.ts";
import { armGitHubAutoMerge } from "./auto-merge.ts";
import { GitHubForge } from "./provider.ts";
import { stubGitHubServer } from "./stub-server.ts";
import { type GitHubForgeTokenSource, StaticGitHubTokenSource } from "./token-source.ts";

const REF: RepoRef = { forge: "github", key: "github.com/octo/widget" };
const DRAFT = {
	title: "Add the widget",
	body: "Body text.",
	headBranch: "warren/run-1",
	baseBranch: "main",
};

/** The fetch calls that reached the stub, for asserting shapes and short-circuits. */
type RecordedFetch = Array<{ url: string; body: string | null }>;

function makeHarness(tokens?: GitHubForgeTokenSource) {
	const stub = stubGitHubServer();
	const forge = new GitHubForge({ token: "pat-token", fetch: stub.fetch });
	const source = tokens ?? new StaticGitHubTokenSource("pat-token");
	const sleeps: number[] = [];
	const calls: RecordedFetch = [];
	const recording = (async (input: URL | RequestInfo, init?: RequestInit): Promise<Response> => {
		const raw = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
		calls.push({ url: raw, body: typeof init?.body === "string" ? init.body : null });
		return stub.fetch(input, init);
	}) as unknown as typeof fetch;
	const arm = (
		pr: PullRequestRef,
		method: AutoMergeMethod = "squash",
	): Promise<ArmAutoMergeResult> =>
		armGitHubAutoMerge({
			tokens: source,
			fetch: recording,
			slug: "octo/widget",
			pr,
			method,
			sleep: async (ms) => {
				sleeps.push(ms);
			},
		});
	async function openPr(): Promise<PullRequestRef> {
		const opened = await forge.openPullRequest(REF, DRAFT);
		if (!opened.ok) throw new Error("open failed");
		return opened.value;
	}
	const graphqlCalls = (): RecordedFetch => calls.filter((c) => c.url.endsWith("/graphql"));
	const restReads = (): RecordedFetch => calls.filter((c) => /\/pulls\/\d+$/.test(c.url));
	return { stub, forge, sleeps, arm, openPr, graphqlCalls, restReads };
}

function missingPr(): PullRequestRef {
	return { forge: "github", key: "github.com/octo/widget#999", number: 999, webUrl: "u" };
}

describe("armGitHubAutoMerge", () => {
	test("arms an open pull request with a settled mergeable state", async () => {
		const h = makeHarness();
		const pr = await h.openPr();
		const result = await h.arm(pr);
		expect(result).toEqual({ ok: true, value: { outcome: "armed" } });
		const state = await h.forge.getPullRequest(REF, pr);
		expect(state.ok && state.value.autoMerge).toBe("armed");
	});

	test("sends the mutation with the PR node id and the mapped merge method", async () => {
		const h = makeHarness();
		const pr = await h.openPr();
		const result = await h.arm(pr, "rebase");
		expect(result.ok).toBe(true);
		const call = h.graphqlCalls()[0];
		expect(call?.url).toBe("https://api.github.com/graphql");
		const body = JSON.parse(call?.body ?? "{}") as {
			query?: string;
			variables?: { input?: { pullRequestId?: unknown; mergeMethod?: unknown } };
		};
		expect(body.query).toContain("enablePullRequestAutoMerge");
		expect(body.variables?.input).toEqual({ pullRequestId: "PR_1", mergeMethod: "REBASE" });
	});

	test("answers already_armed from an existing request, without the mutation", async () => {
		const h = makeHarness();
		const pr = await h.openPr();
		await h.arm(pr);
		expect(h.graphqlCalls()).toHaveLength(1);
		// A scripted refusal would win if the mutation ran again; the pre-check wins.
		h.stub.scriptGraphQL({ errors: [{ message: "Auto merge is not allowed" }] });
		const again = await h.arm(pr);
		expect(again).toEqual({ ok: true, value: { outcome: "already_armed" } });
		expect(h.graphqlCalls()).toHaveLength(1);
	});

	test("classifies an already-enabled mutation error as already_armed (§8 double-armer)", async () => {
		const h = makeHarness();
		const pr = await h.openPr();
		h.stub.scriptGraphQL({ errors: [{ message: "Pull request auto merge is already enabled" }] });
		const result = await h.arm(pr);
		expect(result).toEqual({ ok: true, value: { outcome: "already_armed" } });
	});

	test("refuses not_open on a merged pull request without calling the mutation", async () => {
		const h = makeHarness();
		const pr = await h.openPr();
		h.stub.patchPullRequest(pr.number, { merged: true });
		const result = await h.arm(pr);
		expect(result).toEqual({
			ok: false,
			error: { reason: "not_open", message: expect.stringContaining("merged") },
		});
		expect(h.graphqlCalls()).toHaveLength(0);
		expect(h.sleeps).toEqual([]);
	});

	test("refuses not_open on a closed pull request", async () => {
		const h = makeHarness();
		const pr = await h.openPr();
		h.stub.patchPullRequest(pr.number, { state: "closed" });
		const result = await h.arm(pr);
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.error.reason).toBe("not_open");
			expect(result.error.message).toContain("closed");
		}
		expect(h.graphqlCalls()).toHaveLength(0);
	});

	test("refuses not_open on a draft pull request", async () => {
		const h = makeHarness();
		const pr = await h.openPr();
		h.stub.patchPullRequest(pr.number, { draft: true });
		const result = await h.arm(pr);
		expect(result).toEqual({
			ok: false,
			error: { reason: "not_open", message: expect.stringContaining("draft") },
		});
	});

	test("refuses repo_auto_merge_disabled from GitHub's message", async () => {
		const h = makeHarness();
		const pr = await h.openPr();
		h.stub.scriptGraphQL({
			errors: [{ message: "Auto merge is not allowed for this repository" }],
		});
		const result = await h.arm(pr);
		expect(result).toEqual({
			ok: false,
			error: {
				reason: "repo_auto_merge_disabled",
				message: "Auto merge is not allowed for this repository",
			},
		});
	});

	test("refuses clean_status from GitHub's message", async () => {
		const h = makeHarness();
		const pr = await h.openPr();
		h.stub.scriptGraphQL({ errors: [{ message: "Pull request is in clean status" }] });
		const result = await h.arm(pr);
		expect(result).toEqual({
			ok: false,
			error: { reason: "clean_status", message: "Pull request is in clean status" },
		});
	});

	test("refuses insufficient_permission on a 403 from the GraphQL route", async () => {
		const h = makeHarness();
		const pr = await h.openPr();
		h.stub.scriptGraphQL({ status: 403, body: "Resource not accessible by integration" });
		const result = await h.arm(pr);
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.error.reason).toBe("insufficient_permission");
			expect(result.error.message).toContain("Resource not accessible by integration");
		}
	});

	test("refuses insufficient_permission on the integration message (PAT-scope shape)", async () => {
		const h = makeHarness();
		const pr = await h.openPr();
		h.stub.scriptGraphQL({
			errors: [{ type: "FORBIDDEN", message: "Resource not accessible by integration" }],
		});
		const result = await h.arm(pr);
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error.reason).toBe("insufficient_permission");
	});

	test("refuses insufficient_permission from a FORBIDDEN-typed error with other wording", async () => {
		const h = makeHarness();
		const pr = await h.openPr();
		h.stub.scriptGraphQL({ errors: [{ type: "FORBIDDEN", message: "You shall not arm" }] });
		const result = await h.arm(pr);
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error.reason).toBe("insufficient_permission");
	});

	test("refuses insufficient_permission on a missing PAT scope", async () => {
		const h = makeHarness();
		const pr = await h.openPr();
		h.stub.scriptGraphQL({
			errors: [{ message: "Your token does not have the required scopes for this mutation" }],
		});
		const result = await h.arm(pr);
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error.reason).toBe("insufficient_permission");
	});

	test("refuses mergeability_unsettled from a mutation mergeability error", async () => {
		const h = makeHarness();
		const pr = await h.openPr();
		h.stub.scriptGraphQL({ errors: [{ message: "Pull Request is not mergeable" }] });
		const result = await h.arm(pr);
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.error.reason).toBe("mergeability_unsettled");
			expect(result.error.message).toBe("Pull Request is not mergeable");
		}
	});

	test("refuses not_open from a mutation closed error", async () => {
		const h = makeHarness();
		const pr = await h.openPr();
		h.stub.scriptGraphQL({ errors: [{ message: "Pull request is closed" }] });
		const result = await h.arm(pr);
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error.reason).toBe("not_open");
	});

	test("refuses unknown with GitHub's words on an unclassifiable error", async () => {
		const h = makeHarness();
		const pr = await h.openPr();
		h.stub.scriptGraphQL({ errors: [{ message: "Something novel happened" }] });
		const result = await h.arm(pr);
		expect(result).toEqual({
			ok: false,
			error: { reason: "unknown", message: "Something novel happened" },
		});
	});

	test("refuses unknown naming the ForgeErrorKind when the GraphQL transport fails", async () => {
		const h = makeHarness();
		const pr = await h.openPr();
		// Three scripted 500s exhaust the transport retry (the sleep seam records the waits).
		h.stub.scriptGraphQL({ status: 500 });
		h.stub.scriptGraphQL({ status: 500 });
		h.stub.scriptGraphQL({ status: 500 });
		const result = await h.arm(pr);
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.error.reason).toBe("unknown");
			expect(result.error.message).toContain("(http_error)");
		}
	});

	test("refuses unknown naming the kind when the REST read fails", async () => {
		const h = makeHarness();
		const result = await h.arm(missingPr());
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.error.reason).toBe("unknown");
			expect(result.error.message).toContain("(not_found)");
		}
	});

	test("waits the §2.4 schedule while mergeability is unknown, then arms", async () => {
		const h = makeHarness();
		const pr = await h.openPr();
		h.stub.patchPullRequest(pr.number, { mergeableStates: ["unknown", "unknown", "clean"] });
		const result = await h.arm(pr);
		expect(result).toEqual({ ok: true, value: { outcome: "armed" } });
		expect(h.sleeps).toEqual([1_000, 2_000]);
		expect(h.graphqlCalls()).toHaveLength(1);
	});

	test("refuses mergeability_unsettled past the schedule bound and never arms", async () => {
		const h = makeHarness();
		const pr = await h.openPr();
		h.stub.patchPullRequest(pr.number, { mergeableStates: ["unknown"] });
		const result = await h.arm(pr);
		expect(result).toEqual({
			ok: false,
			error: {
				reason: "mergeability_unsettled",
				message: expect.stringContaining("never settled"),
			},
		});
		// Four waits (1s, 2s, 4s, 8s — §2.4's bound) over five reads, no mutation.
		expect(h.sleeps).toEqual([1_000, 2_000, 4_000, 8_000]);
		expect(h.restReads()).toHaveLength(5);
		expect(h.graphqlCalls()).toHaveLength(0);
	});

	test("treats an unstable mergeable_state as the retryable class", async () => {
		const h = makeHarness();
		const pr = await h.openPr();
		h.stub.patchPullRequest(pr.number, { mergeableStates: ["unstable", "blocked"] });
		const result = await h.arm(pr);
		expect(result).toEqual({ ok: true, value: { outcome: "armed" } });
		expect(h.sleeps).toEqual([1_000]);
	});

	test("refuses unknown on a conflicting pull request, without waiting or arming", async () => {
		const h = makeHarness();
		const pr = await h.openPr();
		h.stub.patchPullRequest(pr.number, { mergeableStates: ["dirty"] });
		const result = await h.arm(pr);
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.error.reason).toBe("unknown");
			expect(result.error.message).toContain("dirty");
		}
		expect(h.sleeps).toEqual([]);
		expect(h.graphqlCalls()).toHaveLength(0);
	});

	test("refuses unknown naming the credential kind when the mint fails", async () => {
		const h = makeHarness(new StaticGitHubTokenSource(""));
		const pr = await h.openPr();
		const result = await h.arm(pr);
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.error.reason).toBe("unknown");
			expect(result.error.message).toContain("no_credential");
		}
	});
});
