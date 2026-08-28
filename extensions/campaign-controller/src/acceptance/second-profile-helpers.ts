/**
 * Shared harness for the second-profile respond-iterate-land e2e
 * (warren-c7f5). Profile-driven fixtures only: every heading, bot login,
 * marker, command, and path rule below lives in the committed profile
 * data under `profiles/`, loaded at run time — never inlined here.
 */
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { approveCampaign, importCampaign } from "../admission.ts";
import { FixedClock, SequentialIdGenerator } from "../clock.ts";
import { digestOf } from "../digest.ts";
import { ReadOnlyGithubClient } from "../github/client.ts";
import { FakeGithubServer } from "../github/fake-server.ts";
import type { FetchLike } from "../github/http-transport.ts";
import {
	BunFetchGithubBranchUpdater,
	BunFetchGithubCommentPoster,
	BunFetchGithubPrUpdater,
} from "../github/pr-mutations.ts";
import type { PrBodyFacts } from "../pr-intent/pr-body.ts";
import {
	validateRepositoryPolicy,
	type RepositoryPolicy,
} from "../repository-policy.ts";
import { CampaignStateStore } from "../store/state-store.ts";
import type { TickDeps } from "../tick/tick.ts";
import { WarrenClient } from "../warren-client.ts";
import { FakeWarrenServer } from "../warren-fake.ts";

export const NOW = Date.parse("2026-08-26T00:00:00.000Z");
export const WARREN_TOKEN = "warren-second-profile-token";
export const HEAD_SHA = "abc123abc123abc123abc123abc123abc123abc1";
const PROFILES_DIR = join(import.meta.dir, "..", "..", "profiles");

/** The full mutation-flag vocabulary; every fixture must bind all of it. */
export const ALL_MUTATION_FLAGS = [
	"createPullRequest",
	"followUpPush",
	"updatePullRequest",
	"pushCommits",
	"updateBranch",
	"postComment",
	"editComment",
	"requestReview",
	"addLabels",
	"closePullRequest",
	"reopenPullRequest",
	"enableAutoMerge",
	"mergePullRequest",
	"editIssue",
] as const;

export type MutationFlag = (typeof ALL_MUTATION_FLAGS)[number];

export interface ProfileFixture {
	readonly profileId: string;
	readonly owner: string;
	readonly repo: string;
	readonly forkOwner: string;
	readonly branch: string;
	readonly issue: number;
	/** A body heading unique to this profile's contract. */
	readonly uniqueHeading: string;
	/** The other profile's unique heading. */
	readonly foreignHeading: string;
	/** A response-summary finding this profile's reviewer raises. */
	readonly findingTitle: string;
	readonly summary: {
		problem: string;
		solution: string;
		userImpact: string;
		operatorNotes: string;
	};
	/** A bot finding comment under this profile's grammar. */
	readonly botLogin: string;
	readonly botComment: string;
	readonly reReviewCommand: string;
	/** An agentGuidance norm fragment unique to this profile. */
	readonly guidanceFragment: string;
}

export const OPENCLAW: ProfileFixture = {
	profileId: "openclaw",
	owner: "openclaw",
	repo: "openclaw",
	forkOwner: "warren-run-bot",
	branch: "warren/issue-812",
	issue: 812,
	uniqueHeading: "User impact",
	foreignHeading: "Why it matters",
	findingTitle: "Clock not seeded",
	summary: {
		problem: "The scheduler test flakes on cold caches.",
		solution: "Seed the scheduler's deterministic clock in the test setup.",
		userImpact: "Contributors see stable CI results for scheduler changes.",
		operatorNotes: "Reviewed during the dry-run session.",
	},
	botLogin: "clawreview[bot]",
	botComment:
		"### Findings\n" +
		"- [P1] Clock not seeded: `src/scheduler/clock.ts` line 42\n" +
		"- [P2] Stale assertion: `src/scheduler/scheduler.test.ts` line 88",
	reReviewCommand: "@clawreview recheck please",
	guidanceFragment: "smallest possible diff",
};

export const MERIDIAN: ProfileFixture = {
	profileId: "meridian",
	owner: "meridian-oss",
	repo: "meridian",
	forkOwner: "warren-run-bot",
	branch: "warren/issue-77",
	issue: 77,
	uniqueHeading: "Why it matters",
	foreignHeading: "User impact",
	findingTitle: "Shutdown drains unbounded",
	summary: {
		problem: "The retry queue loses in-flight jobs on shutdown.",
		solution: "Drain the queue with a bounded grace period before exit.",
		userImpact: "Operators stop losing retry jobs during deploys.",
		operatorNotes: "Reviewed during the dry-run session.",
	},
	botLogin: "meridian-guard",
	botComment:
		"<!-- meridian-guard: findings -->\n" +
		"* Shutdown drains unbounded @ src/queue/drain.ts:31 [high]\n" +
		"* No grace-period test @ src/queue/drain.test.ts:12 [normal]",
	reReviewCommand: "/meridian-guard re-run review",
	guidanceFragment: "bounded grace period",
};

export const FIXTURES = [OPENCLAW, MERIDIAN];

interface CommittedProfile {
	policyRaw: Record<string, unknown>;
	manifestRaw: Record<string, unknown>;
	grammarRaw: Record<string, unknown>;
}

/** Load the committed profile data for one fixture. */
export function committedProfile(f: ProfileFixture): CommittedProfile {
	const load = (name: string): Record<string, unknown> =>
		JSON.parse(readFileSync(join(PROFILES_DIR, name), "utf8")) as Record<string, unknown>;
	return {
		policyRaw: load(`${f.profileId}.repository-policy.json`),
		manifestRaw: load(`${f.profileId}.campaign-manifest.example.json`),
		grammarRaw: load(`${f.profileId}.bot-grammar.json`),
	};
}

/** Operator manifest: the committed example, one issue, re-digest-bound. */
export function campaignManifest(f: ProfileFixture): Record<string, unknown> {
	const { approval: _a, promptDigest: _p, issueEvidenceTiers: _t, ...rest } =
		committedProfile(f).manifestRaw;
	const unapproved = {
		...rest,
		prompt: `Fix the assigned issue end to end (${f.profileId}).`,
		issues: [f.issue],
	};
	return {
		...unapproved,
		approval: {
			approvedBy: "jayminwest",
			approvedAt: "2026-08-25T12:00:00.000Z",
			manifestDigest: digestOf(unapproved),
		},
	};
}

export interface Harness {
	readonly store: CampaignStateStore;
	readonly warren: FakeWarrenServer;
	readonly github: FakeGithubServer;
	readonly deps: TickDeps;
	readonly campaignId: string;
	readonly workItemId: string;
	readonly policy: RepositoryPolicy;
	readonly contract: NonNullable<RepositoryPolicy["prBodyContract"]>;
	readonly grammar: Record<string, unknown>;
	readonly dir: string;
}

/** Boot the full loop harness for one fixture. */
export function boot(f: ProfileFixture): Harness {
	const { policyRaw, grammarRaw } = committedProfile(f);
	const dir = mkdtempSync(join(tmpdir(), `second-profile-${f.profileId}-`));
	const clock = new FixedClock(NOW);
	const ids = new SequentialIdGenerator();
	const store = new CampaignStateStore(join(dir, "state.db"), { clock, ids });
	const warren = new FakeWarrenServer({ token: WARREN_TOKEN });
	const warrenClient = new WarrenClient({
		baseUrl: "http://warren.test",
		token: WARREN_TOKEN,
		fetchFn: warren.fetch,
		clock,
		sleep: async () => {},
	});
	const github = new FakeGithubServer({ clock });
	seedGithubWorld(f, github);
	const manifest = campaignManifest(f);
	const imported = importCampaign(store, { manifest, policy: policyRaw, nowMs: NOW });
	approveCampaign(store, {
		campaignId: imported.campaign.id,
		manifestDigest: imported.manifestDigest,
		approvedBy: "jayminwest",
		nowMs: NOW,
	});
	const { policy } = validateRepositoryPolicy(policyRaw, { nowMs: NOW });
	const workItem = store.campaigns.listWorkItems(imported.campaign.id)[0];
	if (workItem === undefined) throw new Error("no work item imported");
	const summaries = new Map([
		[
			f.issue,
			{
				problem: f.summary.problem,
				solution: f.summary.solution,
				userImpact: f.summary.userImpact,
				evidence: [`bun test — all passing (${f.profileId})`],
				changedPaths: ["src/example.ts"],
				operatorNotes: f.summary.operatorNotes,
			},
		],
	]);
	return {
		store,
		warren,
		github,
		campaignId: imported.campaign.id,
		workItemId: workItem.id,
		policy,
		contract: policy.prBodyContract as NonNullable<RepositoryPolicy["prBodyContract"]>,
		grammar: grammarRaw,
		dir,
		deps: {
			store,
			warrenClient,
			github: new ReadOnlyGithubClient(github, { perPage: 2, maxPages: 10 }),
			clock,
			ids,
			policy: policyRaw,
			summaries,
		},
	};
}

/** Read-only upstream world: repo, the issue, no open PRs yet. */
function seedGithubWorld(f: ProfileFixture, github: FakeGithubServer): void {
	const base = `/repos/${f.owner}/${f.repo}`;
	github.setResource(base, {
		node_id: "R_repo",
		name: f.repo,
		full_name: `${f.owner}/${f.repo}`,
		owner: { login: f.owner },
		default_branch: "main",
		fork: false,
		archived: false,
		pushed_at: null,
		html_url: `https://github.com/${f.owner}/${f.repo}`,
	});
	github.setResource(`${base}/issues/${f.issue}`, {
		node_id: `I_${f.issue}`,
		number: f.issue,
		state: "open",
		title: `Issue ${f.issue}`,
		user: { login: `${f.owner}-maintainer` },
		labels: [],
		created_at: "2026-08-01T00:00:00.000Z",
		updated_at: "2026-08-20T00:00:00.000Z",
		closed_at: null,
		html_url: `https://github.com/${f.owner}/${f.repo}/issues/${f.issue}`,
	});
	github.setPaginatedCollection(`${base}/pulls`, []);
	github.setPaginatedCollection("/notifications", []);
}

/** Seed the upstream PR the loop drives, with failing checks. */
export function seedPr(f: ProfileFixture, github: FakeGithubServer, body: string): void {
	const base = `/repos/${f.owner}/${f.repo}`;
	github.setResource(`${base}/pulls/7`, {
		node_id: "PR_7",
		number: 7,
		state: "open",
		draft: false,
		title: `Fix issue ${f.issue}`,
		body,
		user: { login: f.forkOwner },
		head: { ref: f.branch, sha: HEAD_SHA, repo: { full_name: `${f.forkOwner}/${f.repo}` } },
		base: {
			ref: "main",
			sha: "def456def456def456def456def456def456def4",
			repo: { full_name: `${f.owner}/${f.repo}` },
		},
		merged_at: null,
		closed_at: null,
		created_at: "2026-08-26T00:00:00.000Z",
		updated_at: "2026-08-26T00:00:00.000Z",
		html_url: `https://github.com/${f.owner}/${f.repo}/pull/7`,
	});
	github.setPaginatedCollection(`${base}/pulls/7/reviews`, []);
	github.setPaginatedCollection(`${base}/issues/7/comments`, []);
	github.setPaginatedCollection(`${base}/pulls/7/comments`, []);
	const checkName = `${f.profileId}/ci-gate`;
	github.setResource(`${base}/commits/${HEAD_SHA}/check-runs`, {
		total_count: 1,
		check_runs: [
			{
				node_id: "CR_1",
				id: 1,
				name: checkName,
				status: "completed",
				conclusion: "failure",
				started_at: "2026-08-26T00:00:00.000Z",
				completed_at: "2026-08-26T00:01:00.000Z",
				details_url: null,
				html_url: `https://github.com/${f.owner}/${f.repo}/pull/7/checks`,
			},
		],
	});
	github.setResource(`${base}/commits/${HEAD_SHA}/status`, {
		state: "failure",
		total_count: 1,
		sha: HEAD_SHA,
		statuses: [{ context: checkName, state: "failure", description: null }],
	});
}

/** Initial PR-body facts for the profile contract render. */
export function baseFacts(
	f: ProfileFixture,
	campaignId: string,
	runId: string,
): PrBodyFacts {
	return {
		campaignId,
		agent: "pi",
		provider: "anthropic",
		model: "claude-sonnet-4-5",
		approvedBy: "jayminwest",
		runId,
		branch: f.branch,
		forkOwner: f.forkOwner,
		issueNumber: f.issue,
		problem: f.summary.problem,
		solution: f.summary.solution,
		userImpact: f.summary.userImpact,
		evidence: [`bun test — all passing (${f.profileId})`],
		evidenceTier: "local-provable",
		operatorNotes: f.summary.operatorNotes,
	};
}

/**
 * Re-bind the policy's mutation flags explicitly. The result always
 * carries all fourteen flags; anything not listed stays `false`.
 */
export function policyWithFlags(
	policy: RepositoryPolicy,
	flags: Partial<Record<MutationFlag, boolean>> = {},
): RepositoryPolicy {
	const mutations: Record<string, boolean> = {};
	for (const flag of ALL_MUTATION_FLAGS) mutations[flag] = flags[flag] ?? false;
	const raw = { ...(policy as unknown as Record<string, unknown>), mutations };
	return validateRepositoryPolicy(raw, { nowMs: NOW }).policy;
}

/** Mutation transports bound to one policy; records every I/O attempt. */
export function mutationTransports(policy: RepositoryPolicy) {
	const calls: { method: string; path: string; body: unknown }[] = [];
	const fetchImpl: FetchLike = async (input, init) => {
		const request = new Request(input as string, init);
		calls.push({
			method: request.method,
			path: new URL(request.url).pathname,
			body: init?.body === undefined ? null : JSON.parse(String(init.body)),
		});
		const responseBody =
			request.method === "POST" ? JSON.stringify({ id: 4242 }) : JSON.stringify({ updated_at: "2026-08-26T01:00:00Z" });
		return new Response(responseBody, { status: 200 });
	};
	const options = { policy, token: "gh-token", fetchImpl };
	return {
		calls,
		updater: () => new BunFetchGithubPrUpdater(options),
		poster: () => new BunFetchGithubCommentPoster(options),
		branchUpdater: () => new BunFetchGithubBranchUpdater(options),
	};
}
