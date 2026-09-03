import type { RunEvent, RunRow } from "@/api/types.ts";
import { isTerminalRunState } from "@/api/types.ts";
import { formatWallClock } from "@/pages/run-detail-format.ts";
import { formatElapsedMs } from "@/pages/runs/runs-format.ts";
import { deriveStageDurations, lastEventTsOf, lastStateChangeTypeTs } from "./run-detail-format.ts";

/**
 * The Direction C lifecycle phase rail's derivation logic
 * (warren-8c85 / pl-7e38 step 4): five cells — Admitted, Workspace
 * ready, Agent running, Reap, Git delivery — each with a status dot
 * and a mono sub-line. Every figure is derived from real sources (run
 * row + event stream); pending phases say "pending", never a
 * fabricated timestamp. Kept free of React so unit tests cover it
 * directly; phase-rail.tsx renders what this returns.
 */

export type PhaseState = "done" | "active" | "pending";

export interface PhaseCellData {
	label: string;
	state: PhaseState;
	sub: string;
	/** Duration of this cell's stage (warren-935a); null = unobserved, render `sub`. */
	durationMs: number | null;
}

function wallClockOf(iso: string | null): string {
	if (iso === null) return "";
	const wc = formatWallClock(iso);
	return wc === iso ? new Date(iso).toISOString().slice(0, 19) : wc;
}

function elapsedLabel(run: RunRow): string {
	const startIso =
		run.startedAt ?? (run.createdAt !== null ? new Date(run.createdAt).toISOString() : null);
	if (startIso === null) return "";
	const start = new Date(startIso).getTime();
	if (Number.isNaN(start)) return "";
	const end = run.endedAt !== null ? new Date(run.endedAt).getTime() : Date.now();
	if (Number.isNaN(end) || end < start) return "";
	return formatElapsedMs(end - start);
}

export function dotClass(state: PhaseState): string {
	switch (state) {
		case "done":
			return "bg-(--color-success)";
		case "active":
			return "bg-(--color-info)";
		default:
			return "bg-(--color-neutral)";
	}
}

export function cellClass(state: PhaseState): string {
	return state === "active"
		? "border-b-2 border-(--color-primary) bg-(--color-primary)/5"
		: "border-b border-transparent";
}

function admittedPhase(run: RunRow, events: RunEvent[], queuePrepMs: number | null): PhaseCellData {
	if (run.state === "queued")
		return { label: "Admitted", state: "pending", sub: "queued", durationMs: null };
	const ts = run.startedAt ?? lastEventTsOf(events, new Set(["state_change"]));
	return {
		label: "Admitted",
		state: "done",
		sub: wallClockOf(ts) || "admitted",
		durationMs: queuePrepMs,
	};
}

function workspacePhase(
	run: RunRow,
	events: RunEvent[],
	agentBootMs: number | null,
): PhaseCellData {
	// Probe three real signals (warren-57fb): the raw `agent_start` kind
	// (other adapters), the pi adapter's state_change payload.type form,
	// and run.startedAt — the bridge stamps it when the agent is claimed,
	// so the cell lights while the run is live, not only at terminal.
	const agentStartTs =
		lastEventTsOf(events, new Set(["agent_start"])) ??
		lastStateChangeTypeTs(events, "agent_start") ??
		run.startedAt;
	const done = agentStartTs !== null;
	return {
		label: "Workspace ready",
		state: done ? "done" : "pending",
		sub: agentStartTs !== null ? wallClockOf(agentStartTs) : "pending",
		durationMs: agentBootMs,
	};
}

function agentPhase(
	run: RunRow,
	terminal: boolean,
	elapsed: string,
	agentRunMs: number | null,
): PhaseCellData {
	// The duration travels on the cell even after terminal (warren-935a):
	// the span the agent actually ran, not the wall clock it ended at.
	if (terminal) {
		return {
			label: "Agent running",
			state: "done",
			sub: wallClockOf(run.endedAt) || "ended",
			durationMs: agentRunMs,
		};
	}
	if (run.state === "running") {
		return {
			label: "Agent running",
			state: "active",
			sub: elapsed !== "" ? `${elapsed} elapsed` : "running",
			durationMs: null,
		};
	}
	return { label: "Agent running", state: "pending", sub: "pending", durationMs: null };
}

function reapPhase(
	run: RunRow,
	events: RunEvent[],
	reaped: boolean,
	reapMs: number | null,
): PhaseCellData {
	const reapTs = lastEventTsOf(events, new Set(["reap.completed", "reap_failed", "reap.orphaned"]));
	return {
		label: "Reap",
		state: reaped ? "done" : "pending",
		sub: reaped ? wallClockOf(reapTs ?? run.endedAt) || "reaped" : "pending",
		durationMs: reapMs,
	};
}

function deliveryPhase(run: RunRow, terminal: boolean, deliveryMs: number | null): PhaseCellData {
	const delivered = (run.commitsAhead ?? 0) > 0 || run.prUrl !== null;
	let sub = "pending";
	if (delivered) {
		sub =
			run.prUrl !== null
				? "PR delivered"
				: `+${run.commitsAhead} commit${run.commitsAhead === 1 ? "" : "s"} pushed`;
	} else if (terminal) {
		sub = run.commitsAhead === 0 ? "no new commits" : "pending";
	}
	return {
		label: "Git delivery",
		state: delivered ? "done" : "pending",
		sub,
		durationMs: deliveryMs,
	};
}

/**
 * Derive the five phases. Admitted = state left `queued`; Workspace
 * ready = an `agent_start` event exists — by kind or as the pi
 * adapter's state_change payload.type — or the run row carries
 * startedAt (agent claimed); Agent running = current phase while
 * non-terminal, done at the run's terminal state; Reap = the reap
 * completed (or failed) event; Git delivery = commits/PR facts on
 * the row.
 */
export function derivePhases(run: RunRow, events: RunEvent[]): PhaseCellData[] {
	const terminal = isTerminalRunState(run.state);
	const reapTs = lastEventTsOf(events, new Set(["reap.completed", "reap_failed", "reap.orphaned"]));
	// Reap is off the terminal short-circuit (warren-57fb): a terminal row
	// without a reap event has not reaped yet (e.g. finalize_failed).
	const reaped = reapTs !== null;
	const elapsed = elapsedLabel(run);
	const stages = deriveStageDurations(run, events);

	return [
		admittedPhase(run, events, stages.queuePrepMs),
		workspacePhase(run, events, stages.agentBootMs),
		agentPhase(run, terminal, elapsed, stages.agentRunMs),
		reapPhase(run, events, reaped, stages.reapMs),
		deliveryPhase(run, terminal, stages.deliveryMs),
	];
}
