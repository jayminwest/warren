import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { lazy, Suspense } from "react";
import { HashRouter, Navigate, Route, Routes } from "react-router-dom";
import { AuthGate } from "@/components/AuthGate.tsx";
import { DefaultLanding } from "@/components/DefaultLanding.tsx";
import { Layout } from "@/components/Layout.tsx";
import { MotionProvider } from "@/components/ui/motion.tsx";
import { ToastProvider } from "@/components/ui/toast.tsx";
import { AgentsPage } from "@/pages/Agents.tsx";
import { LeveretPage } from "@/pages/Leveret.tsx";
import { LoginPage } from "@/pages/Login.tsx";
import { NewPlanRunPage } from "@/pages/NewPlanRun.tsx";
import { NewRunPage } from "@/pages/NewRun.tsx";
import { PlanRunDetailPage } from "@/pages/PlanRunDetail.tsx";
import { PlanRunsPage } from "@/pages/PlanRuns.tsx";
import { PlotDetailPage } from "@/pages/PlotDetail.tsx";
import { PlotSummaryPage } from "@/pages/PlotSummary.tsx";
import { PlotsPage } from "@/pages/Plots.tsx";
import { ProjectDetailPage } from "@/pages/ProjectDetail.tsx";
import { ProjectsPage } from "@/pages/Projects.tsx";
import { RunDetailPage } from "@/pages/RunDetail.tsx";
import { RunsPage } from "@/pages/Runs.tsx";

// recharts is heavy and tree-shakes poorly (warren-876c). The two
// analytics pages are its only consumers, so they're code-split into a
// lazy chunk — recharts stays out of the initial-load bundle and the
// main chunk holds near the pre-recharts floor (warren-638a / pl-ad0f).
const CostAnalyticsPage = lazy(() =>
	import("@/pages/CostAnalytics.tsx").then((m) => ({ default: m.CostAnalyticsPage })),
);
const RunAnalyticsPage = lazy(() =>
	import("@/pages/RunAnalytics.tsx").then((m) => ({ default: m.RunAnalyticsPage })),
);

const queryClient = new QueryClient({
	defaultOptions: {
		queries: {
			retry: false,
			staleTime: 5_000,
		},
	},
});

/**
 * HashRouter, not BrowserRouter — `/runs/:id`, `/agents/:name`, etc. are
 * registered as API routes on the same Bun.serve, so a browser-history
 * URL like `/runs/abc123` would be shadowed by the JSON handler on a
 * hard reload. Hash routes (`/#/runs/abc123`) live entirely on the
 * client; the server only ever sees `/` and serves index.html.
 */
/** Minimal placeholder shown while a lazy analytics chunk loads. */
function AnalyticsFallback() {
	return <div className="p-4 text-sm text-(--color-muted-foreground)">Loading analytics…</div>;
}

export function App() {
	return (
		<QueryClientProvider client={queryClient}>
			<MotionProvider>
			<ToastProvider>
			<HashRouter>
				<Routes>
					<Route path="/login" element={<LoginPage />} />
					<Route
						element={
							<AuthGate>
								<Layout />
							</AuthGate>
						}
					>
						<Route index element={<DefaultLanding />} />
						<Route path="/runs" element={<RunsPage />} />
						<Route path="/runs/new" element={<NewRunPage />} />
						<Route path="/runs/:id" element={<RunDetailPage />} />
						<Route path="/plan-runs" element={<PlanRunsPage />} />
						<Route path="/plan-runs/new" element={<NewPlanRunPage />} />
						<Route path="/plan-runs/:id" element={<PlanRunDetailPage />} />
						<Route path="/leveret" element={<LeveretPage />} />
						<Route path="/plots" element={<PlotsPage />} />
						<Route path="/plots/:id" element={<PlotDetailPage />} />
						<Route path="/plots/:id/summary" element={<PlotSummaryPage />} />
						<Route path="/agents" element={<AgentsPage />} />
						<Route
							path="/cost-analytics"
							element={
								<Suspense fallback={<AnalyticsFallback />}>
									<CostAnalyticsPage />
								</Suspense>
							}
						/>
						<Route
							path="/run-analytics"
							element={
								<Suspense fallback={<AnalyticsFallback />}>
									<RunAnalyticsPage />
								</Suspense>
							}
						/>
						<Route path="/projects" element={<ProjectsPage />} />
						<Route path="/projects/:id" element={<ProjectDetailPage />} />
					</Route>
					<Route path="*" element={<Navigate to="/runs" replace />} />
				</Routes>
			</HashRouter>
			</ToastProvider>
			</MotionProvider>
		</QueryClientProvider>
	);
}
