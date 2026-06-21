import { useQuery } from "@tanstack/react-query";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { agentsApi, projectsApi, runsApi } from "@/api/client.ts";
import { StateBadge } from "@/components/StateBadge.tsx";
import { Alert } from "@/components/ui/alert.tsx";
import { Button } from "@/components/ui/button.tsx";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card.tsx";
import { EmptyState } from "@/components/ui/empty-state.tsx";
import { FilterPill } from "@/components/ui/filter-pill.tsx";
import { FadeInItem, StaggerList } from "@/components/ui/motion.tsx";
import { PageHeader } from "@/components/ui/page-header.tsx";
import { responsiveCardHeaderRow } from "@/components/ui/responsive.ts";
import { SortableTableHead } from "@/components/ui/sortable-table-head.tsx";
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
import { formatCostUsd } from "./RunDetail.tsx";

// Cost column is on by default (warren-a7ec): pi runs are the common
// runtime today and hydrate `costUsd` via in-stream extraction
// (warren-17a4), so the column carries signal for most installs. The
// toggle remains as a hide option for operators who want to recover the
// horizontal space; localStorage persists the choice.
const COST_COLUMN_LS_KEY = "warren.runsList.showCostColumn";
// warren-ee50 / pl-b0c0 step 1: page size + offset persist in
// localStorage so the operator's chosen window survives a refresh.
// `offset` is intentionally NOT persisted — a stale offset can land
// past the end of the result set after the row count shrinks, and
// resetting to page 1 on reload is the conservative default.
const PAGE_SIZE_LS_KEY = "warren.runsList.pageSize";
const PAGE_SIZE_OPTIONS: readonly number[] = [25, 50, 100, 200];
const DEFAULT_PAGE_SIZE = 50;

type Filter = "all" | { kind: "agent"; value: string } | { kind: "project"; value: string };
type SortKey = "started" | "cost";
type SortDir = "asc" | "desc";

export function RunsPage() {
	const [filter, setFilter] = useState<Filter>("all");
	const [sort, setSort] = useState<SortKey>("started");
	const [dir, setDir] = useState<SortDir>("desc");
	const [pageSize, setPageSize] = useState<number>(() => {
		if (typeof window === "undefined") return DEFAULT_PAGE_SIZE;
		const stored = window.localStorage.getItem(PAGE_SIZE_LS_KEY);
		if (stored === null) return DEFAULT_PAGE_SIZE;
		const n = Number.parseInt(stored, 10);
		return PAGE_SIZE_OPTIONS.includes(n) ? n : DEFAULT_PAGE_SIZE;
	});
	const [offset, setOffset] = useState<number>(0);
	const [showCost, setShowCost] = useState<boolean>(() => {
		if (typeof window === "undefined") return true;
		const stored = window.localStorage.getItem(COST_COLUMN_LS_KEY);
		// Default to on; only "0" hides the column.
		return stored !== "0";
	});

	useEffect(() => {
		if (typeof window === "undefined") return;
		window.localStorage.setItem(COST_COLUMN_LS_KEY, showCost ? "1" : "0");
	}, [showCost]);

	useEffect(() => {
		if (typeof window === "undefined") return;
		window.localStorage.setItem(PAGE_SIZE_LS_KEY, String(pageSize));
	}, [pageSize]);

	// Any change to filter / sort / dir / page size resets to page 1.
	// Otherwise an operator who narrows the result set can land on a
	// past-the-end offset and see an empty page.
	// biome-ignore lint/correctness/useExhaustiveDependencies: offset reset is the intended side effect
	useEffect(() => {
		setOffset(0);
	}, [filter, sort, dir, pageSize]);

	const filterApi = {
		...(filter === "all" ? {} : { [filter.kind]: filter.value }),
		sort,
		dir,
		limit: pageSize,
		offset,
	};
	const runs = useQuery({
		queryKey: ["runs", filter, sort, dir, pageSize, offset],
		queryFn: ({ signal }) => runsApi.list(filterApi, signal),
		refetchInterval: 5000,
	});

	// Click cycles: inactive → desc → asc → (back to started/desc default).
	const toggleSort = (key: SortKey): void => {
		if (sort !== key) {
			setSort(key);
			setDir("desc");
			return;
		}
		if (dir === "desc") {
			setDir("asc");
			return;
		}
		// asc → reset to default (started/desc)
		setSort("started");
		setDir("desc");
	};
	const sortState = { key: sort, direction: dir };
	const agents = useQuery({
		queryKey: ["agents"],
		queryFn: ({ signal }) => agentsApi.list({}, signal),
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

	// All-time totals from the server (warren-ee50). Survives pagination
	// — unlike the prior "sum the visible page" approach.
	const totalRuns = runs.data?.total ?? 0;
	const costTotals = {
		total: runs.data?.costTotalUsd ?? 0,
		priced: runs.data?.costPricedCount ?? 0,
	};
	const visibleCount = runs.data?.runs.length ?? 0;
	const rangeStart = visibleCount === 0 ? 0 : offset + 1;
	const rangeEnd = offset + visibleCount;
	const hasPrev = offset > 0;
	const hasNext = offset + visibleCount < totalRuns;

	return (
		<div className="space-y-6">
			<PageHeader
				title="Runs"
				description="Agent runs dispatched into burrow sandboxes."
				actions={
					<Link to="/runs/new">
						<Button>Dispatch a run</Button>
					</Link>
				}
			/>

			<div className="flex flex-wrap items-center justify-between gap-3">
				<div className="flex flex-wrap items-center gap-2">
					<label className="ml-1 flex items-center gap-1 text-xs text-(--color-muted-foreground)">
						<input
							type="checkbox"
							checked={showCost}
							onChange={(e) => setShowCost(e.target.checked)}
						/>
						Show cost
					</label>
				</div>
			</div>

			<StaggerList className="flex flex-wrap gap-2">
				<FadeInItem>
					<FilterPill
						active={filter === "all"}
						label="All"
						onClick={() => setFilter("all")}
					/>
				</FadeInItem>
				{agents.data?.agents.map((a) => (
					<FadeInItem key={`a-${a.name}`}>
						<FilterPill
							active={filter !== "all" && filter.kind === "agent" && filter.value === a.name}
							label={`agent: ${a.name}`}
							onClick={() => setFilter({ kind: "agent", value: a.name })}
						/>
					</FadeInItem>
				))}
				{projects.data?.projects.map((p) => (
					<FadeInItem key={`p-${p.id}`}>
						<FilterPill
							active={filter !== "all" && filter.kind === "project" && filter.value === p.id}
							label={`project: ${p.gitUrl.replace(/^https:\/\/github\.com\//, "")}`}
							onClick={() => setFilter({ kind: "project", value: p.id })}
						/>
					</FadeInItem>
				))}
			</StaggerList>

			<Card>
				<CardHeader className={responsiveCardHeaderRow}>
					<CardTitle>{totalRuns} runs</CardTitle>
					{showCost && costTotals.priced > 0 ? (
						<span
							className="font-mono text-xs text-(--color-muted-foreground)"
							title={`${costTotals.priced} of ${totalRuns} runs have a recorded cost (all-time)`}
						>
							total: {formatCostUsd(costTotals.total)}
						</span>
					) : null}
				</CardHeader>
				<CardContent className="p-0">
					{runs.isLoading ? (
						<div className="p-6"><Spinner label="Loading runs" /></div>
					) : runs.isError ? (
						<div className="p-6">
							<Alert variant="danger" title="Failed to load runs">
								{formatError(runs.error)}
							</Alert>
						</div>
					) : runs.data?.runs.length === 0 ? (
						<EmptyState
							title="No runs match this filter"
							description="Dispatch one above."
						/>
					) : (
						<Table>
							<TableHeader>
								<TableRow>
									<TableHead className="whitespace-nowrap">State</TableHead>
									<TableHead className="whitespace-nowrap">ID</TableHead>
									<TableHead className="whitespace-nowrap">Agent</TableHead>
									<TableHead className="whitespace-nowrap">Project</TableHead>
									<SortableTableHead
										columnKey="started"
										sort={sortState}
										onSort={toggleSort}
									>
										Started
									</SortableTableHead>
									{showCost ? (
										<SortableTableHead
											columnKey="cost"
											sort={sortState}
											onSort={toggleSort}
											align="right"
										>
											Cost
										</SortableTableHead>
									) : null}
								</TableRow>
							</TableHeader>
							<TableBody>
								{runs.data?.runs.map((r) => (
									<TableRow key={r.id}>
										<TableCell>
											<StateBadge state={r.state} />
										</TableCell>
										<TableCell>
											<Link
												to={`/runs/${encodeURIComponent(r.id)}`}
												className="font-mono text-xs underline-offset-2 hover:underline"
											>
												{r.id}
											</Link>
											{r.parentRunId !== null ? (
												<Link
													to={`/runs/${encodeURIComponent(r.parentRunId)}`}
													className="block font-mono text-xs text-(--color-muted-foreground) hover:underline"
												>
													↪ from {r.parentRunId}
												</Link>
											) : null}
										</TableCell>
										<TableCell className="whitespace-nowrap">{r.agentName}</TableCell>
										<TableCell className="whitespace-nowrap font-mono text-xs">
											{r.projectId === null ? (
												<span className="italic text-(--color-muted-foreground)">
													(deleted project)
												</span>
											) : (
												(projectIndex.get(r.projectId) ?? r.projectId)
											)}
										</TableCell>
										<TableCell className="whitespace-nowrap text-(--color-muted-foreground)">
											{relativeTime(r.startedAt)}
										</TableCell>
										{showCost ? (
											<TableCell className="whitespace-nowrap text-right font-mono text-xs">
												{r.costUsd !== null ? (
													formatCostUsd(r.costUsd)
												) : (
													<span className="text-(--color-muted-foreground)">—</span>
												)}
											</TableCell>
										) : null}
									</TableRow>
								))}
							</TableBody>
						</Table>
					)}
				</CardContent>
				{totalRuns > 0 ? (
					<div className="flex flex-wrap items-center justify-between gap-3 border-t border-(--color-border) px-4 py-2">
						<div className="flex items-center gap-2 text-xs text-(--color-muted-foreground)">
							<label htmlFor="runs-page-size" className="text-xs">
								Rows per page
							</label>
							<select
								id="runs-page-size"
								value={pageSize}
								onChange={(e) => setPageSize(Number.parseInt(e.target.value, 10))}
								className="rounded border border-(--color-border) bg-(--color-card) px-2 py-1 text-xs"
							>
								{PAGE_SIZE_OPTIONS.map((n) => (
									<option key={n} value={n}>
										{n}
									</option>
								))}
							</select>
						</div>
						<div className="flex items-center gap-3 text-xs text-(--color-muted-foreground)">
							<span className="font-mono">
								{rangeStart}–{rangeEnd} of {totalRuns}
							</span>
							<div className="flex items-center gap-1">
								<Button
									variant="ghost"
									size="sm"
									disabled={!hasPrev}
									onClick={() => setOffset((o) => Math.max(0, o - pageSize))}
									aria-label="Previous page"
								>
									<ChevronLeft className="h-4 w-4" />
								</Button>
								<Button
									variant="ghost"
									size="sm"
									disabled={!hasNext}
									onClick={() => setOffset((o) => o + pageSize)}
									aria-label="Next page"
								>
									<ChevronRight className="h-4 w-4" />
								</Button>
							</div>
						</div>
					</div>
				) : null}
			</Card>
		</div>
	);
}

