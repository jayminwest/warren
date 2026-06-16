import { useQuery } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { planRunsApi, projectsApi } from "@/api/client.ts";
import type { PlanRunChildState, PlanRunRow, PlanRunState, RunRow } from "@/api/types.ts";
import {
	compareStrings,
	type Comparator,
	useClientSort,
} from "@/hooks/use-client-sort.ts";
import { SortableTableHead } from "@/components/ui/sortable-table-head.tsx";
import { formatCostUsd } from "./RunDetail.tsx";
import { PlanRunStateBadge } from "@/components/PlanRunStateBadge.tsx";
import { Alert } from "@/components/ui/alert.tsx";
import { Button } from "@/components/ui/button.tsx";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card.tsx";
import { EmptyState } from "@/components/ui/empty-state.tsx";
import { PageHeader } from "@/components/ui/page-header.tsx";
import { responsiveTrailingControl } from "@/components/ui/responsive.ts";
import { Spinner } from "@/components/ui/spinner.tsx";
import {
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from "@/components/ui/table.tsx";
import { formatError } from "@/lib/format-error.ts";
import { relativeTime } from "@/lib/utils.ts";

type PlanRunSortKey = "state" | "id" | "planId" | "project" | "agentName" | "startedAt";

const STATE_FILTERS: { label: string; value: "all" | PlanRunState }[] = [
	{ label: "Active", value: "all" },
	{ label: "Queued", value: "queued" },
	{ label: "Running", value: "running" },
	{ label: "Succeeded", value: "succeeded" },
	{ label: "Failed", value: "failed" },
	{ label: "Cancelled", value: "cancelled" },
];

export function PlanRunsPage() {
	const [stateFilter, setStateFilter] = useState<"all" | PlanRunState>("all");
	const [projectFilter, setProjectFilter] = useState<string>("");

	const planRuns = useQuery({
		queryKey: ["plan-runs", projectFilter, stateFilter],
		queryFn: ({ signal }) =>
			planRunsApi.list(
				{
					...(projectFilter.length > 0 ? { project: projectFilter } : {}),
					...(stateFilter !== "all" ? { state: stateFilter } : {}),
				},
				signal,
			),
		refetchInterval: 5000,
	});

	const projects = useQuery({
		queryKey: ["projects"],
		queryFn: ({ signal }) => projectsApi.list(signal),
	});

	const projectIndex = useMemo(() => {
		const m = new Map<string, string>();
		for (const p of projects.data?.projects ?? []) m.set(p.id, p.gitUrl);
		return m;
	}, [projects.data]);

	const comparators = useMemo<Record<PlanRunSortKey, Comparator<PlanRunRow>>>(
		() => ({
			state: (a, b) => compareStrings(a.state, b.state),
			id: (a, b) => compareStrings(a.id, b.id),
			planId: (a, b) => compareStrings(a.planId, b.planId),
			project: (a, b) =>
				compareStrings(
					projectIndex.get(a.projectId) ?? a.projectId,
					projectIndex.get(b.projectId) ?? b.projectId,
				),
			agentName: (a, b) => compareStrings(a.agentName, b.agentName),
			startedAt: (a, b) => compareStrings(a.startedAt, b.startedAt),
		}),
		[projectIndex],
	);
	const { sorted, sort, onSort } = useClientSort(
		planRuns.data?.planRuns ?? [],
		comparators,
		{ initialKey: "startedAt", initialDirection: "desc", defaultDirections: { startedAt: "desc" } },
	);

	return (
		<div className="space-y-6">
			<PageHeader
				title="Plan runs"
				description="Serial execution of a seeds plan — one warren run per open child, in order."
				actions={
					<Link to="/plan-runs/new">
						<Button>Dispatch a plan run</Button>
					</Link>
				}
			/>

			<div className="flex flex-wrap items-center gap-2">
				{STATE_FILTERS.map((f) => (
					<button
						key={f.value}
						type="button"
						onClick={() => setStateFilter(f.value)}
						className={`rounded-full border px-3 py-1 text-xs transition-colors ${
							stateFilter === f.value
								? "bg-(--color-primary) text-(--color-primary-foreground)"
								: "bg-(--color-card) hover:bg-(--color-accent)"
						}`}
					>
						{f.label}
					</button>
				))}
				<select
					value={projectFilter}
					onChange={(e) => setProjectFilter(e.target.value)}
					className={`h-8 rounded-md border bg-(--color-card) px-2 text-xs ${responsiveTrailingControl}`}
				>
					<option value="">All projects</option>
					{projects.data?.projects.map((p) => (
						<option key={p.id} value={p.id}>
							{p.gitUrl}
						</option>
					))}
				</select>
			</div>

			<Card>
				<CardHeader>
					<CardTitle>{planRuns.data?.planRuns.length ?? 0} plan runs</CardTitle>
				</CardHeader>
				<CardContent className="p-0">
					{planRuns.isLoading ? (
						<div className="p-6"><Spinner label="Loading plan runs" /></div>
					) : planRuns.isError ? (
						<div className="p-6">
							<Alert variant="danger" title="Failed to load plan runs">
								{formatError(planRuns.error)}
							</Alert>
						</div>
					) : planRuns.data?.planRuns.length === 0 ? (
						<EmptyState
							title="No plan runs match this filter"
							description="Dispatch one above."
						/>
					) : (
						<Table>
							<TableHeader>
								<TableRow>
									<SortableTableHead columnKey="state" sort={sort} onSort={onSort}>
										State
									</SortableTableHead>
									<SortableTableHead columnKey="id" sort={sort} onSort={onSort}>
										ID
									</SortableTableHead>
									<SortableTableHead columnKey="planId" sort={sort} onSort={onSort}>
										Plan
									</SortableTableHead>
									<SortableTableHead columnKey="project" sort={sort} onSort={onSort}>
										Project
									</SortableTableHead>
									<SortableTableHead columnKey="agentName" sort={sort} onSort={onSort}>
										Agent
									</SortableTableHead>
									<TableHead className="whitespace-nowrap">Children</TableHead>
									<TableHead className="whitespace-nowrap">Cost</TableHead>
									<SortableTableHead columnKey="startedAt" sort={sort} onSort={onSort}>
										Started
									</SortableTableHead>
								</TableRow>
							</TableHeader>
							<TableBody>
								{sorted.map((pr) => (
									<PlanRunListRow
										key={pr.id}
										planRunId={pr.id}
										planId={pr.planId}
										state={pr.state}
										startedAt={pr.startedAt}
										agentName={pr.agentName}
										projectLabel={projectIndex.get(pr.projectId) ?? pr.projectId}
									/>
								))}
							</TableBody>
						</Table>
					)}
				</CardContent>
			</Card>
		</div>
	);
}

/**
 * Per-row component so each plan run can fetch its own child-state counts
 * without one big GET. Detail endpoint is cheap (single tx) and the list
 * page polls every 5s — the cost is bounded and keeps the list endpoint
 * narrow (rows only, no children fan-out, mirrors `GET /runs` shape).
 */
function PlanRunListRow({
	planRunId,
	planId,
	state,
	startedAt,
	agentName,
	projectLabel,
}: {
	planRunId: string;
	planId: string;
	state: PlanRunState;
	startedAt: string | null;
	agentName: string;
	projectLabel: string;
}) {
	const detail = useQuery({
		queryKey: ["plan-runs", planRunId],
		queryFn: ({ signal }) => planRunsApi.get(planRunId, signal),
		refetchInterval: 5000,
	});
	const counts = summarizeChildren(detail.data?.children ?? []);
	const cost = summarizeCost(detail.data?.runs ?? []);
	return (
		<TableRow>
			<TableCell>
				<PlanRunStateBadge state={state} />
			</TableCell>
			<TableCell>
				<Link
					to={`/plan-runs/${encodeURIComponent(planRunId)}`}
					className="font-mono text-xs underline-offset-2 hover:underline"
				>
					{planRunId}
				</Link>
			</TableCell>
			<TableCell className="whitespace-nowrap font-mono text-xs">{planId}</TableCell>
			<TableCell className="whitespace-nowrap font-mono text-xs">{projectLabel}</TableCell>
			<TableCell className="whitespace-nowrap">{agentName}</TableCell>
			<TableCell className="whitespace-nowrap font-mono text-xs text-(--color-muted-foreground)">
				{counts}
			</TableCell>
			<TableCell
				className="whitespace-nowrap font-mono text-xs text-(--color-muted-foreground)"
				title={
					cost.priced === 0
						? "No child runs have a recorded cost yet"
						: `${cost.priced} of ${cost.total} child runs have a recorded cost`
				}
			>
				{cost.priced === 0 ? "—" : formatCostUsd(cost.sum)}
			</TableCell>
			<TableCell className="whitespace-nowrap text-(--color-muted-foreground)">
				{relativeTime(startedAt)}
			</TableCell>
		</TableRow>
	);
}

/**
 * Aggregate cost across a plan-run's child runs (warren-2235 / pl-b0c0
 * step 5). Mirrors RunsRepo.aggregate's NULL-aware rollup: `sum` adds
 * non-null `costUsd` only, `priced` counts those rows, `total` is the
 * full child-run count. Ghost runs whose cost was never recorded land
 * in `total - priced` — the tooltip surfaces the gap so a low total
 * isn't mistaken for cheap.
 */
function summarizeCost(runs: RunRow[]): {
	sum: number;
	priced: number;
	total: number;
} {
	let sum = 0;
	let priced = 0;
	for (const r of runs) {
		if (r.costUsd !== null) {
			sum += r.costUsd;
			priced += 1;
		}
	}
	return { sum, priced, total: runs.length };
}

function summarizeChildren(
	children: { state: PlanRunChildState }[],
): string {
	if (children.length === 0) return "—";
	const buckets: Record<"pending" | "inflight" | "merged" | "failed", number> = {
		pending: 0,
		inflight: 0,
		merged: 0,
		failed: 0,
	};
	for (const c of children) {
		if (c.state === "pending") buckets.pending += 1;
		else if (c.state === "dispatched" || c.state === "running" || c.state === "pr_open")
			buckets.inflight += 1;
		else if (c.state === "merged" || c.state === "skipped") buckets.merged += 1;
		else if (c.state === "failed") buckets.failed += 1;
	}
	return `${buckets.pending}p / ${buckets.inflight}i / ${buckets.merged}m / ${buckets.failed}f`;
}
