import { useQuery } from "@tanstack/react-query";
import { Plus } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { agentsApi, projectsApi, runsApi } from "@/api/client.ts";
import { isTerminalRunState } from "@/api/types.ts";
import { OperatorOnly, useOperatorHint } from "@/components/operator-only.tsx";
import { buttonVariants } from "@/components/ui/button.tsx";
import { Card } from "@/components/ui/card.tsx";
import { EmptyState } from "@/components/ui/empty-state.tsx";
import { PageHeader } from "@/components/ui/page-header.tsx";
import { SkeletonRows } from "@/components/ui/skeleton.tsx";
import { useCapabilities } from "@/hooks/use-capabilities.ts";
import { useNow } from "@/hooks/use-now.ts";
import { formatCostUsd } from "@/pages/run-detail-format.ts";
import { ListError } from "@/pages/runs/list-error.tsx";
import { RunsCardList } from "@/pages/runs/runs-cards.tsx";
import {
	matchesStateFilter,
	NO_FILTERS,
	type PageFilters,
	RunsFilterBar,
} from "@/pages/runs/runs-filter-bar.tsx";
import { RunsPager } from "@/pages/runs/runs-pager.tsx";
import { RunsTable } from "@/pages/runs/runs-table.tsx";

/**
 * Runs — every agent run across every project (warren-9e87, migrated to
 * the primitives in warren-9474): a filter bar over one dense table, a
 * row-card list on a phone. The lifecycle stream invalidates the
 * ["runs"] query family; the 60s poll only covers public mode and
 * dropped notifications.
 */

// warren-ee50: page size persists in localStorage; offset deliberately
// does not (a stale offset can land past the end of a shrunken set).
const PAGE_SIZE_LS_KEY = "warren.runsList.pageSize";
const PAGE_SIZE_OPTIONS: readonly number[] = [25, 50, 100, 200];
const DEFAULT_PAGE_SIZE = 50;
// Phone "Load more" window (warren-ffaf): the card list grows a
// client-side visible-count window instead of the desktop pager.
const MOBILE_PAGE_STEP = 8;
const DEFAULT_MOBILE_COUNT = 8;

function readPageSize(): number {
	try {
		const stored = window.localStorage.getItem(PAGE_SIZE_LS_KEY);
		const n = stored === null ? Number.NaN : Number.parseInt(stored, 10);
		return PAGE_SIZE_OPTIONS.includes(n) ? n : DEFAULT_PAGE_SIZE;
	} catch {
		return DEFAULT_PAGE_SIZE;
	}
}

function isFiltering(f: PageFilters): boolean {
	return (
		f.agent !== "all" ||
		f.project !== "all" ||
		f.state !== "all" ||
		f.trigger !== "all" ||
		f.search.trim().length > 0
	);
}

export function RunsPage() {
	const caps = useCapabilities();
	const isOperator = caps.can("readOperator");
	const [filters, setFilters] = useState<PageFilters>(NO_FILTERS);
	const [pageSize, setPageSize] = useState<number>(readPageSize);
	const [offset, setOffset] = useState<number>(0);
	const [mobileCount, setMobileCount] = useState<number>(DEFAULT_MOBILE_COUNT);

	useEffect(() => {
		try {
			window.localStorage.setItem(PAGE_SIZE_LS_KEY, String(pageSize));
		} catch {
			// Storage blocked: the choice just doesn't persist.
		}
	}, [pageSize]);

	// Any filter / page-size change resets to page 1 so a narrowed result
	// set never leaves the offset past its end.
	// biome-ignore lint/correctness/useExhaustiveDependencies: offset reset is the intended side effect
	useEffect(() => {
		setOffset(0);
		setMobileCount(DEFAULT_MOBILE_COUNT);
	}, [filters, pageSize]);

	const serverFilter = {
		...(filters.agent !== "all" ? { agent: filters.agent } : {}),
		...(filters.project !== "all" ? { project: filters.project } : {}),
		sort: "started" as const,
		dir: "desc" as const,
		limit: pageSize,
		offset,
	};
	const runs = useQuery({
		queryKey: ["runs", filters.agent, filters.project, pageSize, offset],
		queryFn: ({ signal }) => runsApi.list(serverFilter, signal),
		// warren-f566: the lifecycle stream drives invalidation; this is
		// only the slow fallback for public mode / dropped notifications.
		refetchInterval: 60_000,
	});
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
	const projectOptions = useMemo(
		() => (projects.data?.projects ?? []).map((p) => ({ id: p.id, gitUrl: p.gitUrl })),
		[projects.data],
	);
	const agentNames = useMemo(() => (agents.data?.agents ?? []).map((a) => a.name), [agents.data]);

	const loadedRows = useMemo(() => runs.data?.runs ?? [], [runs.data]);

	// Client-side window filters (state / trigger / search-by-id-or-seed).
	const rows = useMemo(() => {
		const q = filters.search.trim().toLowerCase();
		return loadedRows.filter((r) => {
			if (!matchesStateFilter(r.state, filters.state)) return false;
			if (filters.trigger !== "all" && r.trigger !== filters.trigger) return false;
			if (q.length > 0) {
				const seed = r.seedId ?? "";
				if (!r.id.toLowerCase().includes(q) && !seed.toLowerCase().includes(q)) return false;
			}
			return true;
		});
	}, [loadedRows, filters.state, filters.trigger, filters.search]);

	const triggers = useMemo(
		() => [...new Set(loadedRows.map((r) => r.trigger))].sort(),
		[loadedRows],
	);

	const totalRuns = runs.data?.total ?? 0;
	// All-time rollup from the server. `costTotalUsd` is absent from a
	// spectator's envelope (warren-946f), so it stays `undefined` rather
	// than 0 and the figure renders on presence (warren-f53e).
	const costTotals = {
		total: runs.data?.costTotalUsd,
		priced: runs.data?.costPricedCount ?? 0,
	};
	const emptyHint = useOperatorHint("Dispatch one above.");
	// Live durations (warren-b610): a 1s tick only while a visible row is
	// still moving — a terminal-only list must not re-render on a timer.
	const hasLiveRows = rows.some((r) => !isTerminalRunState(r.state));
	const now = useNow(1000, hasLiveRows);
	const mobileRows = rows.slice(0, mobileCount);
	const filtering = isFiltering(filters);

	const listState = runs.isLoading ? (
		<SkeletonRows rows={10} />
	) : runs.isError ? (
		<ListError what="runs" error={runs.error} onRetry={() => void runs.refetch()} />
	) : rows.length === 0 ? (
		<EmptyState
			title={filtering ? "No runs match these filters" : "No runs yet"}
			description={filtering ? "Clear a filter to see more runs." : emptyHint}
		/>
	) : null;

	return (
		<div className="flex flex-col gap-5 px-4 pt-6 pb-12 md:px-6">
			<PageHeader
				title="Runs"
				description="Every agent run across your projects, newest first."
				actions={
					<OperatorOnly>
						<Link to="/dispatch" className={buttonVariants({ className: "hidden md:inline-flex" })}>
							<Plus aria-hidden />
							Dispatch run
						</Link>
					</OperatorOnly>
				}
			/>
			<Card className="self-stretch">
				<RunsFilterBar
					filters={filters}
					setFilters={setFilters}
					agentNames={agentNames}
					projects={projectOptions}
					triggers={triggers}
				/>
				{listState ?? (
					<>
						<RunsCardList rows={mobileRows} projectIndex={projectIndex} now={now} />
						<div className="hidden md:block">
							<RunsTable
								rows={rows}
								projectIndex={projectIndex}
								now={now}
								isOperator={isOperator}
							/>
						</div>
					</>
				)}
				{totalRuns > 0 ? (
					<RunsPager
						pageSize={pageSize}
						pageSizeOptions={PAGE_SIZE_OPTIONS}
						onPageSize={setPageSize}
						rangeStart={rows.length === 0 ? 0 : offset + 1}
						rangeEnd={offset + rows.length}
						total={totalRuns}
						hasPrev={offset > 0}
						hasNext={offset + loadedRows.length < totalRuns}
						onPrev={() => setOffset((o) => Math.max(0, o - pageSize))}
						onNext={() => setOffset((o) => o + pageSize)}
						costLabel={
							costTotals.total !== undefined && costTotals.priced > 0
								? formatCostUsd(costTotals.total)
								: null
						}
						costTitle={`${costTotals.priced} of ${totalRuns} runs have a recorded cost`}
						mobileShown={mobileRows.length}
						mobileHasMore={mobileCount < rows.length}
						onMore={() => setMobileCount((c) => c + MOBILE_PAGE_STEP)}
					/>
				) : null}
			</Card>
		</div>
	);
}
