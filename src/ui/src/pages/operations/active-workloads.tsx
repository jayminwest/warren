import { Plus, Workflow } from "lucide-react";
import { useMemo } from "react";
import { Link } from "react-router-dom";
import type { ProjectRow, RunRow } from "@/api/types.ts";
import { OperatorOnly } from "@/components/operator-only.tsx";
import { Button } from "@/components/ui/button.tsx";
import { Card, CardHeader } from "@/components/ui/card.tsx";
import { EmptyState } from "@/components/ui/empty-state.tsx";
import { SkeletonRows } from "@/components/ui/skeleton.tsx";
import { StatusText } from "@/components/ui/status.tsx";
import {
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from "@/components/ui/table.tsx";
import { formatCostUsd } from "@/pages/run-detail-format.ts";
import {
	activeWorkloads,
	activityLine,
	formatAgeMs,
	phaseElapsedMs,
	shortRepo,
} from "./operations.helpers.ts";

/**
 * Active workloads (warren-d903, warren-9474): the queued and running
 * runs, longest-waiting first — the row that has waited longest is the
 * one the operator judges. Activity is the prompt's first line. On a
 * phone the table scrolls inside its card.
 */

const MAX_ROWS = 8;

function WorkloadRow({
	run,
	projectLabel,
	now,
}: {
	run: RunRow;
	projectLabel: string;
	now: number;
}) {
	return (
		<TableRow>
			<TableCell>
				<StatusText state={run.state} />
			</TableCell>
			<TableCell>
				<Link
					to={`/runs/${run.id}`}
					className="font-mono text-xs text-(--color-text) hover:text-(--color-primary) hover:underline"
				>
					{run.id}
				</Link>
			</TableCell>
			<TableCell className="text-(--color-text-2)">{run.agentName}</TableCell>
			<TableCell className="max-w-40 truncate text-(--color-text-2)">{projectLabel}</TableCell>
			<TableCell className="max-w-80 truncate text-(--color-text-2)">
				{run.state === "queued" ? "Waiting for a slot" : activityLine(run.prompt)}
			</TableCell>
			<TableCell className="text-right text-(--color-text-2)">
				{formatAgeMs(phaseElapsedMs(run, now))}
			</TableCell>
			<TableCell className="text-right text-(--color-text-2)">
				{run.costUsd === null ? "—" : formatCostUsd(run.costUsd)}
			</TableCell>
		</TableRow>
	);
}

function WorkloadsBody({
	active,
	projectIndex,
	now,
	loading,
}: {
	active: readonly RunRow[];
	projectIndex: ReadonlyMap<string, string>;
	now: number;
	loading: boolean;
}) {
	if (loading) return <SkeletonRows rows={3} />;
	if (active.length === 0) {
		return (
			<EmptyState
				compact
				icon={Workflow}
				title="Nothing running"
				description="Runs show here while they wait for a slot and while they work."
				action={
					<OperatorOnly>
						<Button asChild variant="outline" size="sm">
							<Link to="/dispatch">
								<Plus aria-hidden />
								Dispatch a run
							</Link>
						</Button>
					</OperatorOnly>
				}
			/>
		);
	}
	return (
		<Table>
			<TableHeader>
				<TableRow>
					<TableHead>State</TableHead>
					<TableHead>Run</TableHead>
					<TableHead>Agent</TableHead>
					<TableHead>Project</TableHead>
					<TableHead>Activity</TableHead>
					<TableHead className="text-right">Elapsed</TableHead>
					<TableHead className="text-right">Cost</TableHead>
				</TableRow>
			</TableHeader>
			<TableBody>
				{active.map((run) => (
					<WorkloadRow
						key={run.id}
						run={run}
						projectLabel={
							run.projectId === null
								? "No project"
								: (projectIndex.get(run.projectId) ?? run.projectId)
						}
						now={now}
					/>
				))}
			</TableBody>
		</Table>
	);
}

export function ActiveWorkloads({
	runs,
	projects,
	now,
	loading,
}: {
	runs: readonly RunRow[] | undefined;
	projects: readonly ProjectRow[] | undefined;
	now: number;
	loading: boolean;
}) {
	const { active, running, queued } = useMemo(() => {
		const list = runs ?? [];
		return {
			active: activeWorkloads(list, MAX_ROWS),
			running: list.filter((r) => r.state === "running").length,
			queued: list.filter((r) => r.state === "queued").length,
		};
	}, [runs]);
	const projectIndex = useMemo(() => {
		const index = new Map<string, string>();
		for (const p of projects ?? []) index.set(p.id, shortRepo(p.gitUrl));
		return index;
	}, [projects]);
	return (
		<Card>
			<CardHeader
				title="Active workloads"
				meta={runs === undefined ? undefined : `${running} running · ${queued} queued`}
				actions={
					<Button asChild variant="ghost" size="sm">
						<Link to="/runs">All runs</Link>
					</Button>
				}
			/>
			<WorkloadsBody
				active={active}
				projectIndex={projectIndex}
				now={now}
				loading={loading && runs === undefined}
			/>
		</Card>
	);
}
