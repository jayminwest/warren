/**
 * Durable Warren dispatch and restart reconciliation (plan pl-91b6 step 7,
 * warren-2a0a).
 *
 * Every scenario runs against the deterministic fake Warren server through
 * the real WarrenClient, on an in-memory store with a pinned clock and
 * sequential ids. The acceptance set from the seed:
 *
 * - normal dispatch (intent before I/O, confirmed correlation);
 * - concurrent tick exclusion (second dispatch never POSTs);
 * - accepted-response-loss (run exists, response lost → dispatch_uncertain,
 *   attention, no second POST);
 * - restart with a known run (reads resume to terminal, ledger settles);
 * - restart with an unknown run (fails closed, attention, no POST);
 * - terminal settlement (actual cost replaces the reservation);
 * - unknown-cost reservation (conservative reservation stays active);
 * - no second POST for an uncertain action, including after restart.
 */
import { describe, expect, test } from "bun:test";
import {
	admitWorkItem,
	approveCampaign,
	type IssueSnapshot,
	importCampaign,
} from "../admission.ts";
import { FixedClock, SequentialIdGenerator } from "../clock.ts";
import { digestOf } from "../digest.ts";
import { StateError } from "../errors.ts";
import { CampaignStateStore } from "../store/state-store.ts";
import type { CampaignRow, WorkItemRow } from "../store/types.ts";
import { WarrenClient } from "../warren-client.ts";
import { FakeWarrenServer } from "../warren-fake.ts";
import { WarrenDispatcher, type WarrenDispatchRequestSpec } from "./dispatcher.ts";

const NOW = Date.parse("2026-08-26T00:00:00.000Z");
const TOKEN = "test-token";

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

function signedManifest(): Record<string, unknown> {
	const unapproved = {
		schemaVersion: 1,
		campaignId: "camp-openclaw-eod-v0",
		campaignVersion: 1,
		upstream: { owner: "openclaw", repo: "openclaw" },
		fork: { owner: "warren-run-bot", repo: "openclaw" },
		defaultBranch: "main",
		issues: [812],
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

interface Harness {
	readonly store: CampaignStateStore;
	readonly clock: FixedClock;
	readonly warren: FakeWarrenServer;
	readonly client: WarrenClient;
	readonly dispatcher: WarrenDispatcher;
	readonly campaign: CampaignRow;
	readonly workItem: WorkItemRow;
	readonly reservationId: string;
}

const ISSUE: IssueSnapshot = {
	number: 812,
	owner: "openclaw",
	repo: "openclaw",
	title: "Flaky scheduler test",
	body: "The scheduler test flakes on cold caches.",
	labels: ["bug"],
};

const REQUEST: WarrenDispatchRequestSpec = {
	project: "openclaw-contrib",
	agent: "pi",
	prompt: "Fix issue 812 end to end.",
	provider: "anthropic",
	model: "claude-sonnet-4-5",
	maxCostUsd: 5,
};

function harness(): Harness {
	const clock = new FixedClock(NOW);
	const store = new CampaignStateStore(":memory:", { clock, ids: new SequentialIdGenerator() });
	const warren = new FakeWarrenServer({ token: TOKEN });
	const client = new WarrenClient({
		baseUrl: "http://warren.test",
		token: TOKEN,
		fetchFn: warren.fetch,
		clock,
		sleep: async () => {},
	});
	const dispatcher = new WarrenDispatcher({
		store,
		client,
		ids: new SequentialIdGenerator(),
	});
	const imported = importCampaign(store, {
		manifest: signedManifest(),
		policy: basePolicy(),
		nowMs: NOW,
	});
	approveCampaign(store, {
		campaignId: imported.campaign.id,
		manifestDigest: imported.manifestDigest,
		approvedBy: "jayminwest",
		nowMs: NOW,
	});
	const admission = admitWorkItem(store, {
		campaignId: imported.campaign.id,
		issue: ISSUE,
		policy: basePolicy(),
		nowMs: NOW,
	});
	return {
		store,
		clock,
		warren,
		client,
		dispatcher,
		campaign: imported.campaign,
		workItem: admission.workItem,
		reservationId: admission.reservation.id,
	};
}

function postRequests(warren: FakeWarrenServer): number {
	return warren.recordedRequests().filter((req) => req.method === "POST" && req.path === "/runs")
		.length;
}

describe("WarrenDispatcher", () => {
	test("dispatches normally: intent before I/O, confirmed run correlated", async () => {
		const h = harness();
		const outcome = await h.dispatcher.dispatch({
			campaignId: h.campaign.id,
			workItemId: h.workItem.id,
			request: REQUEST,
			reservationId: h.reservationId,
		});
		expect(outcome.status).toBe("dispatched");
		expect(outcome.runId).not.toBeNull();
		expect(outcome.runState).toBe("queued");

		// The action was journaled with the exact request digest and the
		// idempotency key equals the deterministic action key.
		const action = h.store.actions.getActionByKey(
			`warren-dispatch:${h.campaign.id}:${h.workItem.id}:a1`,
		);
		expect(action).not.toBeNull();
		expect(action?.state).toBe("executing");
		expect(postRequests(h.warren)).toBe(1);
		const post = h.warren.recordedRequests().find((req) => req.method === "POST");
		expect(post?.headers["idempotency-key"]).toBe(action?.actionKey);
		expect(post?.body).toMatchObject({ project: "openclaw-contrib", agent: "pi" });

		// Run correlation is durable; work item progressed.
		expect(h.store.events.getRunLink(outcome.runId as string)?.actionId).toBe(action?.id);
		expect(h.store.campaigns.getWorkItem(h.workItem.id)?.status).toBe("running");

		// The admission reservation was attached to the action, not doubled.
		const reservations = h.store.budget.listReservations(h.campaign.id);
		expect(reservations).toHaveLength(1);
		expect(reservations[0]?.actionId).toBe(action?.id);
		expect(reservations[0]?.state).toBe("active");
		expect(reservations[0]?.amountUsdCents).toBe(500);
	});

	test("excludes a concurrent tick: the second dispatch never POSTs", async () => {
		const h = harness();
		const gate = Promise.withResolvers<void>();
		// First dispatch hangs inside the POST until the gate opens.
		const hangingFetch = async (
			url: string,
			init: { method: "GET" | "POST"; headers: Record<string, string>; body?: string },
		): Promise<Response> => {
			if (init.method === "POST") {
				await gate.promise;
			}
			return h.warren.fetch(url, init);
		};
		const hangingClient = new WarrenClient({
			baseUrl: "http://warren.test",
			token: TOKEN,
			fetchFn: hangingFetch,
			clock: h.clock,
			sleep: async () => {},
		});
		const dispatcherA = new WarrenDispatcher({
			store: h.store,
			client: hangingClient,
			ids: { newId: () => "tick-a" },
		});
		const first = dispatcherA.dispatch({
			campaignId: h.campaign.id,
			workItemId: h.workItem.id,
			request: REQUEST,
			reservationId: h.reservationId,
		});
		// Let dispatcherA reach and hold the POST.
		await Bun.sleep(10);
		const second = await h.dispatcher.dispatch({
			campaignId: h.campaign.id,
			workItemId: h.workItem.id,
			request: REQUEST,
			reservationId: h.reservationId,
		});
		expect(second.status).toBe("excluded");
		expect(postRequests(h.warren)).toBe(0);
		gate.resolve();
		const firstOutcome = await first;
		expect(firstOutcome.status).toBe("dispatched");
		expect(postRequests(h.warren)).toBe(1);
	});

	test("accepted-response-loss fails closed: uncertain, attention, no retry", async () => {
		const h = harness();
		h.warren.dropNextResponses(1);
		const outcome = await h.dispatcher.dispatch({
			campaignId: h.campaign.id,
			workItemId: h.workItem.id,
			request: REQUEST,
			reservationId: h.reservationId,
		});
		expect(outcome.status).toBe("dispatch_uncertain");
		// The server DID create the run — the client just never learned it.
		expect(h.warren.createdRunCount()).toBe(1);

		const action = h.store.actions.listActionsForWorkItem(h.workItem.id)[0] as ActionAssert;
		expect(action.state).toBe("uncertain");
		expect(action.errorClass).toBe("ambiguous_response");
		expect(h.store.campaigns.getWorkItem(h.workItem.id)?.status).toBe("dispatch_uncertain");
		const attention = h.store.events.listOpenAttention(h.campaign.id);
		expect(attention).toHaveLength(1);
		expect(attention[0]?.reason).toBe("dispatch_uncertain");

		// The reservation stays conservatively active.
		expect(h.store.budget.listReservations(h.campaign.id)[0]?.state).toBe("active");
	});

	test("settles resultBranch from the composed run branch when no targetBranch override exists (warren-5255)", async () => {
		const h = harness();
		const outcome = await h.dispatcher.dispatch({
			campaignId: h.campaign.id,
			workItemId: h.workItem.id,
			request: REQUEST,
			reservationId: h.reservationId,
		});
		const runId = outcome.runId as string;
		// The live-bug shape: a default dispatch has no targetBranch override;
		// warren serves only the composed `branch` (warren-5255).
		h.warren.setRunState(runId, {
			state: "succeeded",
			costUsd: 0.55,
			branch: "burrow/run_seq-1",
		});
		const reconciled = await h.dispatcher.reconcileRun(runId);
		expect(reconciled.terminal).toBe(true);
		expect(reconciled.branch).toBe("burrow/run_seq-1");
		const action = h.store.actions.listActionsForWorkItem(h.workItem.id)[0] as ActionAssert;
		expect(action.state).toBe("succeeded");
		expect(action.resultBranch).toBe("burrow/run_seq-1");
	});

	test("restart with a known run resumes reads and settles terminal cost", async () => {
		const h = harness();
		const outcome = await h.dispatcher.dispatch({
			campaignId: h.campaign.id,
			workItemId: h.workItem.id,
			request: REQUEST,
			reservationId: h.reservationId,
		});
		const runId = outcome.runId as string;
		// Simulate a controller restart: fresh dispatcher, same store, fake
		// warren keeps the run (its idempotency store is irrelevant now).
		h.warren.restart();
		h.warren.setRunState(runId, {
			state: "succeeded",
			costUsd: 1.25,
			targetBranch: "warren/run_seq-1",
		});
		const dispatcher = new WarrenDispatcher({
			store: h.store,
			client: h.client,
			ids: new SequentialIdGenerator(),
		});
		const restart = await dispatcher.reconcileAfterRestart();
		expect(restart.failClosed).toHaveLength(0);
		expect(restart.resumedRuns).toHaveLength(1);
		expect(restart.resumedRuns[0]?.runId).toBe(runId);
		expect(restart.resumedRuns[0]?.terminal).toBe(true);
		expect(restart.resumedRuns[0]?.settledNow).toBe(true);
		expect(restart.resumedRuns[0]?.branch).toBe("warren/run_seq-1");

		// Terminal success records the pushed branch/ref on the action.
		const action = h.store.actions.listActionsForWorkItem(h.workItem.id)[0] as ActionAssert;
		expect(action.state).toBe("succeeded");
		expect(action.resultBranch).toBe("warren/run_seq-1");
		expect(h.store.campaigns.getWorkItem(h.workItem.id)?.status).toBe("terminal");

		// Actual cost replaced the reservation.
		const reservation = h.store.budget.listReservations(h.campaign.id)[0];
		expect(reservation?.state).toBe("settled");
		expect(reservation?.settledUsdCents).toBe(125);
		// No second POST ever happened.
		expect(postRequests(h.warren)).toBe(1);
	});

	test("restart with an unknown run fails closed without any POST", async () => {
		const h = harness();
		// Crash between the intent transaction and a confirmed response:
		// replan the action directly, as a crashed process would leave it.
		const action = h.store.transaction(() =>
			h.store.actions.beginAction({
				actionKey: `warren-dispatch:${h.campaign.id}:${h.workItem.id}:a1`,
				campaignId: h.campaign.id,
				workItemId: h.workItem.id,
				actionType: "warren_dispatch",
				requestDigest: "0".repeat(64),
				policyDigest: h.campaign.policyDigest,
				attempt: 1,
			}),
		);
		h.store.actions.markExecuting(action.id);
		h.store.campaigns.setWorkItemStatus(h.workItem.id, "dispatch_intent");

		const restart = await h.dispatcher.reconcileAfterRestart();
		expect(restart.failClosed).toHaveLength(1);
		expect(restart.failClosed[0]?.actionId).toBe(action.id);
		expect(postRequests(h.warren)).toBe(0);

		const settled = h.store.actions.getAction(action.id) as ActionAssert;
		expect(settled.state).toBe("uncertain");
		expect(settled.errorClass).toBe("ambiguous_response");
		expect(h.store.campaigns.getWorkItem(h.workItem.id)?.status).toBe("dispatch_uncertain");
		expect(h.store.events.listOpenAttention(h.campaign.id)[0]?.reason).toBe("dispatch_uncertain");
	});

	test("terminal failure records the structured outcome without advancing", async () => {
		const h = harness();
		const outcome = await h.dispatcher.dispatch({
			campaignId: h.campaign.id,
			workItemId: h.workItem.id,
			request: REQUEST,
			reservationId: h.reservationId,
		});
		const runId = outcome.runId as string;
		h.warren.setRunState(runId, {
			state: "failed",
			failureReason: "provider_error",
			costUsd: 0.5,
		});
		const result = await h.dispatcher.reconcileRun(runId);
		expect(result.terminal).toBe(true);
		expect(result.settledNow).toBe(true);
		const action = h.store.actions.listActionsForWorkItem(h.workItem.id)[0] as ActionAssert;
		expect(action.state).toBe("permanent_failure");
		expect(action.errorClass).toBe("run_failed");
		expect(JSON.parse(action.errorJson as string)).toEqual({
			runState: "failed",
			failureReason: "provider_error",
		});
		expect(h.store.campaigns.getWorkItem(h.workItem.id)?.status).toBe("failed");
		// Known failure cost still settles the ledger.
		expect(h.store.budget.listReservations(h.campaign.id)[0]?.settledUsdCents).toBe(50);
	});

	test("unknown terminal cost keeps the conservative reservation", async () => {
		const h = harness();
		const outcome = await h.dispatcher.dispatch({
			campaignId: h.campaign.id,
			workItemId: h.workItem.id,
			request: REQUEST,
			reservationId: h.reservationId,
		});
		h.warren.setRunState(outcome.runId as string, {
			state: "succeeded",
			costUsd: null,
			targetBranch: "warren/run_seq-1",
		});
		const result = await h.dispatcher.reconcileRun(outcome.runId as string);
		expect(result.terminal).toBe(true);
		expect(result.costUsdCents).toBeNull();
		const reservation = h.store.budget.listReservations(h.campaign.id)[0];
		expect(reservation?.state).toBe("active");
		expect(reservation?.amountUsdCents).toBe(500);
		// The work item still reached terminal; only the ledger waits.
		expect(h.store.campaigns.getWorkItem(h.workItem.id)?.status).toBe("terminal");
	});

	test("an uncertain action is never re-dispatched, even after restart", async () => {
		const h = harness();
		h.warren.dropNextResponses(1);
		await h.dispatcher.dispatch({
			campaignId: h.campaign.id,
			workItemId: h.workItem.id,
			request: REQUEST,
			reservationId: h.reservationId,
		});
		expect(postRequests(h.warren)).toBe(1);

		// Restart reconciliation is a no-op read path (already settled).
		const restart = await h.dispatcher.reconcileAfterRestart();
		expect(restart.failClosed).toHaveLength(0);
		expect(postRequests(h.warren)).toBe(1);

		// A second dispatch attempt on the uncertain work item refuses.
		await expect(
			h.dispatcher.dispatch({
				campaignId: h.campaign.id,
				workItemId: h.workItem.id,
				request: REQUEST,
			}),
		).rejects.toThrow(StateError);
		expect(postRequests(h.warren)).toBe(1);

		// Restarting the controller changes nothing: fail closed persists.
		const dispatcher = new WarrenDispatcher({
			store: h.store,
			client: h.client,
			ids: new SequentialIdGenerator(),
		});
		await expect(
			dispatcher.dispatch({
				campaignId: h.campaign.id,
				workItemId: h.workItem.id,
				request: REQUEST,
			}),
		).rejects.toThrow(StateError);
		expect(postRequests(h.warren)).toBe(1);
	});

	test("reconcile of a non-terminal run is a pure idempotent read", async () => {
		const h = harness();
		const outcome = await h.dispatcher.dispatch({
			campaignId: h.campaign.id,
			workItemId: h.workItem.id,
			request: REQUEST,
			reservationId: h.reservationId,
		});
		const first = await h.dispatcher.reconcileRun(outcome.runId as string);
		expect(first.terminal).toBe(false);
		const second = await h.dispatcher.reconcileRun(outcome.runId as string);
		expect(second.terminal).toBe(false);
		expect(h.store.budget.listReservations(h.campaign.id)[0]?.state).toBe("active");
		expect(postRequests(h.warren)).toBe(1);
	});
});

/** Test-local narrowing of the action row. */
interface ActionAssert {
	readonly id: string;
	readonly state: string;
	readonly errorClass: string | null;
	readonly errorJson: string | null;
	readonly resultBranch: string | null;
}
