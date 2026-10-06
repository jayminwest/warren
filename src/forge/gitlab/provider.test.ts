import { describe, expect, test } from "bun:test";
import { jsonResponse } from "../github/test-helpers.ts";
import { GitLabForge } from "./provider.ts";
import { parseGitLabInstance } from "./repo-ref.ts";
import { stubGitLabServer } from "./stub-server.ts";
import { setup } from "./test-helpers.ts";

const draft = {
	title: "Add the widget",
	body: "Body.",
	headBranch: "warren/run-1",
	baseBranch: "main",
};

describe("GitLabForge requests", () => {
	test("authenticates with PRIVATE-TOKEN and addresses the project by its encoded path", async () => {
		const { forge, ref, stub } = setup();
		await forge.openPullRequest(ref, draft);
		const call = stub.state.calls[0];
		expect(call?.privateToken).toBe("glpat-test");
		expect(call?.url).toBe(
			"https://gitlab.com/api/v4/projects/acme%2Fplatform%2Fwidget/merge_requests",
		);
	});

	test("keeps a self-hosted instance's URL root in front of /api/v4", async () => {
		const instance = parseGitLabInstance("https://git.example.com/gitlab");
		if (instance === null) throw new Error("unreachable");
		const stub = stubGitLabServer();
		const forge = new GitLabForge({ instance, token: "t", fetch: stub.fetch });
		const ref = forge.parseRepoRef("https://git.example.com/gitlab/team/app.git");
		if (ref === null) throw new Error("unreachable");
		const opened = await forge.openPullRequest(ref, draft);
		expect(stub.state.calls[0]?.url).toStartWith(
			"https://git.example.com/gitlab/api/v4/projects/team%2Fapp/",
		);
		expect(opened.ok && opened.value.webUrl).toBe(
			"https://git.example.com/gitlab/team/app/-/merge_requests/1",
		);
	});

	test("hands git the oauth2 username beside the token, with no expiry", async () => {
		const { forge, ref } = setup();
		expect(await forge.gitCredential(ref)).toEqual({
			ok: true,
			value: { username: "oauth2", secret: "glpat-test", expiresAt: null },
		});
	});

	test("answers no_credential without a request when the token is empty", async () => {
		const stub = stubGitLabServer();
		const base = setup();
		const forge = new GitLabForge({
			instance: {
				origin: "https://gitlab.com",
				host: "gitlab.com",
				hostname: "gitlab.com",
				basePath: "",
			},
			token: "",
			fetch: stub.fetch,
		});
		const opened = await forge.openPullRequest(base.ref, draft);
		expect(opened.ok).toBe(false);
		if (!opened.ok) expect(opened.error.kind).toBe("no_credential");
		expect((await forge.gitCredential(base.ref)).ok).toBe(false);
		expect(stub.state.calls).toHaveLength(0);
	});
});

describe("GitLabForge merge requests", () => {
	test("marks a draft through the title prefix GitLab reads", async () => {
		const { forge, ref, stub } = setup();
		await forge.openPullRequest(ref, { ...draft, draft: true });
		expect(stub.state.mergeRequests[0]?.title).toBe("Draft: Add the widget");
	});

	test("refuses a fork-qualified head instead of opening against the wrong project", async () => {
		const { forge, ref, stub } = setup();
		const opened = await forge.openPullRequest(ref, { ...draft, headBranch: "someone:feature" });
		expect(opened.ok).toBe(false);
		if (!opened.ok) expect(opened.error.kind).toBe("unsupported");
		expect(stub.state.calls).toHaveLength(0);
	});

	test("builds a web URL that parses back to the same repo ref", async () => {
		const { forge, ref } = setup();
		const opened = await forge.openPullRequest(ref, draft);
		if (!opened.ok) throw new Error("open failed");
		expect(opened.value.webUrl).toBe("https://gitlab.com/acme/platform/widget/-/merge_requests/1");
		expect(opened.value.key).toBe("gitlab.com/acme/platform/widget!1");
		// The ci-fixer poller re-parses run.prUrl into a ref.
		expect(forge.parseRepoRef(opened.value.webUrl)).toEqual(ref);
	});

	test("finds a merged request under the closed state, and never an open one", async () => {
		const { forge, ref, stub } = setup();
		const opened = await forge.openPullRequest(ref, draft);
		if (!opened.ok) throw new Error("open failed");
		const query = {
			headBranch: draft.headBranch,
			baseBranch: draft.baseBranch,
			state: "closed" as const,
		};
		expect(await forge.findPullRequest(ref, query)).toEqual({ ok: true, value: null });
		const mr = stub.state.mergeRequests[0];
		if (mr === undefined) throw new Error("unreachable");
		mr.state = "merged";
		const found = await forge.findPullRequest(ref, query);
		expect(found.ok && found.value?.number).toBe(1);
	});

	test("reads merged, closed and armed states off the merge request", async () => {
		const { forge, ref, stub } = setup();
		const opened = await forge.openPullRequest(ref, draft);
		if (!opened.ok) throw new Error("open failed");
		const mr = stub.state.mergeRequests[0];
		if (mr === undefined) throw new Error("unreachable");

		mr.merge_when_pipeline_succeeds = true;
		const armed = await forge.getPullRequest(ref, opened.value);
		expect(armed.ok && armed.value.autoMerge).toBe("armed");

		mr.state = "merged";
		mr.merged_at = "2026-10-06T12:00:00.000Z";
		const merged = await forge.getPullRequest(ref, opened.value);
		expect(merged.ok && merged.value).toMatchObject({
			lifecycle: "merged",
			mergedAt: Date.parse("2026-10-06T12:00:00.000Z"),
		});

		mr.state = "closed";
		const closed = await forge.getPullRequest(ref, opened.value);
		expect(closed.ok && closed.value).toMatchObject({
			lifecycle: "closed_unmerged",
			mergedAt: null,
		});
	});

	test("rewrites the description in place", async () => {
		const { forge, ref, stub } = setup();
		const opened = await forge.openPullRequest(ref, draft);
		if (!opened.ok) throw new Error("open failed");
		expect((await forge.setPullRequestBody(ref, opened.value, "Rewritten.")).ok).toBe(true);
		expect(stub.state.mergeRequests[0]?.description).toBe("Rewritten.");
		expect(stub.state.calls.at(-1)?.method).toBe("PUT");
	});
});

describe("GitLabForge CI", () => {
	const SHA = "a".repeat(40);

	test("reads only the newest pipeline for the commit", async () => {
		const { forge, ref } = setup({
			pipelines: [
				{ id: 10, sha: SHA, jobs: [{ id: 1, name: "test", status: "failed" }] },
				{ id: 11, sha: SHA, jobs: [{ id: 2, name: "test", status: "success" }] },
			],
		});
		const checks = await forge.listChecks(ref, SHA);
		expect(checks.ok && checks.value).toEqual({
			conclusion: "passing",
			runs: [
				{
					name: "test",
					status: "completed",
					conclusion: "success",
					jobId: "2",
					detailsUrl: "https://gitlab.example/stub/-/jobs/2",
				},
			],
		});
	});

	test("folds job statuses onto the classifier's vocabulary", async () => {
		const { forge, ref } = setup({
			pipelines: [
				{
					id: 1,
					sha: SHA,
					jobs: [
						{ id: 1, name: "lint", status: "failed", allow_failure: true },
						{ id: 2, name: "deploy", status: "manual" },
						{ id: 3, name: "flaky", status: "canceled" },
						{ id: 4, name: "docs", status: "skipped" },
					],
				},
			],
		});
		const checks = await forge.listChecks(ref, SHA);
		if (!checks.ok) throw new Error("listChecks failed");
		expect(checks.value.runs.map((r) => r.conclusion)).toEqual([
			"neutral",
			"skipped",
			"cancelled",
			"skipped",
		]);
		expect(checks.value.conclusion).toBe("failing");
	});

	test("holds the rollup pending while a job is queued or running", async () => {
		const { forge, ref } = setup({
			pipelines: [
				{
					id: 1,
					sha: SHA,
					jobs: [
						{ id: 1, name: "build", status: "success" },
						{ id: 2, name: "test", status: "running" },
						{ id: 3, name: "e2e", status: "created" },
					],
				},
			],
		});
		const checks = await forge.listChecks(ref, SHA);
		if (!checks.ok) throw new Error("listChecks failed");
		expect(checks.value.conclusion).toBe("pending");
		expect(checks.value.runs.map((r) => r.status)).toEqual(["completed", "in_progress", "queued"]);
	});

	test("resolves a branch name to its tip, and a missing branch has no checks", async () => {
		const { forge, ref, stub } = setup({
			pipelines: [{ id: 1, sha: "abc123", jobs: [{ id: 9, name: "t", status: "failed" }] }],
		});
		const byBranch = await forge.listChecks(ref, "warren/run-1");
		expect(byBranch.ok && byBranch.value.conclusion).toBe("failing");
		expect(stub.state.calls[0]?.url).toContain("/repository/branches/warren%2Frun-1");
		expect(await forge.listChecks(ref, "warren/gone")).toEqual({
			ok: true,
			value: { conclusion: "unknown", runs: [] },
		});
	});

	test("tails a job trace to maxBytes, and degrades to null when it cannot", async () => {
		const { forge, ref } = setup();
		const tail = await forge.fetchJobLogTail(ref, "42", 32);
		expect(tail.ok && tail.value).toBe("[stub-gitlab] job 42 trace line 20".slice(-32));
		const failing = new GitLabForge({
			instance: {
				origin: "https://gitlab.com",
				host: "gitlab.com",
				hostname: "gitlab.com",
				basePath: "",
			},
			token: "t",
			fetch: (async () =>
				jsonResponse(403, { message: "403 Forbidden" })) as unknown as typeof fetch,
		});
		expect(await failing.fetchJobLogTail(ref, "42", 32)).toEqual({ ok: true, value: null });
	});
});

describe("GitLabForge branches and identity", () => {
	test("deletes a branch, and a missing one is not_found", async () => {
		const { forge, ref, stub } = setup();
		expect((await forge.deleteBranch(ref, "warren/run-1")).ok).toBe(true);
		expect(stub.state.branches.has("warren/run-1")).toBe(false);
		const again = await forge.deleteBranch(ref, "warren/run-1");
		expect(again.ok).toBe(false);
		if (!again.ok) expect(again.error.kind).toBe("not_found");
	});

	test("names the token's bot user by its commit email", async () => {
		const { forge } = setup({
			user: {
				username: "project_7_bot_x",
				name: "warren-bot",
				commit_email: "bot@noreply.example",
			},
		});
		expect(await forge.botIdentity()).toEqual({
			ok: true,
			value: { name: "warren-bot", email: "bot@noreply.example" },
		});
	});

	test("reports unsupported when the user names no email, unauthorized on a bad token", async () => {
		const quiet = setup({ user: { username: "someone" } });
		const identity = await quiet.forge.botIdentity();
		expect(identity.ok).toBe(false);
		if (!identity.ok) expect(identity.error.kind).toBe("unsupported");
		const rejected = setup({ user: null });
		const denied = await rejected.forge.botIdentity();
		expect(denied.ok).toBe(false);
		if (!denied.ok) expect(denied.error.kind).toBe("unauthorized");
	});
});
