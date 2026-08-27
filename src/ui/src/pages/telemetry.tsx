import { NavLink, Outlet } from "react-router-dom";
import { cn } from "@/lib/utils.ts";
import { TelemetryMetricStrip } from "@/pages/telemetry/telemetry-metrics.tsx";
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
 */

const TABS = [
	{ path: "loop", label: "THE LOOP" },
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

/** The 7D/14D/30D/90D segmented control from the artboards. */
function RangeSelector() {
	const { days, setDays } = useTelemetryWindow();
	return (
		<div className="flex items-center gap-3">
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

/** The tab strip; active tab carries the 2px primary underline. */
function TabNav() {
	return (
		<nav className="flex w-full shrink-0 items-end gap-6 border-b border-(--color-border)">
			{TABS.map(({ path, label }) => (
				<NavLink
					key={path}
					to={`/telemetry/${path}`}
					className={({ isActive }) =>
						cn(
							"flex flex-col gap-2 pb-0 font-mono text-[11px] leading-[14px] tracking-[0.08em]",
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

/** The tab layout: every /telemetry/* child renders under these tabs. */
export function TelemetryPage() {
	return (
		<TelemetryWindowProvider>
			<div className="flex min-h-full flex-col gap-5 px-3.5 py-6 md:px-6">
				<header className="flex flex-col justify-between gap-3 sm:flex-row sm:items-end">
					<div className="flex flex-col gap-1.5">
						<h1 className="text-[22px] font-semibold leading-7 tracking-[-0.025em] text-(--color-text)">
							Telemetry
						</h1>
						<p className="text-[13px] leading-[18px] text-(--color-text-2)">
							Cost, behavior, and delivery joined across run records, forge PR state, and judge
							verdicts.
						</p>
					</div>
					<RangeSelector />
				</header>
				<TelemetryMetricStrip />
				<TabNav />
				<div className="min-h-0 flex-1">
					<Outlet />
				</div>
			</div>
		</TelemetryWindowProvider>
	);
}
