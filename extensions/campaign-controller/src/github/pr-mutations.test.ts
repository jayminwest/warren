import { describe, expect, test } from "bun:test";
import { BoundaryError } from "../errors.ts";
import { NO_MUTATIONS } from "../mutations.ts";
import { validateRepositoryPolicy } from "../repository-policy.ts";
import {
	BunFetchGithubBranchUpdater,
	BunFetchGithubCommentPoster,
	BunFetchGithubPrUpdater,
	GithubMutationUncertainError,
	GitPushFollowUpPusher,
	renderFollowUpPushIntent,
	renderPostCommentIntent,
	renderUpdateBranchIntent,
	renderUpdatePullRequestIntent,
} from "./pr-mutations.ts";

const NOW = Date.parse("2026-08-27T00:00:00.000Z");
const TOKEN = "ghp_test-token-value-123";

function policyWith(mutations: Record<string, boolean>) {
	return validateRepositoryPolicy(
		{
			schemaVersion: 1,
			profileId: "openclaw",
			upstream: { owner: "openclaw", repo: "openclaw" },
			source: {
				url: "https://raw.githubusercontent.com/openclaw/openclaw/main/CONTRIBUTING.md",
				fetchedAt: "2026-08-26T00:00:00.000Z",
				sha256: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
			},
			stalenessMaxDays: 90,
			issueFirstRequired: true,
			aiDisclosure: { required: true, evidenceRequired: true },
			allowedWorkTypes: ["bug-fix", "docs", "test"],
			forbiddenPaths: [".github/workflows/*", "SECURITY.md"],
			protectedPaths: [],
			upstreamObservedMaxOpenPrs: 20,
			maxOpenPrs: 5,
			maxNewPrsPerDay: 2,
			requiredChecks: ["ci"],
			mutations: { ...NO_MUTATIONS, ...mutations },
		},
		{ nowMs: NOW },
	).policy;
}

const DRY_RUN = policyWith({});
const ALL_ON = policyWith({
	updatePullRequest: true,
	postComment: true,
	updateBranch: true,
	followUpPush: true,
});

function okResponse(status: number, body: unknown): Response {
	return new Response(JSON.stringify(body), { status });
}

function recordingFetch(
	status = 200,
	body: unknown = {},
): { calls: { method: string; url: string; body: unknown }[]; fetch: typeof fetch } {
	const calls: { method: string; url: string; body: unknown }[] = [];
	const impl = ((_url: unknown, init?: RequestInit) => {
		calls.push({
			method: String(init?.method),
			url: String(_url),
			body: init?.body,
		});
		return Promise.resolve(okResponse(status, body));
	}) as typeof fetch;
	return { calls, fetch: impl };
}

describe("per-flag enforced-by-absence (warren-094b)", () => {
	test("a dry-run policy constructs no mutation transport at all", () => {
		expect(() => new BunFetchGithubPrUpdater({ policy: DRY_RUN, token: TOKEN })).toThrow(
			BoundaryError,
		);
		expect(() => new BunFetchGithubCommentPoster({ policy: DRY_RUN, token: TOKEN })).toThrow(
			BoundaryError,
		);
		expect(() => new BunFetchGithubBranchUpdater({ policy: DRY_RUN, token: TOKEN })).toThrow(
			BoundaryError,
		);
		expect(
			() => new GitPushFollowUpPusher({ policy: DRY_RUN, push: async () => undefined }),
		).toThrow(BoundaryError);
	});

	test("each enabled flag constructs only its own transport — the others stay absent", () => {
		const updateOnly = policyWith({ updatePullRequest: true });
		expect(() => new BunFetchGithubPrUpdater({ policy: updateOnly, token: TOKEN })).not.toThrow();
		expect(() => new BunFetchGithubCommentPoster({ policy: updateOnly, token: TOKEN })).toThrow(
			/mutations.postComment/,
		);
		expect(() => new BunFetchGithubBranchUpdater({ policy: updateOnly, token: TOKEN })).toThrow(
			/mutations.updateBranch/,
		);
		expect(
			() => new GitPushFollowUpPusher({ policy: updateOnly, push: async () => undefined }),
		).toThrow(/mutations.followUpPush/);

		const commentOnly = policyWith({ postComment: true });
		expect(
			() => new BunFetchGithubCommentPoster({ policy: commentOnly, token: TOKEN }),
		).not.toThrow();
		expect(() => new BunFetchGithubPrUpdater({ policy: commentOnly, token: TOKEN })).toThrow(
			/mutations.updatePullRequest/,
		);

		const branchOnly = policyWith({ updateBranch: true });
		expect(
			() => new BunFetchGithubBranchUpdater({ policy: branchOnly, token: TOKEN }),
		).not.toThrow();
		expect(() => new BunFetchGithubPrUpdater({ policy: branchOnly, token: TOKEN })).toThrow(
			/mutations.updatePullRequest/,
		);

		const pushOnly = policyWith({ followUpPush: true });
		expect(
			() => new GitPushFollowUpPusher({ policy: pushOnly, push: async () => undefined }),
		).not.toThrow();
		expect(() => new BunFetchGithubPrUpdater({ policy: pushOnly, token: TOKEN })).toThrow(
			/mutations.updatePullRequest/,
		);
	});

	test("no credential, no transport even with the flag on", () => {
		expect(() => new BunFetchGithubPrUpdater({ policy: ALL_ON, token: "" })).toThrow(
			/credential is required/,
		);
		expect(() => new BunFetchGithubCommentPoster({ policy: ALL_ON, token: "" })).toThrow(
			/credential is required/,
		);
		expect(() => new BunFetchGithubBranchUpdater({ policy: ALL_ON, token: "" })).toThrow(
			/credential is required/,
		);
	});
});

describe("mutation transports send the journaled intent verbatim", () => {
	test("updatePullRequest PATCHes the policy upstream and nothing else", async () => {
		const { calls, fetch } = recordingFetch(200, { updated_at: "2026-08-27T01:00:00Z" });
		const transport = new BunFetchGithubPrUpdater({
			policy: ALL_ON,
			token: TOKEN,
			fetchImpl: fetch,
		});
		const intent = renderUpdatePullRequestIntent({
			upstreamOwner: "openclaw",
			upstreamRepo: "openclaw",
			prNumber: 7,
			title: "new title",
		});
		expect(intent.url).toBe("/repos/openclaw/openclaw/pulls/7");
		const result = await transport.updatePullRequest(intent);
		expect(result.updatedAt).toBe("2026-08-27T01:00:00Z");
		expect(calls).toHaveLength(1);
		expect(calls[0]?.method).toBe("PATCH");
		expect(calls[0]?.url).toBe("https://api.github.com/repos/openclaw/openclaw/pulls/7");
	});

	test("postComment POSTs to the issue comments collection and returns the id", async () => {
		const { calls, fetch } = recordingFetch(201, { id: 4242 });
		const transport = new BunFetchGithubCommentPoster({
			policy: ALL_ON,
			token: TOKEN,
			fetchImpl: fetch,
		});
		const intent = renderPostCommentIntent({
			upstreamOwner: "openclaw",
			upstreamRepo: "openclaw",
			issueNumber: 9,
			body: "follow-up reply",
		});
		const result = await transport.postComment(intent);
		expect(result.commentId).toBe(4242);
		expect(calls[0]?.method).toBe("POST");
		expect(calls[0]?.url).toBe("https://api.github.com/repos/openclaw/openclaw/issues/9/comments");
	});

	test("updateBranch PUTs the update-branch endpoint", async () => {
		const { calls, fetch } = recordingFetch(202, { message: "Updating pull request state..." });
		const transport = new BunFetchGithubBranchUpdater({
			policy: ALL_ON,
			token: TOKEN,
			fetchImpl: fetch,
		});
		const intent = renderUpdateBranchIntent({
			upstreamOwner: "openclaw",
			upstreamRepo: "openclaw",
			prNumber: 3,
		});
		const result = await transport.updateBranch(intent);
		expect(result.message).toBe("Updating pull request state...");
		expect(calls[0]?.method).toBe("PUT");
		expect(calls[0]?.url).toBe(
			"https://api.github.com/repos/openclaw/openclaw/pulls/3/update-branch",
		);
		expect(calls[0]?.body).toBe('{"update_method":"merge"}');
	});

	test("followUpPush drives the injected push primitive to the policy fork", async () => {
		const pushes: string[] = [];
		const transport = new GitPushFollowUpPusher({
			policy: ALL_ON,
			push: async (intent) => {
				pushes.push(intent.body.headBranch);
			},
		});
		const intent = renderFollowUpPushIntent({
			forkOwner: "warren-bot",
			forkRepo: "openclaw",
			headBranch: "warren/issue-9",
			refspec: "HEAD:refs/heads/warren/issue-9",
		});
		const result = await transport.pushFollowUpCommits(intent);
		expect(result.pushedTo).toBe("warren/issue-9");
		expect(pushes).toEqual(["warren/issue-9"]);
	});

	test("followUpPush refuses a fork that is not the policy repo's fork", async () => {
		const transport = new GitPushFollowUpPusher({ policy: ALL_ON, push: async () => undefined });
		await expect(
			transport.pushFollowUpCommits({
				method: "GIT_PUSH",
				url: "https://github.com/someone/other.git",
				body: { forkOwner: "someone", forkRepo: "other", headBranch: "x", refspec: "HEAD:x" },
			}),
		).rejects.toBeInstanceOf(BoundaryError);
	});

	test("a transport failure after the request may have been sent is uncertain", async () => {
		const failing = ((_url: unknown, _init?: RequestInit) => {
			throw new Error("connection reset");
		}) as unknown as typeof fetch;
		const transport = new BunFetchGithubPrUpdater({
			policy: ALL_ON,
			token: TOKEN,
			fetchImpl: failing,
		});
		await expect(
			transport.updatePullRequest(
				renderUpdatePullRequestIntent({
					upstreamOwner: "openclaw",
					upstreamRepo: "openclaw",
					prNumber: 7,
					title: "t",
				}),
			),
		).rejects.toBeInstanceOf(GithubMutationUncertainError);

		const pusher = new GitPushFollowUpPusher({
			policy: ALL_ON,
			push: async () => {
				throw new Error("remote hung up");
			},
		});
		await expect(
			pusher.pushFollowUpCommits(
				renderFollowUpPushIntent({
					forkOwner: "warren-bot",
					forkRepo: "openclaw",
					headBranch: "b",
					refspec: "HEAD:refs/heads/b",
				}),
			),
		).rejects.toBeInstanceOf(GithubMutationUncertainError);
	});

	test("a GitHub refusal (non-2xx) is a definite failure, not uncertain", async () => {
		const { fetch } = recordingFetch(422, { message: "Validation Failed" });
		const transport = new BunFetchGithubCommentPoster({
			policy: ALL_ON,
			token: TOKEN,
			fetchImpl: fetch,
		});
		await expect(
			transport.postComment(
				renderPostCommentIntent({
					upstreamOwner: "openclaw",
					upstreamRepo: "openclaw",
					issueNumber: 9,
					body: "x",
				}),
			),
		).rejects.toMatchObject({ status: 422 });
	});
});

describe("intent rendering", () => {
	test("renders are frozen, deterministic, and refuse empty payloads", () => {
		const intent = renderUpdateBranchIntent({
			upstreamOwner: "openclaw",
			upstreamRepo: "openclaw",
			prNumber: 3,
		});
		expect(Object.isFrozen(intent)).toBe(true);
		expect(Object.isFrozen(intent.body)).toBe(true);
		expect(() =>
			renderUpdatePullRequestIntent({
				upstreamOwner: "openclaw",
				upstreamRepo: "openclaw",
				prNumber: 3,
			}),
		).toThrow(/title or a body/);
		expect(() =>
			renderPostCommentIntent({
				upstreamOwner: "openclaw",
				upstreamRepo: "openclaw",
				issueNumber: 3,
				body: "  ",
			}),
		).toThrow(/non-empty/);
		expect(() =>
			renderUpdatePullRequestIntent({
				upstreamOwner: "openclaw",
				upstreamRepo: "openclaw",
				prNumber: 0,
				title: "t",
			}),
		).toThrow(/positive integer/);
	});
});
