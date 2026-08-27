import { Fragment } from "react";
import type { RunEvent, RunRow } from "@/api/types.ts";
import { isTerminalRunState } from "@/api/types.ts";
import { cn } from "@/lib/utils.ts";
import { formatWallClock } from "@/pages/run-detail-format.ts";
import { formatElapsedMs } from "@/pages/runs/runs-format.ts";

/**
 * The Direction C lifecycle phase rail (warren-8c85 / pl-7e38 step 4),
 * translated from docs/ui-revamp/screens/run-detail.jsx: five cells —
 * Admitted, Workspace ready, Agent running, Reap, Git delivery — each
 * with a status dot and a mono sub-line. Every figure is derived from
 * real sources (run row + event stream); pending phases say "pending",
 * never a fabricated timestamp.
 */

type PhaseState = "done" | "active" | "pending";

interface PhaseCellData {
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

function dotClass(state: PhaseState): string {
	switch (state) {
		case "done":
			return "bg-(--color-success)";
		case "active":
			return "bg-(--color-info)";
		default:
			return "bg-(--color-neutral)";
	}
}

function cellClass(state: PhaseState): string {
	return state === "active"
		? "border-b-2 border-(--color-primary) bg-(--color-primary)/5"
		: "border-b border-transparent";
}

function admittedPhase(run: RunRow, events: RunEvent[]): PhaseCellData {
	if (run.state === "queued") return { label: "Admitted", state: "pending", sub: "queued" };
	const ts = run.startedAt ?? lastEventTs(events, new Set(["state_change"]));
	return { label: "Admitted", state: "done", sub: wallClockOf(ts) || "admitted" };
}

function workspacePhase(run: RunRow, events: RunEvent[], terminal: boolean): PhaseCellData {
	const agentStartTs =
		lastEventTs(events, new Set(["agent_start"])) ?? (terminal ? run.startedAt : null);
	const done = agentStartTs !== null || terminal;
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
 * ready = an `agent_start` event exists (or the run is already past
 * it); Agent running = current phase while non-terminal, done at the
 * run's terminal state; Reap = the reap completed (or failed) event,
 * else implied by a terminal state; Git delivery = commits/PR facts on
 * the row.
 */
export function derivePhases(run: RunRow, events: RunEvent[]): PhaseCellData[] {
	const terminal = isTerminalRunState(run.state);
	const reapTs = lastEventTs(events, new Set(["reap.completed", "reap_failed", "reap.orphaned"]));
	const reaped = terminal || reapTs !== null;
	const elapsed = elapsedLabel(run);

	return [
		admittedPhase(run, events),
		workspacePhase(run, events, terminal),
		agentPhase(run, terminal, elapsed),
		reapPhase(run, events, reaped),
		deliveryPhase(run, terminal),
	];
}

function PhaseCell({ cell, first, last }: { cell: PhaseCellData; first: boolean; last: boolean }) {
	return (
		<div
			className={cn(
				"flex flex-1 flex-col gap-[5px] px-3 py-2.5",
				!last && "border-r border-(--color-border)",
				cellClass(cell.state),
				first && "rounded-tl-(--radius-md)",
			)}
		>
			<span className="flex items-center gap-[7px]">
				<span
					className={cn("h-1.5 w-1.5 shrink-0 rounded-full", dotClass(cell.state))}
					aria-hidden
				/>
				<span
					className={cn(
						"text-[10px] leading-3 font-medium",
						cell.state === "active" ? "text-(--color-text)" : "text-(--color-text-2)",
					)}
				>
					{cell.label}
				</span>
			</span>
			<span className="pl-[13px] font-mono text-[9px] leading-3 text-(--color-text-3)">
				{cell.sub}
			</span>
		</div>
	);
}

/** Short one-word label for the compact below-md connector strip. */
const STRIP_LABELS: Record<string, string> = {
	Admitted: "queued",
	"Workspace ready": "workspace",
	"Agent running": "agent",
	Reap: "reap",
	"Git delivery": "PR",
};

function StripNode({ cell }: { cell: PhaseCellData }) {
	const active = cell.state === "active";
	return (
		<span
			className={cn(
				"flex shrink-0 items-center gap-[5px]",
				active &&
					"rounded-(--radius-sm) border border-(--color-border-strong) bg-(--color-surface-raised) px-[7px] py-[3px]",
			)}
		>
			<span
				aria-hidden
				className={cn(
					"h-1.5 w-1.5 shrink-0 rounded-full",
					cell.state === "done"
						? "bg-(--color-success)"
						: active
							? "bg-(--color-info)"
							: "border border-(--color-border-strong)",
				)}
			/>
			<span
				className={cn(
					"font-mono text-[9px] leading-[11px]",
					cell.state === "pending" ? "text-(--color-text-3)" : "text-(--color-text-2)",
				)}
			>
				{STRIP_LABELS[cell.label] ?? cell.label}
			</span>
		</span>
	);
}

export function PhaseRail({ run, events }: { run: RunRow; events: RunEvent[] }) {
	const phases = derivePhases(run, events);
	return (
		<div className="flex shrink-0 overflow-clip rounded-(--radius-md) border border-(--color-border) bg-(--color-surface)">
			{phases.map((p, i) => (
				<PhaseCell key={p.label} cell={p} first={i === 0} last={i === phases.length - 1} />
			))}
		</div>
	);
}

/** Below-md compact connector strip (warren-8a8f / mobile run-detail artboard). */
export function PhaseRailStrip({ run, events }: { run: RunRow; events: RunEvent[] }) {
	const phases = derivePhases(run, events);
	return (
		<div className="flex shrink-0 items-center gap-1.5 overflow-x-auto border-b border-(--color-border) px-3.5 py-3">
			{phases.map((p, i) => (
				<Fragment key={p.label}>
					{i > 0 && <span aria-hidden className="h-px w-3.5 shrink-0 bg-(--color-border)" />}
					<StripNode cell={p} />
				</Fragment>
			))}
		</div>
	);
}
