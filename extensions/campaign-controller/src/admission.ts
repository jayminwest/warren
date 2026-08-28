/**
 * Campaign import, explicit approval, and per-item admission (plan pl-91b6
 * step 6, warren-a252).
 *
 * This module owns the approval boundary of the controller:
 *
 * - `importCampaign` validates the manifest and the repository-policy
 *   snapshot, stores an immutable campaign row keyed by the canonical
 *   manifest digest, and materializes the explicit ordered work items.
 *   Importing a changed manifest for the same `campaignId` produces a new
 *   digest and returns every prior non-terminal row to
 *   `awaiting_approval` with its approval stamp cleared — a changed bound
 *   field can never inherit an old approval.
 * - `approveCampaign` is the explicit human act: the operator re-states the
 *   exact manifest digest and approver, and only an exact match over the
 *   stored immutable manifest stamps approval.
 * - `admitWorkItem` is the per-item gate before any dispatch may be planned.
 *   It verifies approved/unexpired state, repository-policy freshness and
 *   digest binding, explicit ordered issue membership, the upstream/fork
 *   allowlist, all-false mutation flags, the warren dispatch identity and
 *   caps, available budget (campaign and daily), concurrency, and the
 *   one-active-attempt rule. A protected-path reference in untrusted issue
 *   data fails closed into `needs_attention`.
 *
 * Untrusted issue text (title, body, labels, proposed paths) is data only.
 * It can cause a refusal; it can never grant, widen, or rewrite policy.
 *
 * No network request may occur before admission succeeds, and none does:
 * this module imports no client and touches no transport. Dispatch (a later
 * step) is the first operation that may perform I/O, and only after
 * admission returned a reservation.
 */
import { AdmissionRefusal } from "./admission-errors.ts";
import { digestOf } from "./digest.ts";
import { ValidationError } from "./errors.ts";
import { checkRepoCoordinates, type RepoCoordinates } from "./github-grammar.ts";
import { type CampaignManifest, validateCampaignManifest } from "./manifest.ts";
import { EXECUTABLE_MUTATION_FLAGS, MUTATION_FLAGS } from "./mutations.ts";
import {
	DEFAULT_EVIDENCE_TIER,
	type RepositoryPolicy,
	validateRepositoryPolicy,
} from "./repository-policy.ts";
import type { CampaignStateStore } from "./store/state-store.ts";
import type { CampaignRow, ReservationRow, WorkItemRow } from "./store/types.ts";

const DAY_MS = 86_400_000;

/** Work-item statuses that occupy a concurrency slot. */
const CONCURRENT_STATUSES: readonly string[] = [
	"dispatch_intent",
	"dispatched",
	"running",
	"repair_pending",
	"repairing",
	"retry_pending",
];

/** Immutable facts an import commits. */
export interface CampaignImportResult {
	readonly campaign: CampaignRow;
	readonly workItems: readonly WorkItemRow[];
	readonly manifestDigest: string;
	readonly policyDigest: string;
	/** True when this import invalidated prior approval of an older digest. */
	readonly invalidatedPriorVersions: boolean;
	/**
	 * Non-fatal advisories recorded at import (warren-4dc1); a warning never
	 * blocks dispatch, it steers issue selection toward provable work.
	 */
	readonly warnings: readonly string[];
}

/** The recorded approval: what was bound, by whom, and until when. */
export interface CampaignApprovalResult {
	readonly campaign: CampaignRow;
	readonly manifestDigest: string;
	readonly approvedBy: string;
	readonly approvedAtMs: number;
	readonly expiresAt: string;
}

/**
 * The untrusted upstream issue snapshot admission consumes. Everything but
 * `number`/`owner`/`repo` is inert data: it is stored or refused on, never
 * consulted as policy.
 */
export interface IssueSnapshot {
	readonly number: number;
	readonly owner: string;
	readonly repo: string;
	readonly title?: string | null;
	readonly body?: string | null;
	readonly labels?: readonly string[] | null;
	/** Paths the issue proposes to touch, if known. Data only — checked against protected/forbidden paths. */
	readonly changedPaths?: readonly string[] | null;
}

/** A successfully admitted work item with its reserved budget. */
export interface AdmissionResult {
	readonly workItem: WorkItemRow;
	readonly reservation: ReservationRow;
	readonly manifestDigest: string;
	readonly policyDigest: string;
}

function usdToCents(usd: number): number {
	return Math.round(usd * 100);
}

/**
 * Cross-check the manifest's per-issue evidence tiers (warren-4dc1) against
 * the tiers the repository policy recognizes, and advise (never refuse) when
 * the campaign is majority external-proof-required: selection is steered
 * toward locally provable work. Returns the advisory list.
 */
function evidenceTierAdvisories(manifest: CampaignManifest, policy: RepositoryPolicy): string[] {
	const recognized = policy.evidenceTiers ?? [DEFAULT_EVIDENCE_TIER, "external-proof-required"];
	for (const [issue, tier] of Object.entries(manifest.issueEvidenceTiers ?? {})) {
		if (!recognized.includes(tier)) {
			throw new AdmissionRefusal(
				"evidence_tier_unknown",
				`issue ${issue} carries evidence tier '${tier}', which the repository policy does not recognize (recognizes: ${recognized.join(", ")})`,
			);
		}
	}
	const external = manifest.issues.filter(
		(issue) =>
			(manifest.issueEvidenceTiers?.[String(issue)] ?? DEFAULT_EVIDENCE_TIER) !==
			DEFAULT_EVIDENCE_TIER,
	).length;
	if (external * 2 > manifest.issues.length) {
		return [
			`advisory: ${external} of ${manifest.issues.length} issues are tagged 'external-proof-required' — a majority of this campaign's evidence needs a real external system; prefer locally provable issue selection where possible`,
		];
	}
	return [];
}

function parseManifestRow(row: CampaignRow): CampaignManifest {
	try {
		const parsed: unknown = JSON.parse(row.manifestJson);
		return parsed as CampaignManifest;
	} catch (cause) {
		throw new AdmissionRefusal(
			"campaign_invalid",
			`stored manifest for campaign ${row.id} is not valid JSON`,
			{ cause },
		);
	}
}

function isTerminalStatus(status: string): boolean {
	return status === "completed" || status === "failed" || status === "cancelled";
}

/**
 * Import (or idempotently re-import) a campaign: validate manifest and
 * repository policy against `nowMs`, cross-check that the policy snapshot
 * describes the manifest's upstream, persist the immutable campaign keyed
 * by digest, and materialize the explicit ordered work items. Re-importing
 * the exact same digest is idempotent. A different digest for the same
 * `campaignId` returns prior non-terminal versions to `awaiting_approval`.
 */
export function importCampaign(
	store: CampaignStateStore,
	input: { manifest: unknown; policy: unknown; nowMs: number },
): CampaignImportResult {
	const validatedManifest = validateCampaignManifest(input.manifest, { nowMs: input.nowMs });
	const validatedPolicy = validateRepositoryPolicy(input.policy, { nowMs: input.nowMs });
	const { manifest, digest } = validatedManifest;
	const { policy, digest: policyDigest } = validatedPolicy;
	if (
		policy.upstream.owner !== manifest.upstream.owner ||
		policy.upstream.repo !== manifest.upstream.repo
	) {
		throw new ValidationError(
			`repository policy upstream ${policy.upstream.owner}/${policy.upstream.repo} does not match manifest upstream ${manifest.upstream.owner}/${manifest.upstream.repo} — the policy snapshot must describe the campaign's upstream repository`,
		);
	}

	const advisory = evidenceTierAdvisories(manifest, policy);

	const existing = store.campaigns.getCampaignByDigest(digest);
	if (existing !== null) {
		return {
			campaign: existing,
			workItems: store.campaigns.listWorkItems(existing.id),
			manifestDigest: digest,
			policyDigest,
			invalidatedPriorVersions: false,
			warnings: advisory,
		};
	}

	// A changed bound field means a new digest: prior non-terminal versions
	// of this campaignId lose their approval and return to awaiting_approval.
	let invalidatedPriorVersions = false;
	for (const prior of store.campaigns.listCampaigns()) {
		if (prior.manifestDigest === digest) continue;
		const priorManifest = parseManifestRow(prior);
		if (priorManifest.campaignId !== manifest.campaignId) continue;
		if (isTerminalStatus(prior.status)) continue;
		store.campaigns.invalidateApproval(prior.id);
		store.events.addAttention({
			campaignId: prior.id,
			reason: "superseded_by_new_manifest_version",
			detailJson: JSON.stringify({
				previousDigest: prior.manifestDigest,
				newDigest: digest,
			}),
		});
		invalidatedPriorVersions = true;
	}

	const campaign = store.campaigns.createCampaign({
		manifestDigest: digest,
		manifestJson: JSON.stringify(manifest),
		policyDigest,
		budgetCapUsdCents: usdToCents(manifest.budget.totalUsd),
		status: "awaiting_approval",
	});
	const workItems = manifest.issues.map((issue, index) =>
		store.campaigns.addWorkItem({
			campaignId: campaign.id,
			position: index + 1,
			issueRef: String(issue),
			status: "candidate",
		}),
	);
	return {
		campaign,
		workItems,
		manifestDigest: digest,
		policyDigest,
		invalidatedPriorVersions,
		warnings: advisory,
	};
}

/**
 * Explicit operator approval. The caller re-states the exact manifest
 * digest and approver; approval stamps only an exact match over the stored
 * immutable manifest. Approval records the digest, approver, timestamp,
 * and the manifest's expiry.
 */
export function approveCampaign(
	store: CampaignStateStore,
	input: { campaignId: string; manifestDigest: string; approvedBy: string; nowMs: number },
): CampaignApprovalResult {
	const campaign = requireCampaign(store, input.campaignId);
	const manifest = parseManifestRow(campaign);
	if (input.nowMs >= Date.parse(manifest.expiresAt)) {
		throw new AdmissionRefusal(
			"campaign_expired",
			`campaign ${campaign.id} expired at ${manifest.expiresAt}; an expired manifest cannot be approved`,
		);
	}
	if (campaign.status === "approved" && campaign.approvedAtMs !== null) {
		// Idempotent re-approval of the exact same digest and approver.
		if (
			campaign.manifestDigest === input.manifestDigest &&
			manifest.approval.approvedBy === input.approvedBy
		) {
			return approvalResult(store, campaign, manifest);
		}
		throw new AdmissionRefusal(
			"approval_digest_mismatch",
			`campaign ${campaign.id} is already approved against digest ${campaign.manifestDigest}; refusing to re-approve a different digest`,
		);
	}
	if (campaign.status !== "awaiting_approval") {
		throw new AdmissionRefusal(
			"campaign_not_awaiting_approval",
			`campaign ${campaign.id} is ${campaign.status}; only an awaiting_approval campaign can be approved`,
		);
	}
	if (input.manifestDigest !== campaign.manifestDigest) {
		throw new AdmissionRefusal(
			"approval_digest_mismatch",
			`approval digest mismatch: operator stated ${input.manifestDigest}, campaign binds ${campaign.manifestDigest} — approval must bind the exact manifest digest`,
		);
	}
	if (input.approvedBy !== manifest.approval.approvedBy) {
		throw new AdmissionRefusal(
			"approver_mismatch",
			`approver mismatch: operator stated '${input.approvedBy}', manifest names '${manifest.approval.approvedBy}'`,
		);
	}
	const approved = store.campaigns.approveCampaign(campaign.id);
	store.campaigns.setCampaignStatus(campaign.id, "approved");
	resolveSupersededAttention(store, input.manifestDigest, input.approvedBy);
	return approvalResult(store, approved, manifest);
}

/**
 * Attention hygiene (warren-b853): a `superseded_by_new_manifest_version`
 * item auto-resolves when the superseding manifest version is approved.
 * Monotonic and journal-free: the resolved detail is stamped with the
 * approving digest and approver as the resolving evidence.
 */
function resolveSupersededAttention(
	store: CampaignStateStore,
	approvedDigest: string,
	approvedBy: string,
): void {
	for (const campaign of store.campaigns.listCampaigns()) {
		for (const item of store.events.listOpenAttention(campaign.id)) {
			if (item.reason !== "superseded_by_new_manifest_version" || item.detailJson === null) {
				continue;
			}
			let detail: { newDigest?: unknown };
			try {
				detail = JSON.parse(item.detailJson) as typeof detail;
			} catch {
				continue;
			}
			if (detail.newDigest !== approvedDigest) continue;
			store.events.resolveAttentionAuto(item.id, {
				resolvedByRule: "superseding_manifest_approved",
				resolvingManifestDigest: approvedDigest,
				approvedBy,
			});
		}
	}
}

function approvalResult(
	store: CampaignStateStore,
	campaign: CampaignRow,
	manifest: CampaignManifest,
): CampaignApprovalResult {
	const stamped = store.campaigns.getCampaign(campaign.id) as CampaignRow;
	return {
		campaign: stamped,
		manifestDigest: stamped.manifestDigest,
		approvedBy: manifest.approval.approvedBy,
		approvedAtMs: stamped.approvedAtMs as number,
		expiresAt: manifest.expiresAt,
	};
}

/**
 * Admit one work item: the last gate before any dispatch planning. Runs
 * every invariant fail-closed and, only when all pass, transitions the work
 * item to `admitted` and reserves the full per-run cap inside one
 * transaction. Performs no I/O of any kind.
 */
export function admitWorkItem(
	store: CampaignStateStore,
	input: {
		campaignId: string;
		issue: IssueSnapshot;
		/** The current repository-policy snapshot, re-validated and digest-bound here. */
		policy: unknown;
		nowMs: number;
	},
): AdmissionResult {
	const campaign = requireCampaign(store, input.campaignId);
	if (
		campaign.approvedAtMs === null ||
		(campaign.status !== "approved" && campaign.status !== "running")
	) {
		throw new AdmissionRefusal(
			"campaign_not_approved",
			`campaign ${campaign.id} is ${campaign.status} with no approval stamp; only an approved campaign may admit work`,
		);
	}
	const manifest = verifyManifest(campaign, input.nowMs);
	const policy = verifyPolicy(campaign, input.policy, manifest, input.nowMs);
	verifyWarrenTarget(manifest);
	verifyMutationFlags(policy);
	const workItem = findWorkItem(store, campaign, manifest, input.issue.number);
	verifyIssueRepository(manifest, input.issue);
	verifyProtectedPaths(store, campaign, policy, workItem, input.issue);
	verifyNoActiveAttempt(store, workItem, input.issue);
	verifyConcurrency(store, campaign, manifest);
	verifyDailyBudget(store, campaign, manifest, input.issue, input.nowMs);

	// Budget reservation and the admission transition commit atomically.
	const perRunCents = usdToCents(manifest.budget.perRunUsd);
	const reservation: ReservationRow = store.transaction(() => {
		let reserved: ReservationRow;
		try {
			reserved = store.budget.reserve({
				campaignId: campaign.id,
				amountUsdCents: perRunCents,
			});
		} catch (cause) {
			throw new AdmissionRefusal(
				"budget_insufficient",
				`insufficient campaign budget for issue ${input.issue.number}: need ${perRunCents}c, ${store.budget.availableUsdCents(campaign.id)}c available of the approved ${campaign.budgetCapUsdCents}c`,
				{ cause },
			);
		}
		store.campaigns.setWorkItemStatus(workItem.id, "admitted");
		return reserved;
	});

	return {
		workItem: store.campaigns.getWorkItem(workItem.id) as WorkItemRow,
		reservation,
		manifestDigest: campaign.manifestDigest,
		policyDigest: campaign.policyDigest as string,
	};
}

function requireCampaign(store: CampaignStateStore, id: string): CampaignRow {
	const campaign = store.campaigns.getCampaign(id);
	if (campaign === null) {
		throw new AdmissionRefusal("campaign_unknown", `unknown campaign: ${id}`);
	}
	return campaign;
}

/**
 * Re-validate the stored immutable manifest against `nowMs` and recompute
 * its digest: expiry, freshness, and storage tampering all fail closed.
 */
function verifyManifest(campaign: CampaignRow, nowMs: number): CampaignManifest {
	const manifest = parseManifestRow(campaign);
	if (nowMs >= Date.parse(manifest.expiresAt)) {
		throw new AdmissionRefusal(
			"campaign_expired",
			`campaign ${campaign.id} expired at ${manifest.expiresAt}; an expired campaign cannot admit work`,
		);
	}
	try {
		const { approval: _bound, ...unapproved } = manifest;
		const digest = digestOf(unapproved);
		if (digest !== campaign.manifestDigest) {
			throw new AdmissionRefusal(
				"campaign_invalid",
				`stored manifest of campaign ${campaign.id} does not recompute to its bound digest ${campaign.manifestDigest}`,
			);
		}
		validateCampaignManifest(manifest, { nowMs });
	} catch (cause) {
		if (cause instanceof AdmissionRefusal) throw cause;
		throw new AdmissionRefusal(
			"campaign_invalid",
			`stored manifest of campaign ${campaign.id} failed re-validation`,
			{ cause },
		);
	}
	return manifest;
}

/**
 * Re-validate the supplied policy snapshot against `nowMs` (staleness),
 * recompute its digest, and require it to be exactly the snapshot the
 * campaign was imported with. No live action may be authorized from stale
 * or silently swapped policy data (design record risk 4).
 */
function verifyPolicy(
	campaign: CampaignRow,
	policyInput: unknown,
	manifest: CampaignManifest,
	nowMs: number,
): RepositoryPolicy {
	const stale = stalenessViolation(policyInput, nowMs);
	if (stale !== null) {
		throw new AdmissionRefusal("policy_stale", stale);
	}
	let validated: ReturnType<typeof validateRepositoryPolicy>;
	try {
		validated = validateRepositoryPolicy(policyInput, { nowMs });
	} catch (cause) {
		throw new AdmissionRefusal("policy_invalid", "repository policy snapshot failed validation", {
			cause,
		});
	}
	if (
		campaign.policyDigest !== null &&
		(validated.policy.upstream.owner !== manifest.upstream.owner ||
			validated.policy.upstream.repo !== manifest.upstream.repo)
	) {
		throw new AdmissionRefusal(
			"policy_upstream_mismatch",
			`repository policy describes ${validated.policy.upstream.owner}/${validated.policy.upstream.repo}, not the campaign upstream ${manifest.upstream.owner}/${manifest.upstream.repo}`,
		);
	}
	if (campaign.policyDigest !== null && validated.digest !== campaign.policyDigest) {
		throw new AdmissionRefusal(
			"policy_changed",
			`repository policy digest changed: campaign binds ${campaign.policyDigest}, snapshot is ${validated.digest} — a changed policy requires re-approval`,
		);
	}
	return validated.policy;
}

/** Pre-check staleness so the refusal names the freshness invariant. */
function stalenessViolation(policyInput: unknown, nowMs: number): string | null {
	if (typeof policyInput !== "object" || policyInput === null) return null;
	const root = policyInput as Record<string, unknown>;
	const source = root.source;
	if (typeof source !== "object" || source === null) return null;
	const fetchedAt = (source as Record<string, unknown>).fetchedAt;
	const stalenessMaxDays = root.stalenessMaxDays;
	if (typeof fetchedAt !== "string" || typeof stalenessMaxDays !== "number") return null;
	const fetchedMs = Date.parse(fetchedAt);
	if (Number.isNaN(fetchedMs)) return null;
	const ageMs = nowMs - fetchedMs;
	if (ageMs > stalenessMaxDays * DAY_MS) {
		return `repository policy snapshot is stale: fetchedAt ${fetchedAt} is older than the ${stalenessMaxDays}-day staleness bound — re-fetch and re-approve before admitting work`;
	}
	return null;
}

/** Warren dispatch identity and layered caps must still hold. */
function verifyWarrenTarget(manifest: CampaignManifest): void {
	const { warren, budget } = manifest;
	if (
		warren.project.length === 0 ||
		warren.agent.length === 0 ||
		warren.provider.length === 0 ||
		warren.model.length === 0
	) {
		throw new AdmissionRefusal(
			"warren_target_invalid",
			"warren dispatch identity is incomplete — project, agent, provider, and model must all be bound",
		);
	}
	if (
		!(budget.perRunUsd > 0) ||
		budget.perRunUsd > budget.dailyUsd ||
		budget.dailyUsd > budget.totalUsd
	) {
		throw new AdmissionRefusal(
			"budget_caps_invalid",
			`budget caps must layer per-run ≤ daily ≤ total, got ${budget.perRunUsd} / ${budget.dailyUsd} / ${budget.totalUsd}`,
		);
	}
}

/**
 * Defensive re-check: only mutations with an executable code path may be
 * enabled (Phase 2, warren-84da, opened exactly `createPullRequest`); the
 * schema enforces the same rule, and this belt-and-suspenders copy holds
 * even against a store row validated by an older revision.
 */
function verifyMutationFlags(policy: RepositoryPolicy): void {
	const enabled = MUTATION_FLAGS.filter(
		(flag) => policy.mutations[flag] !== false && !EXECUTABLE_MUTATION_FLAGS.includes(flag),
	);
	if (enabled.length > 0) {
		throw new AdmissionRefusal(
			"mutation_flag_enabled",
			`mutation flag(s) enabled: ${enabled.join(", ")} — no executable code path exists for them (only ${EXECUTABLE_MUTATION_FLAGS.join(", ")} may be enabled, warren-84da)`,
		);
	}
}

/** Explicit ordered membership: the issue must be in the manifest, in order. */
function findWorkItem(
	store: CampaignStateStore,
	campaign: CampaignRow,
	manifest: CampaignManifest,
	issueNumber: number,
): WorkItemRow {
	if (!manifest.issues.includes(issueNumber)) {
		throw new AdmissionRefusal(
			"issue_not_in_campaign",
			`issue ${issueNumber} is not in the approved campaign's explicit issue list`,
		);
	}
	const items = store.campaigns.listWorkItems(campaign.id);
	const item = items.find((candidate) => candidate.issueRef === String(issueNumber));
	if (item === undefined) {
		throw new AdmissionRefusal(
			"issue_not_in_campaign",
			`issue ${issueNumber} is approved but has no work item — the campaign store is inconsistent with its manifest`,
		);
	}
	if (item.status !== "candidate") {
		throw new AdmissionRefusal(
			"issue_already_admitted",
			`work item for issue ${issueNumber} is ${item.status}; each issue admits exactly once per attempt cycle`,
		);
	}
	for (const earlier of items) {
		if (earlier.position >= item.position) continue;
		if (earlier.status === "candidate") {
			throw new AdmissionRefusal(
				"issue_out_of_order",
				`issue ${issueNumber} cannot be admitted before issue ${earlier.issueRef} — membership is explicit and ordered`,
			);
		}
	}
	return item;
}

/** Repository/fork allowlist: the issue must live on the approved upstream. */
function verifyIssueRepository(manifest: CampaignManifest, issue: IssueSnapshot): void {
	const issueRepo: RepoCoordinates | null = checkRepoCoordinates({
		owner: issue.owner,
		repo: issue.repo,
	});
	if (
		issueRepo === null ||
		issueRepo.owner !== manifest.upstream.owner ||
		issueRepo.repo !== manifest.upstream.repo
	) {
		throw new AdmissionRefusal(
			"issue_repository_not_allowed",
			`issue ${issue.number} lives on ${issue.owner}/${issue.repo}, which is not the approved upstream ${manifest.upstream.owner}/${manifest.upstream.repo}`,
		);
	}
}

/** Protected paths: untrusted proposed paths force attention, never authorization (design record §7.1). */
function verifyProtectedPaths(
	store: CampaignStateStore,
	campaign: CampaignRow,
	policy: RepositoryPolicy,
	workItem: WorkItemRow,
	issue: IssueSnapshot,
): void {
	const proposed = issue.changedPaths ?? [];
	const protectedHit = proposed.filter(
		(path) => policy.protectedPaths.includes(path) || policy.forbiddenPaths.includes(path),
	);
	if (protectedHit.length > 0) {
		store.campaigns.setWorkItemStatus(workItem.id, "needs_attention");
		store.events.addAttention({
			campaignId: campaign.id,
			workItemId: workItem.id,
			reason: "protected_path",
			detailJson: JSON.stringify({ paths: protectedHit }),
		});
		throw new AdmissionRefusal(
			"protected_path",
			`issue ${issue.number} proposes protected/forbidden path(s) ${protectedHit.join(", ")} — protected paths always force human attention`,
		);
	}
}

/** One active attempt per work item. */
function verifyNoActiveAttempt(
	store: CampaignStateStore,
	workItem: WorkItemRow,
	issue: IssueSnapshot,
): void {
	for (const action of store.actions.listActionsForWorkItem(workItem.id)) {
		if (action.state === "planned" || action.state === "executing") {
			throw new AdmissionRefusal(
				"attempt_already_active",
				`work item ${workItem.id} (issue ${issue.number}) already has an active attempt (action ${action.id}, ${action.state})`,
			);
		}
	}
}

/** Concurrency across the whole campaign. */
function verifyConcurrency(
	store: CampaignStateStore,
	campaign: CampaignRow,
	manifest: CampaignManifest,
): void {
	const active = countConcurrentWork(store, campaign);
	if (active >= manifest.maxConcurrentRuns) {
		throw new AdmissionRefusal(
			"concurrency_exceeded",
			`campaign ${campaign.id} already runs ${active} concurrent work item(s); the approved maximum is ${manifest.maxConcurrentRuns}`,
		);
	}
}

/** Daily budget: settled spend plus active reservations started today. */
function verifyDailyBudget(
	store: CampaignStateStore,
	campaign: CampaignRow,
	manifest: CampaignManifest,
	issue: IssueSnapshot,
	nowMs: number,
): void {
	const perRunCents = usdToCents(manifest.budget.perRunUsd);
	const dailyCents = usdToCents(manifest.budget.dailyUsd);
	const dayStart = Math.floor(nowMs / DAY_MS) * DAY_MS;
	let todayCommitted = 0;
	for (const reservation of store.budget.listReservations(campaign.id)) {
		if (reservation.createdAtMs < dayStart) continue;
		todayCommitted +=
			reservation.state === "active"
				? reservation.amountUsdCents
				: (reservation.settledUsdCents ?? 0);
	}
	if (todayCommitted + perRunCents > dailyCents) {
		throw new AdmissionRefusal(
			"daily_budget_exhausted",
			`daily budget exhausted: ${todayCommitted}c committed today, per-run cap ${perRunCents}c would exceed the daily ${dailyCents}c for issue ${issue.number}`,
		);
	}
}

function countConcurrentWork(store: CampaignStateStore, campaign: CampaignRow): number {
	const items = store.campaigns.listWorkItems(campaign.id);
	let count = items.filter((item) => CONCURRENT_STATUSES.includes(item.status)).length;
	for (const action of store.actions.listUnfinishedActions()) {
		if (action.campaignId !== campaign.id) continue;
		if (action.workItemId === null) continue;
		const item = items.find((candidate) => candidate.id === action.workItemId);
		if (item !== undefined && CONCURRENT_STATUSES.includes(item.status)) continue;
		count += 1;
	}
	return count;
}
