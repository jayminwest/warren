import { useNavigate } from "react-router-dom";
import type { RunRow } from "@/api/types.ts";
import { PrChip, StatusText } from "@/components/ui/status.tsx";
import {
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from "@/components/ui/table.tsx";
import { Tag } from "@/components/ui/tag.tsx";
import { useListKeys } from "@/hooks/use-list-keys.ts";
import { relativeTime } from "../../lib/utils.ts";
import {
	branchLabelOf,
	formatDuration,
	projectLabel,
	runCostLabel,
	runtimeTitleOf,
	shortSha,
	startedAtOf,
} from "./runs-format.ts";

/**
 * The runs inventory table (warren-9e87, rebuilt on the primitives in
 * warren-9474): one dense row per run — status, run id + tracker item,
 * agent, project, trigger, started, duration, cost, delivery. Branch,
 * base commit and runtime handle ride the tooltips; the run detail page
 * carries them in full. J/K moves the selection and Enter opens it.
 */

/** Run cell sub-line: continuation chain, tracker item, or nothing. */
function runSubLine(row: RunRow): string | null {
	if (row.parentRunId !== null) return `continues ${row.parentRunId}`;
	if (row.retryOf !== null) return `retry of ${row.retryOf}`;
	return row.seedId;
}

/** Tooltip for the project cell: branch · base commit. */
function projectTitleOf(row: RunRow): string | undefined {
	const parts = [branchLabelOf(row), shortSha(row.baseCommit)].filter(
		(p): p is string => p !== null && p !== "",
	);
	return parts.length > 0 ? parts.join(" · ") : undefined;
}

/** Delivery: the PR when reap opened one, else the commit count. */
function DeliveryCell({ row }: { row: RunRow }) {
	if (row.prUrl !== null) return <PrChip url={row.prUrl} lifecycle={row.prState} />;
	if (row.commitsAhead !== null && row.commitsAhead > 0) {
		return (
			<Tag className="tabular-nums">
				{row.commitsAhead} {row.commitsAhead === 1 ? "commit" : "commits"}
			</Tag>
		);
	}
	return <span className="text-(--color-text-3)">—</span>;
}

function RunsTableRow({
	row,
	projectName,
	now,
	isOperator,
	selected,
	rowRef,
	onOpen,
}: {
	row: RunRow;
	projectName: string;
	now: number;
	isOperator: boolean;
	selected: boolean;
	rowRef: (el: HTMLElement | null) => void;
	onOpen: (path: string) => void;
}) {
	const runPath = `/runs/${encodeURIComponent(row.id)}`;
	const sub = runSubLine(row);
	const started = startedAtOf(row);
	return (
		<TableRow
			ref={rowRef}
			data-selected={selected}
			className="cursor-pointer"
			onClick={() => onOpen(runPath)}
		>
			<TableCell className="w-36 max-w-36">
				<StatusText state={row.state} reason={row.failureReason} />
			</TableCell>
			<TableCell className="max-w-56">
				<span className="flex min-w-0 flex-col">
					<a
						href={`#${runPath}`}
						onClick={(e) => e.stopPropagation()}
						title={isOperator ? runtimeTitleOf(row) : undefined}
						className="truncate font-mono text-sm text-(--color-text) hover:underline"
					>
						{row.id}
					</a>
					{sub !== null ? (
						<span className="truncate font-mono text-2xs text-(--color-text-3)">{sub}</span>
					) : null}
				</span>
			</TableCell>
			<TableCell className="max-w-44">
				<span className="flex min-w-0 flex-col">
					<span className="truncate text-(--color-text)">{row.agentName}</span>
					{row.model !== null ? (
						<span className="truncate font-mono text-2xs text-(--color-text-3)">{row.model}</span>
					) : null}
				</span>
			</TableCell>
			<TableCell className="max-w-52">
				<span title={projectTitleOf(row)} className="block truncate text-(--color-text-2)">
					{projectName}
				</span>
			</TableCell>
			<TableCell>
				<Tag>{row.trigger}</Tag>
			</TableCell>
			<TableCell className="whitespace-nowrap text-(--color-text-2)" title={started ?? undefined}>
				{relativeTime(started)}
			</TableCell>
			<TableCell className="text-right whitespace-nowrap text-(--color-text-2)">
				{formatDuration(row, now)}
			</TableCell>
			<TableCell className="text-right whitespace-nowrap text-(--color-text-2)">
				{runCostLabel(row)}
			</TableCell>
			<TableCell onClick={(e) => e.stopPropagation()}>
				<DeliveryCell row={row} />
			</TableCell>
		</TableRow>
	);
}

export function RunsTable({
	rows,
	projectIndex,
	now,
	isOperator,
}: {
	rows: readonly RunRow[];
	projectIndex: Map<string, string>;
	now: number;
	isOperator: boolean;
}) {
	const navigate = useNavigate();
	const { selected, setRef } = useListKeys(rows.length, (i) => {
		const row = rows[i];
		if (row) navigate(`/runs/${encodeURIComponent(row.id)}`);
	});
	return (
		<Table className="min-w-[60rem]">
			<TableHeader>
				<TableRow>
					<TableHead>Status</TableHead>
					<TableHead>Run</TableHead>
					<TableHead>Agent</TableHead>
					<TableHead>Project</TableHead>
					<TableHead>Trigger</TableHead>
					<TableHead>Started</TableHead>
					<TableHead className="text-right">Duration</TableHead>
					<TableHead className="text-right">Cost</TableHead>
					<TableHead>Delivery</TableHead>
				</TableRow>
			</TableHeader>
			<TableBody>
				{rows.map((row, i) => (
					<RunsTableRow
						key={row.id}
						now={now}
						row={row}
						projectName={
							row.projectId === null
								? "Deleted project"
								: projectLabel(projectIndex.get(row.projectId), row.projectId)
						}
						isOperator={isOperator}
						selected={selected === i}
						rowRef={setRef(i)}
						onOpen={navigate}
					/>
				))}
			</TableBody>
		</Table>
	);
}
