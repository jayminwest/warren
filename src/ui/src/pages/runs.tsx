import { useQuery } from "@tanstack/react-query";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { agentsApi, projectsApi, runsApi } from "@/api/client.ts";
import { isTerminalRunState } from "@/api/types.ts";
import { OperatorOnly, useOperatorHint } from "@/components/operator-only.tsx";
import { Alert } from "@/components/ui/alert.tsx";
import { Button } from "@/components/ui/button.tsx";
import { EmptyState } from "@/components/ui/empty-state.tsx";
import { Spinner } from "@/components/ui/spinner.tsx";
import { useCapabilities } from "@/hooks/use-capabilities.ts";
import { useNow } from "@/hooks/use-now.ts";
import { formatError } from "@/lib/format-error.ts";
import { formatCostUsd } from "@/pages/run-detail-format.ts";
import { RunsCardList } from "@/pages/runs/runs-cards.tsx";
import {
	matchesStateFilter,
	NO_FILTERS,
	type PageFilters,
	RunsFilterBar,
} from "@/pages/runs/runs-filter-bar.tsx";
import { RunsTable } from "@/pages/runs/runs-table.tsx";

/**
 * Runs — the Direction C workload inventory (warren-9e87 / pl-7e38
 * step 3), translated from docs/ui-revamp/screens/runs.jsx: a filter
 * strip plus a dense run index table. No summary cards — the table is
 * the product. Colors come only from token variables; operator
 * affordances (Dispatch run) ride OperatorOnly so the spectator
 * projection stays read-only.
 *
 * Refresh behavior is unchanged from the legacy page (warren-f566):
 * the global lifecycle stream invalidates the ["runs"] query family;
 * this page keeps a 45s fallback poll.
 */

// warren-ee50: page size persists in localStorage; offset deliberately
// does not (a stale offset can land past the end of a shrunken set).
const PAGE_SIZE_LS_KEY = "warren.runsList.pageSize";
const PAGE_SIZE_OPTIONS: readonly number[] = [25, 50, 100, 200];
const DEFAULT_PAGE_SIZE = 50;
// Mobile "Load more" window (warren-ffaf / pl-4ab6 step 10): the phone
// list grows a client-side visible-count window instead of the desktop
// offset pager. 8 rows per step, mirroring the 375px artboard footer.
const MOBILE_PAGE_STEP = 8;
const DEFAULT_MOBILE_COUNT = 8;

export function RunsPage() {
	const caps = useCapabilities();
	const isOperator = caps.can("readOperator");
	const [filters, setFilters] = useState<PageFilters>(NO_FILTERS);
	const [pageSize, setPageSize] = useState<number>(() => {
		if (typeof window === "undefined") return DEFAULT_PAGE_SIZE;
		const stored = window.localStorage.getItem(PAGE_SIZE_LS_KEY);
		if (stored === null) return DEFAULT_PAGE_SIZE;
		const n = Number.parseInt(stored, 10);
		return PAGE_SIZE_OPTIONS.includes(n) ? n : DEFAULT_PAGE_SIZE;
	});
	const [offset, setOffset] = useState<number>(0);
	const [mobileCount, setMobileCount] = useState<number>(DEFAULT_MOBILE_COUNT);

	useEffect(() => {
		if (typeof window === "undefined") return;
		window.localStorage.setItem(PAGE_SIZE_LS_KEY, String(pageSize));
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
		refetchInterval: 45_000,
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

	const triggerOptions = useMemo(() => {
		const seen = new Set<string>();
		for (const r of loadedRows) seen.add(r.trigger);
		return [
			{ value: "all", label: "Trigger" },
			...[...seen].sort().map((t) => ({ value: t, label: t })),
		];
	}, [loadedRows]);

	const totalRuns = runs.data?.total ?? 0;
	// All-time rollup from the server. `costTotalUsd` is absent from a
	// spectator's envelope (warren-946f drops the instance-wide rollup), so
	// it stays `undefined` rather than 0 and the footer figure renders on
	// presence — a coalesced 0 would read as a real "$0.00 all-time"
	// (warren-f53e). No summary cards (the design spec): this is a quiet
	// footer figure, not a tile.
	const costTotals = {
		total: runs.data?.costTotalUsd,
		priced: runs.data?.costPricedCount ?? 0,
	};
	const emptyHint = useOperatorHint("Dispatch one above.");
	// Live durations (warren-b610): a 1s tick keeps the Duration cell of a
	// running run moving between the 45s refetches. The tick runs only
	// while a visible row is non-terminal — a terminal-only list must not
	// re-render on a timer.
	const hasLiveRows = rows.some((r) => !isTerminalRunState(r.state));
	const now = useNow(1000, hasLiveRows);
	const visibleCount = rows.length;
	const rangeStart = visibleCount === 0 ? 0 : offset + 1;
	const rangeEnd = offset + visibleCount;
	const hasPrev = offset > 0;
	const hasNext = offset + loadedRows.length < totalRuns;

	// Mobile window: the phone card list shows only the first
	// `mobileCount` filtered rows; "Load more" grows the window
	// (warren-ffaf). The desktop table keeps the full filtered page.
	const mobileRows = rows.slice(0, mobileCount);
	const mobileHasMore = mobileCount < rows.length;
	const isFiltered =
		filters.agent !== "all" ||
		filters.project !== "all" ||
		filters.state !== "all" ||
		filters.trigger !== "all" ||
		filters.search.trim().length > 0;

	// Shared loading/error/empty body — rendered inside both the mobile
	// card and the desktop table container (warren-8258 hoisted the
	// states out of the desktop-only arm; both surfaces keep them).
	const listState = runs.isLoading ? (
		<div className="p-6">
			<Spinner label="Loading runs" />
		</div>
	) : runs.isError ? (
		<div className="p-6">
			<Alert variant="danger" title="Failed to load runs">
				{formatError(runs.error)}
			</Alert>
		</div>
	) : visibleCount === 0 ? (
		<div className="p-6">
			<EmptyState title="No runs match this filter" description={emptyHint} />
		</div>
	) : null;

	return (
		<div className="flex min-h-full flex-col px-3.5 pt-[22px] pb-12 md:px-6">
			{/* Page header: title + description + operator action (export layout). */}
			<div className="flex shrink-0 flex-wrap items-start justify-between gap-4 pb-5">
				<div className="flex min-w-0 flex-col gap-[5px]">
					<h1 className="text-[17px] leading-[22px] font-semibold tracking-[-0.025em] text-(--color-text) md:text-[20px] md:leading-6">
						Runs
					</h1>
					<p className="text-[11px] leading-[14px] text-(--color-text-2) md:text-[12px] md:leading-4">
						Managed agent workloads across every project and runtime.
					</p>
				</div>
				{/* Below md the trailing slot is the mono run count; dispatch
				    lives in the bottom nav (warren-ffaf, mock :66-68). */}
				<div className="shrink-0 font-mono text-[10px] leading-3 text-(--color-text-3) md:hidden">
					{totalRuns} TOTAL
				</div>
				<OperatorOnly>
					<Link
						to="/dispatch"
						className="hidden md:inline-flex h-[31px] items-center gap-[7px] rounded-(--radius-sm) bg-(--color-primary) px-[11px] text-[11px] leading-[14px] font-medium text-(--color-primary-ink) hover:opacity-90"
					>
						＋ Dispatch run
					</Link>
				</OperatorOnly>
			</div>

			{/* Filter strip: mobile pill strip below md, the export's surface bar at md+ (warren-6419). */}
			<RunsFilterBar
				filters={filters}
				setFilters={setFilters}
				agentNames={(agents.data?.agents ?? []).map((a) => a.name)}
				projects={(projects.data?.projects ?? []).map((p) => ({ id: p.id, gitUrl: p.gitUrl }))}
				triggerOptions={triggerOptions}
			/>
			{/* Mobile list card (warren-ffaf / pl-4ab6 step 10): its own
			    fully-rounded bordered surface with 14px side margins, capped
			    by the --color-thead column strip (mock :92-103). */}
			<div className="mx-[14px] flex flex-col overflow-clip rounded-(--radius-md) border border-(--color-border) bg-(--color-surface) md:hidden">
				<div className="flex shrink-0 items-center gap-2 bg-(--color-thead) px-3 py-2 font-mono text-[9px] leading-[11px] tracking-[0.06em] text-(--color-text-3)">
					<span className="w-[70px] shrink-0">STATE</span>
					<span className="grow">RUN</span>
					<span className="shrink-0">ELAPSED · COST</span>
				</div>
				{listState ?? <RunsCardList rows={mobileRows} projectIndex={projectIndex} now={now} />}
			</div>
			{/* Mobile pagination footer (mock :297-305): outside the card,
			    count on the left, Load-more on the right. */}
			<div className="flex shrink-0 items-center px-[14px] pt-3 pb-4 md:hidden">
				<span className="font-mono text-[9px] leading-[11px] text-(--color-text-3)">
					{mobileRows.length} OF {totalRuns}
					{isFiltered ? " · FILTERED" : null}
				</span>
				<span className="grow" />
				{mobileHasMore ? (
					<button
						type="button"
						onClick={() => setMobileCount((c) => c + MOBILE_PAGE_STEP)}
						className="text-[11px] leading-[14px] font-medium text-(--color-primary)"
					>
						Load more →
					</button>
				) : null}
			</div>
			{/* Inventory table — desktop only below this point, unchanged. */}
			<div className="hidden min-h-0 flex-1 flex-col overflow-clip rounded-b-(--radius-md) border border-t-0 border-(--color-border) bg-(--color-surface) md:flex">
				{listState ?? (
					<div className="hidden md:block">
						<RunsTable rows={rows} projectIndex={projectIndex} now={now} isOperator={isOperator} />
					</div>
				)}
				{totalRuns > 0 ? (
					<div className="mt-auto flex flex-wrap items-center justify-between gap-3 border-t border-(--color-border) px-4 py-2">
						<div className="flex items-center gap-2 text-xs text-(--color-text-3)">
							<label htmlFor="runs-page-size" className="text-xs">
								Rows per page
							</label>
							<select
								id="runs-page-size"
								value={pageSize}
								onChange={(e) => setPageSize(Number.parseInt(e.target.value, 10))}
								className="rounded border border-(--color-border) bg-(--color-bg) px-2 py-1 text-xs"
							>
								{PAGE_SIZE_OPTIONS.map((n) => (
									<option key={n} value={n}>
										{n}
									</option>
								))}
							</select>
						</div>
						<div className="flex items-center gap-3 text-xs text-(--color-text-3)">
							{costTotals.total !== undefined && costTotals.priced > 0 ? (
								<span
									className="font-mono text-[10px] leading-3 text-(--color-text-3)"
									title={`${costTotals.priced} of ${totalRuns} runs have a recorded cost (all-time)`}
								>
									total: {formatCostUsd(costTotals.total)}
								</span>
							) : null}
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
			</div>
		</div>
	);
}
