import type { OpsOverviewResponse } from "@/api/ops-types.ts";
import type { RunRow } from "@/api/types.ts";
import { cn } from "@/lib/utils.ts";
import type { OpsWindow } from "../../../../core/wire.ts";
import { formatDurationMs, oldestPhaseInstant } from "./operations.helpers.ts";

/**
 * The Operations capacity strip (warren-d903): RUNNING / QUEUE DEPTH /
 * SPEND / DELIVERY cards from one `GET /ops/overview` snapshot. Cards
 * whose section the public projection omits (spend, delivery) render on
 * presence — a spectator sees the reduced strip, not zeroed cards
 * (warren-f53e: absent ≠ 0).
 *
 * Mobile (warren-10d3, mobile/operations.jsx:72-137): below sm the strip
 * is the mock's 2x2 grid — RUNNING|QUEUE over SPEND|DELIVERY — with a
 * right hairline on the left cells, a bottom hairline on the first row,
 * 12px cell padding, and 18/22 600 values. The sm+ row is unchanged.
 */

interface CapacityCellSpec {
	readonly label: string;
	readonly value: string;
	readonly unit?: string;
	readonly detail: string;
}

function CapacityCell({
	label,
	value,
	unit,
	detail,
	className,
}: CapacityCellSpec & { className?: string }) {
	return (
		<div
			className={cn(
				"flex min-w-0 flex-col gap-[5px] p-3 sm:gap-2 sm:flex-1 sm:px-3.5 sm:pt-3 sm:pb-2.5",
				className,
			)}
		>
			<span className="font-mono text-[9px] leading-[11px] tracking-[0.08em] text-(--color-text-3) sm:leading-3 sm:tracking-[0.07em]">
				{label}
			</span>
			<span className="flex items-baseline gap-1 sm:gap-[7px]">
				<span className="font-mono text-[18px] leading-[22px] font-semibold tracking-[-0.03em] text-(--color-text) sm:text-xl sm:leading-6 sm:font-medium">
					{value}
				</span>
				{unit ? (
					<span className="w-max shrink-0 font-mono text-[10px] leading-3 text-(--color-text-3)">
						{unit}
					</span>
				) : null}
			</span>
			<span className="font-mono text-[9px] leading-[11px] text-(--color-text-3) sm:leading-3">
				{detail}
			</span>
		</div>
	);
}

export function CapacityStrip({
	overview,
	runs,
	now,
	window = "24h",
}: {
	overview: OpsOverviewResponse | undefined;
	runs: readonly RunRow[] | undefined;
	now: number;
	/** Trailing window the spend/delivery buckets cover (warren-7194). */
	window?: OpsWindow;
}) {
	if (overview === undefined) {
		return (
			<div className="rounded-(--radius-md) border border-(--color-border) bg-(--color-surface) px-3.5 py-3 font-mono text-[10px] leading-3 text-(--color-text-3)">
				loading snapshot…
			</div>
		);
	}
	const running = overview.runs.byState.running ?? 0;
	const queued = overview.runs.byState.queued ?? 0;
	const nonTerminal = overview.runs.nonTerminal;
	// Oldest phases come from the newest-runs window (the same shared
	// ["runs"] query the shell uses) — the snapshot endpoint carries no
	// per-state age. Null window = "unknown", never 0.
	const oldestQueued = runs ? oldestPhaseInstant(runs, "queued") : null;
	const oldestQueuedLabel =
		runs === undefined
			? "oldest queued unknown"
			: oldestQueued === null
				? "queue empty"
				: `oldest queued ${formatDurationMs(now - oldestQueued)}`;
	const spend = overview.spend;
	const delivery = overview.delivery;

	const cells: CapacityCellSpec[] = [
		{
			label: "RUNNING",
			value: String(running),
			unit: "ACTIVE",
			detail: `${nonTerminal} occupying admission slots · ${overview.runs.total} total`,
		},
		{
			label: "QUEUE DEPTH",
			value: String(queued),
			unit: "RUNS",
			detail: oldestQueuedLabel,
		},
	];
	if (spend !== undefined) {
		cells.push({
			label: `SPEND · ${window.toUpperCase()}`,
			// The USD sums are operator-only — a spectator's reduced body
			// carries windowRuns alone, so the value renders "—", not 0.00.
			value: spend.windowUsd === undefined ? "—" : spend.windowUsd.toFixed(2),
			unit: "USD",
			detail: `${spend.windowRuns} runs in window`,
		});
	}
	if (delivery !== undefined) {
		cells.push({
			label: "DELIVERY",
			value: String(delivery.branchesPushed),
			unit: "BRANCHES",
			detail: `${delivery.prsOpened} PRs opened · ${delivery.prsMerged} merged`,
		});
	}

	// Mobile hairlines (warren-10d3): a 2x2 grid wants a right hairline
	// on cells with a right neighbour (left column, and the lone cell of
	// an odd last row has none) and a bottom hairline on every row but
	// the last. sm+ keeps the row layout's per-cell right hairline.
	const rowCount = Math.ceil(cells.length / 2);

	return (
		<div className="grid min-w-0 grid-cols-2 overflow-clip rounded-(--radius-md) border border-(--color-border) bg-(--color-surface) sm:flex sm:flex-row">
			{cells.map((cell, i) => (
				<CapacityCell
					key={cell.label}
					{...cell}
					className={cn(
						i % 2 === 0 && i + 1 < cells.length && "border-r border-(--color-border)",
						i < 2 * (rowCount - 1) && "border-b border-(--color-border) sm:border-b-0",
						"sm:border-r sm:border-r-(--color-border)",
					)}
				/>
			))}
		</div>
	);
}
