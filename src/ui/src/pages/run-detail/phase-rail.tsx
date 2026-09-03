import { Fragment } from "react";
import type { RunEvent, RunRow } from "@/api/types.ts";
import { cn } from "@/lib/utils.ts";
import { cellClass, derivePhases, dotClass, type PhaseCellData } from "./phase-rail-logic.ts";

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
