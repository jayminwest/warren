import { useQuery } from "@tanstack/react-query";
import { Navigate, NavLink, Outlet } from "react-router-dom";
import { projectsApi } from "@/api/client.ts";
import type { ProjectRow } from "@/api/types.ts";
import { PageHeader } from "@/components/ui/page-header.tsx";
import { Segmented } from "@/components/ui/segmented.tsx";
import { Select } from "@/components/ui/select.tsx";
import { cn } from "@/lib/utils.ts";
import { TelemetryMetricStrip } from "@/pages/telemetry/telemetry-metrics.tsx";
import {
	TELEMETRY_RANGE_DAYS,
	type TelemetryRangeDays,
	TelemetryWindowProvider,
	useTelemetryWindow,
} from "@/pages/telemetry/use-telemetry-window.tsx";

export { TelemetryBehaviorTab } from "@/pages/telemetry/behavior-tab.tsx";
export { TelemetryEconomicsTab } from "@/pages/telemetry/economics-tab.tsx";
export { TelemetryJudgeTab } from "@/pages/telemetry/judge-tab.tsx";
export { TelemetryLoopTab } from "@/pages/telemetry/loop-tab.tsx";

/**
 * Telemetry (warren-7197, migrated in warren-9474) — cost, behavior, and
 * delivery across runs, as four tabbed child routes: Delivery, Behavior,
 * Judge, Economics.
 *
 * Every width uses the same routing (warren-6bca): the tab strip scrolls
 * sideways on a phone instead of disappearing, and a /telemetry/<tab>
 * link opens that tab at any viewport. Nothing here reads the viewport
 * width to redirect a tab route.
 */

const TABS = [
	{ path: "loop", label: "Delivery", operatorOnly: false },
	{ path: "behavior", label: "Behavior", operatorOnly: false },
	{ path: "judge", label: "Judge", operatorOnly: false },
	{ path: "economics", label: "Economics", operatorOnly: true },
] as const;

const RANGE_OPTIONS = TELEMETRY_RANGE_DAYS.map((d) => ({
	value: String(d) as `${TelemetryRangeDays}`,
	label: `${d}d`,
}));

/** Filter the window to one project (warren-1548). */
function ProjectSelector() {
	const { projectId, setProjectId } = useTelemetryWindow();
	const projects = useQuery({
		queryKey: ["projects"],
		queryFn: ({ signal }) => projectsApi.list(signal),
		staleTime: 60_000,
	});
	const rows: readonly ProjectRow[] = projects.data?.projects ?? [];
	return (
		<Select
			value={projectId ?? ""}
			onChange={(e) => setProjectId(e.target.value === "" ? null : e.target.value)}
			aria-label="Filter by project"
			wrapperClassName="w-44"
		>
			<option value="">All projects</option>
			{rows.map((p) => (
				<option key={p.id} value={p.id}>
					{p.id}
				</option>
			))}
		</Select>
	);
}

function RangeSelector() {
	const { days, setDays } = useTelemetryWindow();
	return (
		<Segmented
			label="Time window"
			options={RANGE_OPTIONS}
			value={String(days) as `${TelemetryRangeDays}`}
			onChange={(v) => setDays(Number(v) as TelemetryRangeDays)}
		/>
	);
}

/**
 * The tab strip: the active tab carries a primary underline, drawn as an
 * inset shadow because the global `* { border-color }` rule outranks
 * border-colour utilities.
 */
function TabNav() {
	const { isOperator } = useTelemetryWindow();
	return (
		<nav
			aria-label="Telemetry sections"
			className="-mx-4 flex shrink-0 gap-5 overflow-x-auto border-b border-(--color-border) px-4 md:mx-0 md:px-0"
		>
			{TABS.filter((t) => isOperator || !t.operatorOnly).map(({ path, label }) => (
				<NavLink
					key={path}
					to={`/telemetry/${path}`}
					className={({ isActive }) =>
						cn(
							"flex h-10 shrink-0 items-center text-sm font-medium whitespace-nowrap transition-colors",
							isActive
								? "text-(--color-text) shadow-[inset_0_-2px_0_var(--color-primary)]"
								: "text-(--color-text-3) hover:text-(--color-text-2)",
						)
					}
				>
					{label}
				</NavLink>
			))}
		</nav>
	);
}

/** `/telemetry` opens the first tab, at every width. */
export function TelemetryIndexRedirect() {
	return <Navigate to="/telemetry/loop" replace />;
}

/** The tab layout: every /telemetry/* child renders under these tabs. */
export function TelemetryPage() {
	return (
		<TelemetryWindowProvider>
			<div className="flex min-h-full flex-col gap-5 px-4 pt-5 pb-12 md:px-6">
				<PageHeader
					title="Telemetry"
					description="Cost, behavior, and delivery across runs."
					actions={
						<>
							<ProjectSelector />
							<RangeSelector />
						</>
					}
				/>
				<TelemetryMetricStrip />
				<TabNav />
				<div className="min-h-0 flex-1">
					<Outlet />
				</div>
			</div>
		</TelemetryWindowProvider>
	);
}
