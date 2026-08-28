import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { HashRouter, Navigate, Route, Routes } from "react-router-dom";
import { AuthGate } from "@/components/auth-gate.tsx";
import { ConsoleShell } from "@/components/console/console-shell.tsx";
import { OperatorRoute } from "@/components/operator-only.tsx";
import { MotionProvider } from "@/components/ui/motion.tsx";
import { ToastProvider } from "@/components/ui/toast.tsx";
import { useLifecycleStreamInvalidation } from "@/hooks/use-lifecycle-stream-invalidation.ts";
import { AgentsPage } from "@/pages/agents.tsx";
import { DispatchPage } from "@/pages/dispatch.tsx";
import { DispatchPlanPage } from "@/pages/dispatch-plan.tsx";
import { EventExplorerPage } from "@/pages/event-explorer.tsx";
import { InstancePage } from "@/pages/instance.tsx";
import { LoginPage } from "@/pages/login.tsx";
import { OperationsPage } from "@/pages/operations.tsx";
import { PlanRunDetailPage } from "@/pages/plan-run-detail.tsx";
import { PlanRunsPage } from "@/pages/plan-runs.tsx";
import { ProjectDetailPage } from "@/pages/project-detail.tsx";
import { ProjectsPage } from "@/pages/projects.tsx";
import { RunDetailPage } from "@/pages/run-detail/index.tsx";
import { RunsPage } from "@/pages/runs.tsx";
import { SetupLandingRoute, SetupPage } from "@/pages/setup.tsx";
import {
	TelemetryBehaviorTab,
	TelemetryEconomicsTab,
	TelemetryIndexRedirect,
	TelemetryJudgeTab,
	TelemetryLoopTab,
	TelemetryPage,
} from "@/pages/telemetry.tsx";

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
 * Direction C route skeleton (warren-4ed7 / pl-7e38 step 2). The IA
 * follows the canvas index (docs/ui-revamp/README.md): Operations is the
 * index route. Pages whose Direction C redesign has not landed mount the
 * existing legacy page inside the new shell — the co-mounted migration —
 * and stubs name the issue that builds the coming page.
 */
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
										<ConsoleShell />
									</AuthGate>
								}
							>
								{/* Operations is the index route (c-operations), except
								    on a zero-project instance where an undismissed
								    operator lands on the first-run setup checklist
								    instead (warren-a911 / pl-26f3 step 9). Spectators
								    always get the console. */}
								<Route index element={<SetupLandingRoute />} />
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
							<Route path="*" element={<Navigate to="/operations" replace />} />
						</Routes>
					</HashRouter>
				</ToastProvider>
			</MotionProvider>
		</QueryClientProvider>
	);
}
