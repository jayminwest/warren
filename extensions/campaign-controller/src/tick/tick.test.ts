/**
 * Composed dry-run tick tests (plan pl-91b6 step 10, warren-d050).
 *
 * Every scenario runs the real composition — the tick engine over the real
 * admission, dispatcher, PR-intent, and reconciler modules — against the
 * deterministic fake Warren and fake GitHub servers. The scenarios pin:
 *
 * - the seed's exact stage ordering over a full campaign lifecycle;
 * - one new dispatch per tick, and none at all after restart;
 * - fail-closed ambiguous dispatch with no re-POST ever;
 * - concurrent-tick refusal through the campaign lease;
 * - read-only upstream reconciliation with durable deduplication;
 * - restart over a file-backed store resuming exactly once.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { approveCampaign, importCampaign } from "../admission.ts";
import { FixedClock, SequentialIdGenerator } from "../clock.ts";
import { digestOf } from "../digest.ts";
import { ReadOnlyGithubClient } from "../github/client.ts";
import { FakeGithubServer } from "../github/fake-server.ts";
import { GithubPrAlreadyExistsError, type GithubPrCreateTransport } from "../github/pr-create.ts";
import { FakeGithubPrCreator } from "../github/pr-create-fake.ts";
import { PR_INTENT_ACTION_TYPE } from "../pr-intent/intender.ts";
import { validateBotGrammar } from "../reconcile/bot-grammar.ts";
import { CampaignStateStore } from "../store/state-store.ts";
import { WarrenClient } from "../warren-client.ts";
import { FakeWarrenServer } from "../warren-fake.ts";
import {
	runTick,
	TickConcurrentError,
	type TickDeps,
	type TickOutcome,
	type TickStage,
} from "./tick.ts";

const NOW = Date.parse("2026-08-26T00:00:00.000Z");
const TOKEN = "test-token";
const BRANCH = "warren/issue-812";
const TEMP_ROOT = join(tmpdir(), `campaign-tick-test-${process.pid}`);

function basePolicy(): Record<string, unknown> {
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
		allowedWorkTypes: ["bug-fix", "feature", "docs", "test", "refactor"],
		forbiddenPaths: [".github/workflows/*", "SECURITY.md"],
		protectedPaths: ["docs/CONSTITUTION.md"],
		upstreamObservedMaxOpenPrs: 20,
		maxOpenPrs: 5,
		maxNewPrsPerDay: 2,
		requiredChecks: ["ci", "typecheck", "lint"],
		mutations: {
			createPullRequest: false,
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

function signedManifest(issues: number[]): Record<string, unknown> {
	const unapproved = {
		schemaVersion: 1,
		campaignId: "camp-openclaw-eod-v0",
		campaignVersion: 1,
		upstream: { owner: "openclaw", repo: "openclaw" },
		fork: { owner: "warren-run-bot", repo: "openclaw" },
		defaultBranch: "main",
		issues,
		warren: {
			project: "openclaw-contrib",
			agent: "pi",
			provider: "anthropic",
			model: "claude-sonnet-4-5",
		},
		prompt: "Fix the assigned OpenClaw issue end to end.",
		budget: { perRunUsd: 5, dailyUsd: 20, totalUsd: 100 },
		maxConcurrentRuns: 2,
		expiresAt: "2026-12-31T00:00:00.000Z",
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

interface TickHarness {
	readonly store: CampaignStateStore;
	readonly warren: FakeWarrenServer;
	readonly github: FakeGithubServer;
	readonly deps: TickDeps;
	readonly campaignId: string;
}

function seedGithub(github: FakeGithubServer, issues: number[]): void {
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
	for (const issue of issues) {
		github.setResource(`/repos/openclaw/openclaw/issues/${issue}`, {
			node_id: `I_${issue}`,
			number: issue,
			state: "open",
			title: `Issue ${issue}: flaky scheduler test`,
			user: { login: "openclaw-maintainer" },
			labels: [],
			created_at: "2026-08-01T00:00:00.000Z",
			updated_at: "2026-08-20T00:00:00.000Z",
			closed_at: null,
			html_url: `https://github.com/openclaw/openclaw/issues/${issue}`,
		});
	}
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
	github.setResource("/notifications", []);
}

/** Build an approved campaign wired to fake warren + fake github. */
function harness(options: {
	dbPath?: string;
	issues?: number[];
	store?: CampaignStateStore;
	ids?: SequentialIdGenerator;
	/** Import/approve with this policy instead of the dry-run base one. */
	policy?: Record<string, unknown>;
	/** Profile bot grammar; absent means the classifier no-ops (warren-8c83). */
	botGrammar?: unknown;
	/** Wire the Phase 2 creator so ticks execute journaled intents. */
	prCreator?: GithubPrCreateTransport;
}): TickHarness {
	const clock = new FixedClock(NOW);
	const ids = options.ids ?? new SequentialIdGenerator();
	const store =
		options.store ?? new CampaignStateStore(options.dbPath ?? ":memory:", { clock, ids });
	const warren = new FakeWarrenServer({ token: TOKEN });
	const warrenClient = new WarrenClient({
		baseUrl: "http://warren.test",
		token: TOKEN,
		fetchFn: warren.fetch,
		clock,
		sleep: async () => {},
	});
	const github = new FakeGithubServer({ clock });
	seedGithub(github, options.issues ?? [812]);
	const issues = options.issues ?? [812];
	const policy = options.policy ?? basePolicy();
	const imported = importCampaign(store, {
		manifest: signedManifest(issues),
		policy,
		nowMs: NOW,
	});
	approveCampaign(store, {
		campaignId: imported.campaign.id,
		manifestDigest: imported.manifestDigest,
		approvedBy: "jayminwest",
		nowMs: NOW,
	});
	const summaries = new Map((options.issues ?? [812]).map((issue) => [issue, SUMMARY]));
	return {
		store,
		warren,
		github,
		campaignId: imported.campaign.id,
		deps: {
			store,
			warrenClient,
			github: new ReadOnlyGithubClient(github),
			clock,
			ids,
			policy,
			summaries,
			...(options.botGrammar !== undefined ? { botGrammar: options.botGrammar } : {}),
			...(options.prCreator !== undefined ? { prCreator: options.prCreator } : {}),
		},
	};
}

function requireStage(tick: { stages: readonly TickOutcome[] }, stage: TickStage): TickOutcome {
	const found = tick.stages.find((outcome) => outcome.stage === stage);
	if (found === undefined) {
		throw new Error(`no ${stage} stage in the tick result`);
	}
	return found;
}

function detailOf(outcome: TickOutcome): Record<string, number> {
	return outcome.detail as Record<string, number>;
}

function stagesOf(outcomes: readonly TickOutcome[]): string[] {
	return outcomes.map((outcome) => `${outcome.stage}:${outcome.status}`);
}

/** The run id a dispatch stage correlated, straight from its outcome. */
function runIdOf(tick: { stages: readonly TickOutcome[] }): string {
	const stage = tick.stages.find((outcome) => outcome.stage === "dispatch");
	const runId = (stage?.detail as { runId?: unknown } | undefined)?.runId;
	if (typeof runId !== "string" || runId.length === 0) {
		throw new Error("no dispatch stage with a run id");
	}
	return runId;
}

beforeAll(() => {
	mkdirSync(TEMP_ROOT, { recursive: true });
});

afterAll(() => {
	rmSync(TEMP_ROOT, { recursive: true, force: true });
});

describe("runTick", () => {
	test("executes the seed's stage order across a full campaign lifecycle", async () => {
		const h = harness({});
		const tick1 = await runTick(h.deps, h.campaignId);
		expect(tick1.dryRun).toBe(true);
		expect(stagesOf(tick1.stages)).toEqual([
			"lease:acquired",
			"admit:admitted",
			"dispatch:dispatched",
			"github_reconcile:none",
		]);
		expect(tick1.campaignStatus).toBe("running");
		expect(h.warren.createdRunCount()).toBe(1);

		// The run completes on warren's side; the next tick reconciles it,
		// renders the dry-run PR intent, and settles the campaign.
		h.warren.setRunState(runIdOf(tick1), {
			state: "succeeded",
			costUsd: 1.25,
			targetBranch: BRANCH,
		});
		const tick2 = await runTick(h.deps, h.campaignId);
		expect(stagesOf(tick2.stages)).toEqual([
			"lease:acquired",
			"reconcile_run:reconciled",
			"pr_intent:rendered",
			"github_reconcile:none",
		]);
		expect(tick2.campaignStatus).toBe("completed");
		expect(tick2.report.budget).toEqual({ capUsdCents: 10000, availableUsdCents: 9875 });
		expect(tick2.report.workItems).toEqual([
			{ id: expect.any(String), issueRef: "812", position: 1, status: "terminal" },
		]);
		// Exactly one warren POST for the whole lifecycle.
		expect(h.warren.createdRunCount()).toBe(1);

		// The third tick replays the intent idempotently: a completed campaign
		// backfills/replays terminal work items under the deterministic action
		// key instead of refusing them (warren-968d).
		const tick3 = await runTick(h.deps, h.campaignId);
		expect(stagesOf(tick3.stages)).toEqual([
			"lease:acquired",
			"pr_intent:already_journaled",
			"github_reconcile:none",
		]);
		const intents = h.store.actions
			.listActionsForCampaign(h.campaignId)
			.filter((action) => action.actionType === PR_INTENT_ACTION_TYPE);
		expect(intents).toHaveLength(1);
		expect(intents[0]?.state).toBe("planned");
		// Every GitHub interaction was a read.
		expect(h.github.requestCount).toBeGreaterThan(0);
	});

	test("renders pr_intent before completion when the run settles during the restart sweep (warren-968d)", async () => {
		const h = harness({});
		const tick1 = await runTick(h.deps, h.campaignId);
		const runId = runIdOf(tick1);

		// The live interleaving: the run is still running when the item loop
		// reconciles it, and completes before the restart sweep's second
		// authoritative read — all within ONE tick. The old pipeline settled
		// the campaign completed and the pr_intent stage never ran.
		let reads = 0;
		h.warren.onGetRunRead((_id, count) => {
			reads = count;
			// Read #1 was tick 1's post-dispatch confirmation; read #2 is the
			// item loop's reconcile (still running), read #3 is the restart
			// sweep — the run settles only there.
			if (count >= 3) {
				h.warren.setRunState(runId, {
					state: "succeeded",
					costUsd: 1.5,
					targetBranch: BRANCH,
				});
			}
		});
		const tick2 = await runTick(h.deps, h.campaignId);
		expect(reads).toBeGreaterThanOrEqual(3);
		expect(stagesOf(tick2.stages)).toContain("reconcile_run:running");
		expect(stagesOf(tick2.stages)).toContain("pr_intent:rendered");
		expect(tick2.campaignStatus).toBe("completed");
		const intents = h.store.actions
			.listActionsForCampaign(h.campaignId)
			.filter((action) => action.actionType === PR_INTENT_ACTION_TYPE);
		expect(intents).toHaveLength(1);
		expect(intents[0]?.state).toBe("planned");
		expect(h.warren.createdRunCount()).toBe(1);
	});

	test("backfills pr_intent idempotently for a campaign completed un-rendered (warren-968d)", async () => {
		const h = harness({});
		const tick1 = await runTick(h.deps, h.campaignId);
		h.warren.setRunState(runIdOf(tick1), {
			state: "succeeded",
			costUsd: 1,
			targetBranch: BRANCH,
		});
		// The operator had supplied no summary yet, so the intent was skipped
		// while the campaign settled completed.
		const noSummaries = { ...h.deps, summaries: new Map() };
		const tick2 = await runTick(noSummaries, h.campaignId);
		expect(stagesOf(tick2.stages)).toContain("pr_intent:skipped_no_summary");
		expect(tick2.campaignStatus).toBe("completed");

		// The summary arrives later; the completed campaign backfills the
		// intent under the deterministic action key instead of refusing.
		const tick3 = await runTick(h.deps, h.campaignId);
		expect(stagesOf(tick3.stages)).toEqual([
			"lease:acquired",
			"pr_intent:rendered",
			"github_reconcile:none",
		]);
		const intents = h.store.actions
			.listActionsForCampaign(h.campaignId)
			.filter((action) => action.actionType === PR_INTENT_ACTION_TYPE);
		expect(intents).toHaveLength(1);
		const tick4 = await runTick(h.deps, h.campaignId);
		expect(stagesOf(tick4.stages)).toContain("pr_intent:already_journaled");
		expect(
			h.store.actions
				.listActionsForCampaign(h.campaignId)
				.filter((action) => action.actionType === PR_INTENT_ACTION_TYPE),
		).toHaveLength(1);
	});

	test("backfills a null journaled result_branch from the run wire (warren-5255)", async () => {
		const h = harness({});
		const tick1 = await runTick(h.deps, h.campaignId);
		const runId = runIdOf(tick1);
		// A warren predating the run-wire `branch` field: the run succeeds
		// with no targetBranch override and no composed branch served, so the
		// dispatch settles with result_branch null and the intent refuses.
		h.warren.setRunState(runId, { state: "succeeded", costUsd: 1 });
		const tick2 = await runTick(h.deps, h.campaignId);
		expect(stagesOf(tick2.stages)).toContain("pr_intent:refused");
		const settled = h.store.actions
			.listActionsForCampaign(h.campaignId)
			.find((action) => action.state === "succeeded");
		expect(settled?.resultBranch).toBeNull();

		// The warren upgrade lands and the run wire now serves the composed
		// branch; the next tick backfills the journal row and renders.
		h.warren.setRunState(runId, { branch: BRANCH });
		const tick3 = await runTick(h.deps, h.campaignId);
		expect(stagesOf(tick3.stages)).toContain("pr_intent:rendered");
		const backfilled = h.store.actions
			.listActionsForCampaign(h.campaignId)
			.find((action) => action.resultRunId === runId && action.state === "succeeded");
		expect(backfilled?.resultBranch).toBe(BRANCH);
		// No second dispatch, no second intent.
		expect(h.warren.createdRunCount()).toBe(1);
		expect(
			h.store.actions
				.listActionsForCampaign(h.campaignId)
				.filter((action) => action.actionType === PR_INTENT_ACTION_TYPE),
		).toHaveLength(1);
	});

	test("restart resumes the known run to terminal without a second POST", async () => {
		const dbPath = join(TEMP_ROOT, "restart.db");
		const ids = new SequentialIdGenerator();
		const clock = new FixedClock(NOW);
		const h1 = harness({ dbPath, ids });
		const tick1 = await runTick(h1.deps, h1.campaignId);
		expect(stagesOf(tick1.stages)).toContain("dispatch:dispatched");
		h1.store.close();
		const runId = runIdOf(tick1);

		// Controller restart (new store on the same file) + warren restart
		// (the non-durable idempotency store is wiped, runs survive).
		h1.warren.restart();
		h1.warren.setRunState(runId, {
			state: "succeeded",
			costUsd: 2,
			targetBranch: BRANCH,
		});
		const store2 = new CampaignStateStore(dbPath, { clock, ids });
		const warrenClient = new WarrenClient({
			baseUrl: "http://warren.test",
			token: TOKEN,
			fetchFn: h1.warren.fetch,
			clock,
			sleep: async () => {},
		});
		const tick2 = await runTick(
			{
				...h1.deps,
				store: store2,
				warrenClient,
			},
			h1.campaignId,
		);
		expect(stagesOf(tick2.stages)).toEqual([
			"lease:acquired",
			"reconcile_run:reconciled",
			"pr_intent:rendered",
			"github_reconcile:none",
		]);
		expect(tick2.restart.resumedRuns).toBe(0);
		expect(tick2.restart.failClosed).toBe(0);
		expect(h1.warren.createdRunCount()).toBe(1);
		store2.close();
	});

	test("restart fails closed an unconfirmed dispatch intent with no POST ever", async () => {
		const dbPath = join(TEMP_ROOT, "failclosed.db");
		const ids = new SequentialIdGenerator();
		const clock = new FixedClock(NOW);
		const h = harness({ dbPath, ids });
		// Emulate a crash between journaling the intent and the POST.
		const item = h.store.campaigns.listWorkItems(h.campaignId)[0] as { id: string };
		h.store.actions.beginAction({
			actionKey: `warren-dispatch:${h.campaignId}:${item.id}:a1`,
			campaignId: h.campaignId,
			workItemId: item.id,
			actionType: "warren_dispatch",
			requestDigest: "a".repeat(64),
			policyDigest: null,
			attempt: 1,
		});
		h.store.campaigns.setWorkItemStatus(item.id, "dispatch_intent");
		h.store.close();

		const store2 = new CampaignStateStore(dbPath, { clock, ids });
		const tick = await runTick({ ...h.deps, store: store2 }, h.campaignId);
		expect(stagesOf(tick.stages)).toEqual([
			"lease:acquired",
			"dispatch:awaiting_restart_reconcile",
			"github_reconcile:none",
		]);
		expect(tick.restart.failClosed).toBe(1);
		expect(tick.campaignStatus).toBe("needs_attention");
		expect(store2.campaigns.getWorkItem(item.id)?.status).toBe("dispatch_uncertain");
		expect(store2.events.listOpenAttention(h.campaignId)).toHaveLength(1);
		// The unconfirmed attempt was never POSTed, and never will be.
		expect(h.warren.createdRunCount()).toBe(0);
		const tick2 = await runTick({ ...h.deps, store: store2 }, h.campaignId);
		expect(h.warren.createdRunCount()).toBe(0);
		expect(tick2.campaignStatus).toBe("needs_attention");
		store2.close();
	});

	test("an ambiguous dispatch fails closed and is never re-POSTed", async () => {
		const h = harness({});
		h.warren.dropNextResponses(1); // accepted-response-loss on the POST
		const tick1 = await runTick(h.deps, h.campaignId);
		expect(stagesOf(tick1.stages)).toContain("dispatch:dispatch_uncertain");
		expect(tick1.campaignStatus).toBe("needs_attention");
		const workItem = h.store.campaigns.listWorkItems(h.campaignId)[0] as {
			status: string;
		};
		expect(workItem.status).toBe("dispatch_uncertain");
		expect(h.store.events.listOpenAttention(h.campaignId)).toHaveLength(1);
		// The dropped request WAS accepted server-side: exactly one run exists.
		expect(h.warren.createdRunCount()).toBe(1);

		const tick2 = await runTick(h.deps, h.campaignId);
		expect(stagesOf(tick2.stages)).not.toContain("dispatch:dispatched");
		expect(h.warren.createdRunCount()).toBe(1); // never a second POST
		expect(tick2.campaignStatus).toBe("needs_attention");
	});

	test("refuses a concurrent tick through the campaign lease", async () => {
		const h = harness({});
		const scope = `tick:${h.campaignId}`;
		expect(h.store.leases.acquireLease(scope, "another-holder", 60_000)).not.toBeNull();
		expect(runTick(h.deps, h.campaignId)).rejects.toBeInstanceOf(TickConcurrentError);
		// The foreign lease survives: the refused tick released nothing.
		expect(h.store.leases.getLease(scope)?.holder).toBe("another-holder");
	});

	test("dispatches at most one new run per tick, in issue order", async () => {
		const h = harness({ issues: [812, 815] });
		const tick1 = await runTick(h.deps, h.campaignId);
		expect(stagesOf(tick1.stages)).toEqual([
			"lease:acquired",
			"admit:admitted",
			"dispatch:dispatched",
			"admit:deferred",
			"github_reconcile:none",
		]);
		expect(h.warren.createdRunCount()).toBe(1);

		h.warren.setRunState(runIdOf(tick1), {
			state: "succeeded",
			costUsd: 1,
			targetBranch: BRANCH,
		});
		const tick2 = await runTick(h.deps, h.campaignId);
		expect(stagesOf(tick2.stages)).toEqual([
			"lease:acquired",
			"reconcile_run:reconciled",
			"pr_intent:rendered",
			"admit:admitted",
			"dispatch:dispatched",
			"github_reconcile:none",
		]);
		expect(h.warren.createdRunCount()).toBe(2);

		// A later tick replays the first item's intent idempotently (the
		// campaign is still running while issue 815 is in flight).
		const tick3 = await runTick(h.deps, h.campaignId);
		expect(stagesOf(tick3.stages)).toContain("pr_intent:already_journaled");
		expect(h.warren.createdRunCount()).toBe(2);
	});

	test("reconciles a known upstream PR read-only with durable dedupe", async () => {
		const h = harness({});
		const tick1 = await runTick(h.deps, h.campaignId);
		h.warren.setRunState(runIdOf(tick1), {
			state: "succeeded",
			costUsd: 1.25,
			targetBranch: BRANCH,
		});
		await runTick(h.deps, h.campaignId); // renders + journals the intent

		// The operator links a real upstream PR number to the identity.
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
			headBranch: BRANCH,
			prNumber: 7,
			prUrl: "https://github.com/openclaw/openclaw/pull/7",
		});
		const sha = "abc123abc123abc123abc123abc123abc123abc1";
		h.github.setResource("/repos/openclaw/openclaw/pulls/7", {
			node_id: "PR_7",
			number: 7,
			state: "open",
			draft: false,
			title: "Flaky scheduler test (#812)",
			user: { login: "warren-run-bot" },
			head: { ref: BRANCH, sha, repo: { full_name: "warren-run-bot/openclaw" } },
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
		h.github.setResource(`/repos/openclaw/openclaw/pulls/7/reviews`, []);
		h.github.setResource(`/repos/openclaw/openclaw/issues/7/comments`, []);
		h.github.setResource(`/repos/openclaw/openclaw/pulls/7/comments`, []);
		h.github.setResource(`/repos/openclaw/openclaw/commits/${sha}/check-runs`, {
			total_count: 1,
			check_runs: [
				{
					node_id: "CR_1",
					id: 1,
					name: "ci",
					status: "completed",
					conclusion: "failure",
					started_at: "2026-08-26T00:00:00.000Z",
					completed_at: "2026-08-26T00:00:00.000Z",
					details_url: null,
					html_url: "https://github.com/openclaw/openclaw/pull/7/checks",
				},
			],
		});
		h.github.setResource(`/repos/openclaw/openclaw/commits/${sha}/status`, {
			state: "failure",
			total_count: 1,
			sha,
			statuses: [{ context: "ci", state: "failure", description: null }],
		});

		const tick3 = await runTick(h.deps, h.campaignId);
		const reconcileStage = requireStage(tick3, "github_reconcile");
		expect(reconcileStage.status).toBe("reconciled");
		expect(detailOf(reconcileStage).newEvents).toBeGreaterThan(0);
		expect(tick3.report.openAttention).toBeGreaterThan(0);

		// A second pass over the same upstream state duplicates nothing.
		const before = h.store.events.listGithubEvents(h.campaignId).length;
		const tick4 = await runTick(h.deps, h.campaignId);
		const second = requireStage(tick4, "github_reconcile");
		expect(detailOf(second).newEvents).toBe(0);
		expect(detailOf(second).duplicateEvents).toBeGreaterThan(0);
		expect(h.store.events.listGithubEvents(h.campaignId)).toHaveLength(before);
	});
});

/** Phase 2 (warren-84da): the policy-gated live PR create over the same tick. */
describe("runTick with a policy-gated PR creator", () => {
	function livePolicy(): Record<string, unknown> {
		const policy = basePolicy() as { mutations: Record<string, boolean> };
		policy.mutations = { ...policy.mutations, createPullRequest: true };
		return policy;
	}

	function upstreamPrFixture(number: number, headRef: string): Record<string, unknown> {
		return {
			node_id: `PR_${number}`,
			number,
			state: "open",
			draft: true,
			title: "fix: existing cross-fork PR",
			user: { login: "warren-run-bot" },
			head: {
				ref: headRef,
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
			html_url: `https://github.com/openclaw/openclaw/pull/${number}`,
		};
	}

	async function driveToTerminal(h: TickHarness): Promise<void> {
		const tick1 = await runTick(h.deps, h.campaignId);
		h.warren.setRunState(runIdOf(tick1), {
			state: "succeeded",
			costUsd: 1,
			branch: BRANCH,
		});
	}

	test("executes the journaled intent exactly once and records the created PR", async () => {
		const creator = new FakeGithubPrCreator({ firstPrNumber: 130001 });
		const h = harness({ policy: livePolicy(), prCreator: creator });
		await driveToTerminal(h);
		const tick2 = await runTick(h.deps, h.campaignId);
		expect(tick2.dryRun).toBe(false);
		expect(stagesOf(tick2.stages)).toContain("pr_intent:rendered");
		expect(stagesOf(tick2.stages)).toContain("pr_execute:created");
		expect(creator.received).toHaveLength(1);
		// The exact journaled request went to the wire: cross-fork head, and
		// ready for review — an executable createPullRequest policy renders
		// draft:false so upstream review bots don't skip the PR (warren-68f2).
		expect(creator.received[0]?.url).toBe("/repos/openclaw/openclaw/pulls");
		expect(creator.received[0]?.body.head).toBe(`warren-run-bot:${BRANCH}`);
		expect(creator.received[0]?.body.draft).toBe(false);
		const intent = h.store.actions
			.listActionsForCampaign(h.campaignId)
			.find((action) => action.actionType === PR_INTENT_ACTION_TYPE);
		expect(intent?.state).toBe("succeeded");
		expect(intent?.resultPrNumber).toBe(130001);
		const identity = h.store.events.listPrIdentities(h.campaignId)[0];
		expect(identity?.prNumber).toBe(130001);
		expect(identity?.prUrl).toBe("https://github.com/openclaw/openclaw/pull/130001");
		// Re-tick: stable — no second POST, no second intent.
		const tick3 = await runTick(h.deps, h.campaignId);
		expect(stagesOf(tick3.stages)).toContain("pr_execute:already_executed");
		expect(creator.received).toHaveLength(1);
	});

	test("a lost create response settles uncertain and is never re-POSTed", async () => {
		const creator = new FakeGithubPrCreator();
		creator.loseNextResponse();
		const h = harness({ policy: livePolicy(), prCreator: creator });
		await driveToTerminal(h);
		const tick2 = await runTick(h.deps, h.campaignId);
		expect(stagesOf(tick2.stages)).toContain("pr_execute:settled_uncertain");
		expect(creator.received).toHaveLength(1);
		const attention = h.store.events.listAttention(h.campaignId, false);
		expect(attention.some((item) => item.reason === "pr_create_uncertain")).toBe(true);
		// The uncertain action blocks every later tick; the POST count is final.
		const tick3 = await runTick(h.deps, h.campaignId);
		expect(stagesOf(tick3.stages)).toContain("pr_execute:uncertain_blocked");
		expect(creator.received).toHaveLength(1);
	});

	test("a PR already visible upstream is recovered pre-flight with zero POSTs", async () => {
		const creator = new FakeGithubPrCreator();
		const h = harness({ policy: livePolicy(), prCreator: creator });
		await driveToTerminal(h);
		h.github.setPaginatedCollection("/repos/openclaw/openclaw/pulls", [
			upstreamPrFixture(7777, BRANCH),
		]);
		const tick2 = await runTick(h.deps, h.campaignId);
		expect(stagesOf(tick2.stages)).toContain("pr_execute:recovered_existing");
		expect(creator.received).toHaveLength(0);
		const intent = h.store.actions
			.listActionsForCampaign(h.campaignId)
			.find((action) => action.actionType === PR_INTENT_ACTION_TYPE);
		expect(intent?.state).toBe("succeeded");
		expect(intent?.resultPrNumber).toBe(7777);
	});

	test("GitHub's 422 already-exists recovers through the read, never a second POST", async () => {
		// The PR becomes visible upstream only when the POST bounces —
		// invisible at pre-flight, so this exercises the 422 recovery arm.
		let posts = 0;
		let h: TickHarness | null = null;
		const creator: GithubPrCreateTransport = {
			async createPullRequest(intent) {
				posts += 1;
				(h as TickHarness).github.setPaginatedCollection("/repos/openclaw/openclaw/pulls", [
					upstreamPrFixture(7777, BRANCH),
				]);
				throw new GithubPrAlreadyExistsError(
					`fake: a pull request already exists for head ${intent.body.head}`,
					intent.url,
				);
			},
		};
		h = harness({ policy: livePolicy(), prCreator: creator });
		await driveToTerminal(h);
		const tick2 = await runTick(h.deps, h.campaignId);
		expect(stagesOf(tick2.stages)).toContain("pr_execute:recovered_existing");
		expect(posts).toBe(1);
		const intent = h.store.actions
			.listActionsForCampaign(h.campaignId)
			.find((action) => action.actionType === PR_INTENT_ACTION_TYPE);
		expect(intent?.state).toBe("succeeded");
		expect(intent?.resultPrNumber).toBe(7777);
		// Stable across re-ticks: no further POST.
		await runTick(h.deps, h.campaignId);
		expect(posts).toBe(1);
	});

	test("dry-run policy stays dry: no creator, no pr_execute stage, no POST", async () => {
		const h = harness({});
		await driveToTerminal(h);
		const tick2 = await runTick(h.deps, h.campaignId);
		expect(tick2.dryRun).toBe(true);
		expect(stagesOf(tick2.stages).some((stage) => stage.startsWith("pr_execute"))).toBe(false);
	});

	test("appends the profile's agentGuidance block to every dispatched prompt (warren-39b0)", async () => {
		const guided = {
			...basePolicy(),
			agentGuidance: {
				version: 1,
				norms: ["Produce the smallest possible diff.", "Cite existing mechanisms."],
			},
		};
		const h = harness({ issues: [812, 815], policy: guided });

		// Initial dispatch: the first run's prompt carries the delimited block.
		const tick1 = await runTick(h.deps, h.campaignId);
		const firstPrompt = h.warren.getRunRow(runIdOf(tick1))?.prompt ?? "";
		expect(firstPrompt.startsWith("Fix the assigned OpenClaw issue end to end.")).toBe(true);
		expect(firstPrompt).toContain("BEGIN AGENT GUIDANCE");
		expect(firstPrompt).toContain("agentGuidance v1");
		expect(firstPrompt).toContain("1. Produce the smallest possible diff.");
		expect(firstPrompt).toContain("2. Cite existing mechanisms.");
		expect(firstPrompt).toContain("END AGENT GUIDANCE");

		// Follow-up dispatch (the second work item, next tick): same block.
		h.warren.setRunState(runIdOf(tick1), { state: "succeeded", costUsd: 1, targetBranch: BRANCH });
		const tick2 = await runTick(h.deps, h.campaignId);
		expect(stagesOf(tick2.stages)).toContain("dispatch:dispatched");
		const secondRunId = detailOf(requireStage(tick2, "dispatch")).runId;
		const secondPrompt =
			typeof secondRunId === "string" ? (h.warren.getRunRow(secondRunId)?.prompt ?? "") : "";
		expect(secondPrompt).toContain("BEGIN AGENT GUIDANCE");
		expect(secondPrompt).toContain("1. Produce the smallest possible diff.");
		expect(secondPrompt).toContain("END AGENT GUIDANCE");
	});
});

/** The review-bot grammar the openclaw profile declares (data, not code). */
function openclawBotGrammar(): unknown {
	return JSON.parse(
		readFileSync(
			join(import.meta.dir, "..", "..", "profiles", "openclaw.bot-grammar.json"),
			"utf8",
		),
	) as unknown;
}

/**
 * warren-8c83: drive a campaign to a linked upstream PR with a review-bot
 * finding comment, entirely through the real tick composition.
 */
describe("runTick with a profile bot grammar (warren-8c83)", () => {
	async function linkPrWithBotComment(h: TickHarness): Promise<void> {
		const tick1 = await runTick(h.deps, h.campaignId);
		h.warren.setRunState(runIdOf(tick1), {
			state: "succeeded",
			costUsd: 1.25,
			targetBranch: BRANCH,
		});
		await runTick(h.deps, h.campaignId); // renders + journals the intent

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
			headBranch: BRANCH,
			prNumber: 7,
			prUrl: "https://github.com/openclaw/openclaw/pull/7",
		});
		const sha = "abc123abc123abc123abc123abc123abc123abc1";
		h.github.setResource("/repos/openclaw/openclaw/pulls/7", {
			node_id: "PR_7",
			number: 7,
			state: "open",
			draft: false,
			title: "Flaky scheduler test (#812)",
			user: { login: "warren-run-bot" },
			head: { ref: BRANCH, sha, repo: { full_name: "warren-run-bot/openclaw" } },
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
		h.github.setResource("/repos/openclaw/openclaw/pulls/7/reviews", []);
		h.github.setResource("/repos/openclaw/openclaw/pulls/7/comments", []);
		h.github.setResource(`/repos/openclaw/openclaw/commits/${sha}/check-runs`, {
			total_count: 0,
			check_runs: [],
		});
		h.github.setResource(`/repos/openclaw/openclaw/commits/${sha}/status`, {
			state: "pending",
			total_count: 0,
			sha,
			statuses: [],
		});
		h.github.setPaginatedCollection("/repos/openclaw/openclaw/issues/7/comments", [
			{
				node_id: "IC_bot_1",
				id: 1,
				user: { login: "clawsweeper[bot]" },
				author_association: "NONE",
				body: "## Findings\n- [P1] Clock not seeded \u2014 `src/scheduler/clock.ts:42-44`",
				created_at: "2026-08-26T02:00:00.000Z",
				updated_at: "2026-08-26T02:00:00.000Z",
				html_url: "https://github.com/openclaw/openclaw/pull/7#issuecomment-1",
			},
		]);
	}

	test("classifies the bot finding comment into durable review feedback through the tick", async () => {
		const h = harness({ botGrammar: validateBotGrammar(openclawBotGrammar()) });
		await linkPrWithBotComment(h);

		const tick = await runTick(h.deps, h.campaignId);
		const reconcileStage = requireStage(tick, "github_reconcile");
		expect(reconcileStage.status).toBe("reconciled");
		expect(detailOf(reconcileStage).feedbackCreated).toBeGreaterThan(0);

		const feedback = h.store.events
			.listFeedback(h.campaignId)
			.filter((row) => row.category === "review_bot_findings");
		expect(feedback).toHaveLength(1);
		const fields = JSON.parse(feedback[0]?.fieldsJson ?? "{}") as {
			findings: { value: { title: { value: string } }[] } | { title: { value: string } }[];
		};
		const list = Array.isArray(fields.findings) ? fields.findings : fields.findings.value;
		expect(list[0]?.title.value).toBe("Clock not seeded");
	});

	test("without a configured grammar the tick still reconciles but classifies nothing", async () => {
		const h = harness({});
		await linkPrWithBotComment(h);

		const tick = await runTick(h.deps, h.campaignId);
		const reconcileStage = requireStage(tick, "github_reconcile");
		expect(reconcileStage.status).toBe("reconciled");
		expect(detailOf(reconcileStage).newEvents).toBeGreaterThan(0);
		expect(detailOf(reconcileStage).feedbackCreated).toBe(0);
		expect(h.store.events.listFeedback(h.campaignId)).toHaveLength(0);
	});
});
