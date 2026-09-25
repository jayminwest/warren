import type { RunEvent, RunRow } from "@/api/types.ts";
import { isTerminalRunState } from "@/api/types.ts";
import { formatRunFailureReason } from "@/lib/labels.ts";
import { lastEventTsOf, lastStateChangeTypeTs } from "./run-detail-format.ts";

/**
 * The run-detail stage timeline (warren-7d17): one node per lifecycle
 * moment, each placed by the run row's stage timestamps (warren-7116,
 * mx-424525: workspace_ready_at / agent_ready_at / agent_ended_at /
 * reaped_at) with the event stream as the fallback for rows written
 * before those columns existed. Nothing is fabricated: a moment with no
 * observed timestamp is live, failed, skipped, or waiting — never a
 * made-up time. Pure, so the tests drive it directly; stage-timeline.tsx
 * only draws what this returns.
 */

export type StageStatus = "done" | "live" | "failed" | "skipped" | "pending";

export interface Stage {
	readonly key: string;
	readonly label: string;
	/** Epoch ms the stage was reached, or null when never observed. */
	readonly at: number | null;
	readonly status: StageStatus;
	/** Short caption for non-done stages ("In progress", a failure reason). */
	readonly note: string | null;
}

const REAP_KINDS = new Set(["reap.completed", "reap_failed", "reap.orphaned"]);

function ms(iso: string | null | undefined): number | null {
	if (iso === null || iso === undefined) return null;
	const v = Date.parse(iso);
	return Number.isNaN(v) ? null : v;
}

interface Moment {
	key: string;
	label: string;
	at: number | null;
}

function workspaceReadyAt(run: RunRow, events: RunEvent[]): number | null {
	// Three real signals behind the column (warren-57fb): the raw
	// `agent_start` kind, the pi adapter's state_change payload.type form,
	// and run.startedAt — stamped when the agent is claimed.
	return (
		ms(run.workspaceReadyAt) ??
		ms(lastEventTsOf(events, new Set(["agent_start"]))) ??
		ms(lastStateChangeTypeTs(events, "agent_start")) ??
		ms(run.startedAt)
	);
}

function deliveryMoment(run: RunRow, events: RunEvent[], reapedAt: number | null): Moment {
	if (run.prUrl !== null) {
		if (run.prState === "merged") {
			return { key: "delivery", label: "Merged", at: ms(run.prMergedAt) ?? reapedAt };
		}
		const opened = ms(lastEventTsOf(events, new Set(["reap.pr_opened"])));
		return { key: "delivery", label: "PR opened", at: opened ?? reapedAt };
	}
	if ((run.commitsAhead ?? 0) > 0) {
		const pushed = ms(lastEventTsOf(events, new Set(["reap.branch_pushed"])));
		return { key: "delivery", label: "Branch pushed", at: pushed ?? reapedAt };
	}
	return { key: "delivery", label: "Delivered", at: null };
}

function moments(run: RunRow, events: RunEvent[]): Moment[] {
	const terminal = isTerminalRunState(run.state);
	const agentStarted = ms(run.agentReadyAt) ?? ms(run.startedAt);
	// A terminal run's endedAt stands in for agent end only when the agent
	// actually started; a run that never started did not "finish" an agent.
	const agentEnded =
		ms(run.agentEndedAt) ?? (terminal && agentStarted !== null ? ms(run.endedAt) : null);
	const reapedAt = ms(run.reapedAt) ?? ms(lastEventTsOf(events, REAP_KINDS));
	return [
		{ key: "queued", label: "Queued", at: run.createdAt ?? ms(run.startedAt) },
		{ key: "workspace", label: "Workspace ready", at: workspaceReadyAt(run, events) },
		{ key: "agent", label: "Agent started", at: agentStarted },
		{ key: "agent-end", label: "Agent finished", at: agentEnded },
		{ key: "reap", label: "Finalized", at: reapedAt },
		deliveryMoment(run, events, reapedAt),
	];
}

function failureNote(run: RunRow): string {
	if (run.state === "cancelled") return "Cancelled";
	return run.failureReason !== null ? formatRunFailureReason(run.failureReason) : "Failed";
}

function statusOf(
	i: number,
	m: Moment,
	lastDone: number,
	run: RunRow,
): { status: StageStatus; note: string | null } {
	if (m.at !== null) return { status: "done", note: null };
	if (i < lastDone) return { status: "skipped", note: "Not reported" };
	const terminal = isTerminalRunState(run.state);
	if (!terminal) {
		return i === lastDone + 1
			? { status: "live", note: "In progress" }
			: { status: "pending", note: null };
	}
	const failed = run.state === "failed" || run.state === "cancelled";
	if (failed && i === lastDone + 1) return { status: "failed", note: failureNote(run) };
	return { status: "skipped", note: m.key === "delivery" ? "Nothing delivered" : null };
}

export function deriveStages(run: RunRow, events: RunEvent[]): Stage[] {
	const list = moments(run, events);
	let lastDone = -1;
	list.forEach((m, i) => {
		if (m.at !== null) lastDone = i;
	});
	const stages = list.map((m, i) => ({ ...m, ...statusOf(i, m, lastDone, run) }));
	// A failed run whose every moment was observed still failed somewhere:
	// mark the last one so the timeline never reads as a clean success.
	const failed = run.state === "failed" || run.state === "cancelled";
	if (failed && !stages.some((s) => s.status === "failed")) {
		const last = stages[lastDone];
		if (last !== undefined)
			stages[lastDone] = { ...last, status: "failed", note: failureNote(run) };
	}
	return stages;
}

/**
 * The span on the connector after stage `i`: the gap to the next observed
 * stage, or — while the next stage is live — the time elapsed so far.
 */
export function connectorSpan(
	stages: readonly Stage[],
	i: number,
	now: number,
): { ms: number | null; live: boolean } {
	const cur = stages[i];
	const next = stages[i + 1];
	if (cur?.at == null || next === undefined) return { ms: null, live: false };
	if (next.at !== null) return { ms: Math.max(0, next.at - cur.at), live: false };
	if (next.status === "live") return { ms: Math.max(0, now - cur.at), live: true };
	return { ms: null, live: false };
}
