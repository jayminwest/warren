import { useQuery } from "@tanstack/react-query";
import { Navigate, NavLink, Outlet, useLocation } from "react-router-dom";
import { projectsApi } from "@/api/client.ts";
import type { ProjectRow } from "@/api/types.ts";
import { OperatorOnly } from "@/components/operator-only.tsx";
import { cn } from "@/lib/utils.ts";
import { TelemetryBehaviorTab } from "@/pages/telemetry/behavior-tab.tsx";
import { TelemetryEconomicsTab } from "@/pages/telemetry/economics-tab.tsx";
import { TelemetryJudgeTab } from "@/pages/telemetry/judge-tab.tsx";
import { TelemetryLoopTab } from "@/pages/telemetry/loop-tab.tsx";
import { TelemetryMetricStrip } from "@/pages/telemetry/telemetry-metrics.tsx";
import { useIsDesktop } from "@/pages/telemetry/use-is-desktop.ts";
import {
	TELEMETRY_RANGE_DAYS,
	TelemetryWindowProvider,
	useTelemetryWindow,
} from "@/pages/telemetry/use-telemetry-window.tsx";

export { TelemetryBehaviorTab } from "@/pages/telemetry/behavior-tab.tsx";
export { TelemetryEconomicsTab } from "@/pages/telemetry/economics-tab.tsx";
export { TelemetryJudgeTab } from "@/pages/telemetry/judge-tab.tsx";
export { TelemetryLoopTab } from "@/pages/telemetry/loop-tab.tsx";

/**
 * Telemetry (warren-7197 / pl-7e38 step 14) — the Direction C
 * consolidation of the four analysis surfaces under one tabbed page:
 * The Loop, Behavior, Judge, Economics (docs/ui-revamp/README.md,
 * c-telemetry). Cost, behavior, and delivery joined across run
 * records, forge PR state, and judge verdicts.
 *
 * This page replaces and deletes the legacy run-analytics and
 * cost-analytics pages: it consumes the same analytics endpoints
 * (`GET /analytics/runs`, `/analytics/behavior`, `/analytics/cost`)
 * without recharts — the outcome bars and ranking rows are lightweight
 * div/SVG marks so the consolidation shrinks the bundle. The Judge tab
 * reads the judge extension's published surface only.
 *
 * Mobile chrome (warren-93cc / pl-4ab6): below md there is no tab strip
 * and no range selector (mock mobile/telemetry.jsx) — the four tabs'
 * content stacks as panels on one scroll, and the selected window
 * surfaces as panel-header meta (TelemetryPanel appends it). Routing
 * decision: tabs are child routes, so deep links below md redirect to
 * /telemetry (the stacked arm shows every panel anyway); desktop
 * routing is unchanged.
 */

const TABS = [
	{ path: "loop", label: "DELIVERY" },
	{ path: "behavior", label: "BEHAVIOR" },
	{ path: "judge", label: "JUDGE" },
	{ path: "economics", label: "ECONOMICS" },
] as const;

/** "ENDS TODAY · AUG 26" — the window end label beside the selector. */
function endsTodayLabel(): string {
	return `ENDS TODAY · ${new Date()
		.toLocaleDateString("en-US", { month: "short", day: "numeric" })
		.toUpperCase()}`;
}

/** The project <select> beside the range selector (warren-1548). */
function ProjectSelector() {
	const { projectId, setProjectId } = useTelemetryWindow();
	const projects = useQuery({
		queryKey: ["projects"],
		queryFn: ({ signal }) => projectsApi.list(signal),
	});
	const rows: readonly ProjectRow[] = projects.data?.projects ?? [];
	return (
		<select
			value={projectId ?? ""}
			onChange={(e) => setProjectId(e.target.value === "" ? null : e.target.value)}
			aria-label="Filter by project"
			className="hidden h-8 rounded-(--radius-sm) border border-(--color-border) bg-(--color-bg) px-2 font-mono text-[11px] leading-[14px] text-(--color-text-2) md:block"
		>
			<option value="">all projects</option>
			{rows.map((p) => (
				<option key={p.id} value={p.id}>
					{p.id}
				</option>
			))}
		</select>
	);
}

/** The 7D/14D/30D/90D segmented control from the artboards (md+ only). */
function RangeSelector() {
	const { days, setDays } = useTelemetryWindow();
	return (
		<div className="hidden items-center gap-3 md:flex">
			<span className="hidden font-mono text-[11px] tracking-[0.04em] leading-[14px] text-(--color-text-3) sm:inline">
				{endsTodayLabel()}
			</span>
			<section
				className="flex overflow-hidden rounded-(--radius-sm) border border-(--color-border-strong)"
				aria-label="Telemetry window"
			>
				{TELEMETRY_RANGE_DAYS.map((d) => {
					const active = d === days;
					return (
						<button
							key={d}
							type="button"
							onClick={() => setDays(d)}
							aria-pressed={active}
							className={cn(
								"px-2.5 py-1.5 font-mono text-[11px] leading-[14px]",
								active
									? "bg-(--color-primary) font-medium text-(--color-primary-ink)"
									: "text-(--color-text-3) hover:text-(--color-text-2)",
							)}
						>
							{`${String(d)}D`}
						</button>
					);
				})}
			</section>
		</div>
	);
}

/**
 * The tab strip; active tab carries the 2px primary underline. Below md
 * the strip is hidden (stacked panels) — md+ it never wraps: labels
 * scroll horizontally instead of collapsing into two-line stubs.
 */
function TabNav() {
	return (
		<nav className="hidden w-full shrink-0 items-end gap-6 overflow-x-auto whitespace-nowrap border-b border-(--color-border) md:flex">
			{TABS.map(({ path, label }) => (
				<NavLink
					key={path}
					to={`/telemetry/${path}`}
					className={({ isActive }) =>
						cn(
							"flex shrink-0 flex-col gap-2 pb-0 font-mono text-[11px] leading-[14px] tracking-[0.08em]",
							isActive
								? "font-semibold text-(--color-text)"
								: "text-(--color-text-3) hover:text-(--color-text-2)",
						)
					}
				>
					{({ isActive }) => (
						<>
							<span>{label}</span>
							<span
								className={cn("h-0.5 w-full", isActive ? "bg-(--color-primary)" : "bg-transparent")}
							/>
						</>
					)}
				</NavLink>
			))}
		</nav>
	);
}

/**
 * The index child: desktop keeps the legacy "land on DELIVERY"
 * redirect; below md the stacked arm already renders everything, so
 * the index child stays empty (redirecting would bounce off the
 * page-level deep-link flatten).
 */
export function TelemetryIndexRedirect() {
	const isDesktop = useIsDesktop();
	if (!isDesktop) return null;
	return <Navigate to="/telemetry/loop" replace />;
}

/** The tab layout: every /telemetry/* child renders under these tabs. */
export function TelemetryPage() {
	const isDesktop = useIsDesktop();
	const location = useLocation();

	// Below md there is no tab strip — every panel is already on the
	// scroll, so a deep link just flattens to /telemetry.
	if (!isDesktop && location.pathname !== "/telemetry") {
		return <Navigate to="/telemetry" replace />;
	}

	return (
		<TelemetryWindowProvider>
			<div className="flex min-h-full flex-col gap-5 px-3.5 py-6 md:px-6">
				<header className="flex flex-col justify-between gap-3 sm:flex-row sm:items-end">
					<div className="flex flex-col gap-1.5">
						<h1 className="text-[22px] font-semibold leading-7 tracking-[-0.025em] text-(--color-text)">
							Telemetry
						</h1>
						<p className="text-[13px] leading-[18px] text-(--color-text-2)">
							Cost, behavior, and delivery across runs.
						</p>
					</div>
					<div className="flex items-center gap-3">
						<ProjectSelector />
						<RangeSelector />
					</div>
				</header>
				<TelemetryMetricStrip />
				<TabNav />
				{/* Below md: all four tabs' content as stacked panels. The
			    economics arm keeps the readOperator guard its route carries. */}
				<div className="flex flex-col gap-5 md:hidden">
					<TelemetryLoopTab />
					<TelemetryBehaviorTab />
					<TelemetryJudgeTab />
					<OperatorOnly capability="readOperator">
						<TelemetryEconomicsTab />
					</OperatorOnly>
				</div>
				<div className="hidden min-h-0 flex-1 md:block">
					<Outlet />
				</div>
			</div>
		</TelemetryWindowProvider>
	);
}
