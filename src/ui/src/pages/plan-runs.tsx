import { useQuery } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { planRunsApi, projectsApi } from "@/api/client.ts";
import type { PlanRunRow, PlanRunStateFilter } from "@/api/types.ts";
import { isTerminalPlanRunState } from "@/api/types.ts";
import { OperatorOnly, useOperatorHint } from "@/components/operator-only.tsx";
import type { SortState } from "@/components/ui/sortable-table-head.tsx";
import { type Comparator, compareStrings, useClientSort } from "@/hooks/use-client-sort.ts";
import { useNow } from "@/hooks/use-now.ts";
import { formatError } from "@/lib/format-error.ts";
import { WalkCardList } from "./plan-runs/walk-cards.tsx";
import { WalkRow } from "./plan-runs/walk-row.tsx";

/**
 * Plan runs — the Direction C walk inventory (warren-23b2 / pl-7e38
 * step 6, from docs/ui-revamp/screens/plan-runs.jsx). Sequential walks
 * with child-by-child progress: no summary cards, the table is the
 * product. Filterable like the run index (state, project, free-text
 * plan / plan-run id). The read surface is readPublic, so a spectator
 * sees the same inventory read-only — the only operator affordance on
 * this page is the Dispatch plan button, which `OperatorOnly` drops.
 */

type PlanRunSortKey = "state" | "id" | "planId" | "startedAt";

const STATE_OPTIONS: { label: string; value: "all" | PlanRunStateFilter }[] = [
	{ label: "State: all", value: "all" },
	{ label: "State: active", value: "active" },
	{ label: "State: queued", value: "queued" },
	{ label: "State: running", value: "running" },
	{ label: "State: succeeded", value: "succeeded" },
	{ label: "State: failed", value: "failed" },
	{ label: "State: cancelled", value: "cancelled" },
];

const COLUMN_WIDTHS = {
	state: "w-[78px]",
	planRun: "w-[150px]",
	plan: "w-[90px]",
	project: "w-[128px]",
	agent: "w-[118px]",
	trigger: "w-[62px]",
	started: "w-[56px]",
	elapsed: "w-[62px]",
	cap: "w-[54px]",
} as const;

export function PlanRunsPage() {
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
		refetchInterval: 45_000,
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

	const rows = useMemo(() => {
		const all = planRuns.data?.planRuns ?? [];
		if (search.length === 0) return all;
		const q = search.toLowerCase();
		return all.filter(
			(pr) => pr.id.toLowerCase().includes(q) || (pr.planId ?? "").toLowerCase().includes(q),
		);
	}, [planRuns.data, search]);

	const comparators = useMemo<Record<PlanRunSortKey, Comparator<PlanRunRow>>>(
		() => ({
			state: (a, b) => compareStrings(a.state, b.state),
			id: (a, b) => compareStrings(a.id, b.id),
			planId: (a, b) => compareStrings(a.planId ?? "", b.planId ?? ""),
			startedAt: (a, b) => compareStrings(a.startedAt ?? "", b.startedAt ?? ""),
		}),
		[],
	);
	const { sorted, sort, onSort } = useClientSort(rows, comparators, {
		initialKey: "startedAt",
		initialDirection: "desc",
		defaultDirections: { startedAt: "desc" },
	});

	const hasFilters = stateFilter !== "all" || projectFilter.length > 0 || search.length > 0;
	const emptyHint = useOperatorHint("Dispatch one from the Dispatch plan page.");
	// Live elapsed (warren-b610): a 1s tick between the 45s refetches,
	// running only while a visible walk is non-terminal.
	const hasLiveWalks = sorted.some((pr) => !isTerminalPlanRunState(pr.state));
	const now = useNow(1000, hasLiveWalks);
	const projectLabel = (pr: PlanRunRow): string => projectIndex.get(pr.projectId) ?? pr.projectId;

	return (
		<div className="flex min-h-full flex-col px-3.5 pb-12 pt-[22px] md:px-6">
			<div className="flex shrink-0 items-start gap-4 pb-5">
				<div className="flex min-w-0 flex-1 flex-col gap-[5px]">
					<h1 className="text-[20px] font-semibold leading-6 tracking-[-0.025em] text-(--color-text)">
						Plan runs
					</h1>
					<p className="text-[12px] leading-4 text-(--color-text-2)">
						Plans dispatched as sequential runs, one child at a time.
					</p>
				</div>
				<OperatorOnly>
					<Link
						to="/dispatch/plan"
						className="flex h-[31px] shrink-0 items-center justify-center gap-[7px] rounded-(--radius-sm) bg-(--color-primary) px-[11px] text-[11px] leading-3.5 font-medium text-(--color-primary-ink)"
					>
						＋ Dispatch plan
					</Link>
				</OperatorOnly>
			</div>

			<div className="flex min-h-[44px] shrink-0 flex-wrap items-center gap-[7px] rounded-t border border-(--color-border) bg-(--color-surface) px-2 py-[7px]">
				<FilterSelect
					name="State filter"
					value={stateFilter}
					onChange={(v) => setStateFilter(v as "all" | PlanRunStateFilter)}
					active={stateFilter !== "all"}
				>
					{STATE_OPTIONS.map((o) => (
						<option key={o.value} value={o.value}>
							{o.label}
						</option>
					))}
				</FilterSelect>
				<FilterSelect
					name="Project filter"
					value={projectFilter}
					onChange={setProjectFilter}
					active={projectFilter !== ""}
				>
					<option value="">All projects</option>
					{projects.data?.projects.map((p) => (
						<option key={p.id} value={p.id}>
							{p.gitUrl}
						</option>
					))}
				</FilterSelect>
				{hasFilters ? (
					<button
						type="button"
						onClick={() => {
							setStateFilter("all");
							setProjectFilter("");
							setSearch("");
						}}
						className="h-[25px] px-2 text-[10px] leading-3 font-medium text-(--color-text-2) hover:text-(--color-text)"
					>
						Clear
					</button>
				) : null}
				<div className="min-w-0 flex-1" />
				<input
					type="search"
					value={search}
					onChange={(e) => setSearch(e.target.value)}
					placeholder="Filter by plan or plan-run ID"
					className="h-[27px] w-[220px] shrink-0 rounded-(--radius-sm) border border-(--color-border-strong) bg-(--color-bg) px-[9px] text-[10px] leading-3 text-(--color-text-2) placeholder:text-(--color-text-3) focus:outline-none"
				/>
			</div>

			<div className="shrink-0 overflow-x-auto rounded-b bg-(--color-surface)">
				{planRuns.isLoading ? (
					<StatusLine>Loading plan runs…</StatusLine>
				) : planRuns.isError ? (
					<StatusLine danger>Failed to load plan runs: {formatError(planRuns.error)}</StatusLine>
				) : sorted.length === 0 ? (
					<StatusLine>
						No plan runs match this filter.
						{emptyHint !== undefined ? ` ${emptyHint}` : ""}
					</StatusLine>
				) : (
					<>
						{/* Mobile arm: compact walk cards (warren-dea8). */}
						<WalkCardList planRuns={sorted} projectLabel={projectLabel} now={now} />
						<div className="hidden min-w-[1080px] md:block">
							<HeaderRow sort={sort} onSort={onSort} />
							{sorted.map((pr) => (
								<WalkRow key={pr.id} planRun={pr} projectLabel={projectLabel(pr)} now={now} />
							))}
						</div>
					</>
				)}
			</div>
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
	const head = (label: string, width: string, sortKey?: PlanRunSortKey, right = false) => (
		<div
			key={label}
			className={`${width} shrink-0 ${right ? "text-right" : ""} text-[9px] leading-3 font-semibold tracking-[0.05em] text-(--color-text-3) uppercase`}
		>
			{sortKey === undefined ? (
				label
			) : (
				<button
					type="button"
					onClick={() => onSort(sortKey)}
					className="cursor-pointer hover:text-(--color-text-2)"
					title={sort.key === sortKey ? `Sorted ${sort.direction}` : `Sort by ${label}`}
				>
					{label}
					{sort.key === sortKey ? (sort.direction === "asc" ? " ↑" : " ↓") : ""}
				</button>
			)}
		</div>
	);

	return (
		<div className="flex h-[31px] items-center gap-2.5 border-b border-(--color-border-strong) bg-(--color-thead) px-2.5">
			{head("State", COLUMN_WIDTHS.state, "state")}
			{head("Plan run", COLUMN_WIDTHS.planRun, "id")}
			{head("Plan", COLUMN_WIDTHS.plan, "planId")}
			{head("Project", COLUMN_WIDTHS.project)}
			{head("Agent", COLUMN_WIDTHS.agent)}
			{head("Trigger", COLUMN_WIDTHS.trigger)}
			{head("Started", COLUMN_WIDTHS.started, "startedAt")}
			{head("Elapsed", COLUMN_WIDTHS.elapsed, undefined, true)}
			{head("Cap", COLUMN_WIDTHS.cap, undefined, true)}
			<div className="min-w-0 flex-1 text-[9px] leading-3 font-semibold tracking-[0.05em] text-(--color-text-3) uppercase">
				Children
			</div>
		</div>
	);
}

function FilterSelect({
	name,
	value,
	onChange,
	active,
	children,
}: {
	/** Stable accessible name for the filter control. */
	name: string;
	value: string;
	onChange: (value: string) => void;
	active: boolean;
	children: React.ReactNode;
}) {
	return (
		<select
			aria-label={name}
			value={value}
			onChange={(e) => onChange(e.target.value)}
			className={`h-[27px] cursor-pointer rounded-(--radius-sm) border bg-(--color-bg) px-2 text-[10px] leading-3 text-(--color-text-2) focus:outline-none ${
				active
					? "border-(--color-primary) text-(--color-primary)"
					: "border-(--color-border) text-(--color-text-3)"
			}`}
		>
			{children}
		</select>
	);
}

function StatusLine({ children, danger = false }: { children: React.ReactNode; danger?: boolean }) {
	return (
		<div
			className={`px-2.5 py-6 text-[11px] leading-4 ${
				danger ? "text-(--color-danger)" : "text-(--color-text-3)"
			}`}
		>
			{children}
		</div>
	);
}
