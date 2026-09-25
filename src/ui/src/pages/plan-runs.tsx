import { useQuery } from "@tanstack/react-query";
import { Plus } from "lucide-react";
import { useMemo, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { planRunsApi, projectsApi } from "@/api/client.ts";
import type { PlanRunListRow, PlanRunStateFilter } from "@/api/types.ts";
import { isTerminalPlanRunState } from "@/api/types.ts";
import { OperatorOnly, useOperatorHint } from "@/components/operator-only.tsx";
import { Button, buttonVariants } from "@/components/ui/button.tsx";
import { Card } from "@/components/ui/card.tsx";
import { EmptyState } from "@/components/ui/empty-state.tsx";
import { Input } from "@/components/ui/input.tsx";
import { PageHeader } from "@/components/ui/page-header.tsx";
import { Select } from "@/components/ui/select.tsx";
import { SkeletonRows } from "@/components/ui/skeleton.tsx";
import { SortableTableHead, type SortState } from "@/components/ui/sortable-table-head.tsx";
import { Table, TableBody, TableHead, TableHeader, TableRow } from "@/components/ui/table.tsx";
import { type Comparator, compareStrings, useClientSort } from "@/hooks/use-client-sort.ts";
import { useListKeys } from "@/hooks/use-list-keys.ts";
import { useNow } from "@/hooks/use-now.ts";
import { ListError } from "@/pages/runs/list-error.tsx";
import { WalkCardList } from "./plan-runs/walk-cards.tsx";
import { WalkRow } from "./plan-runs/walk-row.tsx";

/**
 * Plan runs — plans walked one child at a time (warren-23b2, migrated in
 * warren-9474). One table with per-row child progress, which the list
 * endpoint now carries itself (warren-b2d6), so the page makes one
 * request, not one per row. A spectator sees the same list read-only;
 * the Dispatch plan button is the only operator control.
 */

type PlanRunSortKey = "state" | "id" | "startedAt";

const STATE_OPTIONS: { label: string; value: "all" | PlanRunStateFilter }[] = [
	{ label: "Any state", value: "all" },
	{ label: "Active", value: "active" },
	{ label: "Queued", value: "queued" },
	{ label: "Running", value: "running" },
	{ label: "Succeeded", value: "succeeded" },
	{ label: "Failed", value: "failed" },
	{ label: "Cancelled", value: "cancelled" },
];

const COMPARATORS: Record<PlanRunSortKey, Comparator<PlanRunListRow>> = {
	state: (a, b) => compareStrings(a.state, b.state),
	id: (a, b) => compareStrings(a.id, b.id),
	startedAt: (a, b) => compareStrings(a.startedAt ?? "", b.startedAt ?? ""),
};

export function PlanRunsPage() {
	const navigate = useNavigate();
	const [stateFilter, setStateFilter] = useState<"all" | PlanRunStateFilter>("all");
	const [projectFilter, setProjectFilter] = useState<string>("");
	const [search, setSearch] = useState("");

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
		// warren-f566: stream-driven invalidation + slow fallback poll.
		refetchInterval: 60_000,
	});
	const projects = useQuery({
		queryKey: ["projects"],
		queryFn: ({ signal }) => projectsApi.list(signal),
	});

	const projectIndex = useMemo(() => {
		const m = new Map<string, string>();
		for (const p of projects.data?.projects ?? []) {
			m.set(p.id, p.gitUrl.replace(/^https:\/\/github\.com\//, ""));
		}
		return m;
	}, [projects.data]);

	const rows = useMemo(() => {
		const all = planRuns.data?.planRuns ?? [];
		if (search.length === 0) return all;
		const q = search.toLowerCase();
		return all.filter(
			(pr) => pr.id.toLowerCase().includes(q) || (pr.planId ?? "").toLowerCase().includes(q),
		);
	}, [planRuns.data, search]);

	const { sorted, sort, onSort } = useClientSort(rows, COMPARATORS, {
		initialKey: "startedAt",
		initialDirection: "desc",
		defaultDirections: { startedAt: "desc" },
	});
	const { selected, setRef } = useListKeys(sorted.length, (i) => {
		const pr = sorted[i];
		if (pr) navigate(`/plan-runs/${encodeURIComponent(pr.id)}`);
	});

	const hasFilters = stateFilter !== "all" || projectFilter.length > 0 || search.length > 0;
	const emptyHint = useOperatorHint("Dispatch one from the Dispatch plan page.");
	// Live elapsed (warren-b610): a 1s tick only while a visible walk moves.
	const hasLiveWalks = sorted.some((pr) => !isTerminalPlanRunState(pr.state));
	const now = useNow(1000, hasLiveWalks);
	const projectLabel = (pr: PlanRunListRow): string =>
		projectIndex.get(pr.projectId) ?? pr.projectId;

	const body = planRuns.isLoading ? (
		<SkeletonRows rows={6} />
	) : planRuns.isError ? (
		<ListError what="plan runs" error={planRuns.error} onRetry={() => void planRuns.refetch()} />
	) : sorted.length === 0 ? (
		<EmptyState
			title={hasFilters ? "No plan runs match these filters" : "No plan runs yet"}
			description={hasFilters ? "Clear a filter to see more." : emptyHint}
		/>
	) : (
		<>
			<WalkCardList planRuns={sorted} projectLabel={projectLabel} now={now} />
			<div className="hidden md:block">
				<Table className="min-w-[64rem]">
					<HeaderRow sort={sort} onSort={onSort} />
					<TableBody>
						{sorted.map((pr, i) => (
							<WalkRow
								key={pr.id}
								planRun={pr}
								projectLabel={projectLabel(pr)}
								now={now}
								selected={selected === i}
								rowRef={setRef(i)}
								onOpen={navigate}
							/>
						))}
					</TableBody>
				</Table>
			</div>
		</>
	);

	return (
		<div className="flex flex-col gap-5 px-4 pt-6 pb-12 md:px-6">
			<PageHeader
				title="Plan runs"
				description="Plans dispatched as a sequence of runs, one child at a time."
				actions={
					<OperatorOnly>
						<Link to="/dispatch/plan" className={buttonVariants()}>
							<Plus aria-hidden />
							Dispatch plan
						</Link>
					</OperatorOnly>
				}
			/>
			<Card className="self-stretch">
				<div className="flex flex-wrap items-center gap-2 border-b border-(--color-border) px-4 py-3">
					<Select
						aria-label="State filter"
						value={stateFilter}
						onChange={(e) => setStateFilter(e.target.value as "all" | PlanRunStateFilter)}
						wrapperClassName="flex-1 sm:flex-none sm:w-36"
					>
						{STATE_OPTIONS.map((o) => (
							<option key={o.value} value={o.value}>
								{o.label}
							</option>
						))}
					</Select>
					<Select
						aria-label="Project filter"
						value={projectFilter}
						onChange={(e) => setProjectFilter(e.target.value)}
						wrapperClassName="flex-1 sm:flex-none sm:w-52"
					>
						<option value="">Any project</option>
						{projects.data?.projects.map((p) => (
							<option key={p.id} value={p.id}>
								{projectIndex.get(p.id) ?? p.gitUrl}
							</option>
						))}
					</Select>
					{hasFilters ? (
						<Button
							variant="ghost"
							size="sm"
							onClick={() => {
								setStateFilter("all");
								setProjectFilter("");
								setSearch("");
							}}
						>
							Clear
						</Button>
					) : null}
					<Input
						type="search"
						aria-label="Filter by plan or plan-run ID"
						value={search}
						onChange={(e) => setSearch(e.target.value)}
						placeholder="Filter by plan or plan-run ID"
						className="sm:ml-auto sm:w-60"
					/>
				</div>
				{body}
			</Card>
		</div>
	);
}

function HeaderRow({
	sort,
	onSort,
}: {
	sort: SortState<PlanRunSortKey>;
	onSort: (key: PlanRunSortKey) => void;
}) {
	return (
		<TableHeader>
			<TableRow>
				<SortableTableHead columnKey="state" sort={sort} onSort={onSort}>
					Status
				</SortableTableHead>
				<SortableTableHead columnKey="id" sort={sort} onSort={onSort}>
					Plan run
				</SortableTableHead>
				<TableHead>Project</TableHead>
				<TableHead>Agent</TableHead>
				<TableHead>Progress</TableHead>
				<TableHead>Trigger</TableHead>
				<SortableTableHead columnKey="startedAt" sort={sort} onSort={onSort}>
					Started
				</SortableTableHead>
				<TableHead className="text-right">Elapsed</TableHead>
				<TableHead className="text-right">Cap</TableHead>
			</TableRow>
		</TableHeader>
	);
}
