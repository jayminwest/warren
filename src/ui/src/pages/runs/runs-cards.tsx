import type { RunRow } from "@/api/types.ts";
import {
	CardFigure,
	CardFigureNote,
	InventoryCardList,
	InventoryRowCard,
} from "@/components/ui/inventory-card.tsx";
import { costNoteToneOf, stateCellOf, sublineOf } from "@/pages/runs/runs-card.helpers.ts";
import { formatDuration, projectLabel, runCostLabel } from "@/pages/runs/runs-format.ts";

/**
 * The mobile arm of the Runs inventory (warren-dea8 / pl-7e38 step 20):
 * the table degrades to the artboard row-card pattern
 * (docs/ui-revamp/screens/mobile/runs.jsx) below `md`. Same rows, same
 * data, token colors only; the desktop table stays untouched.
 *
 * warren-f8a2 collapsed the card to the mock's two-line anatomy: no meta
 * row, one-contextual-extra subline, cancelled on the neutral tone, and a
 * warning-tinted cost note near the cap. The cell/subline decisions live
 * in runs-card.helpers.ts (pure, tested there).
 */

function RunCard({ row, projectName, now }: { row: RunRow; projectName: string; now: number }) {
	const state = stateCellOf(row);
	return (
		<InventoryRowCard
			tone={state.tone}
			stateLabel={state.label}
			title={row.id}
			titleTo={`/runs/${encodeURIComponent(row.id)}`}
			subline={sublineOf(row, projectName)}
			figures={
				<>
					<CardFigure value={formatDuration(row, now)} />
					<CardFigureNote value={runCostLabel(row)} tone={costNoteToneOf(row)} />
				</>
			}
		/>
	);
}

export function RunsCardList({
	rows,
	projectIndex,
	now,
}: {
	rows: readonly RunRow[];
	projectIndex: Map<string, string>;
	now: number;
}) {
	return (
		<InventoryCardList>
			{rows.map((row) => (
				<RunCard
					key={row.id}
					now={now}
					row={row}
					projectName={
						row.projectId === null
							? "deleted project"
							: projectLabel(projectIndex.get(row.projectId), row.projectId)
					}
				/>
			))}
		</InventoryCardList>
	);
}
