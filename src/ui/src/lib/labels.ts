/**
 * Visitor-facing labels for warren's wire vocabulary (warren-14fc / #641).
 *
 * Warren serves a PUBLIC read-only dashboard, so anything a component
 * renders straight off the wire is read by anonymous visitors. Several
 * surfaces were printing the raw discriminator — `finalize_failed`,
 * `pr_closed_without_merge` — or internal shorthand (`2p / 0i / 3m / 1f`).
 * This module is the ONE place a wire value becomes prose; call it instead
 * of inlining a string literal in a component.
 *
 * Two rules the call sites follow:
 *
 *   - The raw value always survives in a `title` tooltip, so an operator
 *     can still read the discriminator the server actually recorded.
 *   - Unknown values degrade through `humanizeWireValue` rather than
 *     leaking underscores, so a reason added server-side before this UI
 *     ships still reads as prose.
 *
 * Status-PILL labels are deliberately NOT here: `components/status-indicator.tsx`
 * is already the single registry for `{label, variant, icon, pulse}`, and a
 * second copy of those labels is exactly the drift this file exists to
 * prevent. It imports `humanizeWireValue` for its unknown-status fallback.
 */
import type { PlanRunChildState, PullRequestLifecycle, RunFailureReason } from "@/api/types.ts";

/**
 * Snake-case words that read wrong when merely capitalised. Kept tiny on
 * purpose — this is a display nicety, not a dictionary.
 */
const ACRONYMS: Readonly<Record<string, string>> = { pr: "PR" };

/**
 * Generic fallback: `no_model_response` → `No model response`,
 * `pr_open` → `PR open`. Used wherever an explicit map has no entry.
 */
export function humanizeWireValue(raw: string): string {
	const words = raw.split("_").filter((w) => w.length > 0);
	if (words.length === 0) return raw;
	return words
		.map((w, i) => ACRONYMS[w] ?? (i === 0 ? `${w.charAt(0).toUpperCase()}${w.slice(1)}` : w))
		.join(" ");
}

/**
 * `RunFailureReason` → prose. Annotated `Record<string, string>` so a
 * lookup with an arbitrary wire string type-checks, and `satisfies` so the
 * compiler still fails the build when `src/core/wire.ts` grows a reason
 * this map does not carry.
 *
 * `sandbox_run_lost` / `sandbox_unreachable` say "sandbox", not "burrow":
 * burrow is the LocalProvider's substrate, an implementation detail a
 * visitor has no name for. The raw value stays in the tooltip.
 */
const RUN_FAILURE_REASON_LABELS: Readonly<Record<string, string>> = {
	never_started: "Never started",
	no_model_response: "No model response",
	sandbox_failed: "Sandbox failed",
	spawn_failed: "Spawn failed",
	crashed: "Crashed",
	agent_died: "Agent died",
	timed_out: "Timed out",
	sandbox_run_lost: "Sandbox run lost",
	sandbox_unreachable: "Sandbox unreachable",
	dropped_commit: "Dropped commit",
	no_changes: "No changes",
	finalize_failed: "Finalize failed",
	push_rejected_policy: "Push blocked by repository policy",
	finalize_unposted: "Finalize not posted",
	provider_error: "Provider error",
	oom_killed: "Out of memory",
	evicted: "Evicted",
	preempted: "Preempted (Spot node reclaimed)",
} satisfies Record<RunFailureReason, string>;

/** Prose for a run's `failureReason`. */
export function formatRunFailureReason(reason: string): string {
	return RUN_FAILURE_REASON_LABELS[reason] ?? humanizeWireValue(reason);
}

/**
 * `PullRequestLifecycle` → prose (warren-0993). Same shape as the
 * failure-reason map: `satisfies` so the compiler fails the build when
 * `PULL_REQUEST_LIFECYCLES` grows a value this map does not carry.
 */
const PULL_REQUEST_LIFECYCLE_LABELS: Readonly<Record<string, string>> = {
	open: "Open",
	merged: "Merged",
	closed_unmerged: "Closed without merging",
} satisfies Record<PullRequestLifecycle, string>;

/** Prose for a pull request's `lifecycle`. */
export function formatPullRequestLifecycle(lifecycle: string): string {
	return PULL_REQUEST_LIFECYCLE_LABELS[lifecycle] ?? humanizeWireValue(lifecycle);
}

/**
 * Plan-run failure text is NOT an enum — the coordinator writes free-form
 * `reason` or `reason:detail` strings (`pr_closed_without_merge`,
 * `dispatch_failed:burrow unreachable`, `child_seed_not_found:warren-a`).
 * There is no closed set to map exhaustively, so humanize the
 * discriminator half and keep the detail verbatim in parentheses.
 */
export function formatPlanRunFailureReason(reason: string): string {
	const sep = reason.indexOf(":");
	if (sep === -1) return humanizeWireValue(reason);
	const label = humanizeWireValue(reason.slice(0, sep));
	const detail = reason.slice(sep + 1).trim();
	return detail.length === 0 ? label : `${label} (${detail})`;
}

/**
 * Buckets for the plan-run child rollup, in display order. The list page
 * used to render these as `2p / 0i / 3m / 1f` — undocumented single-letter
 * jargon in a public table.
 *
 * `skipped` gets its own bucket rather than being folded into `merged`
 * (which is what the letter form did): once the counts are spelled out,
 * calling a child that was never dispatched "merged" is simply wrong.
 *
 * Container shape follows the `src/core/wire.ts` convention — a frozen
 * `as const` tuple with the union derived FROM it, so display order is
 * complete by construction and `Record<ChildBucket, …>` makes the
 * compiler demand a label and a counter for every bucket.
 */
const CHILD_BUCKET_ORDER = ["pending", "inflight", "merged", "skipped", "failed"] as const;
type ChildBucket = (typeof CHILD_BUCKET_ORDER)[number];

const CHILD_BUCKET_LABELS: Record<ChildBucket, string> = {
	pending: "pending",
	inflight: "in flight",
	merged: "merged",
	skipped: "skipped",
	failed: "failed",
};

function bucketFor(state: PlanRunChildState): ChildBucket {
	switch (state) {
		case "pending":
			return "pending";
		case "dispatched":
		case "running":
		case "pr_open":
			return "inflight";
		case "merged":
			return "merged";
		case "skipped":
			return "skipped";
		case "failed":
			return "failed";
	}
}

export interface ChildStateSummary {
	/** Cell text — non-empty buckets only, e.g. `2 pending · 3 merged`. */
	text: string;
	/** Tooltip — the full breakdown, including the empty buckets. */
	title: string;
}

/** Roll a plan-run's children up into a readable count line plus tooltip. */
export function formatChildStateCounts(
	children: readonly { state: PlanRunChildState }[],
): ChildStateSummary {
	const counts: Record<ChildBucket, number> = {
		pending: 0,
		inflight: 0,
		merged: 0,
		skipped: 0,
		failed: 0,
	};
	for (const c of children) counts[bucketFor(c.state)] += 1;

	const phrase = (b: ChildBucket): string => `${counts[b]} ${CHILD_BUCKET_LABELS[b]}`;
	const nonEmpty = CHILD_BUCKET_ORDER.filter((b) => counts[b] > 0);
	if (nonEmpty.length === 0) {
		return { text: "—", title: "No child seeds yet" };
	}
	return {
		text: nonEmpty.map(phrase).join(" · "),
		title: `${children.length} child seed${children.length === 1 ? "" : "s"}: ${CHILD_BUCKET_ORDER.map(phrase).join(", ")}`,
	};
}
