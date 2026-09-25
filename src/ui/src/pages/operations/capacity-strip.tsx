import type { OpsOverviewResponse } from "@/api/ops-types.ts";
import type { RunRow } from "@/api/types.ts";
import { formatCostUsd } from "@/pages/run-detail-format.ts";
import type { OpsWindow } from "../../../../core/wire.ts";
import { formatAgeMs, oldestPhaseInstant, windowLabel } from "./operations.helpers.ts";
import { type StatCell, StatStrip } from "./stat-strip.tsx";

/**
 * The Operations headline figures (warren-d903, warren-9474): running,
 * queued, spend, and delivery from one ops overview. Cells whose section
 * the public projection omits (spend, delivery) render on presence — a
 * spectator sees the reduced strip, never zeroed cells (warren-f53e:
 * absent ≠ 0).
 */

function plural(n: number, one: string, many = `${one}s`): string {
	return `${n.toLocaleString()} ${n === 1 ? one : many}`;
}

function queueDetail(runs: readonly RunRow[] | undefined, now: number): string {
	if (runs === undefined) return "Checking the queue";
	const oldest = oldestPhaseInstant(runs, "queued");
	return oldest === null ? "Nothing waiting" : `Oldest waiting ${formatAgeMs(now - oldest)}`;
}

function buildCapacityCells(
	overview: OpsOverviewResponse | undefined,
	runs: readonly RunRow[] | undefined,
	now: number,
	window: OpsWindow,
): StatCell[] {
	if (overview === undefined) {
		return ["Running", "Queued", "Spend", "Delivered"].map((label) => ({
			key: label,
			label,
			value: null,
		}));
	}
	const running = overview.runs.byState.running ?? 0;
	const queued = overview.runs.byState.queued ?? 0;
	const span = windowLabel(window);
	const cells: StatCell[] = [
		{
			key: "running",
			label: "Running",
			value: running.toLocaleString(),
			detail: `${plural(overview.runs.nonTerminal, "run")} holding a slot · ${plural(overview.runs.total, "run")} all time`,
		},
		{
			key: "queued",
			label: "Queued",
			value: queued.toLocaleString(),
			detail: queueDetail(runs, now),
		},
	];
	const spend = overview.spend;
	if (spend !== undefined) {
		cells.push({
			key: "spend",
			label: `Spend, ${span}`,
			// The USD sums are operator-only — a spectator's reduced body
			// carries windowRuns alone, so the figure reads "—", not $0.00.
			value: spend.windowUsd === undefined ? "—" : formatCostUsd(spend.windowUsd),
			detail: `${plural(spend.windowRuns, "run")} in this window`,
		});
	}
	const delivery = overview.delivery;
	if (delivery !== undefined) {
		cells.push({
			key: "delivery",
			label: `Delivered, ${span}`,
			value: delivery.branchesPushed.toLocaleString(),
			unit: delivery.branchesPushed === 1 ? "branch" : "branches",
			detail: `${plural(delivery.prsOpened, "PR")} opened · ${delivery.prsMerged.toLocaleString()} merged`,
		});
	}
	return cells;
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
	return <StatStrip cells={buildCapacityCells(overview, runs, now, window)} />;
}
