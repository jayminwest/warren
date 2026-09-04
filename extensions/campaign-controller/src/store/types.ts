/**
 * Durable-state vocabulary for the campaign controller store.
 *
 * These are controller-local wire shapes (plan pl-91b6 step 3, warren-2853).
 * The package never imports warren's `src/core/wire.ts` — the layer guard
 * forbids it — so every enum-shaped value the store persists is defined here
 * once and re-exported through `src/index.ts`.
 */

/** Campaign lifecycle states (design record §6.1). */
export type CampaignStatus =
	| "draft"
	| "validating"
	| "awaiting_approval"
	| "approved"
	| "running"
	| "paused_operator"
	| "paused_budget"
	| "needs_attention"
	| "completed"
	| "failed"
	| "cancelled";

/** Work-item lifecycle states (design record §6.2, common subset). */
export type WorkItemStatus =
	| "candidate"
	| "admitted"
	| "ready"
	| "dispatch_intent"
	| "dispatched"
	| "running"
	| "terminal"
	| "pr_open"
	| "checks_pending"
	| "merge_ready"
	| "merged"
	| "verifying"
	| "completed"
	| "dispatch_uncertain"
	| "needs_attention"
	| "retry_pending"
	| "repair_pending"
	| "repairing"
	| "paused"
	| "failed"
	| "cancelled";

/** Terminal PR outcome for a work item (warren-7cd1). */
export type WorkItemOutcome = "merged" | "closed_unmerged";

/**
 * Action-journal states (design record §6.3). `planned` is committed before
 * the caller performs any I/O; terminal states never transition again.
 */
export type ActionState =
	| "planned"
	| "executing"
	| "succeeded"
	| "uncertain"
	| "retryable_failure"
	| "permanent_failure";

/** Terminal action states — once written, the row is frozen. */
export const TERMINAL_ACTION_STATES: readonly ActionState[] = [
	"succeeded",
	"uncertain",
	"retryable_failure",
	"permanent_failure",
];

/** Structured error classification for a settled action. */
export type ActionErrorClass =
	| "network"
	| "timeout"
	| "ambiguous_response"
	| "warren_rejected"
	| "github_rejected"
	| "run_failed"
	| "policy_violation"
	| "dispatch_rejected"
	| "unknown";

/** Budget reservation lifecycle. */
export type ReservationState = "active" | "settled" | "released";

/** A persisted campaign row. */
export interface CampaignRow {
	readonly id: string;
	readonly status: CampaignStatus;
	readonly manifestDigest: string;
	/** Immutable manifest JSON as approved. Approval binds this digest. */
	readonly manifestJson: string;
	readonly policyDigest: string | null;
	readonly budgetCapUsdCents: number | null;
	readonly createdAtMs: number;
	readonly updatedAtMs: number;
	readonly approvedAtMs: number | null;
}

/** A persisted ordered work item. */
export interface WorkItemRow {
	readonly id: string;
	readonly campaignId: string;
	readonly position: number;
	/** Issue (or replay-case) reference, opaque to the store. */
	readonly issueRef: string;
	readonly status: WorkItemStatus;
	/** Terminal PR outcome; null until reconcile flips it (exactly once). */
	readonly outcome: WorkItemOutcome | null;
	readonly outcomeAtMs: number | null;
	readonly createdAtMs: number;
	readonly updatedAtMs: number;
}

/** A persisted action-journal row. */
export interface ActionRow {
	readonly id: string;
	/** Deterministic key: same logical effect, same key, exactly one row. */
	readonly actionKey: string;
	readonly campaignId: string;
	readonly workItemId: string | null;
	/** e.g. "warren_dispatch" | "pr_intent" | ... — policy defines the set. */
	readonly actionType: string;
	readonly requestDigest: string;
	readonly policyDigest: string | null;
	readonly state: ActionState;
	readonly attempt: number;
	readonly reservedUsdCents: number | null;
	readonly startedAtMs: number | null;
	readonly settledAtMs: number | null;
	readonly resultRunId: string | null;
	readonly resultPlanRunId: string | null;
	readonly resultBranch: string | null;
	readonly resultPrNumber: number | null;
	readonly errorClass: ActionErrorClass | null;
	readonly errorJson: string | null;
	readonly createdAtMs: number;
	readonly updatedAtMs: number;
}

/** Warren run correlation (design record §14.8 stays controller-local). */
export interface RunLinkRow {
	readonly runId: string;
	readonly planRunId: string | null;
	readonly campaignId: string;
	readonly workItemId: string | null;
	readonly actionId: string | null;
	readonly branch: string | null;
	readonly linkedAtMs: number;
}

/** Prospective/upstream cross-fork PR identity (dry-run rendered, never posted). */
export interface PrIdentityRow {
	readonly id: string;
	readonly campaignId: string;
	readonly workItemId: string;
	readonly upstreamOwner: string;
	readonly upstreamRepo: string;
	readonly forkOwner: string;
	readonly forkRepo: string;
	readonly headBranch: string;
	readonly title: string | null;
	readonly bodyDigest: string | null;
	readonly prNumber: number | null;
	readonly prUrl: string | null;
	readonly createdAtMs: number;
}

/** A journaled, applied campaign amendment (warren-35c4). Append-only. */
export interface AmendmentRow {
	readonly id: string;
	readonly campaignId: string;
	readonly amendmentId: string;
	/** UNIQUE: the same approved amendment journals exactly once. */
	readonly amendmentDigest: string;
	readonly previousManifestDigest: string;
	readonly newManifestDigest: string;
	readonly amendmentJson: string;
	readonly appliedAtMs: number;
}

/** A deduplicated upstream source event keyed by stable GitHub node id. */
export interface GithubEventRow {
	readonly nodeId: string;
	readonly campaignId: string;
	readonly eventKind: string;
	readonly payloadJson: string;
	readonly observedAtMs: number;
}

/** A durable human-attention queue entry. */
export interface AttentionItemRow {
	readonly id: string;
	readonly campaignId: string;
	readonly workItemId: string | null;
	readonly reason: string;
	readonly detailJson: string | null;
	readonly createdAtMs: number;
	readonly resolvedAtMs: number | null;
}

/** One classified review-feedback row, deduplicated by its source event. */
export interface ReviewFeedbackRow {
	readonly id: string;
	readonly campaignId: string;
	readonly workItemId: string | null;
	readonly category: string;
	readonly sourceEventNodeId: string;
	readonly fieldsJson: string;
	readonly createdAtMs: number;
}

/** Follow-up loop progress for one work item (warren-0ad3). */
export interface FollowUpProgressRow {
	readonly workItemId: string;
	readonly campaignId: string;
	/** Feedback row ids the loop already responded to. */
	readonly addressedFeedbackIds: readonly string[];
	/** Fingerprint of the findings the last response covered. */
	readonly lastRespondedFingerprint: string | null;
	/** How many follow-up runs already responded. */
	readonly iteration: number;
	/** The journaled follow-up action currently in flight, if any. */
	readonly activeActionId: string | null;
	readonly runId: string | null;
	readonly headBranch: string | null;
	readonly createdAtMs: number;
	readonly updatedAtMs: number;
}

/** A budget reservation in the campaign ledger. */
export interface ReservationRow {
	readonly id: string;
	readonly campaignId: string;
	readonly actionId: string | null;
	readonly amountUsdCents: number;
	readonly state: ReservationState;
	readonly settledUsdCents: number | null;
	readonly createdAtMs: number;
	readonly settledAtMs: number | null;
}

/** A leased work claim (design record §9). */
export interface LeaseRow {
	readonly scope: string;
	readonly holder: string;
	readonly acquiredAtMs: number;
	readonly expiresAtMs: number;
}
