import type { RunEvent, RunRow } from "@/api/types.ts";
import { isTerminalRunState } from "@/api/types.ts";
import { formatWallClock } from "@/pages/run-detail-format.ts";
import { formatElapsedMs } from "@/pages/runs/runs-format.ts";

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
}

/** Latest event ts for a kind, else null. */
function lastEventTs(events: RunEvent[], kinds: ReadonlySet<string>): string | null {
	let ts: string | null = null;
	for (const e of events) {
		if (kinds.has(e.kind)) ts = e.ts;
	}
	return ts;
}

/**
 * Latest ts of a state_change event whose pi envelope type matches
 * (warren-57fb): the pi adapter collapses the harness's `agent_start`
 * lifecycle envelope to `state_change` on `system` with the raw type
 * preserved in `payload.type`, so `agent_start` as a kind never appears
 * on the wire.
 */
function lastStateChangeOfType(events: RunEvent[], type: string): string | null {
	let ts: string | null = null;
	for (const e of events) {
		if (e.kind !== "state_change") continue;
		const payload = e.payload;
		if (
			payload !== null &&
			typeof payload === "object" &&
			!Array.isArray(payload) &&
			(payload as Record<string, unknown>).type === type
		) {
			ts = e.ts;
		}
	}
	return ts;
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

function admittedPhase(run: RunRow, events: RunEvent[]): PhaseCellData {
	if (run.state === "queued") return { label: "Admitted", state: "pending", sub: "queued" };
	const ts = run.startedAt ?? lastEventTs(events, new Set(["state_change"]));
	return { label: "Admitted", state: "done", sub: wallClockOf(ts) || "admitted" };
}

function workspacePhase(run: RunRow, events: RunEvent[]): PhaseCellData {
	// Probe three real signals (warren-57fb): the raw `agent_start` kind
	// (other adapters), the pi adapter's state_change payload.type form,
	// and run.startedAt — the bridge stamps it when the agent is claimed,
	// so the cell lights while the run is live, not only at terminal.
	const agentStartTs =
		lastEventTs(events, new Set(["agent_start"])) ??
		lastStateChangeOfType(events, "agent_start") ??
		run.startedAt;
	const done = agentStartTs !== null;
	return {
		label: "Workspace ready",
		state: done ? "done" : "pending",
		sub: agentStartTs !== null ? wallClockOf(agentStartTs) : "pending",
	};
}

function agentPhase(run: RunRow, terminal: boolean, elapsed: string): PhaseCellData {
	if (terminal) {
		return { label: "Agent running", state: "done", sub: wallClockOf(run.endedAt) || "ended" };
	}
	if (run.state === "running") {
		return {
			label: "Agent running",
			state: "active",
			sub: elapsed !== "" ? `${elapsed} elapsed` : "running",
		};
	}
	return { label: "Agent running", state: "pending", sub: "pending" };
}

function reapPhase(run: RunRow, events: RunEvent[], reaped: boolean): PhaseCellData {
	const reapTs = lastEventTs(events, new Set(["reap.completed", "reap_failed", "reap.orphaned"]));
	return {
		label: "Reap",
		state: reaped ? "done" : "pending",
		sub: reaped ? wallClockOf(reapTs ?? run.endedAt) || "reaped" : "pending",
	};
}

function deliveryPhase(run: RunRow, terminal: boolean): PhaseCellData {
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
	return { label: "Git delivery", state: delivered ? "done" : "pending", sub };
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
	const reapTs = lastEventTs(events, new Set(["reap.completed", "reap_failed", "reap.orphaned"]));
	// Reap is off the terminal short-circuit (warren-57fb): a terminal row
	// without a reap event has not reaped yet (e.g. finalize_failed).
	const reaped = reapTs !== null;
	const elapsed = elapsedLabel(run);

	return [
		admittedPhase(run, events),
		workspacePhase(run, events),
		agentPhase(run, terminal, elapsed),
		reapPhase(run, events, reaped),
		deliveryPhase(run, terminal),
	];
}
