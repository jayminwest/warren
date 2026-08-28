/**
 * The manifest amendment flow (plan pl-096b step 3, warren-35c4).
 *
 * Every manifest edit used to create a full new campaign row and an
 * unresolved `superseded_by_new_manifest_version` attention item, so a live
 * campaign iterating on prompt or budget burned a row per edit. An
 * amendment is the bounded alternative: a document that references the
 * campaign and its base manifest digest, carries ONLY the changed fields,
 * and is digest-bound and owner-approved exactly like a manifest — the
 * approval authority never weakens.
 *
 * Amendable fields (the manifest's operator-tunable knobs):
 *   - `appendIssues`    — issues added at the END of the ordered list
 *   - `budget`          — full replacement of the layered caps
 *   - `prompt`/`promptDigest` — replacement dispatch prompt (exactly one)
 *   - `maxConcurrentRuns`
 *   - `expiresAt`       — expiry extension
 *
 * Out of scope by construction: removing or reordering existing issues
 * (an amendment cannot express either; appending an already-present issue
 * is refused with an actionable error) and mutation-flag changes (those
 * live in the repository-policy snapshot, which has its own digest and
 * re-approval path — see `repository-policy.ts`).
 *
 * On approval the controller applies the amendment as a new campaign
 * version IN PLACE: same campaign row id, `campaignVersion` incremented,
 * the amendment journaled append-only, no superseded attention row.
 *
 * Deterministic policy for prior in-flight intents of the old version:
 * actions still in `planned` state (an intent committed but whose I/O has
 * not started) are INVALIDATED — settled `permanent_failure` with
 * `policy_violation`, their active reservations released, since the old
 * approval no longer authorizes them. Actions already `executing` are left
 * alone: their I/O is in flight and the dispatcher's reconcile path owns
 * them. Work items in post-dispatch states are never rewound.
 */
import { AdmissionRefusal } from "./admission-errors.ts";
import { digestOf } from "./digest.ts";
import { ValidationError } from "./errors.ts";
import {
	type CampaignBudget,
	type CampaignManifest,
	MAX_CAMPAIGN_ISSUES,
	MAX_CAP_USD,
	validateCampaignManifest,
} from "./manifest.ts";
import type { CampaignStateStore } from "./store/state-store.ts";
import type { CampaignRow, WorkItemRow } from "./store/types.ts";
import {
	asObject,
	rejectUnknownKeys,
	requireInt,
	requireIsoTimestamp,
	requirePositiveNumber,
	requireSha256,
	requireString,
} from "./validate-utils.ts";

/** V0 has exactly one amendment schema revision. */
export const AMENDMENT_SCHEMA_VERSION = 1;

/** `ame-` followed by 3–48 lowercase kebab-case characters. */
const AMENDMENT_ID = /^ame-[a-z0-9](-?[a-z0-9]){2,47}$/;
const CAMPAIGN_ID = /^camp-[a-z0-9](-?[a-z0-9]){2,47}$/;

/** Operator approval bound to the amendment digest. */
export interface AmendmentApproval {
	approvedBy: string;
	approvedAt: string;
	amendmentDigest: string;
}

/** The normalized, validated amendment document. */
export interface CampaignAmendment {
	schemaVersion: typeof AMENDMENT_SCHEMA_VERSION;
	amendmentId: string;
	campaignId: string;
	/** The manifest digest this amendment edits; approval binds it. */
	baseManifestDigest: string;
	appendIssues?: number[];
	budget?: CampaignBudget;
	prompt?: string;
	promptDigest?: string;
	maxConcurrentRuns?: number;
	expiresAt?: string;
	approval: AmendmentApproval;
}

/** Validation options: `nowMs` pins "now" so tests stay deterministic. */
export interface AmendmentValidationOptions {
	nowMs: number;
}

/** A validated amendment plus the digest its approval binds. */
export interface ValidatedCampaignAmendment {
	amendment: CampaignAmendment;
	/** digest over the normalized amendment WITHOUT the approval envelope. */
	digest: string;
}

/** The result of applying an approved amendment to a campaign row. */
export interface AmendmentApplyResult {
	readonly campaign: CampaignRow;
	/** The new in-place manifest digest (version `campaignVersion + 1`). */
	readonly manifestDigest: string;
	readonly applied: boolean;
	readonly amendedFields: readonly string[];
	readonly appendedIssues: readonly number[];
	/** Planned (never-executed) actions invalidated by the version bump. */
	readonly invalidatedActionIds: readonly string[];
	readonly appendedWorkItems: readonly WorkItemRow[];
}

const TOP_LEVEL_FIELDS = [
	"schemaVersion",
	"amendmentId",
	"campaignId",
	"baseManifestDigest",
	"appendIssues",
	"budget",
	"prompt",
	"promptDigest",
	"maxConcurrentRuns",
	"expiresAt",
	"approval",
] as const;

const BUDGET_FIELDS = ["perRunUsd", "dailyUsd", "totalUsd"] as const;
const APPROVAL_FIELDS = ["approvedBy", "approvedAt", "amendmentDigest"] as const;
const ISSUE_MIN = 1;
const ISSUE_MAX = 1_000_000;

function usdToCents(usd: number): number {
	return Math.round(usd * 100);
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

/**
 * Validate and normalize an amendment document. Throws `ValidationError`
 * with an actionable message on any violation. The returned `digest`
 * recomputes over `amendment` minus `approval`, so
 * `approval.amendmentDigest` is checked against exactly what the journal
 * will record.
 */
export function validateCampaignAmendment(
	input: unknown,
	options: AmendmentValidationOptions,
): ValidatedCampaignAmendment {
	const root = asObject(input, "campaign amendment");
	rejectUnknownKeys(root, TOP_LEVEL_FIELDS, "campaign amendment");

	const schemaVersion = requireInt(root, "schemaVersion", "campaign amendment", {
		min: AMENDMENT_SCHEMA_VERSION,
		max: AMENDMENT_SCHEMA_VERSION,
	});
	const amendmentId = requireString(root, "amendmentId", "campaign amendment", {
		min: 8,
		max: 54,
		pattern: AMENDMENT_ID,
		patternHint: "an 'ame-' prefixed lowercase kebab-case id, e.g. ame-openclaw-append-424",
	});
	const campaignId = requireString(root, "campaignId", "campaign amendment", {
		min: 8,
		max: 54,
		pattern: CAMPAIGN_ID,
		patternHint: "the 'camp-' prefixed id of the campaign being amended",
	});
	const baseManifestDigest = requireSha256(root, "baseManifestDigest", "campaign amendment");

	const appendIssues = requireAppendIssues(root);
	const budget = requireBudgetChange(root);
	const { prompt, promptDigest } = requirePromptChange(root);
	let maxConcurrentRuns: number | undefined;
	if (root.maxConcurrentRuns !== undefined) {
		maxConcurrentRuns = requireInt(root, "maxConcurrentRuns", "campaign amendment", {
			min: 1,
			max: 10,
		});
	}
	let expiresAt: string | undefined;
	if (root.expiresAt !== undefined) {
		expiresAt = requireIsoTimestamp(root, "expiresAt", "campaign amendment");
	}
	if (
		appendIssues === undefined &&
		budget === undefined &&
		prompt === undefined &&
		promptDigest === undefined &&
		maxConcurrentRuns === undefined &&
		expiresAt === undefined
	) {
		throw new ValidationError(
			"an amendment must change at least one field — expected one of 'campaign amendment.appendIssues', 'budget', 'prompt', 'promptDigest', 'maxConcurrentRuns', or 'expiresAt'",
		);
	}
	const approval = requireApproval(root, options);

	const amendment: CampaignAmendment = {
		schemaVersion: schemaVersion as typeof AMENDMENT_SCHEMA_VERSION,
		amendmentId,
		campaignId,
		baseManifestDigest,
		appendIssues,
		budget,
		prompt,
		promptDigest,
		maxConcurrentRuns,
		expiresAt,
		approval,
	};
	const { approval: _bound, ...unapproved } = amendment;
	const digest = digestOf(unapproved);
	if (digest !== approval.amendmentDigest) {
		throw new ValidationError(
			`approval digest mismatch at 'campaign amendment.approval.amendmentDigest' — expected ${digest} for this amendment content; editing a bound field invalidates approval`,
		);
	}
	return { amendment, digest };
}

/** Issues must be positive unique integers, appendable, and stay under the cap. */
function requireAppendIssues(root: ReturnType<typeof asObject>): number[] | undefined {
	const raw = root.appendIssues;
	if (raw === undefined) return undefined;
	if (!Array.isArray(raw) || raw.length === 0) {
		throw new ValidationError(
			`expected a non-empty array of issue numbers at 'campaign amendment.appendIssues' — omit the field entirely to append nothing`,
		);
	}
	const issues: number[] = [];
	const seen = new Set<number>();
	for (const item of raw) {
		if (
			typeof item !== "number" ||
			!Number.isInteger(item) ||
			item < ISSUE_MIN ||
			item > ISSUE_MAX
		) {
			throw new ValidationError(
				`expected positive integer issue numbers at 'campaign amendment.appendIssues' — appended work is explicit and ordered`,
			);
		}
		if (seen.has(item)) {
			throw new ValidationError(
				`duplicate issue ${item} at 'campaign amendment.appendIssues' — each issue appears exactly once`,
			);
		}
		seen.add(item);
		issues.push(item);
	}
	return issues;
}

function requireBudgetChange(root: ReturnType<typeof asObject>): CampaignBudget | undefined {
	if (root.budget === undefined) return undefined;
	const raw = asObject(root.budget, "campaign amendment.budget");
	rejectUnknownKeys(raw, BUDGET_FIELDS, "campaign amendment.budget");
	const budget: CampaignBudget = {
		perRunUsd: requirePositiveNumber(raw, "perRunUsd", "campaign amendment.budget", MAX_CAP_USD),
		dailyUsd: requirePositiveNumber(raw, "dailyUsd", "campaign amendment.budget", MAX_CAP_USD),
		totalUsd: requirePositiveNumber(raw, "totalUsd", "campaign amendment.budget", MAX_CAP_USD),
	};
	if (budget.perRunUsd > budget.dailyUsd || budget.dailyUsd > budget.totalUsd) {
		throw new ValidationError(
			`caps must layer per-run ≤ daily ≤ total at 'campaign amendment.budget' — got ${budget.perRunUsd} / ${budget.dailyUsd} / ${budget.totalUsd}`,
		);
	}
	return budget;
}

function requirePromptChange(root: ReturnType<typeof asObject>): {
	prompt: string | undefined;
	promptDigest: string | undefined;
} {
	const hasPrompt = root.prompt !== undefined;
	const hasDigest = root.promptDigest !== undefined;
	if (hasPrompt && hasDigest) {
		throw new ValidationError(
			"expected at most one of 'campaign amendment.prompt' or 'campaign amendment.promptDigest' — an amendment carries the full prompt or a digest of it, never both",
		);
	}
	if (hasPrompt) {
		const prompt = root.prompt;
		if (typeof prompt !== "string" || prompt.length === 0 || prompt.length > 65_536) {
			throw new ValidationError(
				"expected a non-empty prompt of at most 65536 characters at 'campaign amendment.prompt'",
			);
		}
		return { prompt, promptDigest: undefined };
	}
	if (hasDigest) {
		return {
			prompt: undefined,
			promptDigest: requireSha256(root, "promptDigest", "campaign amendment"),
		};
	}
	return { prompt: undefined, promptDigest: undefined };
}

function requireApproval(
	root: ReturnType<typeof asObject>,
	options: AmendmentValidationOptions,
): AmendmentApproval {
	const raw = asObject(root.approval, "campaign amendment.approval");
	rejectUnknownKeys(raw, APPROVAL_FIELDS, "campaign amendment.approval");
	const approvedAt = requireIsoTimestamp(raw, "approvedAt", "campaign amendment.approval");
	if (Date.parse(approvedAt) > options.nowMs) {
		throw new ValidationError(
			"approval is dated in the future at 'campaign amendment.approval.approvedAt' — approvals cannot predate themselves",
		);
	}
	return {
		approvedBy: requireString(raw, "approvedBy", "campaign amendment.approval", {
			min: 1,
			max: 100,
		}),
		approvedAt,
		amendmentDigest: requireSha256(raw, "amendmentDigest", "campaign amendment.approval"),
	};
}

/** The next manifest: the base with the amendment's changed fields applied. */
function composeNextManifest(
	base: CampaignManifest,
	amendment: CampaignAmendment,
): CampaignManifest {
	const next: CampaignManifest = {
		...base,
		campaignVersion: base.campaignVersion + 1,
	};
	if (amendment.appendIssues !== undefined) {
		next.issues = [...base.issues, ...amendment.appendIssues];
	}
	if (amendment.budget !== undefined) {
		next.budget = amendment.budget;
	}
	if (amendment.prompt !== undefined) {
		next.prompt = amendment.prompt;
		next.promptDigest = undefined;
	}
	if (amendment.promptDigest !== undefined) {
		next.prompt = undefined;
		next.promptDigest = amendment.promptDigest;
	}
	if (amendment.maxConcurrentRuns !== undefined) {
		next.maxConcurrentRuns = amendment.maxConcurrentRuns;
	}
	if (amendment.expiresAt !== undefined) {
		next.expiresAt = amendment.expiresAt;
	}
	return next;
}

/** The approved campaign row an amendment targets, or the exact refusal. */
function resolveBaseCampaign(
	store: CampaignStateStore,
	amendment: CampaignAmendment,
): { campaign: CampaignRow; base: CampaignManifest } {
	const campaign = store.campaigns.getCampaignByDigest(amendment.baseManifestDigest);
	if (campaign === null) {
		throw new AdmissionRefusal(
			"campaign_unknown",
			`no campaign row binds the amendment's base digest ${amendment.baseManifestDigest} — the amendment must reference the campaign's live manifest digest`,
		);
	}
	const base = parseManifestRow(campaign);
	if (base.campaignId !== amendment.campaignId) {
		throw new AdmissionRefusal(
			"campaign_unknown",
			`the campaign bound to ${amendment.baseManifestDigest} is '${base.campaignId}', not '${amendment.campaignId}' — an amendment may only reference its own campaign`,
		);
	}
	if (campaign.status === "failed" || campaign.status === "cancelled") {
		throw new AdmissionRefusal(
			"campaign_not_awaiting_approval",
			`campaign ${campaign.id} is ${campaign.status}; a failed or cancelled campaign cannot be amended — file a new campaign`,
		);
	}
	return { campaign, base };
}

/** The appended issues must be new and must stay under the cap. */
function requireAppendableIssues(base: CampaignManifest, amendment: CampaignAmendment): number[] {
	const appended = amendment.appendIssues ?? [];
	const existingIssues = new Set(base.issues);
	const collides = appended.find((issue) => existingIssues.has(issue));
	if (collides !== undefined) {
		throw new AdmissionRefusal(
			"issue_already_admitted",
			`issue ${collides} is already in the campaign's explicit issue list — amendments can append issues, never remove or reorder them`,
		);
	}
	if (base.issues.length + appended.length > MAX_CAMPAIGN_ISSUES) {
		throw new AdmissionRefusal(
			"issue_not_in_campaign",
			`appending ${appended.length} issue(s) would exceed the ${MAX_CAMPAIGN_ISSUES}-issue cap (${base.issues.length} present)`,
		);
	}
	return appended;
}

/** Deterministic invalidation of planned never-executed intents. */
function invalidatePlannedActions(
	store: CampaignStateStore,
	campaignId: string,
	amendment: CampaignAmendment,
	newManifestDigest: string,
): string[] {
	const invalidated: string[] = [];
	for (const action of store.actions.listActionsForCampaign(campaignId)) {
		if (action.state !== "planned") continue;
		store.actions.settleAction(action.id, {
			state: "permanent_failure",
			errorClass: "policy_violation",
			errorJson: JSON.stringify({
				reason: "invalidated_by_amendment",
				amendmentId: amendment.amendmentId,
				previousManifestDigest: amendment.baseManifestDigest,
				newManifestDigest,
			}),
		});
		const reservation = store.budget.getReservationByAction(action.id);
		if (reservation !== null && reservation.state === "active") {
			store.budget.releaseReservation(reservation.id);
		}
		invalidated.push(action.id);
	}
	return invalidated;
}

/**
 * Apply a digest-bound, owner-approved amendment to a campaign IN PLACE.
 *
 * No new campaign row is created and no superseded attention row is
 * emitted — that is the whole point of the flow. The base manifest digest
 * named by the amendment must be the campaign row's live digest; anything
 * else is refused, so two amendments can never race on stale bases.
 */
export function applyAmendment(
	store: CampaignStateStore,
	input: { amendment: unknown; nowMs: number },
): AmendmentApplyResult {
	const { amendment, digest } = validateCampaignAmendment(input.amendment, { nowMs: input.nowMs });

	const alreadyApplied = store.events.getAmendmentByDigest(digest);
	if (alreadyApplied !== null) {
		const campaign = store.campaigns.getCampaign(alreadyApplied.campaignId);
		if (campaign !== null) {
			return {
				campaign,
				manifestDigest: campaign.manifestDigest,
				applied: false,
				amendedFields: [],
				appendedIssues: [],
				invalidatedActionIds: [],
				appendedWorkItems: [],
			};
		}
	}

	const { campaign, base } = resolveBaseCampaign(store, amendment);

	const appended = requireAppendableIssues(base, amendment);

	const nextManifest = composeNextManifest(base, amendment);
	const { approval: _bound, ...unapproved } = nextManifest;
	const nextDigest = digestOf(unapproved);
	// Full fail-closed re-validation proves the digest binds, the caps
	// layer, the expiry is in the future, and every manifest invariant
	// still holds over the amended content. The amendment's own approval
	// envelope becomes the new manifest's approval envelope: the operator
	// who signed the amendment signed exactly this content.
	const validated = validateCampaignManifest(
		{
			...nextManifest,
			approval: {
				approvedBy: amendment.approval.approvedBy,
				approvedAt: amendment.approval.approvedAt,
				manifestDigest: nextDigest,
			},
		},
		{ nowMs: input.nowMs },
	);
	const finalManifest = validated.manifest;

	// Idempotence on the resulting digest too: if some amendment already
	// produced exactly this manifest, re-applying changes nothing.
	const existingVersion = store.campaigns.getCampaignByDigest(nextDigest);
	if (existingVersion !== null) {
		return {
			campaign: existingVersion,
			manifestDigest: nextDigest,
			applied: false,
			amendedFields: [],
			appendedIssues: [],
			invalidatedActionIds: [],
			appendedWorkItems: [],
		};
	}

	const amendedFields = [
		...(amendment.appendIssues !== undefined ? ["appendIssues"] : []),
		...(amendment.budget !== undefined ? ["budget"] : []),
		...(amendment.prompt !== undefined ? ["prompt"] : []),
		...(amendment.promptDigest !== undefined ? ["promptDigest"] : []),
		...(amendment.maxConcurrentRuns !== undefined ? ["maxConcurrentRuns"] : []),
		...(amendment.expiresAt !== undefined ? ["expiresAt"] : []),
	];

	const priorWorkItems = store.campaigns.listWorkItems(campaign.id);
	const nextPosition = priorWorkItems.reduce((max, item) => Math.max(max, item.position), 0);

	return store.transaction(() => {
		store.campaigns.updateManifestInPlace(campaign.id, {
			manifestDigest: nextDigest,
			manifestJson: JSON.stringify(finalManifest),
			budgetCapUsdCents: usdToCents(finalManifest.budget.totalUsd),
		});
		// A completed campaign re-opens with its appended work; an
		// awaiting_approval row is approved by the amendment's approval.
		if (campaign.status === "completed" || campaign.status === "awaiting_approval") {
			store.campaigns.setCampaignStatus(campaign.id, "approved");
		}
		if (campaign.approvedAtMs === null) {
			store.campaigns.stampApproval(campaign.id, Date.parse(amendment.approval.approvedAt));
		}
		// Deterministic policy: planned (never-executed) intents of the old
		// version are invalidated; executing ones stay with the dispatcher.
		const invalidated = invalidatePlannedActions(store, campaign.id, amendment, nextDigest);
		// Appended issues become the trailing work items, in order.
		const appendedItems = appended.map((issue, index) =>
			store.campaigns.addWorkItem({
				campaignId: campaign.id,
				position: nextPosition + index + 1,
				issueRef: String(issue),
				status: "candidate",
			}),
		);
		// The amendment is journaled append-only; nothing about it ever
		// rewinds, and a superseded attention row is deliberately NOT
		// created for a clean amendment.
		store.events.recordAmendment({
			campaignId: campaign.id,
			amendmentId: amendment.amendmentId,
			amendmentDigest: digest,
			previousManifestDigest: amendment.baseManifestDigest,
			newManifestDigest: nextDigest,
			amendmentJson: JSON.stringify(amendment),
		});
		const updated = store.campaigns.getCampaign(campaign.id) as CampaignRow;
		return {
			campaign: updated,
			manifestDigest: nextDigest,
			applied: true,
			amendedFields,
			appendedIssues: appended,
			invalidatedActionIds: invalidated,
			appendedWorkItems: appendedItems,
		};
	});
}
