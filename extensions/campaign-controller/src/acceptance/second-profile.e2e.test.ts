/**
 * Second-profile proof (warren-c7f5, plan pl-096b capstone).
 *
 * The full respond-iterate-land loop drives against BOTH committed
 * profiles — the OpenClaw profile and the non-openclaw meridian profile —
 * each with its own PR-body headings, bot login / marker grammar,
 * re-review command, agentGuidance norms, and evidence tiers:
 *
 *   dispatch -> PR intent with the profile-correct body -> bot review
 *   ingested + classified by the profile grammar -> follow-up intent ->
 *   warren run on the existing PR head branch -> push reconciled ->
 *   body refresh through updatePullRequest -> profile re-review comment
 *   posted -> checks go green -> attention resolves -> PR merges ->
 *   terminal accounting reports cost per merged PR.
 *
 * Structural probes (same file): every mutation transport refuses to
 * construct under the default (all-false) policy, and a disabled
 * follow-up flag refuses the coordinator before any I/O — a disabled
 * flag is structurally impossible, not skipped.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { approveCampaign, importCampaign } from "../admission.ts";
import { FixedClock, SequentialIdGenerator } from "../clock.ts";
import { WARREN_DISPATCH_ACTION_TYPE } from "../dispatch/dispatcher.ts";
import { ReadOnlyGithubClient } from "../github/client.ts";
import { FakeGithubServer } from "../github/fake-server.ts";
import type { FetchLike } from "../github/http-transport.ts";
import {
	BunFetchGithubBranchUpdater,
	BunFetchGithubCommentPoster,
	BunFetchGithubPrUpdater,
	renderPostCommentIntent,
} from "../github/pr-mutations.ts";
import { FollowUpCoordinator, UNTRUSTED_FINDINGS_BANNER } from "../follow-up/coordinator.ts";
import { validateCampaignManifest } from "../manifest.ts";
import { UpstreamPrReconciler } from "../reconcile/reconciler.ts";
import { composeReReviewComment } from "../pr-execute/post-comment.ts";
import { executeJournaledBodyRefresh, renderAndJournalBodyRefresh } from "../pr-execute/body-refresh.ts";
import type { PrBodyFacts } from "../pr-intent/pr-body.ts";
import { validateRepositoryPolicy, type RepositoryPolicy } from "../repository-policy.ts";
import { buildCampaignReport } from "../report/report.ts";
import { CampaignStateStore } from "../store/state-store.ts";
import { runTick, type TickDeps } from "../tick/tick.ts";
import { WarrenClient } from "../warren-client.ts";
import { FakeWarrenServer } from "../warren-fake.ts";

const NOW = Date.parse("2026-08-26T00:00:00.000Z");
const WARREN_TOKEN = "warren-second-profile-token";
const PROFILES_DIR = join(import.meta.dir, "..", "..", "profiles");
const HEAD_SHA = "abc123abc123abc123abc123abc123abc123abc1";

/** The full mutation-flag vocabulary; fixtures must bind every flag. */
const ALL_MUTATION_FLAGS = [
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

interface ProfileFixture {
	readonly name: string;
	readonly profileId: string;
	readonly owner: string;
	readonly repo: string;
	readonly forkOwner: string;
	readonly branch: string;
	readonly issue: number;
	/** A heading unique to this profile's body contract. */
	readonly uniqueHeading: string;
	/** The other profile's unique heading. */
	readonly foreignHeading: string;
	readonly summary: { problem: string; solution: string; userImpact: string; operatorNotes: string };
	/** A bot finding comment under this profile's grammar. */
	readonly botLogin: string;
	readonly botComment: string;
	readonly reReviewCommand: string;
	/** One agentGuidance norm fragment unique to this profile. */
	readonly guidanceFragment: string;
}

const OPENCLAW: ProfileFixture = {
	name: "openclaw",
	profileId: "openclaw",
	owner: "openclaw",
	repo: "openclaw",
	forkOwner: "warren-run-bot",
	branch: "warren/issue-812",
	issue: 812,
	uniqueHeading: "User impact",
	foreignHeading: "Why it matters",
	summary: {
		problem: "The scheduler test flakes on cold caches.",
		solution: "Seed the scheduler's deterministic clock in the test setup.",
		userImpact: "Contributors see stable CI results for scheduler changes.",
		operatorNotes: "Reviewed during the dry-run session.",
	},
	botLogin: "clawreview[bot]",
	botComment:
		"### Findings\n- [P1] Clock not seeded: `src/scheduler/clock.ts` line 42\n- [P2] Stale assertion: `src/scheduler/scheduler.test.ts` line 88",
	reReviewCommand: "@clawreview recheck please",
	guidanceFragment: "smallest possible diff",
};

const MERIDIAN: ProfileFixture = {
	name: "meridian",
	profileId: "meridian",
	owner: "meridian-oss",
	repo: "meridian",
	forkOwner: "warren-run-bot",
	branch: "warren/issue-77",
	issue: 77,
	uniqueHeading: "Why it matters",
	foreignHeading: "User impact",
	summary: {
		problem: "The retry queue loses in-flight jobs on shutdown.",
		solution: "Drain the queue with a bounded grace period before exit.",
		userImpact: "Operators stop losing retry jobs during deploys.",
		operatorNotes: "Reviewed during the dry-run session.",
	},
	botLogin: "meridian-guard",
	botComment:
		"<!-- meridian-guard: findings -->\n* Shutdown drains unbounded @ src/queue/drain.ts:31 [high]\n* No grace-period test @ src/queue/drain.test.ts:12 [normal]",
	reReviewCommand: "/meridian-guard re-run review",
	guidanceFragment: "bounded grace period",
};

const FIXTURES = [OPENCLAW, MERIDIAN];

function profile(f: ProfileFixture): {
	policyRaw: Record<string, unknown>;
	manifestRaw: Record<string, unknown>;
	grammarRaw: Record<string, unknown>;
} {
	const policyRaw = JSON.parse(
		readFileSync(join(PROFILES_DIR, `${f.profileId}.repository-policy.json`), "utf8"),
	) as Record<string, unknown>;
	const manifestRaw = JSON.parse(
		readFileSync(join(PROFILES_DIR, `${f.profileId}.campaign-manifest.example.json`), "utf8"),
	) as Record<string, unknown>;
	const grammarRaw = JSON.parse(
		readFileSync(join(PROFILES_DIR, `${f.profileId}.bot-grammar.json`), "utf8"),
	) as Record<string, unknown>;
	return { policyRaw, manifestRaw, grammarRaw };
}

/** Operator manifest for one fixture: the committed example, one issue, re-digest-bound. */
function campaignManifest(f: ProfileFixture): Record<string, unknown> {
	const { approval: _a, promptDigest: _p, issueEvidenceTiers: _t, ...rest } = profile(f).manifestRaw;
	const unapproved = { ...rest, prompt: `Fix the assigned issue end to end (${f.profileId}).`, issues: [f.issue] };
	return {
		...unapproved,
		approval: { approvedBy: "jayminwest", approvedAt: "2026-08-25T12:00:00.000Z", manifestDigest: "0".repeat(64) },
	};
}

function manifestDigest(manifest: Record<string, unknown>): string {
	const { approval, ...rest } = manifest as { approval?: unknown };
	return `${rest && typeof rest === "object" ? "" : ""}` + JSON.stringify(Object.keys(rest)) + approval === "" ? "" : "";
}

interface Harness {
	readonly store: CampaignStateStore;
	readonly warren: FakeWarrenServer;
	readonly github: FakeGithubServer;
	readonly deps: TickDeps;
	readonly campaignId: string;
	readonly workItemId: string;
	readonly policy: RepositoryPolicy;
	readonly contract: NonNullable<RepositoryPolicy["prBodyContract"]>;
	readonly grammar: Record<string, unknown>;
}

/** Boot the full loop harness for one fixture. */
function boot(f: ProfileFixture): Harness {
	const { policyRaw, grammarRaw } = profile(f);
	const dir = mkdtempSync(join(tmpdir(), `second-profile-${f.name}-`));
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
	return {
		store,
		warren,
		github,
		campaignId: imported.campaign.id,
		workItemId: workItem.id,
		policy,
		contract: policy.prBodyContract as NonNullable<RepositoryPolicy["prBodyContract"]>,
		grammar: grammarRaw,
		deps: {
			store,
			warrenClient,
			github: new ReadOnlyGithubClient(github, { perPage: 2, maxPages: 10 }),
			clock,
			ids,
			policy: policyRaw,
			summaries: new Map([
				[
					f.issue,
					{
						problem: f.summary.problem,
						solution: f.summary.solution,
						userImpact: f.summary.userImpact,
						evidence: [`bun test — all passing (${f.name})`],
						changedPaths: ["src/example.ts"],
						operatorNotes: f.summary.operatorNotes,
					},
				],
			]),
		},
	};
}

/** Read-only upstream world: repo, the issue, one unrelated open PR. */
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
		html_url: `${base}/issues/${f.issue}`,
	});
	github.setPaginatedCollection(`${base}/pulls`, []);
	github.setPaginatedCollection("/notifications", []);
}

/** Seed the upstream PR the loop drives, with failing checks. */
function seedPr(f: ProfileFixture, github: FakeGithubServer, body: string): void {
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
		base: { ref: "main", sha: "def456def456def456def456def456def456def4", repo: { full_name: `${f.owner}/${f.repo}` } },
		merged_at: null,
		closed_at: null,
		created_at: "2026-08-26T00:00:00.000Z",
		updated_at: "2026-08-26T00:00:00.000Z",
		html_url: `${base}/pull/7`,
	});
	github.setPaginatedCollection(`${base}/pulls/7/reviews`, []);
	github.setPaginatedCollection(`${base}/issues/7/comments`, []);
	github.setPaginatedCollection(`${base}/pulls/7/comments`, []);
	github.setResource(`${base}/commits/${HEAD_SHA}/check-runs`, {
		total_count: 1,
		check_runs: [
			{
				node_id: "CR_1",
				id: 1,
				name: `${f.profileId}/ci-gate`,
				status: "completed",
				conclusion: "failure",
				started_at: "2026-08-26T00:00:00.000Z",
				completed_at: "2026-08-26T00:01:00.000Z",
				details_url: null,
				html_url: `${base}/pull/7/checks`,
			},
		],
	});
	github.setResource(`${base}/commits/${HEAD_SHA}/status`, {
		state: "failure",
		total_count: 1,
		sha: HEAD_SHA,
		statuses: [{ context: `${f.profileId}/ci-gate`, state: "failure", description: null }],
	});
}

function baseFacts(f: ProfileFixture, contract: NonNullable<RepositoryPolicy["prBodyContract"]>, campaignId: string, runId: string): PrBodyFacts {
	void contract;
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
		evidence: [`bun test — all passing (${f.name})`],
		evidenceTier: "local-provable",
		operatorNotes: f.summary.operatorNotes,
	};
}

/**
 * The all-false policy (defaults) plus an explicit binding for every flag.
 * This is the shape every fixture must produce: no flag left implicit.
 */
function policyWithFlags(policy: RepositoryPolicy, flags: Partial<Record<(typeof ALL_MUTATION_FLAGS)[number], boolean>>): RepositoryPolicy {
	const mutations: Record<string, boolean> = {};
	for (const flag of ALL_MUTATION_FLAGS) mutations[flag] = flags[flag] ?? false;
	const raw = { ...(policy as unknown as Record<string, unknown>), mutations };
	return validateRepositoryPolicy(raw, { nowMs: NOW }).policy;
}

/** Mutation transports bound to the given policy; records every I/O attempt. */
function mutationTransports(policy: RepositoryPolicy) {
	const calls: { method: string; path: string }[] = [];
	const fetchImpl: FetchLike = async (input, init) => {
		const request = new Request(input as string, init);
		calls.push({ method: request.method, path: new URL(request.url).pathname });
		return new Response(
			request.method === "POST" ? JSON.stringify({ id: 4242 }) : JSON.stringify({ updated_at: "2026-08-26T01:00:00Z" }),
			{ status: 200 },
		);
	};
	const options = { policy, token: "gh-token", fetchImpl };
	return {
		calls,
		updater: () => new BunFetchGithubPrUpdater(options),
		poster: () => new BunFetchGithubCommentPoster(options),
		branchUpdater: () => new BunFetchGithubBranchUpdater(options),
	};
}

describe("second-profile respond-iterate-land loop", () => {
	for (const f of FIXTURES) {
		test(`full loop with profile-correct bodies, grammar, and accounting (${f.name})`, async () => {
			const h = boot(f);
			try {
				// Ticket 1: dispatch the initial run and drive it to success.
				const tick1 = await runTick(h.deps, h.campaignId);
				const dispatch = tick1.stages.find((stage) => stage.stage === "dispatch");
				expect(dispatch?.status).toBe("dispatched");
				const detail = dispatch?.detail as { runId?: string } | undefined;
				const runId = detail?.runId;
				expect(typeof runId).toBe("string");
				const run = runId === undefined ? undefined : h.warren.getRunRow(runId);
				if (runId === undefined || run === undefined) throw new Error("no dispatched run");
				expect(run.prompt).toContain(f.guidanceFragment);
				h.warren.setRunState(runId, { state: "succeeded", costUsd: 1.25, targetBranch: f.branch });

				// Ticket 2: reconcile the run, render the PR intent with the
				// profile-correct body — and nothing of the other profile's.
				const tick2 = await runTick(h.deps, h.campaignId);
				const intent = tick2.stages.find((stage