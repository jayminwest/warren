/**
 * Run analytics view — Phase 1 (warren-638a / pl-ad0f step 5).
 *
 * Operator dashboard over `runs` execution telemetry, complementing the
 * spend-focused Cost analytics page. Renders a date-range / project
 * filter, a row of KPI cards (`totals`), four recharts visualizations
 * (runs-over-time, avg-context-per-agent, top-seeds-by-context,
 * failure-reason), and per-agent / per-model rollup tables — all from a
 * single `GET /analytics/runs` round-trip (`runAnalyticsApi.runs`).
 *
 * Filter state persists in the URL hash query via react-router's
 * `useSearchParams` so deep links survive a refresh, mirroring the Cost
 * analytics page. The chart + table sub-components live under
 * `run-analytics/` to keep this page and each child under the 500-line
 * file budget (warren-4553).
 */
import { useQuery } from "@tanstack/react-query";
import { useSearchParams } from "react-router-dom";
import { projectsApi, runAnalyticsApi } from "@/api/client.ts";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card.tsx";
import { PageHeader } from "@/components/ui/page-header.tsx";
import {
	AvgContextPerAgentChart,
	FailureReasonChart,
	RunsOverTimeChart,
	TopSeedsByContextChart,
} from "./run-analytics/Charts.tsx";
import { KpiCards } from "./run-analytics/KpiCards.tsx";
import { GroupTable } from "./run-analytics/Tables.tsx";

/** Default date window: last 30 days. Mirrors the server default. */
function defaultFrom(): string {
	const d = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
	return d.toISOString().slice(0, 10);
}

export function RunAnalyticsPage() {
	const [searchParams, setSearchParams] = useSearchParams();
	const projectId = searchParams.get("projectId") ?? "";
	const from = searchParams.get("from") ?? defaultFrom();
	const to = searchParams.get("to") ?? "";

	const updateParam = (k: string, v: string) => {
		const next = new URLSearchParams(searchParams);
		if (v === "") next.delete(k);
		else next.set(k, v);
		setSearchParams(next, { replace: true });
	};

	const projects = useQuery({
		queryKey: ["projects"],
		queryFn: ({ signal }) => projectsApi.list(signal),
	});

	const analytics = useQuery({
		queryKey: ["analytics", "runs", { projectId, from, to }],
		queryFn: ({ signal }) =>
			runAnalyticsApi.runs(
				{
					...(projectId !== "" ? { projectId } : {}),
					...(from !== "" ? { from: `${from}T00:00:00.000Z` } : {}),
					...(to !== "" ? { to: `${to}T23:59:59.999Z` } : {}),
				},
				signal,
			),
	});

	const data = analytics.data;
	const loading = analytics.isLoading;

	return (
		<div className="space-y-6">
			<PageHeader
				title="Run analytics"
				description="Execution telemetry across runs — success, duration, context burn. Defaults to the last 30 days."
			/>

			<Card>
				<CardHeader>
					<CardTitle>Filters</CardTitle>
				</CardHeader>
				<CardContent>
					<div className="flex flex-wrap items-end gap-4">
						<div className="flex flex-col gap-1">
							<label htmlFor="ra-from" className="text-xs text-(--color-muted-foreground)">
								From
							</label>
							<input
								id="ra-from"
								type="date"
								value={from}
								onChange={(e) => updateParam("from", e.target.value)}
								className="rounded border border-(--color-border) bg-transparent px-2 py-1 text-sm"
							/>
						</div>
						<div className="flex flex-col gap-1">
							<label htmlFor="ra-to" className="text-xs text-(--color-muted-foreground)">
								To
							</label>
							<input
								id="ra-to"
								type="date"
								value={to}
								onChange={(e) => updateParam("to", e.target.value)}
								className="rounded border border-(--color-border) bg-transparent px-2 py-1 text-sm"
							/>
						</div>
						<div className="flex flex-col gap-1">
							<label htmlFor="ra-project" className="text-xs text-(--color-muted-foreground)">
								Project
							</label>
							<select
								id="ra-project"
								value={projectId}
								onChange={(e) => updateParam("projectId", e.target.value)}
								className="rounded border border-(--color-border) bg-transparent px-2 py-1 text-sm"
							>
								<option value="">All projects</option>
								{projects.data?.projects.map((p) => (
									<option key={p.id} value={p.id}>
										{p.gitUrl.replace(/^https:\/\/github\.com\//, "") || p.id}
									</option>
								))}
							</select>
						</div>
					</div>
				</CardContent>
			</Card>

			{analytics.isError ? (
				<Card>
					<CardContent className="py-6 text-sm text-(--color-destructive)">
						Failed to load run analytics.{" "}
						{(analytics.error as Error | null)?.message ?? ""}
					</CardContent>
				</Card>
			) : null}

			<KpiCards totals={data?.totals} />

			<div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
				<RunsOverTimeChart timeSeries={data?.timeSeries ?? []} />
				<FailureReasonChart byFailureReason={data?.byFailureReason ?? []} />
				<AvgContextPerAgentChart byAgent={data?.byAgent ?? []} />
				<TopSeedsByContextChart topSeeds={data?.topSeedsByContext ?? []} />
			</div>

			<div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
				<GroupTable
					title="By agent"
					subtitle="Run rollup per agent"
					dimension="agent"
					buckets={data?.byAgent ?? []}
					loading={loading}
				/>
				<GroupTable
					title="By model"
					subtitle="Run rollup per provider model"
					dimension="model"
					buckets={data?.byModel ?? []}
					loading={loading}
				/>
			</div>
		</div>
	);
}
