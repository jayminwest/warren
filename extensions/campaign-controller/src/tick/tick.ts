/**
 * The composed dry-run tick (plan pl-91b6 step 10, warren-d050).
 *
 * One `runTick` call executes exactly one deterministic, bounded,
 * restart-safe reconciliation pass over one campaign, in the ordering the
 * seed fixes:
 *
 * 1. **lease** — claim `tick:<campaignId>`; a live lease refuses the tick
 *    (`TickConcurrentError`) instead of racing a second controller.
 * 2. **validate/admit** — each candidate work item is admitted through
 *    the immutable approval gate (issue state re-read from upstream).
 * 3. **reserve/journal + dispatch or reconcile** — admission's reservation
 *    and the deterministic `warren_dispatch` action commit inside
 *    `WarrenDispatcher` BEFORE the POST; known runs reconcile through safe
 *    reads instead. At most ONE new dispatch happens per tick, and the
 *    post-loop restart sweep resumes unreachable runs and fails closed
 *    every unconfirmed dispatch — never a re-POST.
 * 4. **render PR intent (+ optionally execute it)** — terminal work items
 *    with an operator-supplied summary render the exact cross-fork
 *    pull-request request and journal it as evidence. With no creator
 *    wired that is the whole stage (dry run, never posts). When the
 *    policy-gated creator exists (Phase 2, warren-84da) the journaled
 *    intent is then executed exactly once, with the dispatcher's
 *    response-loss discipline: uncertain settles, never re-POSTs.
 * 5. **read-only GitHub reconcile** — every PR identity with a known
 *    upstream PR number is reconciled read-only and deduplicated.
 * 6. **settle/report** — campaign status settles, and the tick returns the
 *    stage trace plus a budget/work-item/attention report.
 *
 * With no `prCreator` the tick is dry-run by construction: it composes the
 * already-approved lower-level modules and adds no mutation path. Every
 * outcome is a JSON-safe stage record so the CLI can emit NDJSON evidence.
 */
import { admitWorkItem } from "../admission.ts";
import { AdmissionRefusal } from "../admission-errors.ts";
import type { Clock, IdGenerator } from "../clock.ts";
import { WARREN_DISPATCH_ACTION_TYPE, WarrenDispatcher } from "../dispatch/dispatcher.ts";
import { CampaignControllerError, StateError, ValidationError } from "../errors.ts";
import type { ReadOnlyGithubClient } from "../github/client.ts";
import type { GithubPrCreateTransport } from "../github/pr-create.ts";
import type { GithubIssueSnapshot } from "../github/types.ts";
import type { CampaignManifest } from "../manifest.ts";
import { executeJournaledPrIntent } from "../pr-execute/executor.ts";
import {
	PrIntentRefusal,
	type PrIntentResult,
	type PrIntentSummaryFacts,
	type PrIntentUpstreamFacts,
	prIntentActionKey,
	prIntentMachineJson,
	renderAndJournalPrIntent,
} from "../pr-intent/intender.ts";
import type { ReviewBotGrammar } from "../reconcile/bot-grammar.ts";
import { UpstreamPrReconciler } from "../reconcile/reconciler.ts";
import type { RepositoryPolicy } from "../repository-policy.ts";
import { composeDispatchPrompt, validateRepositoryPolicy } from "../repository-policy.ts";
import type { CampaignStateStore } from "../store/state-store.ts";
import type { CampaignRow, CampaignStatus, WorkItemRow } from "../store/types.ts";
import { runPushedBranch, type WarrenClient } from "../warren-client.ts";

/** A concurrent tick holds the campaign lease. */
export class TickConcurrentError extends CampaignControllerError {
	constructor(campaignId: string, holder: string) {
		super(
			"tick_concurrent",
			`a tick is already running for campaign ${campaignId} (lease holder ${holder}); refusing to start a second tick`,
		);
		this.name = "TickConcurrentError";
	}
}

const DAY_MS = 86_400_000;
const DEFAULT_LEASE_TTL_MS = 60_000;

/** Work-item statuses that end a campaign's active work. */
const FINAL_WORK_ITEM_STATUSES: ReadonlySet<string> = new Set([
	"terminal",
	"completed",
	"failed",
	"cancelled",
]);

/** Work-item statuses that force the campaign to needs_attention. */
const ATTENTION_WORK_ITEM_STATUSES: ReadonlySet<string> = new Set([
	"needs_attention",
	"dispatch_uncertain",
]);

/** The fixed stage vocabulary of one tick, in execution order. */
export type TickStage =
	| "lease"
	| "admit"
	| "dispatch"
	| "reconcile_run"
	| "pr_intent"
	| "pr_execute"
	| "github_reconcile"
	| "settle";

/** One stage's outcome. All fields are JSON-safe and secret-free. */
export interface TickOutcome {
	readonly stage: TickStage;
	readonly workItemId: string | null;
	readonly status: string;
	readonly detail?: unknown;
}

export interface TickWorkItemSummary {
	readonly id: string;
	readonly issueRef: string;
	readonly position: number;
	readonly status: string;
}

export interface TickReport {
	readonly workItems: readonly TickWorkItemSummary[];
	readonly budget: {
		readonly capUsdCents: number | null;
		readonly availableUsdCents: number;
	};
	readonly openAttention: number;
}

export interface TickResult {
	readonly campaignId: string;
	/**
	 * False only when a policy-gated PR creator is wired (Phase 2,
	 * warren-84da): the one mutation the tick may then perform is executing
	 * a journaled cross-fork PR intent. Everything else stays read-only.
	 */
	readonly dryRun: boolean;
	readonly stages: readonly TickOutcome[];
	readonly restart: {
		readonly expiredLeases: number;
		readonly resumedRuns: number;
		readonly failClosed: number;
	};
	readonly report: TickReport;
	readonly campaignStatus: CampaignStatus;
}

export interface TickDeps {
	readonly store: CampaignStateStore;
	readonly warrenClient: WarrenClient;
	readonly github: ReadOnlyGithubClient;
	readonly clock: Clock;
	readonly ids: IdGenerator;
	/** The current repository-policy snapshot, re-validated at admission. */
	readonly policy: unknown;
	/**
	 * Profile-declared review-bot grammar (warren-8c83). Set from the loaded
	 * grammar file; absent means classification no-ops, exactly as before.
	 */
	readonly botGrammar?: ReviewBotGrammar | unknown;
	/** Operator-supplied change summaries, keyed by issue number. */
	readonly summaries: ReadonlyMap<number, PrIntentSummaryFacts>;
	/**
	 * The single policy-gated mutation (Phase 2, warren-84da). Wired only
	 * when the validated repository policy enables
	 * `mutations.createPullRequest` AND a GitHub credential exists; absent
	 * means the tick is dry-run by construction, exactly as V0 shipped.
	 */
	readonly prCreator?: GithubPrCreateTransport;
	/** Tick lease TTL. Default 60 000 ms. */
	readonly leaseTtlMs?: number;
}

interface WorkItemContext {
	readonly deps: TickDeps;
	readonly dispatcher: WarrenDispatcher;
	readonly campaign: CampaignRow;
	readonly manifest: CampaignManifest;
	readonly item: WorkItemRow;
	readonly nowMs: number;
	readonly alreadyDispatched: boolean;
}

/** Run one bounded dry-run tick over `campaignId`. */
export async function runTick(deps: TickDeps, campaignId: string): Promise<TickResult> {
	const campaign = deps.store.campaigns.getCampaign(campaignId);
	if (campaign === null) {
		throw new StateError(`unknown campaign: ${campaignId}`);
	}
	const manifest = parseManifest(campaign);
	const scope = `tick:${campaignId}`;
	const holder = `tick-${deps.ids.newId()}`;
	const ttlMs = deps.leaseTtlMs ?? DEFAULT_LEASE_TTL_MS;
	const lease = deps.store.leases.acquireLease(scope, holder, ttlMs);
	if (lease === null) {
		throw new TickConcurrentError(
			campaignId,
			deps.store.leases.getLease(scope)?.holder ?? "unknown",
		);
	}
	try {
		return await runLeasedTick(deps, campaign, manifest);
	} finally {
		deps.store.leases.releaseLease(scope, holder);
	}
}

/** The tick body, holding the campaign lease. */
async function runLeasedTick(
	deps: TickDeps,
	campaign: CampaignRow,
	manifest: CampaignManifest,
): Promise<TickResult> {
	const store = deps.store;
	const dispatcher = new WarrenDispatcher({
		store,
		client: deps.warrenClient,
		ids: deps.ids,
		leaseTtlMs: deps.leaseTtlMs,
	});
	const stages: TickOutcome[] = [{ stage: "lease", workItemId: null, status: "acquired" }];

	// Bounded: manifest issue lists are schema-capped, and at most one new
	// dispatch leaves this tick no matter how many items are admitted.
	let dispatchedThisTick = false;
	for (const item of store.campaigns.listWorkItems(campaign.id)) {
		const outcomes = await processWorkItem({
			deps,
			dispatcher,
			campaign,
			manifest,
			item,
			nowMs: deps.clock.nowMs(),
			alreadyDispatched: dispatchedThisTick,
		});
		stages.push(...outcomes);
		if (outcomes.some((outcome) => outcome.stage === "dispatch" && outcome.status !== "deferred")) {
			dispatchedThisTick = true;
		}
	}
	// Restart reconciliation: resume any run the loop could not reach and
	// fail closed every unconfirmed dispatch — never a re-POST.
	const restart = await dispatcher.reconcileAfterRestart();
	// A run the restart sweep just settled to terminal (warren-968d) reached
	// success AFTER the loop above processed its work item. Render its PR
	// intent NOW, before settleCampaign can complete the campaign — the
	// deterministic action key makes this pass idempotent, and it doubles as
	// the backfill for a campaign that already completed un-rendered.
	const intentRenderedFor = new Set(
		stages
			.filter((outcome) => outcome.stage === "pr_intent" && outcome.workItemId !== null)
			.map((outcome) => outcome.workItemId as string),
	);
	for (const item of store.campaigns.listWorkItems(campaign.id)) {
		if (item.status === "terminal" && !intentRenderedFor.has(item.id)) {
			stages.push(
				...(await intentThenMaybeExecute({
					deps,
					dispatcher,
					campaign,
					manifest,
					item,
					nowMs: deps.clock.nowMs(),
					alreadyDispatched: true,
				})),
			);
		}
	}
	stages.push(...(await reconcileUpstreamPrs(deps, campaign)));
	const campaignStatus = settleCampaign(store, campaign.id);
	return {
		campaignId: campaign.id,
		dryRun: deps.prCreator === undefined,
		stages,
		restart: {
			expiredLeases: restart.expiredLeases,
			resumedRuns: restart.resumedRuns.length,
			failClosed: restart.failClosed.length,
		},
		report: buildReport(store, campaign.id),
		campaignStatus,
	};
}

/** One work item's stage outcomes, by lifecycle state. */
async function processWorkItem(ctx: WorkItemContext): Promise<TickOutcome[]> {
	switch (ctx.item.status) {
		case "candidate":
			return admitAndDispatch(ctx);
		case "admitted":
			return [await dispatchOutcome(ctx, null)];
		case "dispatched":
		case "running":
			return reconcileThenMaybeIntent(ctx);
		case "dispatch_intent":
			// Restart reconciliation (which ran first) failed these closed;
			// if one survives mid-tick it is never re-POSTed here.
			return [{ stage: "dispatch", workItemId: ctx.item.id, status: "awaiting_restart_reconcile" }];
		case "terminal":
			return intentThenMaybeExecute(ctx);
		default:
			return [
				{
					stage: "settle",
					workItemId: ctx.item.id,
					status: "no_action",
					detail: { workItemStatus: ctx.item.status },
				},
			];
	}
}

/** Stage 2 + 3 for one candidate: admit, then (first per tick) dispatch. */
async function admitAndDispatch(ctx: WorkItemContext): Promise<TickOutcome[]> {
	if (ctx.alreadyDispatched) {
		return [{ stage: "admit", workItemId: ctx.item.id, status: "deferred" }];
	}
	const issueNumber = parseIssueRef(ctx.item);
	const snapshot = await readIssueSnapshot(ctx.deps.github, ctx.manifest, issueNumber);
	const issue = issueSnapshotOf(ctx.manifest, snapshot);
	try {
		const admission = admitWorkItem(ctx.deps.store, {
			campaignId: ctx.campaign.id,
			issue,
			policy: ctx.deps.policy,
			nowMs: ctx.nowMs,
		});
		ctx.deps.store.campaigns.setCampaignStatus(ctx.campaign.id, "running");
		return [
			{
				stage: "admit",
				workItemId: ctx.item.id,
				status: "admitted",
				detail: { issue: issueNumber, reservationId: admission.reservation.id },
			},
			await dispatchOutcome(ctx, admission.reservation.id),
		];
	} catch (error) {
		if (error instanceof AdmissionRefusal) {
			return [
				{
					stage: "admit",
					workItemId: ctx.item.id,
					status: "refused",
					detail: { issue: issueNumber, invariant: error.invariant, message: error.message },
				},
			];
		}
		throw error;
	}
}

/** Stage 3: reserve/journal/POST (or reconcile) one admitted work item. */
async function dispatchOutcome(
	ctx: WorkItemContext,
	reservationId: string | null,
): Promise<TickOutcome> {
	if (ctx.alreadyDispatched) {
		return { stage: "dispatch", workItemId: ctx.item.id, status: "deferred" };
	}
	const { manifest } = ctx;
	if (manifest.prompt === undefined) {
		return {
			stage: "dispatch",
			workItemId: ctx.item.id,
			status: "refused",
			detail: {
				reason: "prompt_digest_only",
				message:
					"the campaign manifest binds a prompt digest, not a prompt; dispatch needs the approved prompt text",
			},
		};
	}
	// The policy is re-validated at admission (warren-2a0a); for an item
	// dispatched in this tick that validation already succeeded with the
	// same clock, so re-validating here is deterministic and cheap. It is
	// what lets the guidance render from profile data without new state.
	let policy: RepositoryPolicy;
	try {
		policy = validateRepositoryPolicy(ctx.deps.policy, { nowMs: ctx.nowMs }).policy;
	} catch (error) {
		if (error instanceof ValidationError) {
			return {
				stage: "dispatch",
				workItemId: ctx.item.id,
				status: "refused",
				detail: {
					reason: "policy_revalidation_failed",
					message: error.message,
				},
			};
		}
		throw error;
	}
	const outcome = await ctx.dispatcher.dispatch({
		campaignId: ctx.campaign.id,
		workItemId: ctx.item.id,
		reservationId,
		request: {
			project: manifest.warren.project,
			agent: manifest.warren.agent,
			prompt: composeDispatchPrompt(manifest.prompt, policy),
			provider: manifest.warren.provider,
			model: manifest.warren.model,
			maxCostUsd: manifest.budget.perRunUsd,
		},
	});
	return {
		stage: "dispatch",
		workItemId: ctx.item.id,
		status: outcome.status,
		detail: {
			actionId: outcome.actionId,
			attempt: outcome.attempt,
			runId: outcome.runId,
			runState: outcome.runState,
			errorClass: outcome.errorClass,
			retryAfterMs: outcome.retryAfterMs,
		},
	};
}

/** Reconcile a known run; a fresh terminal settle renders the intent too. */
async function reconcileThenMaybeIntent(ctx: WorkItemContext): Promise<TickOutcome[]> {
	const outcome = await reconcileOutcome(ctx);
	if (outcome.status !== "reconciled") {
		return [outcome];
	}
	const refreshed = ctx.deps.store.campaigns.getWorkItem(ctx.item.id);
	if (refreshed?.status !== "terminal") {
		return [outcome];
	}
	return [outcome, ...(await intentThenMaybeExecute({ ...ctx, item: refreshed }))];
}

/** Reconcile one known run through authoritative reads. */
async function reconcileOutcome(ctx: WorkItemContext): Promise<TickOutcome> {
	const action = ctx.deps.store.actions
		.listActionsForWorkItem(ctx.item.id)
		.find(
			(candidate) =>
				candidate.actionType === WARREN_DISPATCH_ACTION_TYPE &&
				(candidate.state === "planned" || candidate.state === "executing"),
		);
	const link = action === undefined ? null : ctx.deps.store.events.getRunLinkByAction(action.id);
	if (link === null) {
		return { stage: "reconcile_run", workItemId: ctx.item.id, status: "no_run_link" };
	}
	const reconciled = await ctx.dispatcher.reconcileRun(link.runId);
	return {
		stage: "reconcile_run",
		workItemId: ctx.item.id,
		status: reconciled.terminal ? "reconciled" : "running",
		detail: {
			runId: reconciled.runId,
			runState: reconciled.runState,
			terminal: reconciled.terminal,
			settledNow: reconciled.settledNow,
			branch: reconciled.branch,
			costUsdCents: reconciled.costUsdCents,
		},
	};
}

/**
 * Stage 4 (+4b): render the cross-fork PR intent, then — ONLY when a
 * policy-gated creator is wired (Phase 2, warren-84da) — execute the
 * journaled intent through it. With no creator this is exactly the V0
 * dry-run stage: render, journal, never post.
 */
async function intentThenMaybeExecute(ctx: WorkItemContext): Promise<TickOutcome[]> {
	// A SETTLED intent action cannot re-render (the journal freezes terminal
	// rows), and with an executor wired it can settle: report its standing
	// instead. `planned` still re-renders below — that replay is the digest
	// stability check the dry run relies on.
	const settled = settledIntentOutcomes(ctx);
	if (settled !== null) {
		return settled;
	}
	const { outcome, result } = await intentOutcome(ctx);
	if (
		ctx.deps.prCreator === undefined ||
		result === null ||
		(outcome.status !== "rendered" && outcome.status !== "already_journaled")
	) {
		return [outcome];
	}
	const executed = await executeJournaledPrIntent(
		{ store: ctx.deps.store, github: ctx.deps.github, prCreator: ctx.deps.prCreator },
		{ campaign: ctx.campaign, manifest: ctx.manifest, intentResult: result },
	);
	return [
		outcome,
		{
			stage: "pr_execute",
			workItemId: ctx.item.id,
			status: executed.status,
			detail: { prNumber: executed.prNumber, prUrl: executed.prUrl },
		},
	];
}

/**
 * The standing of a pr_intent action that already settled (Phase 2 —
 * execution is what settles it). Null while the action is absent or still
 * `planned`, letting the render path run.
 */
function settledIntentOutcomes(ctx: WorkItemContext): TickOutcome[] | null {
	const action = ctx.deps.store.actions.getActionByKey(
		prIntentActionKey(ctx.campaign.id, ctx.item.id),
	);
	if (action === null || action.state === "planned" || action.state === "executing") {
		return null;
	}
	const intentOut: TickOutcome = {
		stage: "pr_intent",
		workItemId: ctx.item.id,
		status: "already_journaled",
		detail: { actionId: action.id, state: action.state },
	};
	if (ctx.deps.prCreator === undefined) {
		return [intentOut];
	}
	const status =
		action.state === "succeeded"
			? "already_executed"
			: action.state === "uncertain"
				? "uncertain_blocked"
				: "failed_blocked";
	const identity = ctx.deps.store.events
		.listPrIdentities(ctx.campaign.id)
		.find((row) => row.workItemId === ctx.item.id);
	return [
		intentOut,
		{
			stage: "pr_execute",
			workItemId: ctx.item.id,
			status,
			detail: {
				prNumber: action.resultPrNumber ?? identity?.prNumber ?? null,
				prUrl: identity?.prUrl ?? null,
			},
		},
	];
}

/** Stage 4: render (never post) the dry-run cross-fork PR intent. */
async function intentOutcome(
	ctx: WorkItemContext,
): Promise<{ outcome: TickOutcome; result: PrIntentResult | null }> {
	const issueNumber = parseIssueRef(ctx.item);
	// "completed" is admitted on purpose (warren-968d): a terminal-success
	// work item whose campaign settled completed before its intent rendered
	// backfills here idempotently on the next tick.
	if (
		ctx.campaign.status !== "approved" &&
		ctx.campaign.status !== "running" &&
		ctx.campaign.status !== "completed"
	) {
		return {
			outcome: {
				stage: "pr_intent",
				workItemId: ctx.item.id,
				status: "campaign_not_active",
				detail: { issue: issueNumber, campaignStatus: ctx.campaign.status },
			},
			result: null,
		};
	}
	const summary = ctx.deps.summaries.get(issueNumber);
	if (summary === undefined) {
		return {
			outcome: {
				stage: "pr_intent",
				workItemId: ctx.item.id,
				status: "skipped_no_summary",
				detail: { issue: issueNumber },
			},
			result: null,
		};
	}
	// warren-5255: a dispatch that settled against a warren predating the
	// run-wire `branch` field journaled result_branch null. Re-read the run
	// (a safe, retryable GET — the same class reconciliation uses) and
	// backfill so the intent can derive its cross-fork head ref.
	await backfillDispatchBranch(ctx);
	const issue = await readIssueSnapshot(ctx.deps.github, ctx.manifest, issueNumber);
	const upstream = await readUpstreamFacts(ctx.deps, ctx.manifest);
	try {
		const result = renderAndJournalPrIntent(ctx.deps.store, {
			campaignId: ctx.campaign.id,
			workItemId: ctx.item.id,
			issue: { number: issue.number, state: issue.state, title: issue.title },
			summary,
			upstream,
			policy: ctx.deps.policy,
			nowMs: ctx.nowMs,
		});
		return {
			outcome: {
				stage: "pr_intent",
				workItemId: ctx.item.id,
				status: result.created ? "rendered" : "already_journaled",
				detail: prIntentMachineJson(result),
			},
			result,
		};
	} catch (error) {
		if (error instanceof PrIntentRefusal) {
			return {
				outcome: {
					stage: "pr_intent",
					workItemId: ctx.item.id,
					status: "refused",
					detail: { issue: issueNumber, invariant: error.invariant, message: error.message },
				},
				result: null,
			};
		}
		throw error;
	}
}

/**
 * Backfill a succeeded dispatch's missing result_branch from the run wire
 * (warren-5255). Fill-only: a journaled branch is frozen, and a warren that
 * still serves no branch leaves the row untouched (the intent then refuses
 * `run_branch_missing` fail-closed, exactly as before).
 */
async function backfillDispatchBranch(ctx: WorkItemContext): Promise<void> {
	const settled = ctx.deps.store.actions
		.listActionsForWorkItem(ctx.item.id)
		.find(
			(action) =>
				action.actionType === WARREN_DISPATCH_ACTION_TYPE &&
				action.state === "succeeded" &&
				action.resultRunId !== null &&
				action.resultBranch === null,
		);
	if (settled === undefined || settled.resultRunId === null) return;
	const run = await ctx.deps.warrenClient.getRun(settled.resultRunId);
	const branch = runPushedBranch(run);
	if (branch !== null) {
		ctx.deps.store.actions.backfillResultBranch(settled.id, branch);
	}
}

/** Stage 5: read-only reconciliation of every known upstream PR. */
async function reconcileUpstreamPrs(deps: TickDeps, campaign: CampaignRow): Promise<TickOutcome[]> {
	const identities = deps.store.events
		.listPrIdentities(campaign.id)
		.filter((identity) => identity.prNumber !== null);
	if (identities.length === 0) {
		return [{ stage: "github_reconcile", workItemId: null, status: "none" }];
	}
	const reconciler = new UpstreamPrReconciler({
		client: deps.github,
		store: deps.store,
		clock: deps.clock,
	});
	const outcomes: TickOutcome[] = [];
	for (const identity of identities) {
		const result = await reconciler.reconcile({
			campaignId: campaign.id,
			workItemId: identity.workItemId,
			upstreamOwner: identity.upstreamOwner,
			upstreamRepo: identity.upstreamRepo,
			prNumber: identity.prNumber as number,
			botLogin: identity.forkOwner,
			...(deps.botGrammar !== undefined ? { botGrammar: deps.botGrammar } : {}),
		});
		outcomes.push({
			stage: "github_reconcile",
			workItemId: identity.workItemId,
			status: "reconciled",
			detail: {
				prNumber: identity.prNumber,
				notificationsSeen: result.notificationsSeen,
				prMissing: result.prMissing,
				newEvents: result.newEvents,
				duplicateEvents: result.duplicateEvents,
				attentionCreated: result.attentionCreated,
				attentionAlreadyOpen: result.attentionAlreadyOpen,
				feedbackCreated: result.feedbackCreated,
				truncated: result.truncated,
			},
		});
	}
	return outcomes;
}

/** Stage 6: settle campaign status from work-item states. */
function settleCampaign(store: CampaignStateStore, campaignId: string): CampaignStatus {
	const items = store.campaigns.listWorkItems(campaignId);
	if (items.length > 0) {
		const statuses = items.map((item) => item.status);
		if (statuses.some((status) => ATTENTION_WORK_ITEM_STATUSES.has(status))) {
			store.campaigns.setCampaignStatus(campaignId, "needs_attention");
		} else if (statuses.every((status) => FINAL_WORK_ITEM_STATUSES.has(status))) {
			store.campaigns.setCampaignStatus(campaignId, "completed");
		}
	}
	return (store.campaigns.getCampaign(campaignId) as CampaignRow).status;
}

function buildReport(store: CampaignStateStore, campaignId: string): TickReport {
	const campaign = store.campaigns.getCampaign(campaignId) as CampaignRow;
	return {
		workItems: store.campaigns.listWorkItems(campaignId).map((item) => ({
			id: item.id,
			issueRef: item.issueRef,
			position: item.position,
			status: item.status,
		})),
		budget: {
			capUsdCents: campaign.budgetCapUsdCents,
			availableUsdCents: store.budget.availableUsdCents(campaignId),
		},
		openAttention: store.events.listOpenAttention(campaignId).length,
	};
}

function parseManifest(campaign: CampaignRow): CampaignManifest {
	try {
		return JSON.parse(campaign.manifestJson) as CampaignManifest;
	} catch (cause) {
		throw new StateError(`stored manifest for campaign ${campaign.id} is not valid JSON`, {
			cause,
		});
	}
}

function parseIssueRef(item: WorkItemRow): number {
	const number = Number(item.issueRef);
	if (!Number.isInteger(number) || number < 1) {
		throw new StateError(`work item ${item.id} has a non-numeric issue ref '${item.issueRef}'`);
	}
	return number;
}

/** One authoritative read-only issue read. */
async function readIssueSnapshot(
	github: ReadOnlyGithubClient,
	manifest: CampaignManifest,
	issueNumber: number,
): Promise<GithubIssueSnapshot> {
	const read = await github.getIssue(manifest.upstream.owner, manifest.upstream.repo, issueNumber);
	if (read.notModified || read.data === undefined) {
		throw new StateError(
			`issue ${issueNumber} read answered 304 without replayed validators; refusing to guess`,
		);
	}
	return read.data;
}

/** Admission's issue snapshot: upstream coordinates plus untrusted text. */
function issueSnapshotOf(
	manifest: CampaignManifest,
	issue: GithubIssueSnapshot,
): import("../admission.ts").IssueSnapshot {
	return {
		number: issue.number,
		owner: manifest.upstream.owner,
		repo: manifest.upstream.repo,
		title: issue.title,
		body: null,
		labels: issue.labels,
		changedPaths: null,
	};
}

/** Upstream PR-capacity facts, observed read-only. */
async function readUpstreamFacts(
	deps: TickDeps,
	manifest: CampaignManifest,
): Promise<PrIntentUpstreamFacts> {
	const repoRead = await deps.github.getRepository(manifest.upstream.owner, manifest.upstream.repo);
	if (repoRead.notModified || repoRead.data === undefined) {
		throw new StateError(
			"repository read answered 304 without replayed validators; refusing to guess",
		);
	}
	const pulls = await deps.github.listPullRequests(manifest.upstream.owner, manifest.upstream.repo);
	const dayStart = Math.floor(deps.clock.nowMs() / DAY_MS) * DAY_MS;
	const forkPrs = pulls.items.filter((pull) => pull.authorLogin === manifest.fork.owner);
	return {
		defaultBranch: repoRead.data.defaultBranch,
		forkOpenPrCount: forkPrs.filter((pull) => pull.state === "open").length,
		newPrsToday: forkPrs.filter((pull) => Date.parse(pull.createdAt) >= dayStart).length,
	};
}
