import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { HashRouter, Navigate, Route, Routes } from "react-router-dom";
import { AuthGate } from "@/components/AuthGate.tsx";
import { DefaultLanding } from "@/components/DefaultLanding.tsx";
import { Layout } from "@/components/Layout.tsx";
import { AgentsPage } from "@/pages/Agents.tsx";
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
export function App() {
	return (
		<QueryClientProvider client={queryClient}>
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
						<Route path="/plots" element={<PlotsPage />} />
						<Route path="/plots/:id" element={<PlotDetailPage />} />
						<Route path="/plots/:id/summary" element={<PlotSummaryPage />} />
						<Route path="/agents" element={<AgentsPage />} />
						<Route path="/projects" element={<ProjectsPage />} />
						<Route path="/projects/:id" element={<ProjectDetailPage />} />
					</Route>
					<Route path="*" element={<Navigate to="/runs" replace />} />
				</Routes>
			</HashRouter>
		</QueryClientProvider>
	);
}
