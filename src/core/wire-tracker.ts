/**
 * The IssueTracker seam's wire vocabulary (warren-6c29, plan pl-a37b
 * Track B step 1). Split out of ./wire.ts for the file-size budget and
 * re-exported from there, so `src/core/wire.ts` stays the one canonical
 * home. `src/core/` imports nothing — this module must stay
 * dependency-free.
 *
 * These are NEUTRAL DTOs: they describe an issue tracker (issues, plans,
 * statuses) without naming seeds. The SeedsTracker implementation
 * (`src/tracker/seeds-tracker.ts`) maps the seeds CLI envelopes onto
 * these shapes; a future tracker (e.g. GitHub Issues) maps onto the same
 * ones. Nothing in this module may import or reference seeds.
 */

import { WarrenError } from "./errors.ts";

/**
 * Normalized issue lifecycle. Trackers disagree on the in-flight
 * vocabulary (`in_progress`, `in review`, …) but every consumer today
 * branches on a single binary — "is this issue closed?" — which is why
 * warren compared the raw status string to the literal `'closed'` in six
 * places before this union existed. Anything not exactly `'open'` or
 * `'closed'` normalizes to `'other'` via {@link normalizeIssueStatus},
 * preserving that binary without claiming to understand each tracker's
 * intermediate states.
 */
export const ISSUE_STATUSES = ["open", "closed", "other"] as const;
export type IssueStatus = (typeof ISSUE_STATUSES)[number];

/** Membership predicate for {@link ISSUE_STATUSES}. */
export function isIssueStatus(value: unknown): value is IssueStatus {
	return typeof value === "string" && (ISSUE_STATUSES as readonly string[]).includes(value);
}

/**
 * Normalize a tracker's raw status string onto {@link IssueStatus}.
 * Exact `'open'` and `'closed'` pass through; every other value — seeds'
 * `in_progress`, GitHub's reopened/duplicate closures, anything a future
 * tracker invents — folds to `'other'`, which is neither closed nor
 * claimably-open.
 */
export function normalizeIssueStatus(raw: string): IssueStatus {
	if (raw === "closed") return "closed";
	if (raw === "open") return "open";
	return "other";
}

/**
 * Plan lifecycle states. Mirrors seeds' `VALID_PLAN_STATUSES`
 * (`draft | approved | active | done`); warren's plan-run coordinator
 * accepts `approved`, `active`, and `done`
 * (`PLAN_RUN_ACCEPTED_PLAN_STATUSES` in `src/plan-runs/create.ts`).
 */
export const PLAN_STATUSES = ["draft", "approved", "active", "done"] as const;
export type PlanStatus = (typeof PLAN_STATUSES)[number];

/** Membership predicate for {@link PLAN_STATUSES}. */
export function isPlanStatus(value: unknown): value is PlanStatus {
	return typeof value === "string" && (PLAN_STATUSES as readonly string[]).includes(value);
}

/**
 * A single issue in the project's tracker. Neutral projection of what
 * warren reads today (`sd show <id> --json`): the coordinator branches on
 * `status`, dispatch prompts inline `title` + `description`, and
 * resume logic reads `blockedBy`. `metadata` is the tracker's
 * extension/metadata record (seeds: `extensions`), passed through
 * untyped.
 */
export interface Issue {
	readonly id: string;
	readonly status: IssueStatus;
	readonly title?: string;
	readonly description?: string;
	readonly blockedBy?: readonly string[];
	readonly metadata?: Readonly<Record<string, unknown>>;
}

/**
 * Wire-lean plan summary — the projection a plan-id selector renders
 * (id/name/status + child count). The heavyweight `sections` body is
 * dropped at the tracker boundary because no list consumer renders it.
 */
export interface PlanSummary {
	readonly id: string;
	readonly status: PlanStatus;
	readonly seed?: string;
	readonly template?: string;
	readonly revision?: number;
	readonly name?: string;
	readonly childCount: number;
	readonly createdAt?: string;
	readonly updatedAt?: string;
}

/**
 * One step of a plan's blocks-DAG. `title` is absent on adoption-only
 * steps, whose work is an existing seed referenced by `existingSeed`.
 * `blocks` uses forward semantics: step i with `blocks: [j]` means step i
 * blocks step j.
 */
export interface PlanStep {
	readonly title?: string;
	readonly existingSeed?: string;
	readonly blocks?: readonly number[];
}

/** A full plan read, including the ordered child ids and the step DAG. */
export interface Plan {
	readonly id: string;
	readonly status: PlanStatus;
	readonly children: readonly string[];
	readonly steps?: readonly PlanStep[];
}

/**
 * An issue carrying a parseable `scheduledFor` timestamp, whatever its
 * past/future direction — the caller decides what is due.
 */
export interface ScheduledIssue {
	readonly id: string;
	readonly status: IssueStatus;
	readonly title?: string;
	readonly scheduledFor: Date;
}

/**
 * Per-call context for the IssueTracker seam. `projectId` is the warren
 * project id; `localPath` is the tracker's on-disk root and is only
 * meaningful for git-native trackers (seeds resolves `.seeds/` relative
 * to cwd) — a hosted tracker ignores it and `localPath` stays optional
 * so the neutral contract does not require it.
 */
export interface TrackerContext {
	readonly projectId: string;
	readonly localPath?: string;
}

/**
 * Base failure for the IssueTracker seam: the tracker could not answer a
 * request (binary missing, non-zero exit, malformed payload, missing
 * context). Subclasses carry the discriminating cases callers branch on.
 */
export class TrackerError extends WarrenError {
	readonly code: string = "tracker_error";
}

/**
 * Definitive "this issue does not exist" failure. Thrown by
 * `IssueTracker.getIssue` when the tracker terminal-reports a missing
 * id, so callers can fail terminally instead of retrying a transient
 * shell-out failure.
 */
export class IssueNotFoundError extends TrackerError {
	override readonly code = "issue_not_found";
}
