import type { OpsOverviewResponse } from "@/api/ops-types.ts";
import type { RunRow } from "@/api/types.ts";
import { cn } from "@/lib/utils.ts";
import { formatDurationMs, oldestPhaseInstant } from "./operations.helpers.ts";

/**
 * The Operations capacity strip (warren-d903): RUNNING / QUEUE DEPTH /
 * SPEND / DELIVERY cards from one `GET /ops/overview` snapshot. Cards
 * whose section the public projection omits (spend, delivery) render on
 * presence — a spectator sees the reduced strip, not zeroed cards
 * (warren-f53e: absent ≠ 0).
 */

function CapacityCell({
	label,
	value,
	unit,
	detail,
	border = true,
}: {
	label: string;
	value: string;
	unit?: string;
	detail: string;
	border?: boolean;
}) {
	return (
		<div
			className={cn(
				"flex min-w-0 flex-1 flex-col gap-2 px-3.5 pt-3 pb-2.5",
				border && "border-r border-(--color-border)",
			)}
		>
			<span className="font-mono text-[9px] tracking-[0.07em] text-(--color-text-3)">{label}</span>
			<span className="flex items-baseline gap-[7px]">
				<span className="font-mono text-xl leading-6 font-medium tracking-[-0.03em] text-(--color-text)">
					{value}
				</span>
				{unit ? (
					<span className="w-max shrink-0 font-mono text-[10px] leading-3 text-(--color-text-3)">
						{unit}
					</span>
				) : null}
			</span>
			<span className="font-mono text-[9px] leading-3 text-(--color-text-3)">{detail}</span>
		</div>
	);
}

export function CapacityStrip({
	overview,
	runs,
	now,
}: {
	overview: OpsOverviewResponse | undefined;
	runs: readonly RunRow[] | undefined;
	now: number;
}) {
	if (overview === undefined) {
		return (
			<div className="rounded-(--radius-md) border border-(--color-border) bg-(--color-surface) px-3.5 py-3 font-mono text-[10px] leading-3 text-(--color-text-3)">
				loading control-plane snapshot…
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
	return (
		<div className="flex flex-wrap overflow-clip rounded-(--radius-md) border border-(--color-border) bg-(--color-surface)">
			<CapacityCell
				label="RUNNING"
				value={String(running)}
				unit="ACTIVE"
				detail={`${nonTerminal} occupying admission slots · ${overview.runs.total} total`}
			/>
			<CapacityCell
				label="QUEUE DEPTH"
				value={String(queued)}
				unit="RUNS"
				detail={oldestQueuedLabel}
			/>
			{spend === undefined ? null : (
				<CapacityCell
					label="SPEND · 24H"
					value={spend.last24hUsd.toFixed(2)}
					unit="USD"
					detail={`$${spend.totalUsd.toFixed(2)} all-time · ${spend.last24hRuns} runs in window`}
				/>
			)}
			{delivery === undefined ? null : (
				<CapacityCell
					label="DELIVERY"
					value={String(delivery.branchesPushed)}
					unit="BRANCHES"
					detail={`${delivery.prsOpened} PRs opened · ${delivery.prsMerged} merged`}
				/>
			)}
		</div>
	);
}
