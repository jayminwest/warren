/**
 * The IssueTracker contract (warren-6c29, plan pl-a37b Track B step 1).
 *
 * Seeds is implementation #1 behind this seam, never a structural
 * dependency (docs/PHILOSOPHY.md: "no issue-tracker monoculture"). The
 * DTOs are neutral and live in `src/core/wire-tracker.ts`; this module
 * declares the behavior surface every tracker implementation answers to.
 *
 * This PR cuts the contract only — no call-site porting. The existing
 * `src/seeds-cli/` facade keeps working as-is; `SeedsTracker`
 * (`src/tracker/seeds-tracker.ts`) wraps it 1:1. Swapping ServerDeps
 * onto the seam is the next issue (warren-5819).
 *
 * Error contract: implementations surface every failure as a
 * `TrackerError` subclass (`src/core/wire-tracker.ts`) — `TrackerError`
 * for transient/operational failures, `IssueNotFoundError` for the
 * definitive missing-id case.
 */

import type {
	Issue,
	IssueStatus,
	Plan,
	PlanSummary,
	ScheduledIssue,
	TrackerContext,
} from "../core/wire.ts";

// The DTO vocabulary is re-exported beside the contract so consumers of
// the seam have one import surface (`src/tracker/contract.ts`) without
// the contract redeclaring anything — the canonical declarations stay in
// `src/core/wire.ts` (warren-b229 / check:wire-types).
export type {
	Issue,
	IssueNotFoundError,
	IssueStatus,
	Plan,
	PlanStatus,
	PlanStep,
	PlanSummary,
	ScheduledIssue,
	TrackerContext,
	TrackerError,
} from "../core/wire.ts";

/**
 * What a tracker can do. Callers branch on these flags instead of
 * sniffing the implementation, so a tracker that lacks a capability
 * fails loudly ("tracker does not support plans") rather than silently
 * no-op-ing.
 */
export interface TrackerCapabilities {
	/** listPlans / getPlan are implemented. */
	readonly supportsPlans: boolean;
	/** mergeIssueMetadata is implemented. */
	readonly supportsMetadata: boolean;
	/** listScheduledIssues is implemented. */
	readonly supportsScheduledIssues: boolean;
	/** The tracker state lives in the project's git checkout (seeds) vs. a host (GitHub Issues). */
	readonly isGitNative: boolean;
}

/**
 * The base IssueTracker surface every implementation must provide.
 */
export interface IssueTracker {
	readonly capabilities: TrackerCapabilities;

	/** Read a single issue. Throws {@link IssueNotFoundError} for a missing id. */
	getIssue(ctx: TrackerContext, issueId: string): Promise<Issue>;

	/**
	 * Resolve an `id → status` map for every issue in the project, with
	 * statuses normalized onto {@link IssueStatus}.
	 */
	listIssueStatuses(ctx: TrackerContext): Promise<ReadonlyMap<string, IssueStatus>>;

	/**
	 * Close an issue. Idempotent — closing an already-closed issue is a
	 * success, not an error.
	 */
	closeIssue(ctx: TrackerContext, issueId: string): Promise<void>;
}

/**
 * Plans capability: trackers whose issues can be grouped into ordered
 * plans (seeds: `sd plan`).
 */
export interface PlanCapableTracker {
	/** Wire-lean plan summaries for the plan-id selector surfaces. */
	listPlans(ctx: TrackerContext): Promise<readonly PlanSummary[]>;

	/** Read a plan's id/status/children + step blocks-DAG. */
	getPlan(ctx: TrackerContext, planId: string): Promise<Plan>;
}

/**
 * Metadata capability. The merge semantics ARE the contract, taken from
 * seeds because seeds is implementation #1:
 *
 *   - SHALLOW MERGE — only the keys present in `metadata` are touched;
 *     keys absent from the payload are left alone, and concurrent edits
 *     to disjoint keys are safe.
 *   - `null` CLEARS — an explicit `null` value removes the key.
 *
 * Implementations may restrict the writable key set (seeds restricts
 * writes to the warren-namespaced extension keys); a payload outside the
 * permitted set fails with a `TrackerError`.
 */
export interface MetadataCapableTracker {
	mergeIssueMetadata(
		ctx: TrackerContext,
		issueId: string,
		metadata: Readonly<Record<string, unknown>>,
	): Promise<void>;
}

/**
 * Scheduled-issues capability: trackers whose issues can carry a
 * `scheduledFor` timestamp (the cron tick's dispatch arm).
 */
export interface ScheduledIssueCapableTracker {
	/**
	 * Open issues with a parseable `scheduledFor`, regardless of
	 * past/future — the caller decides which entries are due.
	 */
	listScheduledIssues(ctx: TrackerContext): Promise<readonly ScheduledIssue[]>;
}
