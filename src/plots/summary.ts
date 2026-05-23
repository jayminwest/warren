/**
 * `summarizePlot` — pure derivation of the curated "Plot summary
 * artifact" payload returned by `GET /plots/:id/summary`
 * (warren-8917 / pl-0344 step 15).
 *
 * The summary view is institutional memory: it reads the full Plot
 * envelope and projects a clean, durable shape callers can render as a
 * standalone artifact page. No IO of its own — the handler opens the
 * underlying `.plot/` directory via the existing `plotReader` seam and
 * hands the result to this function.
 *
 * Shape (matches `PlotSummaryArtifact` on the wire):
 *   - `id`, `name`, `status`, `project_id` — Plot identity.
 *   - `intent`              — the formatted intent body, unchanged.
 *   - `created_at`          — `at` of the first `plot_created` event.
 *   - `last_event_at`       — `at` of the most recent event.
 *   - `done_at`             — `at` of the latest `status_changed` whose
 *     `data.to === "done"`, or `null` when never transitioned to done.
 *   - `decisions[]`         — every `decision_made` event projected to
 *     `{at, actor, summary, rationale?}`, ascending by `at`.
 *   - `linked_prs[]`        — every `gh_pr` attachment projected to a
 *     PR-shaped row with `merged_at` filled from any subsequent
 *     `note` carrying `{kind: "pr_merged", ref}` (the click-to-merge
 *     audit trail from warren-8e39 emits this fragment).
 *   - `linked_commits[]`    — every `artifact_produced` event whose
 *     `data.type === "commit"`, projected to `{at, ref, actor}`.
 *   - `linked_seeds[]`      — every `seeds_issue` attachment projected
 *     to `{ref, role, added_at, added_by, attachment_id}`.
 *   - `timeline[]`          — curated event projection in ascending
 *     order. Includes `plot_created`, every `status_changed`, every
 *     `decision_made`, every `question_posed`, every
 *     `question_answered`, every `attachment_added`, every
 *     `run_dispatched`, every `plan_run_dispatched`, every
 *     `artifact_produced`. Excludes `intent_edited` and `note` to keep
 *     the artifact view at the structural-event grain. Each row carries
 *     `{at, actor, kind, label}` — `label` is a short human-facing
 *     line derived from the event payload.
 *
 * The function is fully synchronous and deterministic; the handler
 * just wraps it around the reader's output.
 */

import type { Attachment, Intent, PlotEvent, PlotStatus } from "@os-eco/plot-cli";

export interface PlotSummaryDecision {
	readonly at: string;
	readonly actor: string;
	readonly summary: string;
	readonly rationale?: string;
}

export interface PlotSummaryLinkedPr {
	readonly attachment_id: string;
	readonly ref: string;
	readonly role: string;
	readonly added_at: string;
	readonly added_by: string;
	/** ISO 8601 of the merge `note` event, or `null` when not merged. */
	readonly merged_at: string | null;
}

export interface PlotSummaryLinkedCommit {
	readonly at: string;
	readonly ref: string;
	readonly actor: string;
}

export interface PlotSummaryLinkedSeed {
	readonly attachment_id: string;
	readonly ref: string;
	readonly role: string;
	readonly added_at: string;
	readonly added_by: string;
}

export const TIMELINE_KINDS = [
	"plot_created",
	"status_changed",
	"decision_made",
	"question_posed",
	"question_answered",
	"attachment_added",
	"run_dispatched",
	"plan_run_dispatched",
	"artifact_produced",
] as const;
export type TimelineKind = (typeof TIMELINE_KINDS)[number];

export interface PlotSummaryTimelineEntry {
	readonly at: string;
	readonly actor: string;
	readonly kind: TimelineKind;
	readonly label: string;
}

export interface PlotSummaryArtifact {
	readonly id: string;
	readonly name: string;
	readonly status: PlotStatus;
	readonly project_id: string;
	readonly intent: Intent;
	readonly created_at: string;
	readonly last_event_at: string;
	readonly done_at: string | null;
	readonly decisions: readonly PlotSummaryDecision[];
	readonly linked_prs: readonly PlotSummaryLinkedPr[];
	readonly linked_commits: readonly PlotSummaryLinkedCommit[];
	readonly linked_seeds: readonly PlotSummaryLinkedSeed[];
	readonly timeline: readonly PlotSummaryTimelineEntry[];
}

export interface SummarizePlotInput {
	readonly id: string;
	readonly name: string;
	readonly status: PlotStatus;
	readonly project_id: string;
	readonly intent: Intent;
	readonly attachments: readonly Attachment[];
	readonly event_log: readonly PlotEvent[];
}

const TIMELINE_KIND_SET: ReadonlySet<string> = new Set<TimelineKind>(TIMELINE_KINDS);

export function summarizePlot(input: SummarizePlotInput): PlotSummaryArtifact {
	const events = [...input.event_log].sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));

	const createdEvent = events.find((e) => e.type === "plot_created");
	const created_at = createdEvent?.at ?? events[0]?.at ?? "";
	const last_event_at = events.length > 0 ? (events[events.length - 1]?.at ?? "") : "";

	let done_at: string | null = null;
	for (const e of events) {
		if (e.type !== "status_changed") continue;
		const to = (e.data as { to?: unknown }).to;
		if (to === "done") done_at = e.at;
	}

	const decisions: PlotSummaryDecision[] = events
		.filter((e) => e.type === "decision_made")
		.map((e) => {
			const data = e.data as { summary?: unknown; rationale?: unknown };
			const summary = typeof data.summary === "string" ? data.summary : "";
			const out: PlotSummaryDecision = { at: e.at, actor: e.actor, summary };
			return typeof data.rationale === "string" && data.rationale.length > 0
				? { ...out, rationale: data.rationale }
				: out;
		});

	// PR merge audit trail: warren-8e39's click-to-merge appends a
	// `note` carrying `{kind: "pr_merged", ref}` after the GitHub PUT
	// returns 200. We join per attachment ref so out-of-order events
	// don't matter.
	const mergedPrRefs = new Map<string, string>(); // ref → at (last wins)
	for (const e of events) {
		if (e.type !== "note") continue;
		const data = e.data as { kind?: unknown; ref?: unknown };
		if (data.kind === "pr_merged" && typeof data.ref === "string") {
			mergedPrRefs.set(data.ref, e.at);
		}
	}

	const linked_prs: PlotSummaryLinkedPr[] = input.attachments
		.filter((a) => a.type === "gh_pr")
		.map((a) => ({
			attachment_id: a.id,
			ref: a.ref,
			role: a.role,
			added_at: a.added_at,
			added_by: a.added_by,
			merged_at: mergedPrRefs.get(a.ref) ?? null,
		}));

	const linked_seeds: PlotSummaryLinkedSeed[] = input.attachments
		.filter((a) => a.type === "seeds_issue")
		.map((a) => ({
			attachment_id: a.id,
			ref: a.ref,
			role: a.role,
			added_at: a.added_at,
			added_by: a.added_by,
		}));

	const linked_commits: PlotSummaryLinkedCommit[] = events
		.filter((e) => e.type === "artifact_produced")
		.filter((e) => (e.data as { type?: unknown }).type === "commit")
		.map((e) => {
			const ref = (e.data as { ref?: unknown }).ref;
			return {
				at: e.at,
				ref: typeof ref === "string" ? ref : "",
				actor: e.actor,
			};
		})
		.filter((c) => c.ref.length > 0);

	const timeline: PlotSummaryTimelineEntry[] = events
		.filter((e) => TIMELINE_KIND_SET.has(e.type))
		.map((e) => ({
			at: e.at,
			actor: e.actor,
			kind: e.type as TimelineKind,
			label: labelForEvent(e),
		}));

	return {
		id: input.id,
		name: input.name,
		status: input.status,
		project_id: input.project_id,
		intent: input.intent,
		created_at,
		last_event_at,
		done_at,
		decisions,
		linked_prs,
		linked_commits,
		linked_seeds,
		timeline,
	};
}

/**
 * Best-effort one-line human label for an event payload, used as the
 * `label` column in `timeline[]`. Falls back to the event `type` when
 * the shape doesn't match the known per-type fields — the artifact view
 * stays renderable even if Plot adds new event subtypes.
 */
function labelForEvent(e: PlotEvent): string {
	const data = e.data as Record<string, unknown>;
	switch (e.type) {
		case "plot_created":
			return typeof data.name === "string" ? `Plot created — “${data.name}”` : "Plot created";
		case "status_changed": {
			const from = typeof data.from === "string" ? data.from : "?";
			const to = typeof data.to === "string" ? data.to : "?";
			return `Status: ${from} → ${to}`;
		}
		case "decision_made":
			return typeof data.summary === "string" ? `Decision: ${data.summary}` : "Decision recorded";
		case "question_posed":
			return typeof data.text === "string" ? `Question: ${data.text}` : "Question posed";
		case "question_answered":
			return typeof data.text === "string" ? `Answered: ${data.text}` : "Question answered";
		case "attachment_added": {
			const type = typeof data.type === "string" ? data.type : "attachment";
			const ref = typeof data.ref === "string" ? data.ref : "";
			return ref.length > 0 ? `Attached ${type}: ${ref}` : `Attached ${type}`;
		}
		case "run_dispatched": {
			const runId = typeof data.run_id === "string" ? data.run_id : "?";
			return `Run dispatched: ${runId}`;
		}
		case "plan_run_dispatched": {
			const planRunId = typeof data.plan_run_id === "string" ? data.plan_run_id : "?";
			const count = typeof data.children_count === "number" ? data.children_count : 0;
			return `Plan run dispatched: ${planRunId} (${count} children)`;
		}
		case "artifact_produced": {
			const type = typeof data.type === "string" ? data.type : "artifact";
			const ref = typeof data.ref === "string" ? data.ref : "";
			return ref.length > 0 ? `Produced ${type}: ${ref}` : `Produced ${type}`;
		}
		default:
			return e.type;
	}
}
