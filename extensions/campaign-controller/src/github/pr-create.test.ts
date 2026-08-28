/**
 * The single-mutation PR-create transport (Phase 2, warren-84da): the
 * structural gates and the wire discipline. The policy flag gates
 * CONSTRUCTION, the URL guard pins the target to the policy upstream, and
 * the three upstream outcomes classify precisely — created, already
 * exists (recover by read), and transport loss (uncertain, never retry).
 */
import { describe, expect, test } from "bun:test";
import { BoundaryError } from "../errors.ts";
import { validateRepositoryPolicy } from "../repository-policy.ts";
import { GithubApiError } from "./errors.ts";
import {
	assertIntentTargetsPolicyUpstream,
	BunFetchGithubPrCreator,
	GithubPrAlreadyExistsError,
	GithubPrCreateUncertainError,
} from "./pr-create.ts";
import { renderCrossForkPullRequestIntent } from "./pr-request.ts";

const NOW = Date.parse("2026-08-26T00:00:00.000Z");

function policyJson(createPullRequest: boolean): Record<string, unknown> {
	return {
		schemaVersion: 1,
		profileId: "openclaw",
		upstream: { owner: "openclaw", repo: "openclaw" },
		source: {
			url: "https://raw.githubusercontent.com/openclaw/openclaw/main/CONTRIBUTING.md",
			fetchedAt: "2026-08-20T00:00:00.000Z",
			sha256: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
		},
		stalenessMaxDays: 90,
		issueFirstRequired: true,
		aiDisclosure: { required: true, evidenceRequired: true },
		allowedWorkTypes: ["bug-fix"],
		forbiddenPaths: [".github/workflows/*"],
		protectedPaths: ["SECURITY.md"],
		upstreamObservedMaxOpenPrs: 20,
		maxOpenPrs: 5,
		maxNewPrsPerDay: 2,
		requiredChecks: ["ci"],
		mutations: {
			createPullRequest,
			followUpPush: false,
			updatePullRequest: false,
			pushCommits: false,
			updateBranch: false,
			postComment: false,
			editComment: false,
			requestReview: false,
			addLabels: false,
			closePullRequest: false,
			reopenPullRequest: false,
			enableAutoMerge: false,
			mergePullRequest: false,
			editIssue: false,
		},
	};
}

function livePolicy() {
	return validateRepositoryPolicy(policyJson(true), { nowMs: NOW }).policy;
}

function intentFor(owner: string, repo: string) {
	return renderCrossForkPullRequestIntent({
		upstreamOwner: owner,
		upstreamRepo: repo,
		baseBranch: "main",
		forkOwner: "warren-run-bot",
		headBranch: "burrow/run_x",
		title: "fix: split embedding batches",
		body: "The change and its evidence.",
	});
}

function creatorWith(fetchImpl: (url: unknown, init?: unknown) => Promise<Response>) {
	return new BunFetchGithubPrCreator({
		policy: livePolicy(),
		token: "test-token",
		fetchImpl: fetchImpl as never,
	});
}

describe("BunFetchGithubPrCreator", () => {
	test("refuses construction from a dry-run policy or a missing credential", () => {
		const dryRun = validateRepositoryPolicy(policyJson(false), { nowMs: NOW }).policy;
		expect(() => new BunFetchGithubPrCreator({ policy: dryRun, token: "t" })).toThrow(
			BoundaryError,
		);
		expect(() => new BunFetchGithubPrCreator({ policy: livePolicy(), token: "" })).toThrow(
			BoundaryError,
		);
	});

	test("refuses an intent aimed anywhere but the policy upstream's /pulls", () => {
		expect(() =>
			assertIntentTargetsPolicyUpstream(intentFor("someone-else", "repo"), livePolicy()),
		).toThrow(BoundaryError);
		expect(() =>
			assertIntentTargetsPolicyUpstream(intentFor("openclaw", "openclaw"), livePolicy()),
		).not.toThrow();
	});

	test("POSTs the frozen body verbatim and parses the created PR", async () => {
		let seenUrl = "";
		let seenBody = "";
		let seenMethod = "";
		const creator = creatorWith(async (url, init) => {
			seenUrl = String(url);
			const request = init as { method: string; body: string };
			seenMethod = request.method;
			seenBody = request.body;
			return new Response(
				JSON.stringify({
					number: 130001,
					html_url: "https://github.com/openclaw/openclaw/pull/130001",
					node_id: "PR_x",
				}),
				{ status: 201 },
			);
		});
		const result = await creator.createPullRequest(intentFor("openclaw", "openclaw"));
		expect(result).toEqual({
			prNumber: 130001,
			prUrl: "https://github.com/openclaw/openclaw/pull/130001",
			nodeId: "PR_x",
		});
		expect(seenMethod).toBe("POST");
		expect(seenUrl).toBe("https://api.github.com/repos/openclaw/openclaw/pulls");
		expect(JSON.parse(seenBody)).toEqual({
			title: "fix: split embedding batches",
			head: "warren-run-bot:burrow/run_x",
			base: "main",
			body: "The change and its evidence.",
			maintainer_can_modify: true,
			draft: true,
		});
	});

	test("classifies 422 already-exists distinctly from other rejections", async () => {
		const already = creatorWith(
			async () =>
				new Response(JSON.stringify({ message: "A pull request already exists for x." }), {
					status: 422,
				}),
		);
		await expect(already.createPullRequest(intentFor("openclaw", "openclaw"))).rejects.toThrow(
			GithubPrAlreadyExistsError,
		);
		const forbidden = creatorWith(async () => new Response("{}", { status: 403 }));
		await expect(forbidden.createPullRequest(intentFor("openclaw", "openclaw"))).rejects.toThrow(
			GithubApiError,
		);
	});

	test("a transport throw surfaces as uncertain, with the credential redacted", async () => {
		const creator = creatorWith(async () => {
			throw new Error("socket reset mid-flight");
		});
		try {
			await creator.createPullRequest(intentFor("openclaw", "openclaw"));
			throw new Error("expected a throw");
		} catch (error) {
			expect(error).toBeInstanceOf(GithubPrCreateUncertainError);
			const uncertain = error as GithubPrCreateUncertainError;
			expect(JSON.stringify(uncertain.requestHeaders)).not.toContain("test-token");
		}
	});
});
