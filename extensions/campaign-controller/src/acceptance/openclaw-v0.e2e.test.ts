/**
 * The OpenClaw V0 end-to-end acceptance scenario (plan pl-91b6 step 11,
 * warren-56dd).
 *
 * One deterministic test walks the whole fake-server vertical slice with
 * the committed OpenClaw profile data:
 *
 * 1. boot fake Warren and fake GitHub;
 * 2. validate and import the committed repository-policy profile and a
 *    digest-bound campaign manifest, then approve it;
 * 3. admit exactly one explicit issue and dispatch exactly once;
 * 4. simulate terminal success with the pushed fork branch;
 * 5. render exactly one cross-fork PR intent (never posted);
 * 6. ingest duplicated and reordered review/check/comment pages;
 * 7. restart the controller and Warren, then tick again;
 * 8. assert stable single actions/events/attention and a settled budget.
 *
 * Negative probes (same test, plus the dedicated ones below): every GitHub
 * request the whole lifecycle issued was a GET or a HEAD, no credential
 * ever reached the journal or event payloads, and an ambiguous dispatch is
 * never re-POSTed — not by this process and not after a restart.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { approveCampaign, importCampaign } from "../admission.ts";
import { FixedClock, SequentialIdGenerator } from "../clock.ts";
import { digestOf } from "../digest.ts";
import { WARREN_DISPATCH_ACTION_TYPE } from "../dispatch/dispatcher.ts";
import { ReadOnlyGithubClient } from "../github/client.ts";
import { FakeGithubServer, type RecordedGithubRequest } from "../github/fake-server.ts";
import { validateCampaignManifest } from "../manifest.ts";
import { PR_INTENT_ACTION_TYPE } from "../pr-intent/intender.ts";
import { validateRepositoryPolicy } from "../repository-policy.ts";
import { CampaignStateStore } from "../store/state-store.ts";
import { runTick, type TickDeps, type TickOutcome, type TickStage } from "../tick/tick.ts";
import { WarrenClient } from "../warren-client.ts";
import { FakeWarrenServer } from "../warren-fake.ts";

const NOW = Date.parse("2026-08-26T00:00:00.000Z");
const WARREN_TOKEN = "warren-acceptance-token";
const FORK_BRANCH = "warren/issue-812";
const TEMP_ROOT = join(tmpdir(), `campaign-e2e-acceptance-${process.pid}`);
const PROFILES_DIR = join(import.meta.dir, "..", "..", "profiles");
const COMMITTED_POLICY = JSON.parse(
	readFileSync(join(PROFILES_DIR, "openclaw.repository-policy.json"), "utf8"),
) as Record<string, unknown>;
const COMMITTED_EXAMPLE_MANIFEST = JSON.parse(
	readFileSync(join(PROFILES_DIR, "openclaw.campaign-manifest.example.json"), "utf8"),
) as Record<string, unknown>;

/** The operator's per-campaign manifest: the committed example, with the
 * approved prompt text and exactly one explicit issue, re-digest-bound. */
function campaignManifest(): Record<string, unknown> {
	const {
		approval: _approval,
		promptDigest: _promptDigest,
		issueEvidenceTiers: _tiers,
		...rest
	} = COMMITTED_EXAMPLE_MANIFEST;
	const unapproved = {
		...rest,
		prompt: "Fix the assigned OpenClaw issue end to end and run the quality gates.",
		issues: [812],
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

const SUMMARY = {
	problem:
		"The scheduler test flakes on cold caches, producing intermittent CI failures unrelated to the change under test.",
	solution:
		"Seed the scheduler's deterministic clock in the test setup so cold-cache ordering cannot vary between runs.",
	userImpact:
		"Contributors see stable CI results for scheduler changes; no runtime behavior changes.",
	evidence: ["bun test src/scheduler.test.ts — 42 passing, 0 failing", "bun run lint — clean"],
	changedPaths: ["src/scheduler/clock.ts", "src/scheduler/scheduler.test.ts"],
	operatorNotes:
		"Reviewed during the 2026-08-25 EOD dry-run session; full evidence in the campaign log.",
};

interface AcceptanceHarness {
	readonly store: CampaignStateStore;
	readonly warren: FakeWarrenServer;
	readonly github: FakeGithubServer;
	readonly deps: TickDeps;
	readonly campaignId: string;
}

/** Boot fake Warren + fake GitHub and import/approve the campaign. */
function bootAndApprove(dbPath: string): AcceptanceHarness {
	const clock = new FixedClock(NOW);
	const ids = new SequentialIdGenerator();
	const store = new CampaignStateStore(dbPath, { clock, ids });
	const warren = new FakeWarrenServer({ token: WARREN_TOKEN });
	const warrenClient = new WarrenClient({
		baseUrl: "http://warren.test",
		token: WARREN_TOKEN,
		fetchFn: warren.fetch,
		clock,
		sleep: async () => {},
	});
	const github = new FakeGithubServer({ clock });
	seedGithubWorld(github);
	const imported = importCampaign(store, {
		manifest: campaignManifest(),
		policy: COMMITTED_POLICY,
		nowMs: NOW,
	});
	approveCampaign(store, {
		campaignId: imported.campaign.id,
		manifestDigest: imported.manifestDigest,
		approvedBy: "jayminwest",
		nowMs: NOW,
	});
	return {
		store,
		warren,
		github,
		campaignId: imported.campaign.id,
		deps: {
			store,
			warrenClient,
			github: new ReadOnlyGithubClient(github, { perPage: 2, maxPages: 10 }),
			clock,
			ids,
			policy: COMMITTED_POLICY,
			summaries: new Map([[812, SUMMARY]]),
		},
	};
}

/** The read-only upstream world: repo, issue 812, one open fork PR. */
function seedGithubWorld(github: FakeGithubServer): void {
	github.setResource("/repos/openclaw/openclaw", {
		node_id: "R_repo",
		name: "openclaw",
		full_name: "openclaw/openclaw",
		owner: { login: "openclaw" },
		default_branch: "main",
		fork: false,
		archived: false,
		pushed_at: null,
		html_url: "https://github.com/openclaw/openclaw",
	});
	github.setResource("/repos/openclaw/openclaw/issues/812", {
		node_id: "I_812",
		number: 812,
		state: "open",
		title: "Issue 812: flaky scheduler test",
		user: { login: "openclaw-maintainer" },
		labels: [],
		created_at: "2026-08-01T00:00:00.000Z",
		updated_at: "2026-08-20T00:00:00.000Z",
		closed_at: null,
		html_url: "https://github.com/openclaw/openclaw/issues/812",
	});
	github.setPaginatedCollection("/repos/openclaw/openclaw/pulls", [
		{
			node_id: "PR_9001",
			number: 9001,
			state: "open",
			draft: false,
			title: "Another fork contribution",
			user: { login: "warren-run-bot" },
			head: {
				ref: "warren/issue-900",
				sha: "abc123abc123abc123abc123abc123abc123abc1",
				repo: { full_name: "warren-run-bot/openclaw" },
			},
			base: {
				ref: "main",
				sha: "def456def456def456def456def456def456def4",
				repo: { full_name: "openclaw/openclaw" },
			},
			merged_at: null,
			closed_at: null,
			created_at: "2026-08-25T10:00:00.000Z",
			updated_at: "2026-08-25T10:00:00.000Z",
			html_url: "https://github.com/openclaw/openclaw/pull/9001",
		},
	]);
	github.setPaginatedCollection("/notifications", []);
}

const HEAD_SHA = "abc123abc123abc123abc123abc123abc123abc1";
const REVIEWS = [
	{
		id: 1,
		node_id: "RV_1",
		user: { login: "maintainer" },
		author_association: "MEMBER",
		state: "COMMENTED",
		body: "review body text",
		submitted_at: "2026-08-26T01:00:00.000Z",
		commit_id: HEAD_SHA,
		html_url: "https://github.com/openclaw/openclaw/pull/7#review-RV_1",
	},
	{
		id: 2,
		node_id: "RV_2",
		user: { login: "maintainer" },
		author_association: "MEMBER",
		state: "CHANGES_REQUESTED",
		body: "review body text",
		submitted_at: "2026-08-26T02:00:00.000Z",
		commit_id: HEAD_SHA,
		html_url: "https://github.com/openclaw/openclaw/pull/7#review-RV_2",
	},
	{
		id: 3,
		node_id: "RV_3",
		user: { login: "maintainer" },
		author_association: "MEMBER",
		state: "APPROVED",
		body: "review body text",
		submitted_at: "2026-08-26T03:00:00.000Z",
		commit_id: HEAD_SHA,
		html_url: "https://github.com/openclaw/openclaw/pull/7#review-RV_3",
	},
];
const ISSUE_COMMENTS = [
	{
		id: 11,
		node_id: "IC_1",
		user: { login: "maintainer" },
		author_association: "MEMBER",
		body: "thanks for the contribution, one note inline",
		created_at: "2026-08-26T01:00:00.000Z",
		updated_at: "2026-08-26T01:00:00.000Z",
		html_url: "https://github.com/openclaw/openclaw/issues/7#issuecomment-IC_1",
	},
	{
		id: 12,
		node_id: "IC_2",
		user: { login: "maintainer" },
		author_association: "MEMBER",
		body: "please keep the change scoped to the scheduler",
		created_at: "2026-08-26T02:00:00.000Z",
		updated_at: "2026-08-26T02:00:00.000Z",
		html_url: "https://github.com/openclaw/openclaw/issues/7#issuecomment-IC_2",
	},
];
const REVIEW_COMMENTS = [
	{
		id: 21,
		node_id: "RC_1",
		user: { login: "reviewer" },
		author_association: "CONTRIBUTOR",
		body: "code comment text",
		created_at: "2026-08-26T01:00:00.000Z",
		updated_at: "2026-08-26T01:00:00.000Z",
		html_url: "https://github.com/openclaw/openclaw/pull/7#discussion-RC_1",
	},
];

/** Seed the upstream PR the operator linked, with multi-page collections. */
function seedLinkedPr(github: FakeGithubServer): void {
	github.setResource("/repos/openclaw/openclaw/pulls/7", {
		node_id: "PR_7",
		number: 7,
		state: "open",
		draft: false,
		title: "Fix the flaky scheduler test (#812)",
		user: { login: "warren-run-bot" },
		head: { ref: FORK_BRANCH, sha: HEAD_SHA, repo: { full_name: "warren-run-bot/openclaw" } },
		base: {
			ref: "main",
			sha: "def456def456def456def456def456def456def4",
			repo: { full_name: "openclaw/openclaw" },
		},
		merged_at: null,
		closed_at: null,
		created_at: "2026-08-26T00:00:00.000Z",
		updated_at: "2026-08-26T00:00:00.000Z",
		html_url: "https://github.com/openclaw/openclaw/pull/7",
	});
	github.setPaginatedCollection("/repos/openclaw/openclaw/pulls/7/reviews", REVIEWS);
	github.setPaginatedCollection("/repos/openclaw/openclaw/issues/7/comments", ISSUE_COMMENTS);
	github.setPaginatedCollection("/repos/openclaw/openclaw/pulls/7/comments", REVIEW_COMMENTS);
	github.setResource(`/repos/openclaw/openclaw/commits/${HEAD_SHA}/check-runs`, {
		total_count: 1,
		check_runs: [
			{
				node_id: "CR_1",
				id: 1,
				name: "ci",
				status: "completed",
				conclusion: "failure",
				started_at: "2026-08-26T00:00:00.000Z",
				completed_at: "2026-08-26T00:01:00.000Z",
				details_url: null,
				html_url: "https://github.com/openclaw/openclaw/pull/7/checks",
			},
		],
	});
	github.setResource(`/repos/openclaw/openclaw/commits/${HEAD_SHA}/status`, {
		state: "failure",
		total_count: 1,
		sha: HEAD_SHA,
		statuses: [{ context: "ci", state: "failure", description: null }],
	});
}

/** Re-deliver every collection reordered, with a duplicated node id in it. */
function redeliverReorderedWithDuplicates(github: FakeGithubServer): void {
	github.mutateResource("/repos/openclaw/openclaw/pulls/7/reviews", [
		REVIEWS[2],
		REVIEWS[1],
		REVIEWS[1],
		REVIEWS[0],
	]);
	github.mutateResource("/repos/openclaw/openclaw/issues/7/comments", [
		ISSUE_COMMENTS[1],
		ISSUE_COMMENTS[0],
		ISSUE_COMMENTS[1],
	]);
	github.mutateResource("/repos/openclaw/openclaw/pulls/7/comments", REVIEW_COMMENTS);
}

function stagesOf(outcomes: readonly TickOutcome[]): string[] {
	return outcomes.map((outcome) => `${outcome.stage}:${outcome.status}`);
}

function stageDetail(tick: { stages: readonly TickOutcome[] }, stage: TickStage): unknown {
	const found = tick.stages.find((outcome) => outcome.stage === stage);
	if (found === undefined) {
		throw new Error(`no ${stage} stage in the tick result`);
	}
	return found.detail;
}

function runIdOf(tick: { stages: readonly TickOutcome[] }): string {
	const runId = (stageDetail(tick, "dispatch") as { runId?: unknown }).runId;
	if (typeof runId !== "string" || runId.length === 0) {
		throw new Error("no dispatch stage with a run id");
	}
	return runId;
}

function actionCounts(
	store: CampaignStateStore,
	campaignId: string,
	actionType: string,
): { total: number; byState: Record<string, number> } {
	const rows = store.actions
		.listActionsForCampaign(campaignId)
		.filter((action) => action.actionType === actionType);
	const byState: Record<string, number> = {};
	for (const row of rows) {
		byState[row.state] = (byState[row.state] ?? 0) + 1;
	}
	return { total: rows.length, byState };
}

beforeAll(() => {
	mkdirSync(TEMP_ROOT, { recursive: true });
});

afterAll(() => {
	rmSync(TEMP_ROOT, { recursive: true, force: true });
});

describe("OpenClaw V0 end-to-end dry run", () => {
	test("proves the full fake-server lifecycle with stable single state", async () => {
		// Committed profile data validates as-is, with OpenClaw's limits.
		const policy = validateRepositoryPolicy(COMMITTED_POLICY, { nowMs: NOW });
		expect(policy.policy.upstreamObservedMaxOpenPrs).toBe(20);
		expect(policy.policy.maxOpenPrs).toBe(5);
		expect(policy.policy.maxNewPrsPerDay).toBe(2);
		expect(() =>
			validateCampaignManifest(COMMITTED_EXAMPLE_MANIFEST, { nowMs: NOW }),
		).not.toThrow();

		const dbPath = join(TEMP_ROOT, "lifecycle.db");
		const h = bootAndApprove(dbPath);

		// Tick 1: admit one explicit issue and dispatch exactly once.
		const tick1 = await runTick(h.deps, h.campaignId);
		expect(tick1.dryRun).toBe(true);
		expect(stagesOf(tick1.stages)).toEqual([
			"lease:acquired",
			"admit:admitted",
			"dispatch:dispatched",
			"github_reconcile:none",
		]);
		expect(h.warren.createdRunCount()).toBe(1);
		const runId = runIdOf(tick1);

		// Terminal success with the pushed fork branch.
		h.warren.setRunState(runId, { state: "succeeded", costUsd: 1.25, targetBranch: FORK_BRANCH });

		// Tick 2: reconcile the run, render exactly one cross-fork PR intent.
		const tick2 = await runTick(h.deps, h.campaignId);
		expect(stagesOf(tick2.stages)).toEqual([
			"lease:acquired",
			"reconcile_run:reconciled",
			"pr_intent:rendered",
			"github_reconcile:none",
		]);
		const intent = stageDetail(tick2, "pr_intent") as {
			request: {
				method: string;
				url: string;
				body: { head: string; base: string; draft: boolean };
			};
		};
		expect(intent.request.method).toBe("POST");
		expect(intent.request.url).toBe("/repos/openclaw/openclaw/pulls");
		expect(intent.request.body.head).toBe(`warren-run-bot:${FORK_BRANCH}`);
		expect(intent.request.body.base).toBe("main");
		expect(intent.request.body.draft).toBe(true);
		expect(h.warren.createdRunCount()).toBe(1);

		// The operator links the (future, separately authorized) upstream PR
		// identity so the read-only ingestion pipeline has a target.
		const identity = h.store.events.listPrIdentities(h.campaignId)[0] as {
			id: string;
			workItemId: string;
		};
		h.store.events.recordPrIdentity({
			campaignId: h.campaignId,
			workItemId: identity.workItemId,
			upstreamOwner: "openclaw",
			upstreamRepo: "openclaw",
			forkOwner: "warren-run-bot",
			forkRepo: "openclaw",
			headBranch: FORK_BRANCH,
			prNumber: 7,
			prUrl: "https://github.com/openclaw/openclaw/pull/7",
		});
		seedLinkedPr(h.github);

		// Tick 3: first read-only ingestion of multi-page upstream state.
		const tick3 = await runTick(h.deps, h.campaignId);
		const ingest = stageDetail(tick3, "github_reconcile") as { newEvents: number };
		expect(ingest.newEvents).toBeGreaterThan(0);
		const eventCount = h.store.events.listGithubEvents(h.campaignId).length;
		const attentionReasons = h.store.events
			.listOpenAttention(h.campaignId)
			.map((item) => item.reason)
			.sort();
		expect(attentionReasons).toContain("requested_changes");
		expect(attentionReasons).toContain("failing_checks");

		// Tick 4: duplicated, reordered pages change nothing durably.
		redeliverReorderedWithDuplicates(h.github);
		const tick4 = await runTick(h.deps, h.campaignId);
		const reingest = stageDetail(tick4, "github_reconcile") as {
			newEvents: number;
			duplicateEvents: number;
		};
		expect(reingest.newEvents).toBe(0);
		expect(reingest.duplicateEvents).toBeGreaterThan(0);
		expect(h.store.events.listGithubEvents(h.campaignId)).toHaveLength(eventCount);
		expect(
			h.store.events
				.listOpenAttention(h.campaignId)
				.map((item) => item.reason)
				.sort(),
		).toEqual(attentionReasons);

		// Restart: new store on the same file, warren's non-durable
		// idempotency store wiped. Tick 5 must remain a pure re-read.
		h.store.close();
		h.warren.restart();
		const clock = new FixedClock(NOW);
		const ids = new SequentialIdGenerator();
		const store2 = new CampaignStateStore(dbPath, { clock, ids });
		const warrenClient = new WarrenClient({
			baseUrl: "http://warren.test",
			token: WARREN_TOKEN,
			fetchFn: h.warren.fetch,
			clock,
			sleep: async () => {},
		});
		const tick5 = await runTick(
			{
				...h.deps,
				store: store2,
				warrenClient,
				github: new ReadOnlyGithubClient(h.github, { perPage: 2, maxPages: 10 }),
				clock,
				ids,
			},
			h.campaignId,
		);
		const postRestart = stageDetail(tick5, "github_reconcile") as {
			newEvents: number;
			duplicateEvents: number;
		};
		expect(postRestart.newEvents).toBe(0);
		expect(postRestart.duplicateEvents).toBeGreaterThan(0);
		expect(stagesOf(tick5.stages)).not.toContain("dispatch:dispatched");
		expect(h.warren.createdRunCount()).toBe(1);

		// Stable single state after the restart.
		expect(store2.events.listGithubEvents(h.campaignId)).toHaveLength(eventCount);
		expect(
			store2.events
				.listOpenAttention(h.campaignId)
				.map((item) => item.reason)
				.sort(),
		).toEqual(attentionReasons);
		expect(actionCounts(store2, h.campaignId, WARREN_DISPATCH_ACTION_TYPE)).toEqual({
			total: 1,
			byState: { succeeded: 1 },
		});
		expect(actionCounts(store2, h.campaignId, PR_INTENT_ACTION_TYPE)).toEqual({
			total: 1,
			byState: { planned: 1 },
		});
		expect(tick5.report.budget).toEqual({ capUsdCents: 10000, availableUsdCents: 9875 });
		expect(tick5.report.openAttention).toBe(attentionReasons.length);

		// Negative probe: every GitHub request of the whole lifecycle was a
		// read. The fake server cannot serve anything else, and the recorded
		// traffic proves the controller only ever asked for reads.
		const recorded: RecordedGithubRequest[] = h.github.recordedRequests();
		expect(recorded.length).toBeGreaterThan(20);
		for (const request of recorded) {
			expect(["GET", "HEAD"]).toContain(request.method);
		}

		// Negative probe: no credential reached any durable payload.
		const durableJson = [
			...store2.actions
				.listActionsForCampaign(h.campaignId)
				.map((action) => `${action.actionKey} ${action.requestDigest ?? ""}`),
			...store2.events
				.listGithubEvents(h.campaignId)
				.map((event) => `${event.nodeId} ${event.payloadJson}`),
			...store2.events
				.listOpenAttention(h.campaignId)
				.map((item) => `${item.reason} ${item.detailJson}`),
		].join("\n");
		expect(durableJson).not.toContain(WARREN_TOKEN);
		store2.close();
	});

	test("an uncertain dispatch is never retried, before or after restart", async () => {
		const dbPath = join(TEMP_ROOT, "uncertain.db");
		const ids = new SequentialIdGenerator();
		const clock = new FixedClock(NOW);
		const h = bootAndApprove(dbPath);
		h.warren.dropNextResponses(1); // accepted-response-loss on the POST

		const tick1 = await runTick(h.deps, h.campaignId);
		expect(stagesOf(tick1.stages)).toContain("dispatch:dispatch_uncertain");
		expect(tick1.campaignStatus).toBe("needs_attention");
		expect(h.store.events.listOpenAttention(h.campaignId)).toHaveLength(1);
		// The dropped request WAS accepted server-side: exactly one run exists,
		// and no later tick may ever POST again.
		expect(h.warren.createdRunCount()).toBe(1);

		const tick2 = await runTick(h.deps, h.campaignId);
		expect(stagesOf(tick2.stages)).not.toContain("dispatch:dispatched");
		expect(h.warren.createdRunCount()).toBe(1);
		expect(tick2.campaignStatus).toBe("needs_attention");

		// Restart does not widen anything: still no re-POST.
		h.store.close();
		h.warren.restart();
		const store2 = new CampaignStateStore(dbPath, { clock, ids });
		const tick3 = await runTick({ ...h.deps, store: store2 }, h.campaignId);
		expect(stagesOf(tick3.stages)).not.toContain("dispatch:dispatched");
		expect(h.warren.createdRunCount()).toBe(1);
		expect(tick3.campaignStatus).toBe("needs_attention");
		const workItem = store2.campaigns.listWorkItems(h.campaignId)[0] as { status: string };
		expect(workItem.status).toBe("dispatch_uncertain");
		store2.close();
	});
});
