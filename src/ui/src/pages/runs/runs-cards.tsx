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
 * The phone arm of the runs inventory (warren-dea8 / warren-f8a2): below
 * `md` the table becomes two-line row cards — status, run id, agent ·
 * project · one contextual extra, and elapsed over cost. The cell and
 * subline decisions live in runs-card.helpers.ts.
 */

function RunCard({ row, projectName, now }: { row: RunRow; projectName: string; now: number }) {
	const cell = stateCellOf(row);
	return (
		<InventoryRowCard
			state={cell.state}
			stateLabel={cell.label}
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
							? "Deleted project"
							: projectLabel(projectIndex.get(row.projectId), row.projectId)
					}
				/>
			))}
		</InventoryCardList>
	);
}
