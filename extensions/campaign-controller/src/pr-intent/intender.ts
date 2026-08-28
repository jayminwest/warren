/**
 * The V0 cross-fork PR intent builder and journaler (plan pl-91b6 step 8,
 * warren-fb4f).
 *
 * Given an approved campaign plus a SUCCEEDED warren run against the
 * bot-owned fork, this module derives the exact upstream pull-request
 * request — head `<fork-owner>:<run-branch>`, base the upstream default
 * branch — renders a repository-policy-compliant title and body, and
 * persists its digest as a `planned` dry-run action BEFORE the result is
 * emitted anywhere. It performs no I/O of any kind: no GitHub call, no
 * warren call. The request is evidence, never transport; the V0 GitHub
 * client has no method that could post it (design record §7.1, §14.8).
 *
 * Every refusal condition from the seed fails closed with a stable
 * `invariant` discriminator: missing run branch, head==base, stale or
 * swapped policy, absent validation evidence, an issue that is not open
 * or not in the approved campaign, protected-path hits or ambiguity, and
 * any open/daily/upstream PR cap breach.
 *
 * Idempotency: the action key is deterministic
 * (`pr-intent:<campaignId>:<workItemId>`) and the request digest is over
 * the canonical rendered body, so a restart or a double tick re-plans onto
 * the existing row and produces exactly one intent. Changed facts under
 * the same key fail closed: the first journaled intent is the stable one.
 */
import { canonicalJson, sha256Hex } from "../digest.ts";
import { WARREN_DISPATCH_ACTION_TYPE } from "../dispatch/dispatcher.ts";
import {
	CampaignControllerError,
	type CampaignControllerErrorCode,
	StateError,
	ValidationError,
} from "../errors.ts";
import {
	type CrossForkPullRequestIntent,
	renderCrossForkPullRequestIntent,
} from "../github/pr-request.ts";
import { isValidRefName } from "../github-grammar.ts";
import type { CampaignManifest } from "../manifest.ts";
import {
	DEFAULT_EVIDENCE_TIER,
	EVIDENCE_TIERS,
	type EvidenceTier,
	type RepositoryPolicy,
	validateRepositoryPolicy,
} from "../repository-policy.ts";
import type { CampaignStateStore } from "../store/state-store.ts";
import type {
	ActionRow,
	ActionState,
	CampaignRow,
	PrIdentityRow,
	WorkItemRow,
} from "../store/types.ts";
import { loadDefaultPrBodyContract, type PrBodyFacts, renderPrBody } from "./pr-body.ts";

/** Action type persisted for every rendered cross-fork PR intent. */
export const PR_INTENT_ACTION_TYPE = "pr_intent";

/** Attention reason recorded when proposed paths hit policy protection. */
export const PR_INTENT_PROTECTED_PATH_REASON = "protected_path";

const DAY_MS = 86_400_000;

/** The exact invariant a PR-intent render refused on. */
export type PrIntentInvariant =
	| "campaign_unknown"
	| "campaign_not_approved"
	| "campaign_expired"
	| "work_item_unknown"
	| "work_item_not_terminal"
	| "issue_not_in_campaign"
	| "issue_not_open"
	| "run_not_succeeded"
	| "run_branch_missing"
	| "run_branch_invalid"
	| "head_equals_base"
	| "base_branch_mismatch"
	| "policy_invalid"
	| "policy_stale"
	| "policy_changed"
	| "policy_upstream_mismatch"
	| "summary_incomplete"
	| "evidence_absent"
	| "known_gap_absent"
	| "evidence_tier_unknown"
	| "protected_path"
	| "open_pr_cap_breach"
	| "daily_pr_cap_breach"
	| "upstream_pr_cap_breach";

/** A refused PR-intent render. `invariant` names the failed rule. */
export class PrIntentRefusal extends CampaignControllerError {
	readonly invariant: PrIntentInvariant;

	constructor(invariant: PrIntentInvariant, message: string, options?: { cause?: unknown }) {
		super("admission_refused" satisfies CampaignControllerErrorCode, message, options);
		this.name = "PrIntentRefusal";
		this.invariant = invariant;
	}

	override toJson(): {
		error: string;
		code: CampaignControllerErrorCode;
		invariant: PrIntentInvariant;
		message: string;
	} {
		return { ...super.toJson(), invariant: this.invariant };
	}
}

/** Checked upstream issue facts the render consumes (untrusted text is data only). */
export interface PrIntentIssueFacts {
	readonly number: number;
	/** Issue state as observed read-only; must be "open". */
	readonly state: string;
	readonly title: string;
}

/** The operator/controller-collected change narrative and evidence. */
export interface PrIntentSummaryFacts {
	readonly problem: string;
	readonly solution: string;
	readonly userImpact: string;
	/** Validation evidence lines; at least one non-empty entry is required. */
	readonly evidence: readonly string[];
	/**
	 * The declared known gap (what external proof is outstanding, warren-4dc1);
	 * required when the manifest tags this issue `external-proof-required`.
	 */
	readonly knownGap?: string;
	/** Paths the succeeded run changed; checked against protected/forbidden. */
	readonly changedPaths: readonly string[];
	readonly operatorNotes: string;
}

/** Read-only upstream capacity facts the caps are enforced against. */
export interface PrIntentUpstreamFacts {
	/** Upstream default branch as observed through the read-only client. */
	readonly defaultBranch: string;
	/** Open PRs from the fork account on upstream right now. */
	readonly forkOpenPrCount: number;
	/** New PRs the fork opened on upstream today. */
	readonly newPrsToday: number;
}

export interface PrIntentInput {
	readonly campaignId: string;
	readonly workItemId: string;
	readonly issue: PrIntentIssueFacts;
	readonly summary: PrIntentSummaryFacts;
	readonly upstream: PrIntentUpstreamFacts;
	/** The current repository-policy snapshot, re-validated and digest-bound here. */
	readonly policy: unknown;
	readonly nowMs: number;
}

/** The result of one render-and-journal call. All fields are JSON-safe. */
export interface PrIntentResult {
	readonly action: ActionRow;
	readonly requestDigest: string;
	readonly intent: CrossForkPullRequestIntent;
	readonly identity: PrIdentityRow;
	/** True when this call journaled the intent; false on an idempotent replay. */
	readonly created: boolean;
}

/** Machine-readable projection for the CLI / status surface. */
export interface PrIntentMachineJson {
	readonly actionId: string;
	readonly actionKey: string;
	readonly actionType: typeof PR_INTENT_ACTION_TYPE;
	readonly state: ActionState;
	readonly requestDigest: string;
	readonly policyDigest: string | null;
	readonly prIdentityId: string;
	readonly created: boolean;
	readonly request: {
		readonly method: "POST";
		readonly url: string;
		readonly body: Readonly<{
			title: string;
			head: string;
			base: string;
			body: string;
			maintainer_can_modify: boolean;
			draft: boolean;
		}>;
	};
}

/** Flatten a result into the stable machine-readable shape. */
export function prIntentMachineJson(result: PrIntentResult): PrIntentMachineJson {
	return {
		actionId: result.action.id,
		actionKey: result.action.actionKey,
		actionType: PR_INTENT_ACTION_TYPE,
		state: result.action.state,
		requestDigest: result.requestDigest,
		policyDigest: result.action.policyDigest,
		prIdentityId: result.identity.id,
		created: result.created,
		request: { method: result.intent.method, url: result.intent.url, body: result.intent.body },
	};
}

/** Deterministic action key: one intent row per campaign work item. */
export function prIntentActionKey(campaignId: string, workItemId: string): string {
	return `pr-intent:${campaignId}:${workItemId}`;
}

/**
 * Render the exact cross-fork pull-request request for one succeeded work
 * item and journal it as a planned dry-run action. Pure with respect to the
 * outside world: the only writes are the controller's own store.
 */
export function renderAndJournalPrIntent(
	store: CampaignStateStore,
	input: PrIntentInput,
): PrIntentResult {
	const campaign = requireCampaign(store, input.campaignId);
	const manifest = parseManifest(campaign, input.nowMs);
	const policy = verifyPolicy(campaign, manifest, input);
	const workItem = requireWorkItem(store, input, manifest);
	requireIssueOpen(input);
	requireSummary(input);
	const evidenceTier = requireEvidenceTier(manifest, input, policy);
	const run = requireSucceededRun(store, workItem);
	const branch = requireRunBranch(run, workItem);
	verifyProtectedPaths(store, campaign, workItem, policy, input);
	verifyPrCaps(policy, input);
	const baseBranch = verifyBaseBranch(manifest, input);
	requireHeadDiffersFromBase(branch, baseBranch, workItem);

	const title = renderTitle(input);
	const body = renderBody(manifest, input, run, branch, policy, evidenceTier);
	const intent = renderCrossForkPullRequestIntent({
		upstreamOwner: manifest.upstream.owner,
		upstreamRepo: manifest.upstream.repo,
		baseBranch,
		forkOwner: manifest.fork.owner,
		headBranch: branch,
		title,
		body,
		draft: true,
		maintainerCanModify: true,
	});
	const requestDigest = sha256Hex(canonicalJson(intent.body));
	const actionKey = prIntentActionKey(campaign.id, workItem.id);
	const existing = store.actions.getActionByKey(actionKey);

	// One transaction journals the intent (action row + prospective PR
	// identity) before anything is emitted to the caller.
	const { action, identity } = store.transaction(() => {
		const planned = store.actions.beginAction({
			actionKey,
			campaignId: campaign.id,
			workItemId: workItem.id,
			actionType: PR_INTENT_ACTION_TYPE,
			requestDigest,
			policyDigest: campaign.policyDigest,
		});
		const recorded = store.events.recordPrIdentity({
			campaignId: campaign.id,
			workItemId: workItem.id,
			upstreamOwner: manifest.upstream.owner,
			upstreamRepo: manifest.upstream.repo,
			forkOwner: manifest.fork.owner,
			forkRepo: manifest.fork.repo,
			headBranch: branch,
			title,
			bodyDigest: sha256Hex(body),
		});
		return { action: planned, identity: recorded };
	});
	return {
		action,
		requestDigest,
		intent,
		identity,
		created: existing === null,
	};
}

function requireCampaign(store: CampaignStateStore, campaignId: string): CampaignRow {
	const campaign = store.campaigns.getCampaign(campaignId);
	if (campaign === null) {
		throw new PrIntentRefusal("campaign_unknown", `unknown campaign: ${campaignId}`);
	}
	if (
		campaign.approvedAtMs === null ||
		(campaign.status !== "approved" &&
			campaign.status !== "running" &&
			campaign.status !== "completed")
	) {
		throw new PrIntentRefusal(
			"campaign_not_approved",
			`campaign ${campaign.id} is ${campaign.status} with no approval stamp; a PR intent may only be rendered for an approved campaign (a completed one backfills idempotently, warren-968d)`,
		);
	}
	return campaign;
}

function parseManifest(campaign: CampaignRow, nowMs: number): CampaignManifest {
	let parsed: unknown;
	try {
		parsed = JSON.parse(campaign.manifestJson);
	} catch (cause) {
		throw new StateError(`stored manifest for campaign ${campaign.id} is not valid JSON`, {
			cause,
		});
	}
	const manifest = parsed as CampaignManifest;
	if (nowMs >= Date.parse(manifest.expiresAt)) {
		throw new PrIntentRefusal(
			"campaign_expired",
			`campaign ${campaign.id} expired at ${manifest.expiresAt}; an expired campaign cannot render a PR intent`,
		);
	}
	return manifest;
}

/** Re-validate the policy snapshot, bind it to the campaign digest, and match upstream. */
function verifyPolicy(
	campaign: CampaignRow,
	manifest: CampaignManifest,
	input: PrIntentInput,
): RepositoryPolicy {
	if (policyIsStale(input.policy, input.nowMs)) {
		throw new PrIntentRefusal(
			"policy_stale",
			`repository policy snapshot is stale — re-fetch and re-approve before rendering a PR intent`,
		);
	}
	let validated: ReturnType<typeof validateRepositoryPolicy>;
	try {
		validated = validateRepositoryPolicy(input.policy, { nowMs: input.nowMs });
	} catch (cause) {
		throw new PrIntentRefusal("policy_invalid", "repository policy snapshot failed validation", {
			cause,
		});
	}
	if (
		validated.policy.upstream.owner !== manifest.upstream.owner ||
		validated.policy.upstream.repo !== manifest.upstream.repo
	) {
		throw new PrIntentRefusal(
			"policy_upstream_mismatch",
			`repository policy describes ${validated.policy.upstream.owner}/${validated.policy.upstream.repo}, not the campaign upstream ${manifest.upstream.owner}/${manifest.upstream.repo}`,
		);
	}
	if (campaign.policyDigest !== null && validated.digest !== campaign.policyDigest) {
		throw new PrIntentRefusal(
			"policy_changed",
			`repository policy digest changed: campaign binds ${campaign.policyDigest}, snapshot is ${validated.digest} — a changed policy requires re-approval before any PR intent`,
		);
	}
	return validated.policy;
}

/** Pre-check staleness so the refusal names the freshness invariant, not a parse error. */
function policyIsStale(policyInput: unknown, nowMs: number): boolean {
	if (typeof policyInput !== "object" || policyInput === null) return false;
	const root = policyInput as Record<string, unknown>;
	const source = root.source;
	if (typeof source !== "object" || source === null) return false;
	const fetchedAt = (source as Record<string, unknown>).fetchedAt;
	const stalenessMaxDays = root.stalenessMaxDays;
	if (typeof fetchedAt !== "string" || typeof stalenessMaxDays !== "number") return false;
	const fetchedMs = Date.parse(fetchedAt);
	if (Number.isNaN(fetchedMs)) return false;
	return nowMs - fetchedMs > stalenessMaxDays * DAY_MS;
}

function requireWorkItem(
	store: CampaignStateStore,
	input: PrIntentInput,
	manifest: CampaignManifest,
): WorkItemRow {
	const workItem = store.campaigns.getWorkItem(input.workItemId);
	if (workItem === null || workItem.campaignId !== input.campaignId) {
		throw new PrIntentRefusal(
			"work_item_unknown",
			`work item ${input.workItemId} does not belong to campaign ${input.campaignId}`,
		);
	}
	if (
		!manifest.issues.includes(input.issue.number) ||
		workItem.issueRef !== String(input.issue.number)
	) {
		throw new PrIntentRefusal(
			"issue_not_in_campaign",
			`issue ${input.issue.number} is not the work item's issue in the approved campaign's explicit issue list`,
		);
	}
	if (workItem.status !== "terminal") {
		throw new PrIntentRefusal(
			"work_item_not_terminal",
			`work item ${workItem.id} (issue ${input.issue.number}) is ${workItem.status}; a PR intent requires a succeeded run's terminal work item`,
		);
	}
	return workItem;
}

function requireIssueOpen(input: PrIntentInput): void {
	if (input.issue.state !== "open") {
		throw new PrIntentRefusal(
			"issue_not_open",
			`issue ${input.issue.number} is '${input.issue.state}', not open — the campaign contributes to open, approved issue work only`,
		);
	}
	if (typeof input.issue.title !== "string" || input.issue.title.trim().length === 0) {
		throw new PrIntentRefusal(
			"summary_incomplete",
			`issue ${input.issue.number} carries no title; the PR title cannot be derived`,
		);
	}
}

/** The evidence tier this issue renders under (manifest tag or default). */
export function issueEvidenceTier(manifest: CampaignManifest, issueNumber: number): EvidenceTier {
	const tagged = manifest.issueEvidenceTiers?.[String(issueNumber)];
	return tagged === undefined || tagged === DEFAULT_EVIDENCE_TIER
		? DEFAULT_EVIDENCE_TIER
		: (tagged as EvidenceTier);
}

function requireSummary(input: PrIntentInput): void {
	const fields: ReadonlyArray<[string, string]> = [
		["problem", input.summary.problem],
		["solution", input.summary.solution],
		["userImpact", input.summary.userImpact],
		["operatorNotes", input.summary.operatorNotes],
	];
	for (const [name, value] of fields) {
		if (typeof value !== "string" || value.trim().length === 0) {
			throw new PrIntentRefusal(
				"summary_incomplete",
				`summary field '${name}' is required — the repository policy demands problem, solution, user impact, and operator-review notes`,
			);
		}
	}
	const evidence = input.summary.evidence.filter((line) => line.trim().length > 0);
	if (evidence.length === 0) {
		throw new PrIntentRefusal(
			"evidence_absent",
			"no validation evidence collected — the repository policy requires AI-assisted contributions to carry evidence, so the intent is refused",
		);
	}
}

/**
 * The manifest's per-issue evidence tier (warren-4dc1) must be one the
 * repository policy recognizes, and an external-proof-required issue must
 * carry a declared known gap — the proof no sandbox can produce is named,
 * never silently omitted. Untagged issues render as `local-provable`.
 */
function requireEvidenceTier(
	manifest: CampaignManifest,
	input: PrIntentInput,
	policy: RepositoryPolicy,
): EvidenceTier {
	const tier = issueEvidenceTier(manifest, input.issue.number);
	if (tier === DEFAULT_EVIDENCE_TIER) return tier;
	const recognized = policy.evidenceTiers ?? EVIDENCE_TIERS;
	if (!recognized.includes(tier)) {
		throw new PrIntentRefusal(
			"evidence_tier_unknown",
			`evidence tier '${tier}' is not recognized by the repository policy (recognizes: ${recognized.join(", ")})`,
		);
	}
	if (typeof input.summary.knownGap !== "string" || input.summary.knownGap.trim().length === 0) {
		throw new PrIntentRefusal(
			"known_gap_absent",
			"a declared known gap naming the outstanding external proof is required when the evidence tier is 'external-proof-required' — unprovable claims are declared, never omitted",
		);
	}
	return tier;
}

/** The succeeded warren dispatch action carrying the terminal branch fact. */
function requireSucceededRun(store: CampaignStateStore, workItem: WorkItemRow): ActionRow {
	const succeeded = store.actions
		.listActionsForWorkItem(workItem.id)
		.find(
			(action) =>
				action.actionType === WARREN_DISPATCH_ACTION_TYPE &&
				action.state === "succeeded" &&
				action.resultRunId !== null,
		);
	if (succeeded === undefined) {
		throw new PrIntentRefusal(
			"run_not_succeeded",
			`work item ${workItem.id} (issue ${workItem.issueRef}) has no succeeded warren run; a PR intent requires one`,
		);
	}
	return succeeded;
}

function requireRunBranch(run: ActionRow, workItem: WorkItemRow): string {
	const branch = run.resultBranch;
	if (typeof branch !== "string" || branch.length === 0) {
		throw new PrIntentRefusal(
			"run_branch_missing",
			`the succeeded run ${run.resultRunId} of work item ${workItem.id} recorded no target branch; the cross-fork head ref cannot be derived`,
		);
	}
	if (!isValidRefName(branch)) {
		throw new PrIntentRefusal(
			"run_branch_invalid",
			`the succeeded run's branch '${branch}' is not a valid git ref name`,
		);
	}
	return branch;
}

/** Match proposed paths against protected/forbidden patterns, globs and all. */
function verifyProtectedPaths(
	store: CampaignStateStore,
	campaign: CampaignRow,
	workItem: WorkItemRow,
	policy: RepositoryPolicy,
	input: PrIntentInput,
): void {
	const patterns = [...policy.protectedPaths, ...policy.forbiddenPaths];
	const hits: string[] = [];
	const ambiguous: string[] = [];
	for (const path of input.summary.changedPaths) {
		for (const pattern of patterns) {
			if (pathMatchesPattern(path, pattern)) {
				hits.push(path);
			} else if (pathIsAmbiguousWith(path, pattern)) {
				ambiguous.push(path);
			}
		}
	}
	const refused = hits.length > 0 ? hits : ambiguous;
	if (refused.length === 0) return;
	const kind = hits.length > 0 ? "protected/forbidden" : "ambiguously overlapping";
	store.campaigns.setWorkItemStatus(workItem.id, "needs_attention");
	store.events.addAttentionOnce({
		campaignId: campaign.id,
		workItemId: workItem.id,
		reason: PR_INTENT_PROTECTED_PATH_REASON,
		detailJson: canonicalJson({ stage: "pr_intent", paths: [...new Set(refused)] }),
	});
	throw new PrIntentRefusal(
		"protected_path",
		`the run's changed path(s) ${[...new Set(refused)].join(", ")} ${kind} policy path(s) — protected paths always force human attention`,
	);
}

/** Exact or `dir/*` glob containment. */
function pathMatchesPattern(path: string, pattern: string): boolean {
	if (path === pattern) return true;
	if (pattern.endsWith("/*")) {
		const dir = pattern.slice(0, -1);
		return path.startsWith(dir);
	}
	return false;
}

/** A changed path that is a directory prefix of a protected path (or vice versa) is ambiguous. */
function pathIsAmbiguousWith(path: string, pattern: string): boolean {
	if (pattern.endsWith("/*")) return false;
	return path !== pattern && (pattern.startsWith(`${path}/`) || path.startsWith(`${pattern}/`));
}

/** Enforce the upstream-observed, controller, and daily PR caps. */
function verifyPrCaps(policy: RepositoryPolicy, input: PrIntentInput): void {
	const { forkOpenPrCount, newPrsToday } = input.upstream;
	for (const [name, value] of [
		["forkOpenPrCount", forkOpenPrCount],
		["newPrsToday", newPrsToday],
	] as const) {
		if (!Number.isInteger(value) || value < 0) {
			throw new ValidationError(
				`upstream fact '${name}' must be a non-negative integer, got ${String(value)}`,
			);
		}
	}
	if (forkOpenPrCount + 1 > policy.upstreamObservedMaxOpenPrs) {
		throw new PrIntentRefusal(
			"upstream_pr_cap_breach",
			`upstream caps contributors at ${policy.upstreamObservedMaxOpenPrs} open PRs; the fork already has ${forkOpenPrCount}`,
		);
	}
	if (forkOpenPrCount + 1 > policy.maxOpenPrs) {
		throw new PrIntentRefusal(
			"open_pr_cap_breach",
			`open-PR cap breach: the fork has ${forkOpenPrCount} open PRs and the policy allows at most ${policy.maxOpenPrs}`,
		);
	}
	if (newPrsToday >= policy.maxNewPrsPerDay) {
		throw new PrIntentRefusal(
			"daily_pr_cap_breach",
			`daily PR cap breach: ${newPrsToday} new PR(s) today against a policy cap of ${policy.maxNewPrsPerDay}`,
		);
	}
}

/** The observed upstream default branch must equal the approved manifest's base. */
function verifyBaseBranch(manifest: CampaignManifest, input: PrIntentInput): string {
	if (input.upstream.defaultBranch !== manifest.defaultBranch) {
		throw new PrIntentRefusal(
			"base_branch_mismatch",
			`upstream default branch is '${input.upstream.defaultBranch}' but the approved campaign targets '${manifest.defaultBranch}' — re-approve against the current upstream before rendering an intent`,
		);
	}
	return manifest.defaultBranch;
}

function requireHeadDiffersFromBase(
	branch: string,
	baseBranch: string,
	workItem: WorkItemRow,
): void {
	if (branch === baseBranch) {
		throw new PrIntentRefusal(
			"head_equals_base",
			`the run's branch '${branch}' equals the upstream base branch '${baseBranch}'; a cross-fork PR needs a distinct head ref (work item ${workItem.id})`,
		);
	}
}

/** The PR title: the upstream issue's title plus its number, verbatim data. */
function renderTitle(input: PrIntentInput): string {
	return `${input.issue.title} (#${input.issue.number})`;
}

/**
 * The repository-policy-compliant PR body: fully deterministic. The section
 * headings, disclosure paragraph, and footer come from the profile's
 * `prBodyContract` (warren-e361); this file declares none of them.
 */
function renderBody(
	manifest: CampaignManifest,
	input: PrIntentInput,
	run: ActionRow,
	branch: string,
	policy: RepositoryPolicy,
	evidenceTier: EvidenceTier,
): string {
	const facts: PrBodyFacts = {
		campaignId: manifest.campaignId,
		agent: manifest.warren.agent,
		provider: manifest.warren.provider,
		model: manifest.warren.model,
		approvedBy: manifest.approval.approvedBy,
		runId: run.resultRunId as string,
		branch,
		forkOwner: manifest.fork.owner,
		issueNumber: input.issue.number,
		problem: input.summary.problem,
		solution: input.summary.solution,
		userImpact: input.summary.userImpact,
		evidence: input.summary.evidence.filter((line) => line.trim().length > 0),
		evidenceTier,
		knownGap: input.summary.knownGap,
		operatorNotes: input.summary.operatorNotes,
	};
	const contract = policy.prBodyContract ?? loadDefaultPrBodyContract();
	return renderPrBody(contract, facts);
}
