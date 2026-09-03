import { useQuery } from "@tanstack/react-query";
import { planRunsApi } from "@/api/client.ts";
import type { PlanRunRow } from "@/api/types.ts";
import {
	CardFigure,
	CardFigureNote,
	InventoryCardList,
	type InventoryCardTone,
	InventoryRowCard,
} from "@/components/ui/inventory-card.tsx";
import { formatChildStateCounts } from "@/lib/labels.ts";
import { relativeTime } from "@/lib/utils.ts";
import { formatCostUsd } from "@/pages/run-detail-format.ts";
import { CHILD_SQUARE_COLOR, childSummary, planRunElapsed } from "./walk-state.ts";

/**
 * The mobile arm of the Plan runs walk inventory (warren-dea8 /
 * pl-7e38 step 20): below `md` the walk table degrades to the shared
 * row-card pattern (docs/ui-revamp/screens/mobile/runs.jsx). Child
 * progress squares ride the same per-row detail fetch WalkRow uses.
 */

function walkTone(state: PlanRunRow["state"]): InventoryCardTone {
	switch (state) {
		case "running":
			return "info";
		case "queued":
			return "warning";
		case "succeeded":
			return "success";
		case "failed":
			return "danger";
		default:
			return "muted";
	}
}

function WalkCard({
	planRun,
	projectLabel,
	now,
}: {
	planRun: PlanRunRow;
	projectLabel: string;
	now: number;
}) {
	// Same bounded N+1 detail fetch as the desktop WalkRow (warren-23b2).
	const detail = useQuery({
		queryKey: ["plan-runs", planRun.id],
		queryFn: ({ signal }) => planRunsApi.get(planRun.id, signal),
		refetchInterval: 45_000,
	});
	const children = detail.data?.children ?? null;
	const counts = children !== null ? formatChildStateCounts(children) : null;
	const planLabel =
		planRun.source === "plan"
			? (planRun.planId ?? "—")
			: `issues${children !== null ? ` × ${children.length}` : ""}`;

	return (
		<InventoryRowCard
			tone={walkTone(planRun.state)}
			stateLabel={planRun.state}
			title={planRun.id}
			titleTo={`/plan-runs/${encodeURIComponent(planRun.id)}`}
			subline={`${planRun.agentName} · ${projectLabel} · ${planLabel}`}
			figures={
				<>
					<CardFigure value={planRunElapsed(planRun, now)} />
					<CardFigureNote value={`${formatCostUsd(planRun.maxCostUsd)} cap`} />
				</>
			}
			meta={
				children === null
					? `${relativeTime(planRun.startedAt)} · by ${planRun.dispatcherHandle ?? "—"} · …`
					: `${relativeTime(planRun.startedAt)} · by ${planRun.dispatcherHandle ?? "—"} · ${childSummary(
							planRun.state,
							children,
						)}${counts !== null ? ` · ${counts.text}` : ""}`
			}
		>
			{children !== null ? (
				<span className="flex shrink-0 gap-[3px]" aria-hidden title={counts?.title}>
					{children.map((c) => (
						<span
							key={c.seq}
							className="h-[7px] w-[7px] rounded-[1px]"
							style={{ backgroundColor: CHILD_SQUARE_COLOR[c.state] }}
						/>
					))}
				</span>
			) : null}
		</InventoryRowCard>
	);
}

export function WalkCardList({
	planRuns,
	projectLabel,
	now,
}: {
	planRuns: readonly PlanRunRow[];
	projectLabel: (pr: PlanRunRow) => string;
	now: number;
}) {
	return (
		<InventoryCardList>
			{planRuns.map((pr) => (
				<WalkCard key={pr.id} planRun={pr} projectLabel={projectLabel(pr)} now={now} />
			))}
		</InventoryCardList>
	);
}
