import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Suspense } from "react";
import { HashRouter, Navigate, Route, Routes } from "react-router-dom";
import { AuthGate } from "@/components/auth-gate.tsx";
import { ConsoleShell, RouteFallback } from "@/components/console/console-shell.tsx";
import { OperatorRoute } from "@/components/operator-only.tsx";
import { ToastProvider } from "@/components/ui/toast.tsx";
import { useLifecycleStreamInvalidation } from "@/hooks/use-lifecycle-stream-invalidation.ts";
import { lazyNamed } from "@/lib/lazy-named.ts";
import { SetupLandingRoute } from "@/pages/setup.tsx";

/*
 * Route-level code splitting (warren-b2d6): every page is its own chunk,
 * so the first load ships the shell plus the page it lands on. The
 * shell's Suspense boundary shows a skeleton while a chunk arrives.
 */
const HomePage = lazyNamed(() => import("@/pages/home/index.tsx"), "HomePage");
const AgentsPage = lazyNamed(() => import("@/pages/agents.tsx"), "AgentsPage");
const DispatchPage = lazyNamed(() => import("@/pages/dispatch.tsx"), "DispatchPage");
const DispatchPlanPage = lazyNamed(() => import("@/pages/dispatch-plan.tsx"), "DispatchPlanPage");
const EventExplorerPage = lazyNamed(
	() => import("@/pages/event-explorer.tsx"),
	"EventExplorerPage",
);
const InstancePage = lazyNamed(() => import("@/pages/instance.tsx"), "InstancePage");
const LoginPage = lazyNamed(() => import("@/pages/login.tsx"), "LoginPage");
const OperationsPage = lazyNamed(() => import("@/pages/operations.tsx"), "OperationsPage");
const PlanRunDetailPage = lazyNamed(
	() => import("@/pages/plan-run-detail.tsx"),
	"PlanRunDetailPage",
);
const PlanRunsPage = lazyNamed(() => import("@/pages/plan-runs.tsx"), "PlanRunsPage");
const ProjectDetailPage = lazyNamed(
	() => import("@/pages/project-detail.tsx"),
	"ProjectDetailPage",
);
const ProjectsPage = lazyNamed(() => import("@/pages/projects.tsx"), "ProjectsPage");
const RunDetailPage = lazyNamed(() => import("@/pages/run-detail/index.tsx"), "RunDetailPage");
const RunsPage = lazyNamed(() => import("@/pages/runs.tsx"), "RunsPage");
const SetupPage = lazyNamed(() => import("@/pages/setup.tsx"), "SetupPage");
const telemetry = () => import("@/pages/telemetry.tsx");
const TelemetryPage = lazyNamed(telemetry, "TelemetryPage");
const TelemetryIndexRedirect = lazyNamed(telemetry, "TelemetryIndexRedirect");
const TelemetryLoopTab = lazyNamed(telemetry, "TelemetryLoopTab");
const TelemetryBehaviorTab = lazyNamed(telemetry, "TelemetryBehaviorTab");
const TelemetryJudgeTab = lazyNamed(telemetry, "TelemetryJudgeTab");
const TelemetryEconomicsTab = lazyNamed(telemetry, "TelemetryEconomicsTab");

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

/**
 * Console routes (warren-4ed7; Home index and lazy pages, plan pl-fae9).
 * Every page is top-level in the sidebar; Home is the index route.
 */
export function App() {
	return (
		<QueryClientProvider client={queryClient}>
			<LifecycleStreamBridge />
			<ToastProvider>
				<HashRouter>
					<Routes>
						<Route
							path="/login"
							element={
								<Suspense fallback={<RouteFallback />}>
									<LoginPage />
								</Suspense>
							}
						/>
						<Route
							element={
								<AuthGate>
									<ConsoleShell />
								</AuthGate>
							}
						>
							{/* Home is the index route (warren-44a2), except on a
								    zero-project instance where an undismissed operator
								    lands on the first-run setup checklist instead
								    (warren-a911). Spectators always get Home. */}
							<Route
								index
								element={
									<SetupLandingRoute>
										<HomePage />
									</SetupLandingRoute>
								}
							/>
							{/* Manual entry point back to the checklist.
								    Operator-gated like every mutating surface. */}
							<Route
								path="/setup"
								element={
									<OperatorRoute capability="admin">
										<SetupPage />
									</OperatorRoute>
								}
							/>
							<Route path="/operations" element={<OperationsPage />} />

							{/* WORKLOADS */}
							<Route path="/runs" element={<RunsPage />} />
							{/* The dispatch forms are the only pages whose whole
								    reason to exist is a mutation, so they are guarded
								    at the route — a spectator who deep-links here lands
								    on /runs (warren-f53e / pl-b82d step 19). Legacy
								    deep links redirect to the Direction C dispatch
								    routes. */}
							<Route path="/runs/new" element={<Navigate to="/dispatch" replace />} />
							<Route path="/runs/:id" element={<RunDetailPage />} />
							<Route
								path="/dispatch"
								element={
									<OperatorRoute>
										<DispatchPage />
									</OperatorRoute>
								}
							/>
							<Route
								path="/dispatch/plan"
								element={
									<OperatorRoute>
										<DispatchPlanPage />
									</OperatorRoute>
								}
							/>
							<Route path="/plan-runs" element={<PlanRunsPage />} />
							<Route path="/plan-runs/new" element={<Navigate to="/dispatch/plan" replace />} />
							<Route path="/plan-runs/:id" element={<PlanRunDetailPage />} />

							{/* INFRASTRUCTURE */}
							<Route path="/projects" element={<ProjectsPage />} />
							<Route path="/projects/:id" element={<ProjectDetailPage />} />
							<Route path="/agents" element={<AgentsPage />} />
							{/* Telemetry consolidates the legacy analytics routes
								    under its tabs until warren-7197 rebuilds them. */}
							<Route path="/telemetry" element={<TelemetryPage />}>
								<Route index element={<TelemetryIndexRedirect />} />
								<Route path="loop" element={<TelemetryLoopTab />} />
								<Route path="behavior" element={<TelemetryBehaviorTab />} />
								<Route path="judge" element={<TelemetryJudgeTab />} />
								<Route
									path="economics"
									element={
										// GET /analytics/cost is readOperator (the
										// instance-wide USD rollup), so the tab keeps the
										// guard the legacy /cost-analytics route carried.
										<OperatorRoute capability="readOperator">
											<TelemetryEconomicsTab />
										</OperatorRoute>
									}
								/>
							</Route>
							<Route
								path="/cost-analytics"
								element={<Navigate to="/telemetry/economics" replace />}
							/>
							<Route
								path="/run-analytics"
								element={<Navigate to="/telemetry/behavior" replace />}
							/>

							{/* Footer + coming pages. */}
							<Route path="/events" element={<EventExplorerPage />} />
							<Route path="/instance" element={<InstancePage />} />
						</Route>
						<Route path="*" element={<Navigate to="/" replace />} />
					</Routes>
				</HashRouter>
			</ToastProvider>
		</QueryClientProvider>
	);
}
