import { lazy, Suspense } from "react";
import { NavLink, Outlet } from "react-router-dom";
import { ComingPage } from "@/components/console/coming-page.tsx";
import { cn } from "@/lib/utils.ts";

/**
 * Telemetry — the Direction C consolidation (warren-4ed7 skeleton) of the
 * four analysis surfaces under one tabbed page: Loop, Behavior, Judge,
 * Economics (docs/ui-revamp/README.md, c-telemetry). Behavior and
 * Economics mount the existing legacy analytics pages for now — they are
 * rebuilt in place by warren-7197 — while Loop and Judge stub to
 * placeholders naming the coming tabs. The tab routes themselves live in
 * app.tsx as children of this layout.
 */

/** Tabs render until their page issues land, so lazy chunks keep splitting. */
const CostAnalyticsPage = lazy(() =>
	import("@/pages/cost-analytics.tsx").then((m) => ({ default: m.CostAnalyticsPage })),
);
const RunAnalyticsPage = lazy(() =>
	import("@/pages/run-analytics.tsx").then((m) => ({ default: m.RunAnalyticsPage })),
);

const TABS = [
	{ path: "loop", label: "Loop" },
	{ path: "behavior", label: "Behavior" },
	{ path: "judge", label: "Judge" },
	{ path: "economics", label: "Economics" },
] as const;

function AnalyticsFallback() {
	return <div className="p-4 text-sm text-(--color-text-3)">Loading analytics…</div>;
}

/** The tab layout: every /telemetry/* child renders under these tabs. */
export function TelemetryPage() {
	return (
		<div className="flex min-h-full flex-col">
			<nav className="flex shrink-0 items-center gap-1 border-b border-(--color-border) px-6 pt-4 sm:px-[22px]">
				{TABS.map(({ path, label }) => (
					<NavLink
						key={path}
						to={`/telemetry/${path}`}
						className={({ isActive }) =>
							cn(
								"border-b-2 px-3 py-2 text-[12px] leading-4",
								isActive
									? "border-(--color-primary) font-medium text-(--color-text)"
									: "border-transparent text-(--color-text-2) hover:text-(--color-text)",
							)
						}
					>
						{label}
					</NavLink>
				))}
			</nav>
			<div className="min-h-0 flex-1">
				<Outlet />
			</div>
		</div>
	);
}

/** Loop tab — run-loop telemetry over run records (warren-7197). */
export function TelemetryLoopTab() {
	return (
		<ComingPage
			title="Telemetry · Loop"
			summary="Run-loop telemetry over run records: lifecycle phases, durations, interventions."
			issueId="warren-7197"
		/>
	);
}

/** Behavior tab — mounts the legacy run-analytics page until warren-7197. */
export function TelemetryBehaviorTab() {
	return (
		<Suspense fallback={<AnalyticsFallback />}>
			<RunAnalyticsPage />
		</Suspense>
	);
}

/** Judge tab — judge verdicts; degrades when the extension is absent. */
export function TelemetryJudgeTab() {
	return (
		<ComingPage
			title="Telemetry · Judge"
			summary="Judge verdicts against the 15-class rubric; degrades gracefully when the extension is absent."
			issueId="warren-7197"
		/>
	);
}

/**
 * Economics tab — mounts the legacy cost-analytics page until warren-7197.
 * The readOperator gating stays at the route (app.tsx), exactly as the
 * legacy /cost-analytics route was gated (warren-cf63).
 */
export function TelemetryEconomicsTab() {
	return (
		<Suspense fallback={<AnalyticsFallback />}>
			<CostAnalyticsPage />
		</Suspense>
	);
}
