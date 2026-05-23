/**
 * Plot "needs attention" signal computation (warren-d693 / pl-0344 step 9).
 *
 * Pure, side-effect-free per-Plot scorer. The aggregator
 * (`./aggregate.ts`) fans out across every `hasPlot=true` project,
 * gathers a small bundle of inputs (the cached `PlotSummary`, the
 * Plot's events, and a snapshot of paused warren runs grouped by
 * `plot_id`), and passes each Plot through `computeNeedsAttentionReasons`
 * to decide whether the deployment-wide "Needs you" filter / sidebar
 * badge should surface it.
 *
 * Three signals (pl-0344 step 9 / SPEC §11.O), each contributing one
 * `NeedsAttentionReason` to the result:
 *
 *   - **paused_run**: at least one warren `runs` row with
 *     `plot_id == plot.id` is in state `paused` (warren-67b6 step 1 /
 *     warren-2976 step 5). These rows have a `paused_question_event_id`
 *     and are awaiting a `question_answered` event on the Plot.
 *
 *   - **merged_pr_unreviewed**: at least one `gh_pr` attachment has
 *     been merged on the host (GitHub side) but no `decision_made` or
 *     `note` event references it after the merge timestamp. The merge
 *     timestamp is sourced from V1.5 click-to-merge state (warren-8e39
 *     / pl-0344 step 14), which records `artifact_produced` events of
 *     the form `{ type: "gh_pr", ref: "owner/repo#N", ... }` on
 *     successful merge. Until step 14 lands, no Plot fires this
 *     signal — the seam is here so the V1 contract is stable.
 *
 *   - **stale_draft**: Plot status is `drafting` and `last_event_ts`
 *     is older than `staleDraftAfterDays` (default 7). Pinned to
 *     `last_event_ts` (not `updated_at`) so an idle conversation in a
 *     brainstorm Plot — where every chat turn appends a `note` /
 *     interactive message event — keeps the draft fresh.
 *
 * The pure helper is exported separately from the aggregator so the
 * unit tests in `./aggregate.test.ts` can exercise it without mocking
 * the disk-backed `UserPlotClient`. The aggregator is responsible for
 * gathering inputs; this module is responsible for the policy.
 */

import type { PlotEvent } from "@os-eco/plot-cli";
import type { PlotSummary } from "./types.ts";

/**
 * The three V1 signals. Order is significant: `reasons` arrays in the
 * `PlotNeedsAttentionSummary` are returned in this canonical order so
 * the UI can render consistent badges regardless of how the underlying
 * signals fired.
 */
export const NEEDS_ATTENTION_REASONS = [
	"paused_run",
	"merged_pr_unreviewed",
	"stale_draft",
] as const;
export type NeedsAttentionReason = (typeof NEEDS_ATTENTION_REASONS)[number];

/**
 * Default stale-draft threshold in days. 7 mirrors the seed spec
 * ("draft Plots with no activity in N days"). Configurable on the
 * aggregator (`PlotAggregatorOptions.staleDraftAfterDays`) so tests
 * can shrink the window and a future per-project knob can override.
 */
export const DEFAULT_STALE_DRAFT_DAYS = 7;

/**
 * Inputs for the per-Plot scorer. Kept narrow so the aggregator can
 * inject precomputed snapshots (the paused-run map is a single
 * `runs.listByState('paused')` query batched across the whole
 * deployment, not a per-Plot fan-out).
 */
export interface NeedsAttentionInputs {
	readonly plot: PlotSummary;
	readonly events: ReadonlyArray<PlotEvent>;
	/**
	 * `true` iff at least one warren `runs` row with this Plot's id is
	 * in state `paused`. Sourced from `runs.listByState('paused')`
	 * grouped by `plot_id` upstream.
	 */
	readonly hasPausedRun: boolean;
	/** Current wall-clock time used for the stale-draft window. */
	readonly now: Date;
	/** Stale-draft window in days. Defaults to `DEFAULT_STALE_DRAFT_DAYS`. */
	readonly staleDraftAfterDays?: number;
}

/**
 * Compute the ordered list of needs-attention reasons for one Plot.
 * Empty array means the Plot does not surface in the "Needs you" view.
 */
export function computeNeedsAttentionReasons(
	inputs: NeedsAttentionInputs,
): readonly NeedsAttentionReason[] {
	const reasons: NeedsAttentionReason[] = [];
	if (inputs.hasPausedRun) {
		reasons.push("paused_run");
	}
	if (hasMergedUnreviewedPr(inputs.events)) {
		reasons.push("merged_pr_unreviewed");
	}
	if (isStaleDraft(inputs)) {
		reasons.push("stale_draft");
	}
	return reasons;
}

/**
 * Detect a `gh_pr` attachment whose merge event has no follow-up
 * review event. V1.5 click-to-merge (warren-8e39) emits an
 * `artifact_produced` event of type `gh_pr` on successful merge; a
 * `decision_made` or `note` event referencing the same PR ref counts
 * as "reviewed" for this signal. Until warren-8e39 lands, no event log
 * carries the merge marker, so this consistently returns `false` —
 * the seam matters more than the predicate here.
 */
function hasMergedUnreviewedPr(events: ReadonlyArray<PlotEvent>): boolean {
	const mergedAt = new Map<string, string>(); // ref → at
	const reviewedRefs = new Set<string>();
	for (const ev of events) {
		if (ev.type === "artifact_produced") {
			const data = ev.data as { type?: string; ref?: string };
			if (data.type === "gh_pr" && typeof data.ref === "string" && data.ref.length > 0) {
				// Last-write-wins on duplicate merges of the same ref.
				mergedAt.set(data.ref, ev.at);
			}
		} else if (ev.type === "decision_made" || ev.type === "note") {
			// Any decision/note that mentions a PR ref after merge counts
			// as the user having weighed in. Keep the match coarse — a
			// substring scan of the canonical `owner/repo#N` ref is enough
			// signal to clear the badge without false negatives.
			const data = ev.data as { summary?: string; text?: string };
			const body = `${data.summary ?? ""} ${data.text ?? ""}`;
			for (const ref of mergedAt.keys()) {
				if (body.includes(ref)) reviewedRefs.add(ref);
			}
		}
	}
	for (const ref of mergedAt.keys()) {
		if (!reviewedRefs.has(ref)) return true;
	}
	return false;
}

function isStaleDraft(inputs: NeedsAttentionInputs): boolean {
	if (inputs.plot.status !== "drafting") return false;
	const days = inputs.staleDraftAfterDays ?? DEFAULT_STALE_DRAFT_DAYS;
	const lastTs = Date.parse(inputs.plot.last_event_ts);
	if (Number.isNaN(lastTs)) return false;
	const ageMs = inputs.now.getTime() - lastTs;
	const thresholdMs = days * 24 * 60 * 60 * 1000;
	return ageMs > thresholdMs;
}
