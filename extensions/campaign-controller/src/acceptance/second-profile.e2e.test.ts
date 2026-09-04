/**
 * Second-profile proof (warren-c7f5, plan pl-096b capstone).
 *
 * One parameterized deterministic test drives the complete respond-
 * iterate-land loop against the fake GitHub and fake Warren servers for
 * BOTH committed profiles: openclaw and the non-openclaw meridian
 * profile. Every heading, bot login, marker, and command comes from the
 * committed profile data via the shared harness (second-profile-
 * helpers.ts); this file inlines none of it.
 *
 * Structural probes (bottom describe): the committed profiles ship
 * every mutation flag false, a disabled followUpPush refuses the
 * coordinator before any store or client access, and each mutation
 * transport refuses to CONSTRUCT under the default all-false policy —
 * a disabled flag is structurally impossible, not skipped at runtime.
 */
import { describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import {
	FollowUpCoordinator,
	findingsFingerprint,
	UNTRUSTED_FINDINGS_BANNER,
} from "../follow-up/coordinator.ts";
import {
	executeJournaledBodyRefresh,
	renderAndJournalBodyRefresh,
} from "../pr-execute/body-refresh.ts";
import { postReReviewCommandComment } from "../pr-execute/post-comment.ts";
import { validateBotGrammar } from "../reconcile/bot-grammar.ts";
import { UpstreamPrReconciler } from "../reconcile/reconciler.ts";
import { buildCampaignReport } from "../report/report.ts";
import { runTick } from "../tick/tick.ts";
import {
	baseFacts,
	boot,
	committedProfile,
	FIXTURES,
	HEAD_SHA,
	mutationTransports,
	NOW,
	type ProfileFixture,
	policyWithFlags,
	seedPr,
} from "./second-profile-helpers.ts";

interface StageLike {
	readonly stage: string;
	readonly status: string;
	readonly detail?: unknown;
}

function stage(tick: { stages: readonly StageLike[] }, name: string): StageLike {
	const found = tick.stages.find((entry) => entry.stage === name);
	if (found === undefined) throw new Error(`no ${name} stage in the tick result`);
	return found;
}

/** The classified finding titles for one work item, from durable feedback rows. */
function classifiedTitles(f: ProfileFixture, h: ReturnType<typeof boot>): string[] {
	const row = h.store.events
		.listFeedback(h.campaignId)
		.find((entry) => entry.workItemId === h.workItemId && entry.category === "review_bot_findings");
	if (row === undefined) throw new Error("no review_bot_findings feedback row");
	const fields = JSON.parse(row.fieldsJson) as { findings: { value: unknown } };
	const list = (Array.isArray(fields.findings) ? fields.findings : fields.findings.value) as {
		title: { value: string };
	}[];
	const titles = list.map((entry) => entry.title.value);
	expect(titles).toContain(f.findingTitle);
	return titles;
}

async function reconcile(h: ReturnType<typeof boot>, f: ProfileFixture) {
	const reconciler = new UpstreamPrReconciler({
		client: h.deps.github,
		store: h.store,
		clock: h.deps.clock,
	});
	return await reconciler.reconcile({
		campaignId: h.campaignId,
		workItemId: h.workItemId,
		upstreamOwner: f.owner,
		upstreamRepo: f.repo,
		prNumber: 7,
		botLogin: f.forkOwner,
		botGrammar: h.grammar,
	});
}

/** The full PR resource with an optional merge timestamp (fake-server shape). */
function prResource(f: ProfileFixture, body: string, mergedAt: string | null) {
	return {
		node_id: "PR_7",
		number: 7,
		state: mergedAt === null ? "open" : "closed",
		draft: false,
		title: `Fix issue ${f.issue}`,
		body,
		user: { login: f.forkOwner },
		head: {
			ref: f.branch,
			sha: HEAD_SHA,
			repo: { full_name: `${f.forkOwner}/${f.repo}` },
		},
		base: {
			ref: "main",
			sha: "def456def456def456def456def456def456def4",
			repo: { full_name: `${f.owner}/${f.repo}` },
		},
		merged_at: mergedAt,
		closed_at: mergedAt,
		created_at: "2026-08-26T00:00:00.000Z",
		updated_at: "2026-08-26T04:00:00.000Z",
		html_url: `https://github.com/${f.owner}/${f.repo}/pull/7`,
	};
}

/**
 * Tickets 7-9 of the loop: flip the checks green (the failing-check
 * attention auto-resolves against the passing evidence), merge the PR
 * (the terminal outcome records exactly once), then assert the terminal
 * accounting: one opened, one merged, the follow-up settled, and the
 * campaign spend = initial run + follow-up, i.e. cost per merged PR.
 */
async function settleMergeAndAccount(
	h: ReturnType<typeof boot>,
	f: ProfileFixture,
	patchedBody: string,
	followUp: { actionId: string | null; runId: string | null },
): Promise<void> {
	const base = `/repos/${f.owner}/${f.repo}`;
	const greenRuns = {
		total_count: 1,
		check_runs: [
			{
				node_id: "CR_1",
				id: 1,
				name: `${f.profileId}/ci-gate`,
				status: "completed",
				conclusion: "success",
				started_at: "2026-08-26T03:00:00.000Z",
				completed_at: "2026-08-26T03:01:00.000Z",
				details_url: null,
				html_url: `${base}/pull/7/checks`,
			},
		],
	};
	h.github.mutateResource(`${base}/commits/${HEAD_SHA}/check-runs`, greenRuns);
	h.github.mutateResource(`${base}/commits/${HEAD_SHA}/status`, {
		state: "success",
		total_count: 1,
		sha: HEAD_SHA,
		statuses: [{ context: `${f.profileId}/ci-gate`, state: "success", description: null }],
	});
	// Green checks auto-resolve the failing-check attention.
	const pass2 = await reconcile(h, f);
	expect(pass2.attentionResolved).toBeGreaterThan(0);
	expect(h.store.events.listOpenAttention(h.campaignId)).toHaveLength(0);

	// The PR merges; the terminal outcome records exactly once.
	h.github.mutateResource(
		`${base}/pulls/7`,
		prResource(f, patchedBody, "2026-08-26T04:00:00.000Z"),
	);
	const pass3 = await reconcile(h, f);
	expect(pass3.terminalOutcome).toBe("merged");
	const item = h.store.campaigns.listWorkItems(h.campaignId)[0];
	expect(item?.outcome).toBe("merged");
	expect(item?.status).toBe("merged");

	// Terminal accounting: cost per merged PR covers initial run + follow-up.
	const report = buildCampaignReport(h.store, h.campaignId);
	expect(report.prsOpened).toBe(1);
	expect(report.prsMerged).toBe(1);
	expect(report.prsClosedUnmerged).toBe(0);
	// The follow-up iteration exists as a settled follow-up action.
	const followUpActions = h.store.actions
		.listActionsForWorkItem(h.workItemId)
		.filter((entry) => entry.actionType === "follow_up_run");
	expect(followUpActions).toHaveLength(1);
	expect(followUpActions[0]?.state).toBe("succeeded");
	void followUp;
	expect(report.totalSpendUsdCents).toBe(200);
	expect(report.costPerMergedPrUsdCents).toBe(200);
}

interface FollowUpLike {
	readonly status: string;
	readonly actionId: string | null;
	readonly runId: string | null;
	readonly feedbackIds: readonly string[];
}

/** Tickets 1-2: dispatch the initial run, settle it, render the PR intent. */
async function dispatchAndRenderBody(
	h: ReturnType<typeof boot>,
	f: ProfileFixture,
): Promise<{ runId: string; prBody: string }> {
	const tick1 = await runTick(h.deps, h.campaignId);
	const dispatch = stage(tick1, "dispatch");
	expect(dispatch.status).toBe("dispatched");
	const runId = (dispatch.detail as { runId: string }).runId;
	expect(h.warren.getRunRow(runId)?.prompt).toContain(f.guidanceFragment);
	h.warren.setRunState(runId, {
		state: "succeeded",
		costUsd: 1.25,
		targetBranch: f.branch,
		branch: f.branch,
	});
	// Ticket 2: reconcile the run; render the profile-correct PR intent.
	const tick2 = await runTick(h.deps, h.campaignId);
	const prIntent = stage(tick2, "pr_intent");
	expect(prIntent.status).toBe("rendered");
	const prBody = (prIntent.detail as { request: { body: { body: string } } }).request.body.body;
	expect(prBody).toContain(f.uniqueHeading);
	expect(prBody).not.toContain(`## ${f.foreignHeading}`);
	expect(prBody).toContain(f.summary.problem);
	expect(prBody).toContain(runId);
	return { runId, prBody };
}

/** Ticket 3: link the PR identity, seed the PR plus one bot review comment, reconcile. */
async function ingestUpstreamFeedback(
	h: ReturnType<typeof boot>,
	f: ProfileFixture,
	prBody: string,
): Promise<string[]> {
	const intentAction = h.store.actions
		.listActionsForWorkItem(h.workItemId)
		.find((entry) => entry.actionType === "pr_intent");
	if (intentAction !== undefined && intentAction.state === "planned") {
		// The journaled pr_intent landed upstream (the linked identity below
		// proves it), so the planned intent row settles.
		h.store.actions.markExecuting(intentAction.id);
		h.store.actions.settleAction(intentAction.id, { state: "succeeded" });
	}
	h.store.events.recordPrIdentity({
		campaignId: h.campaignId,
		workItemId: h.workItemId,
		upstreamOwner: f.owner,
		upstreamRepo: f.repo,
		forkOwner: f.forkOwner,
		forkRepo: f.repo,
		headBranch: f.branch,
		prNumber: 7,
		prUrl: `https://github.com/${f.owner}/${f.repo}/pull/7`,
	});
	seedPr(f, h.github, prBody);
	const base = `/repos/${f.owner}/${f.repo}`;
	h.github.setPaginatedCollection(`${base}/issues/7/comments`, [
		{
			node_id: "IC_bot_1",
			id: 1,
			user: { login: f.botLogin },
			author_association: "NONE",
			body: f.botComment,
			created_at: "2026-08-26T02:00:00.000Z",
			updated_at: "2026-08-26T02:00:00.000Z",
			html_url: `${base}/issues/7#issuecomment-1`,
		},
	]);
	// Reconcile read-only: the profile grammar classifies the bot comment.
	const pass1 = await reconcile(h, f);
	expect(pass1.newEvents).toBeGreaterThan(0);
	expect(pass1.feedbackCreated).toBeGreaterThan(0);
	expect(pass1.attentionCreated).toBeGreaterThan(0);
	return classifiedTitles(f, h);
}

/** Ticket 4: dispatch the follow-up run onto the existing PR head branch. */
async function runFollowUp(
	h: ReturnType<typeof boot>,
	f: ProfileFixture,
	titles: readonly string[],
): Promise<FollowUpLike> {
	const { manifestRaw } = committedProfile(f);
	const budget = (manifestRaw as { budget: { perRunUsd: number } }).budget;
	const warren = (manifestRaw as { warren: { project: string; agent: string } }).warren;
	const calls: { prompt: string; existingBranch: string }[] = [];
	const coordinator = new FollowUpCoordinator({
		store: {
			listFeedback: (cid) => h.store.events.listFeedback(cid),
			listActionsForWorkItem: (wid) => h.store.actions.listActionsForWorkItem(wid),
			beginAction: (input) => h.store.actions.beginAction(input),
			markExecuting: (id) => h.store.actions.markExecuting(id),
			settleAction: (id, input) => h.store.actions.settleAction(id, input),
			addAttention: (input) => h.store.events.addAttention(input),
			followUps: h.store.followUps,
		},
		dispatch: async (input) => {
			calls.push({ prompt: input.prompt, existingBranch: input.existingBranch });
			const view = await h.deps.warrenClient.dispatchRun(input);
			return { runId: view.id };
		},
	});
	const followUp = await coordinator.coordinate(
		{
			campaignId: h.campaignId,
			workItemId: h.workItemId,
			issueRef: String(f.issue),
			project: warren.project,
			agent: warren.agent,
			headBranch: f.branch,
			agentGuidance: undefined,
			maxCostUsd: budget.perRunUsd,
			budgetHeadroomUsdCents: h.store.budget.availableUsdCents(h.campaignId),
		},
		{ followUpPush: true },
	);
	expect(followUp.status).toBe("dispatched");
	expect(followUp.runId).not.toBeNull();
	expect(calls[0]?.existingBranch).toBe(f.branch);
	expect(calls[0]?.prompt).toContain(UNTRUSTED_FINDINGS_BANNER);
	expect(calls[0]?.prompt).toContain(f.findingTitle);
	h.warren.setRunState(followUp.runId as string, {
		state: "succeeded",
		costUsd: 0.75,
		targetBranch: f.branch,
		branch: f.branch,
	});
	h.store.actions.settleAction(followUp.actionId as string, {
		state: "succeeded",
		resultBranch: f.branch,
	});
	// The addressed findings freeze as the loop's responded fingerprint.
	const fingerprint = findingsFingerprint(
		h.store.events
			.listFeedback(h.campaignId)
			.filter((row) => (followUp.feedbackIds as readonly string[]).includes(row.id))
			.map((row) => ({
				feedbackId: row.id,
				category: row.category,
				fields: JSON.parse(row.fieldsJson) as Record<string, unknown>,
			})),
	);
	h.store.followUps.recordResponded({
		workItemId: h.workItemId,
		feedbackIds: [...followUp.feedbackIds],
		fingerprint,
	});
	// The follow-up's spend lands on the campaign ledger.
	const reservation = h.store.budget.reserve({
		campaignId: h.campaignId,
		actionId: followUp.actionId,
		amountUsdCents: 75,
	});
	h.store.budget.settleReservation(reservation.id, 75);
	expect(h.warren.createdRunCount()).toBe(2);
	expect(titles).toContain(f.findingTitle);
	return followUp;
}

/** Tickets 5-6: policy-gated body refresh, then the profile re-review command. */
async function refreshBodyAndPostReReview(
	h: ReturnType<typeof boot>,
	f: ProfileFixture,
	prBody: string,
	runId: string,
	followUp: FollowUpLike,
	titles: readonly string[],
): Promise<string> {
	// Ticket 5: body refresh through the policy-gated PATCH, still in the
	// profile contract — the other profile's heading never appears.
	const refreshTransports = mutationTransports(
		policyWithFlags(h.policy, { updatePullRequest: true }),
	);
	const live = await h.deps.github.getPullRequest(f.owner, f.repo, 7);
	const refreshed = renderAndJournalBodyRefresh(
		{ store: h.store },
		{
			campaignId: h.campaignId,
			workItemId: h.workItemId,
			prNumber: 7,
			upstreamOwner: f.owner,
			upstreamRepo: f.repo,
			contract: h.contract,
			baseFacts: baseFacts(f, h.campaignId, runId),
			refresh: {
				followUpRunId: followUp.runId,
				newEvidence: [`follow-up run ${followUp.runId} green on ${f.profileId} gates`],
				addressedFindings: [...titles],
				knownGap: null,
			},
			lastRenderedBody: prBody,
			liveBody: live.data?.body ?? null,
			policyDigest: "policy-digest",
		},
	);
	expect(refreshed.status).toBe("rendered");
	if (refreshed.status !== "rendered") throw new Error("unreachable");
	const action = h.store.actions.getAction(refreshed.actionId);
	if (action === null) throw new Error("missing body-refresh action row");
	const patch = await executeJournaledBodyRefresh(
		h.store,
		{ campaignId: h.campaignId, action, intent: refreshed.intent },
		refreshTransports.updater(),
	);
	expect(patch.status).toBe("succeeded");
	const patchCall = refreshTransports.calls.find(
		(entry) => entry.method === "PATCH" && entry.path === `/repos/${f.owner}/${f.repo}/pulls/7`,
	);
	if (patchCall === undefined) throw new Error("no PATCH call recorded");
	const patchedBody = (patchCall.body as { body: string }).body;
	expect(patchedBody).toContain(f.uniqueHeading);
	expect(patchedBody).toContain(followUp.runId as string);
	if (h.contract.sections.some((section) => section.key === "responseSummary")) {
		expect(patchedBody).toContain(f.findingTitle);
	} else {
		// No response-summary slot: the follow-up shows as new evidence.
		expect(patchedBody).toContain(`follow-up run ${followUp.runId} green on ${f.profileId} gates`);
	}
	expect(patchedBody).not.toContain(`## ${f.foreignHeading}`);
	// The refreshed body is live upstream for later reads.
	seedPr(f, h.github, patchedBody);

	// Ticket 6: the profile-declared re-review command posts once.
	const commentPolicy = policyWithFlags(h.policy, { postComment: true });
	const commentTransports = mutationTransports(commentPolicy);
	const reReview = await postReReviewCommandComment(
		{ store: h.store, poster: commentTransports.poster() },
		{
			campaignId: h.campaignId,
			workItemId: h.workItemId,
			cycleId: "cycle-1",
			policy: commentPolicy,
			policyDigest: "policy-digest",
			compose: {
				campaignId: h.campaignId,
				runId: followUp.runId as string,
				prNumber: 7,
				findingTitles: titles.map((value) => ({
					value,
					provenance: "untrusted" as const,
				})),
				evidenceLines: [`follow-up run ${followUp.runId} green`],
			},
			nowMs: NOW,
		},
		{ botGrammar: validateBotGrammar(h.grammar), precedingChangeLanded: true },
	);
	expect(reReview.status).toBe("posted");
	expect(reReview.commentId).toBe(4242);
	const commentCall = commentTransports.calls.find(
		(entry) =>
			entry.method === "POST" && entry.path === `/repos/${f.owner}/${f.repo}/issues/7/comments`,
	);
	if (commentCall === undefined) throw new Error("no comment POST recorded");
	expect(JSON.stringify(commentCall.body)).toContain(f.reReviewCommand);
	return patchedBody;
}

describe("second-profile respond-iterate-land loop", () => {
	for (const f of FIXTURES) {
		test(`full loop with profile-correct bodies, grammar, accounting (${f.profileId})`, async () => {
			const h = boot(f);
			try {
				// Tickets 1-2: dispatch, settle, render the profile-correct body.
				const { runId, prBody } = await dispatchAndRenderBody(h, f);
				// Ticket 3: ingest and classify the profile-grammar bot review.
				const titles = await ingestUpstreamFeedback(h, f, prBody);
				// Ticket 4: follow-up run on the existing PR head branch.
				const followUp = await runFollowUp(h, f, titles);
				// Tickets 5-6: body refresh + profile re-review command.
				const patchedBody = await refreshBodyAndPostReReview(h, f, prBody, runId, followUp, titles);
				// Tickets 7-9: green checks, merge, terminal accounting.
				await settleMergeAndAccount(h, f, patchedBody, followUp);
			} finally {
				h.store.close();
				rmSync(h.dir, { recursive: true, force: true });
			}
		});
	}
});
