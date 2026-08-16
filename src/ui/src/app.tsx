import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { lazy, Suspense } from "react";
import { HashRouter, Navigate, Route, Routes } from "react-router-dom";
import { AuthGate } from "@/components/auth-gate.tsx";
import { Layout } from "@/components/layout.tsx";
import { OperatorRoute } from "@/components/operator-only.tsx";
import { MotionProvider } from "@/components/ui/motion.tsx";
import { ToastProvider } from "@/components/ui/toast.tsx";
import { useLifecycleStreamInvalidation } from "@/hooks/use-lifecycle-stream-invalidation.ts";
import { AgentsPage } from "@/pages/agents.tsx";
import { LoginPage } from "@/pages/login.tsx";
import { NewPlanRunPage } from "@/pages/new-plan-run.tsx";
import { NewRunPage } from "@/pages/new-run.tsx";
import { PlanRunDetailPage } from "@/pages/plan-run-detail.tsx";
import { PlanRunsPage } from "@/pages/plan-runs.tsx";
import { ProjectDetailPage } from "@/pages/project-detail.tsx";
import { ProjectsPage } from "@/pages/projects.tsx";
import { RunDetailPage } from "@/pages/run-detail.tsx";
import { RunsPage } from "@/pages/runs.tsx";

// recharts is heavy and tree-shakes poorly (warren-876c). The two
// analytics pages are its only consumers, so they're code-split into a
// lazy chunk — recharts stays out of the initial-load bundle and the
// main chunk holds near the pre-recharts floor (warren-638a / pl-ad0f).
const CostAnalyticsPage = lazy(() =>
	import("@/pages/cost-analytics.tsx").then((m) => ({ default: m.CostAnalyticsPage })),
);
const RunAnalyticsPage = lazy(() =>
	import("@/pages/run-analytics.tsx").then((m) => ({ default: m.RunAnalyticsPage })),
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

/**
 * warren-f566: one global lifecycle stream per tab drives the list
 * pages' query invalidation, replacing their old 5s polls (the pages
 * keep a 45s fallback). Mounted once above the router so navigation
 * never tears the connection down.
 */
function LifecycleStreamBridge() {
	useLifecycleStreamInvalidation();
	return null;
}

export function App() {
	return (
		<QueryClientProvider client={queryClient}>
			<LifecycleStreamBridge />
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
								{/* Runs is the home surface (warren-1f12 / pl-3a79 step 10). */}
								<Route index element={<Navigate to="/runs" replace />} />
								<Route path="/runs" element={<RunsPage />} />
								{/* The two dispatch forms are the only pages whose whole
						    reason to exist is a mutation, so they are guarded at
						    the route rather than field by field — a spectator
						    who deep-links here lands on /runs
						    (warren-f53e / pl-b82d step 19). */}
								<Route
									path="/runs/new"
									element={
										<OperatorRoute>
											<NewRunPage />
										</OperatorRoute>
									}
								/>
								<Route path="/runs/:id" element={<RunDetailPage />} />
								<Route path="/plan-runs" element={<PlanRunsPage />} />
								<Route
									path="/plan-runs/new"
									element={
										<OperatorRoute>
											<NewPlanRunPage />
										</OperatorRoute>
									}
								/>
								<Route path="/plan-runs/:id" element={<PlanRunDetailPage />} />
								<Route path="/agents" element={<AgentsPage />} />
								<Route
									path="/cost-analytics"
									element={
										// `GET /analytics/cost` is readOperator (the
										// instance-wide USD rollup), so the page is
										// guarded to match the nav entry it drops.
										<OperatorRoute capability="readOperator">
											<Suspense fallback={<AnalyticsFallback />}>
												<CostAnalyticsPage />
											</Suspense>
										</OperatorRoute>
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
