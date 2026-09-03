import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { planRunsApi } from "@/api/client.ts";
import type { PlanRunChildRow, PlanRunRow } from "@/api/types.ts";
import { formatChildStateCounts } from "@/lib/labels.ts";
import { relativeTime } from "@/lib/utils.ts";
import { formatCostUsd } from "@/pages/run-detail-format.ts";
import {
	CHILD_SQUARE_COLOR,
	childSummary,
	PLAN_RUN_STATE_COLOR,
	planRunElapsed,
	summarizeCost,
} from "./walk-state.ts";

/**
 * One walk row in the Direction C inventory (warren-23b2). Each row
 * fetches its own detail (`GET /plan-runs/:id`) for the child squares
 * and cost rollup — the list endpoint stays rows-only, mirroring the
 * `GET /runs` shape, so the fan-out is the same bounded N+1 the legacy
 * page carried (warren-f566: stream-driven invalidation + 45s fallback).
 */
export function WalkRow({
	planRun,
	projectLabel,
	now,
}: {
	planRun: PlanRunRow;
	projectLabel: string;
	now: number;
}) {
	const detail = useQuery({
		queryKey: ["plan-runs", planRun.id],
		queryFn: ({ signal }) => planRunsApi.get(planRun.id, signal),
		refetchInterval: 45_000,
	});

	const children = detail.data?.children ?? null;
	const runs = detail.data?.runs ?? null;
	const counts = formatChildStateCounts(children ?? []);
	const cost = runs !== null ? summarizeCost(runs) : null;
	const cap = planRun.maxCostUsd;
	const capTitle =
		cost === null
			? cap == null
				? "No per-child spend cap"
				: `Per-child spend cap ${formatCostUsd(cap)}`
			: cap == null
				? `No cap · spent ${formatCostUsd(cost.sum)} (${cost.priced} of ${cost.total} child runs priced)`
				: `Cap ${formatCostUsd(cap)} per child · spent ${formatCostUsd(cost.sum)} (${cost.priced} of ${cost.total} child runs priced)`;

	return (
		<div className="flex min-h-[49px] items-center gap-2.5 border-b border-(--color-border) px-2.5 py-1.5">
			<StateCell state={planRun.state} />
			<div className="flex w-[150px] shrink-0 flex-col gap-0.5">
				<Link
					to={`/plan-runs/${encodeURIComponent(planRun.id)}`}
					className="font-mono text-[10px] leading-3 text-(--color-text) hover:underline"
				>
					{planRun.id}
				</Link>
				<span className="font-mono text-[9px] leading-3 text-(--color-text-3)">
					by {planRun.dispatcherHandle ?? "—"}
				</span>
			</div>
			<div className="w-[90px] shrink-0 font-mono text-[10px] leading-3 text-(--color-text-2)">
				<PlanCell planRun={planRun} childCount={children?.length ?? null} />
			</div>
			<div className="flex w-[128px] shrink-0 flex-col gap-0.5">
				<span className="truncate text-[11px] leading-3.5 text-(--color-text-2)">
					{projectLabel}
				</span>
				{planRun.ref !== null ? (
					<span className="font-mono text-[9px] leading-3 text-(--color-text-3)">
						{planRun.ref}
					</span>
				) : null}
			</div>
			<div className="flex w-[118px] shrink-0 flex-col gap-0.5">
				<span className="truncate text-[11px] leading-3.5 text-(--color-text-2)">
					{planRun.agentName}
				</span>
				{planRun.modelOverride != null ? (
					<span className="font-mono text-[9px] leading-3 text-(--color-text-3)">
						{planRun.modelOverride}
					</span>
				) : null}
			</div>
			<div className="w-[62px] shrink-0 font-mono text-[10px] leading-3 text-(--color-text-3)">
				{planRun.trigger}
			</div>
			<div className="w-[56px] shrink-0 font-mono text-[10px] leading-3 text-(--color-text-3)">
				{relativeTime(planRun.startedAt)}
			</div>
			<div className="w-[62px] shrink-0 text-right font-mono text-[10px] leading-3 text-(--color-text-2)">
				{planRunElapsed(planRun, now)}
			</div>
			<div
				className="w-[54px] shrink-0 text-right font-mono text-[10px] leading-3 text-(--color-text-2)"
				title={capTitle}
			>
				{cap == null ? "—" : formatCostUsd(cap)}
			</div>
			<ChildrenCell state={planRun.state} childRows={children} counts={counts} />
		</div>
	);
}

function StateCell({ state }: { state: PlanRunRow["state"] }) {
	const color = PLAN_RUN_STATE_COLOR[state];
	return (
		<div className="flex w-[78px] shrink-0 items-center gap-[7px]">
			<span
				className="h-1.5 w-1.5 shrink-0 rounded-full"
				style={{ backgroundColor: color }}
				aria-hidden
			/>
			<span className="font-mono text-[10px] leading-3" style={{ color }}>
				{state}
			</span>
		</div>
	);
}

function PlanCell({ planRun, childCount }: { planRun: PlanRunRow; childCount: number | null }) {
	if (planRun.source === "plan") return planRun.planId ?? "—";
	const count = childCount === null ? "" : ` × ${childCount}`;
	return `issues${count}`;
}

function ChildrenCell({
	state,
	childRows,
	counts,
}: {
	state: PlanRunRow["state"];
	childRows: readonly PlanRunChildRow[] | null;
	counts: { text: string; title: string };
}) {
	if (childRows === null) {
		return (
			<div className="min-w-0 flex-1 font-mono text-[9px] leading-3 text-(--color-text-3)">…</div>
		);
	}
	return (
		<div className="flex min-w-0 flex-1 items-center gap-2" title={counts.title}>
			<span className="flex shrink-0 gap-[3px]" aria-hidden>
				{childRows.map((c) => (
					<span
						key={c.seq}
						className="h-[7px] w-[7px] rounded-[1px]"
						style={{ backgroundColor: CHILD_SQUARE_COLOR[c.state] }}
					/>
				))}
			</span>
			<span className="truncate font-mono text-[9px] leading-3 text-(--color-text-3)">
				{childSummary(state, childRows)}
			</span>
		</div>
	);
}
