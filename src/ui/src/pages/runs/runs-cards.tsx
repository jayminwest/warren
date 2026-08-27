import type { RunRow } from "@/api/types.ts";
import {
	CardFigure,
	CardFigureNote,
	InventoryCardList,
	type InventoryCardTone,
	InventoryRowCard,
} from "@/components/ui/inventory-card.tsx";
import { relativeTime } from "@/lib/utils.ts";
import {
	formatDuration,
	projectLabel,
	runCostLabel,
	shortSha,
	startedAtOf,
} from "@/pages/runs/runs-format.ts";

/**
 * The mobile arm of the Runs inventory (warren-dea8 / pl-7e38 step 20):
 * the table degrades to the artboard row-card pattern
 * (docs/ui-revamp/screens/mobile/runs.jsx) below `md`. Same rows, same
 * data, token colors only; the desktop table stays untouched.
 */

function stateTone(state: RunRow["state"]): InventoryCardTone {
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

/** Subline: agent · project, mirroring the artboard row's second line. */
function sublineOf(row: RunRow, projectName: string): string {
	const branch = row.targetBranch ?? row.ref ?? null;
	const sha = shortSha(row.baseCommit);
	const extras: string[] = [row.agentName, projectName];
	if (row.parentRunId !== null) extras.push(`↪ ${row.parentRunId}`);
	else if (row.retryOf !== null) extras.push(`retry of ${row.retryOf}`);
	else if (row.seedId !== null) extras.push(row.seedId);
	if (branch !== null) extras.push(branch);
	else if (sha !== "") extras.push(sha);
	return extras.join(" · ");
}

function RunCard({ row, projectName }: { row: RunRow; projectName: string }) {
	return (
		<InventoryRowCard
			tone={stateTone(row.state)}
			stateLabel={row.state}
			title={row.id}
			titleTo={`/runs/${encodeURIComponent(row.id)}`}
			subline={sublineOf(row, projectName)}
			figures={
				<>
					<CardFigure value={formatDuration(row)} />
					<CardFigureNote value={runCostLabel(row)} />
				</>
			}
			meta={`${relativeTime(startedAtOf(row))} · ${row.trigger}${
				row.commitsAhead !== null && row.commitsAhead > 0
					? ` · ${row.commitsAhead} commit${row.commitsAhead === 1 ? "" : "s"}`
					: ""
			}`}
		/>
	);
}

export function RunsCardList({
	rows,
	projectIndex,
}: {
	rows: readonly RunRow[];
	projectIndex: Map<string, string>;
}) {
	return (
		<InventoryCardList>
			{rows.map((row) => (
				<RunCard
					key={row.id}
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
