/**
 * Body-refresh e2e vertical slice (warren-09d2, plan pl-096b phase 3).
 *
 * One deterministic scenario proves the mutation end to end over the real
 * store, the real read-only GitHub client, and the real policy-gated PR
 * updater transport (with an injected fetch):
 *
 * 1. a terminal work item whose PR identity exists upstream;
 * 2. a follow-up lands — a settled followUpPush intent plus a succeeded
 *    warren run on the existing PR head branch;
 * 3. a safe read of the live body shows no divergence from the last
 *    rendered state;
 * 4. the controller renders the refreshed body from the profile contract
 *    (new evidence, response-summary titles, cleared known-gap slot),
 *    journals the PATCH intent planned with its digest BEFORE the request,
 *    and executes exactly once through the policy-gated updater;
 * 5. a hand-edited live body on a later refresh raises durable attention
 *    and refuses to clobber — until an operator override.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FixedClock, SequentialIdGenerator } from "../clock.ts";
import { canonicalJson, sha256Hex } from "../digest.ts";
import { WARREN_DISPATCH_ACTION_TYPE } from "../dispatch/dispatcher.ts";
import { ReadOnlyGithubClient } from "../github/client.ts";
import { FakeGithubServer } from "../github/fake-server.ts";
import type { FetchLike } from "../github/http-transport.ts";
import {
	BunFetchGithubPrUpdater,
	type MutationIntent,
	type MutationTransportOptions,
	renderFollowUpPushIntent,
} from "../github/pr-mutations.ts";
import {
	BODY_REFRESH_DIVERGED_REASON,
	executeJournaledBodyRefresh,
	renderAndJournalBodyRefresh,
	renderRefreshedPrBody,
} from "../pr-execute/body-refresh.ts";
import {
	FOLLOW_UP_PUSH_ACTION_TYPE,
	journalMutationIntent,
} from "../pr-execute/mutation-journal.ts";
import { loadDefaultPrBodyContract, type PrBodyFacts, renderPrBody } from "../pr-intent/pr-body.ts";
import type { RepositoryPolicy } from "../repository-policy.ts";
import { validateRepositoryPolicy } from "../repository-policy.ts";
import { CampaignStateStore } from "../store/state-store.ts";

const NOW = Date.parse("2026-08-26T00:00:00.000Z");
const UPSTREAM = { owner: "openclaw", repo: "openclaw" };
const FORK_BRANCH = "warren/issue-812";
const PR_NUMBER = 7;
const COMMITTED_POLICY = JSON.parse(
	readFileSync(
		join(import.meta.dir, "..", "..", "profiles", "openclaw.repository-policy.json"),
		"utf8",
	),
) as Record<string, unknown>;

const BASE_FACTS: PrBodyFacts = {
	campaignId: "camp-e2e",
	agent: "pi",
	provider: "anthropic",
	model: "claude-sonnet-4-5",
	approvedBy: "jayminwest",
	runId: "run_1111",
	branch: FORK_BRANCH,
	forkOwner: "warren-run-bot",
	issueNumber: 812,
	problem: "The scheduler test flakes on cold caches.",
	solution: "Seed the scheduler's deterministic clock in the test setup.",
	userImpact: "Contributors see stable CI results for scheduler changes.",
	evidence: ["bun test src/scheduler.test.ts — 42 passing, 0 failing"],
	evidenceTier: "external-proof-required",
	knownGap: "A staging-cluster soak run must prove no scheduler drift; an operator will attach it.",
	operatorNotes: "Reviewed during the 2026-08-25 EOD dry-run session.",
};

const RESPONSE_SUMMARY_HEADING = loadDefaultPrBodyContract().sections.find(
	(section) => section.key === "responseSummary",
)?.heading as string;

const KNOWN_GAP_HEADING = loadDefaultPrBodyContract().sections.find(
	(section) => section.key === "knownGap",
)?.heading as string;

const REFRESH = {
	followUpRunId: "run_2222",
	newEvidence: ["bun test src/scheduler.test.ts — 44 passing, 0 failing (follow-up)"],
	addressedFindings: ["Seed the clock in beforeAll, not per-test"],
	knownGap: null,
};

/** The committed policy, with only the two response-loop flags opened. */
function policyWith(updatePullRequest: boolean, followUpPush: boolean): RepositoryPolicy {
	const raw = {
		...(COMMITTED_POLICY as Record<string, unknown>),
		mutations: {
			createPullRequest: false,
			followUpPush,
			updatePullRequest,
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
	return validateRepositoryPolicy(raw, { nowMs: NOW }).policy;
}

function requireAction(id: string): NonNullable<ReturnType<typeof h.store.actions.getAction>> {
	const row = h.store.actions.getAction(id);
	if (row === null) throw new Error(`missing action row ${id}`);
	return row;
}

interface RecordedPatch {
	readonly method: string;
	readonly path: string;
	readonly body: unknown;
}

interface Harness {
	readonly store: CampaignStateStore;
	readonly github: FakeGithubServer;
	readonly client: ReadOnlyGithubClient;
	readonly patches: RecordedPatch[];
	readonly setPrBody: (body: string) => void;
	updater(): BunFetchGithubPrUpdater;
}

function boot(dbPath: string, initialBody: string): Harness {
	const clock = new FixedClock(NOW);
	const ids = new SequentialIdGenerator();
	const store = new CampaignStateStore(dbPath, { clock, ids });
	const github = new FakeGithubServer({ clock });
	const prResource = (body: string) => ({
		node_id: "PR_7",
		number: PR_NUMBER,
		state: "open",
		draft: false,
		title: "Fix the flaky scheduler test (#812)",
		body,
		user: { login: "warren-run-bot" },
		head: {
			ref: FORK_BRANCH,
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
		created_at: "2026-08-26T00:00:00.000Z",
		updated_at: "2026-08-26T00:00:00.000Z",
		html_url: "https://github.com/openclaw/openclaw/pull/7",
	});
	github.setResource(
		`/repos/${UPSTREAM.owner}/${UPSTREAM.repo}/pulls/${PR_NUMBER}`,
		prResource(initialBody),
	);
	// Re-serve the PR with a different body (the hand-edited divergence case).
	const setPrBody = (body: string) =>
		github.setResource(
			`/repos/${UPSTREAM.owner}/${UPSTREAM.repo}/pulls/${PR_NUMBER}`,
			prResource(body),
		);
	const patches: RecordedPatch[] = [];
	const fetchImpl: FetchLike = async (input, init) => {
		const request = new Request(input as string, init);
		patches.push({
			method: request.method,
			path: new URL(request.url).pathname,
			body: request.method === "PATCH" ? JSON.parse(String(init?.body)) : null,
		});
		return new Response(JSON.stringify({ updated_at: "2026-08-26T01:00:00Z" }), { status: 200 });
	};
	return {
		store,
		github,
		client: new ReadOnlyGithubClient(github, { perPage: 5, maxPages: 1 }),
		patches,
		setPrBody,
		updater: () =>
			new BunFetchGithubPrUpdater({
				policy: policyWith(true, false),
				token: "gh-token",
				fetchImpl,
			} as MutationTransportOptions),
	};
}

let dir: string;
let h: Harness;
let campaignId: string;
let workItemId: string;
let lastRenderedBody: string;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "body-refresh-e2e-"));
	const contract = loadDefaultPrBodyContract();
	lastRenderedBody = renderPrBody(contract, BASE_FACTS);
	h = boot(join(dir, "state.db"), lastRenderedBody);
	campaignId = h.store.campaigns.createCampaign({
		manifestDigest: "digest-e2e",
		manifestJson: "{}",
		budgetCapUsdCents: 100_00,
	}).id;
	workItemId = h.store.campaigns.addWorkItem({
		campaignId,
		position: 1,
		issueRef: "812",
	}).id;
	h.store.campaigns.setWorkItemStatus(workItemId, "terminal");
});

afterEach(() => {
	h.store.close();
	rmSync(dir, { recursive: true, force: true });
});

/** The controller-owned pre-state: a succeeded run on the PR head branch. */
function seedOriginalRun(): void {
	const planned = journalMutationIntent(h.store, {
		actionKey: `warren-dispatch:${campaignId}:${workItemId}:1`,
		campaignId,
		workItemId,
		actionType: WARREN_DISPATCH_ACTION_TYPE,
		intent: { method: "POST", url: "http://warren.test/runs", body: {} } as MutationIntent,
	});
	h.store.actions.settleAction(planned.action.id, {
		state: "succeeded",
		resultRunId: "run_1111",
		resultBranch: FORK_BRANCH,
	});
	h.store.events.recordPrIdentity({
		campaignId,
		workItemId,
		upstreamOwner: UPSTREAM.owner,
		upstreamRepo: UPSTREAM.repo,
		forkOwner: "warren-run-bot",
		forkRepo: UPSTREAM.repo,
		headBranch: FORK_BRANCH,
		title: "Fix the flaky scheduler test (#812)",
		bodyDigest: sha256Hex(lastRenderedBody),
		prNumber: PR_NUMBER,
		prUrl: "https://github.com/openclaw/openclaw/pull/7",
	});
}

/** The follow-up lands: push settled, then a second succeeded run on the same branch. */
function seedLandedFollowUp(): void {
	const push = journalMutationIntent(h.store, {
		actionKey: `follow-up-push:${campaignId}:${workItemId}`,
		campaignId,
		workItemId,
		actionType: FOLLOW_UP_PUSH_ACTION_TYPE,
		intent: renderFollowUpPushIntent({
			forkOwner: "warren-run-bot",
			forkRepo: UPSTREAM.repo,
			headBranch: FORK_BRANCH,
			refspec: `HEAD:refs/heads/${FORK_BRANCH}`,
		}),
		policyDigest: "policy-digest",
	});
	h.store.actions.settleAction(push.action.id, { state: "succeeded", resultBranch: FORK_BRANCH });
	const run = journalMutationIntent(h.store, {
		actionKey: `warren-dispatch:${campaignId}:${workItemId}:2`,
		campaignId,
		workItemId,
		actionType: WARREN_DISPATCH_ACTION_TYPE,
		intent: { method: "POST", url: "http://warren.test/runs", body: {} } as MutationIntent,
	});
	h.store.actions.settleAction(run.action.id, {
		state: "succeeded",
		resultRunId: "run_2222",
		resultBranch: FORK_BRANCH,
	});
}

async function readLiveBody(): Promise<string | null> {
	const read = await h.client.getPullRequest(UPSTREAM.owner, UPSTREAM.repo, PR_NUMBER);
	if (read.notModified || read.data === undefined) return null;
	return read.data.body;
}

function refreshInput(liveBody: string | null, operatorOverride?: boolean) {
	return {
		campaignId,
		workItemId,
		prNumber: PR_NUMBER,
		upstreamOwner: UPSTREAM.owner,
		upstreamRepo: UPSTREAM.repo,
		contract: loadDefaultPrBodyContract(),
		baseFacts: BASE_FACTS,
		refresh: REFRESH,
		lastRenderedBody,
		liveBody,
		operatorOverride,
		policyDigest: "policy-digest",
	};
}

describe("body refresh e2e (warren-09d2)", () => {
	test("a completed follow-up run drives a journaled, exactly-once body update", async () => {
		seedOriginalRun();
		seedLandedFollowUp();

		// Safe read: the live body still matches the last rendered state.
		const liveBody = await readLiveBody();
		expect(liveBody).toBe(lastRenderedBody);

		const journaled = renderAndJournalBodyRefresh({ store: h.store }, refreshInput(liveBody));
		expect(journaled.status).toBe("rendered");
		if (journaled.status !== "rendered") throw new Error("unreachable");

		// The PATCH intent was journaled planned with its digest BEFORE any I/O.
		const row = h.store.actions.getAction(journaled.actionId);
		expect(row?.state).toBe("planned");
		expect(row?.requestDigest).toBe(sha256Hex(canonicalJson(journaled.intent)));
		expect(h.patches).toHaveLength(0);

		// Exactly one PATCH through the policy-gated transport.
		const outcome = await executeJournaledBodyRefresh(
			h.store,
			{ campaignId, action: requireAction(journaled.actionId), intent: journaled.intent },
			h.updater(),
		);
		expect(outcome.status).toBe("succeeded");
		expect(h.patches).toHaveLength(1);
		expect(h.patches[0]).toMatchObject({
			method: "PATCH",
			path: `/repos/${UPSTREAM.owner}/${UPSTREAM.repo}/pulls/${PR_NUMBER}`,
		});
		const patched = h.patches[0]?.body as { body: string };
		// Refreshed content: follow-up evidence, response summary, cleared gap.
		expect(patched.body).toContain(
			"- bun test src/scheduler.test.ts — 44 passing, 0 failing (follow-up)",
		);
		expect(patched.body).toContain("- Seed the clock in beforeAll, not per-test");
		expect(patched.body).toContain(`## ${RESPONSE_SUMMARY_HEADING}`);
		expect(patched.body).toContain("run_2222");
		expect(patched.body).not.toContain(KNOWN_GAP_HEADING);
		// Untouched contract regions survive byte for byte.
		expect(patched.body).toContain(BASE_FACTS.problem);

		const settled = h.store.actions.getAction(journaled.actionId);
		expect(settled?.state).toBe("succeeded");

		// Idempotent re-drive: same facts re-render the same body, report the
		// settled standing, and never re-PATCH.
		const replay = renderAndJournalBodyRefresh({ store: h.store }, refreshInput(liveBody));
		expect(replay.status).toBe("already_settled");
		const again = await executeJournaledBodyRefresh(
			h.store,
			{
				campaignId,
				action: requireAction(journaled.actionId),
				intent: journaled.intent,
			},
			h.updater(),
		);
		expect(again.status).toBe("already_settled");
		expect(h.patches).toHaveLength(1);
	});

	test("a hand-edited live body raises attention and refuses without an operator override", async () => {
		seedOriginalRun();
		seedLandedFollowUp();
		const handEdited = `${lastRenderedBody}\n\n(someone edited this)`;
		h.setPrBody(handEdited);

		// The divergence convention: the pre-state would still re-render
		// deterministically to the last body, and the live read diverges.
		const liveBody = await readLiveBody();
		const refused = renderAndJournalBodyRefresh({ store: h.store }, refreshInput(liveBody));
		expect(refused.status).toBe("diverged_refused");
		const attention = h.store.events.listOpenAttention(campaignId);
		expect(attention).toHaveLength(1);
		expect(attention[0]?.reason).toBe(BODY_REFRESH_DIVERGED_REASON);
		expect(h.patches).toHaveLength(0);

		// The operator flag unblocks the clobber, and the update lands.
		const overridden = renderAndJournalBodyRefresh(
			{ store: h.store },
			refreshInput(liveBody, true),
		);
		expect(overridden.status).toBe("rendered");
		if (overridden.status !== "rendered") throw new Error("unreachable");
		const outcome = await executeJournaledBodyRefresh(
			h.store,
			{
				campaignId,
				action: requireAction(overridden.actionId),
				intent: overridden.intent,
			},
			h.updater(),
		);
		expect(outcome.status).toBe("succeeded");
		expect(h.patches).toHaveLength(1);
		// The refreshed render is still deterministic against the base facts.
		expect(renderRefreshedPrBody(loadDefaultPrBodyContract(), BASE_FACTS, REFRESH)).toContain(
			BASE_FACTS.solution,
		);
	});
});
