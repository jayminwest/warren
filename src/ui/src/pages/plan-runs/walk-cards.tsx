import type { PlanRunListRow } from "@/api/types.ts";
import {
	CardFigure,
	CardFigureNote,
	InventoryCardList,
	InventoryRowCard,
} from "@/components/ui/inventory-card.tsx";
import { stateLabel } from "@/components/ui/status.tsx";
import { formatCostUsd } from "@/pages/run-detail-format.ts";
import { ChildSquares } from "./child-squares.tsx";
import { planLabelOf } from "./walk-row.tsx";
import { childSummary, planRunElapsed } from "./walk-state.ts";

/**
 * The phone arm of the plan-runs inventory (warren-dea8): each walk as a
 * row card with its child squares and progress caption, drawn from the
 * list row's `childStates` (warren-b2d6).
 */
function WalkCard({
	planRun,
	projectLabel,
	now,
}: {
	planRun: PlanRunListRow;
	projectLabel: string;
	now: number;
}) {
	return (
		<InventoryRowCard
			state={planRun.state}
			stateLabel={stateLabel(planRun.state)}
			title={planRun.id}
			titleTo={`/plan-runs/${encodeURIComponent(planRun.id)}`}
			subline={`${planRun.agentName} · ${projectLabel} · ${planLabelOf(planRun)}`}
			figures={
				<>
					<CardFigure value={planRunElapsed(planRun, now)} />
					{planRun.maxCostUsd != null ? (
						<CardFigureNote value={`${formatCostUsd(planRun.maxCostUsd)} cap`} />
					) : null}
				</>
			}
			meta={childSummary(planRun.state, planRun.childStates)}
		>
			<ChildSquares states={planRun.childStates} />
		</InventoryRowCard>
	);
}

export function WalkCardList({
	planRuns,
	projectLabel,
	now,
}: {
	planRuns: readonly PlanRunListRow[];
	projectLabel: (pr: PlanRunListRow) => string;
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
