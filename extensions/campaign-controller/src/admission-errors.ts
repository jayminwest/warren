/**
 * The refusal error for campaign admission (plan pl-91b6 step 6,
 * warren-a252).
 *
 * Every refusal names the exact invariant that failed through the stable
 * `invariant` discriminator, so the CLI (and tests) never string-match
 * prose. Refusals carry no secret by construction: their inputs are
 * digests, ids, coordinates, and counts.
 */
import type { CampaignControllerErrorCode } from "./errors.ts";
import { CampaignControllerError } from "./errors.ts";

/** The exact invariant an admission (or approval) refused on. */
export type AdmissionInvariant =
	| "campaign_unknown"
	| "campaign_not_approved"
	| "campaign_not_awaiting_approval"
	| "campaign_expired"
	| "campaign_invalid"
	| "approval_digest_mismatch"
	| "approver_mismatch"
	| "policy_invalid"
	| "policy_stale"
	| "policy_changed"
	| "policy_upstream_mismatch"
	| "issue_not_in_campaign"
	| "evidence_tier_unknown"
	| "issue_out_of_order"
	| "issue_already_admitted"
	| "issue_repository_not_allowed"
	| "mutation_flag_enabled"
	| "protected_path"
	| "warren_target_invalid"
	| "budget_caps_invalid"
	| "budget_insufficient"
	| "daily_budget_exhausted"
	| "concurrency_exceeded"
	| "attempt_already_active";

/** A refused admission/approval. `invariant` names the failed rule. */
export class AdmissionRefusal extends CampaignControllerError {
	readonly invariant: AdmissionInvariant;

	constructor(invariant: AdmissionInvariant, message: string, options?: { cause?: unknown }) {
		super("admission_refused" satisfies CampaignControllerErrorCode, message, options);
		this.name = "AdmissionRefusal";
		this.invariant = invariant;
	}

	override toJson(): {
		error: string;
		code: CampaignControllerErrorCode;
		invariant: AdmissionInvariant;
		message: string;
	} {
		return { ...super.toJson(), invariant: this.invariant };
	}
}
