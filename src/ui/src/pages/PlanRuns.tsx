import { useQuery } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { planRunsApi, projectsApi } from "@/api/client.ts";
import type { PlanRunChildState, PlanRunState } from "@/api/types.ts";
import { PlanRunStateBadge } from "@/components/PlanRunStateBadge.tsx";
import { Button } from "@/components/ui/button.tsx";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card.tsx";
import {
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from "@/components/ui/table.tsx";
import { relativeTime } from "@/lib/utils.ts";

const STATE_FILTERS: { label: string; value: "all" | PlanRunState }[] = [
	{ label: "Active", value: "all" },
	{ label: "Queued", value: "queued" },
	{ label: "Running", value: "running" },
	{ label: "Succeeded", value: "succeeded" },
	{ label: "Failed", value: "failed" },
	{ label: "Cancelled", value: "cancelled" },
];

export function PlanRunsPage() {
	const [stateFilter, setStateFilter] = useState<"all" | PlanRunState>("all");
	const [projectFilter, setProjectFilter] = useState<string>("");

	const planRuns = useQuery({
		queryKey: ["plan-runs", projectFilter, stateFilter],
		queryFn: ({ signal }) =>
			planRunsApi.list(
				{
					...(projectFilter.length > 0 ? { project: projectFilter } : {}),
					...(stateFilter !== "all" ? { state: stateFilter } : {}),
				},
				signal,
			),
		refetchInterval: 5000,
	});

	const projects = useQuery({
		queryKey: ["projects"],
		queryFn: ({ signal }) => projectsApi.list(signal),
	});

	const projectIndex = useMemo(() => {
		const m = new Map<string, string>();
		for (const p of projects.data?.projects ?? []) m.set(p.id, p.gitUrl);
		return m;
	}, [projects.data]);

	return (
		<div className="space-y-6">
			<header className="flex flex-wrap items-center justify-between gap-4">
				<div>
					<h1 className="text-2xl font-semibold tracking-tight">Plan runs</h1>
					<p className="text-sm text-(--color-muted-foreground)">
						Serial execution of a seeds plan — one warren run per open child,
						in order.
					</p>
				</div>
				<Link to="/plan-runs/new">
					<Button>Dispatch a plan run</Button>
				</Link>
			</header>

			<div className="flex flex-wrap items-center gap-2">
				{STATE_FILTERS.map((f) => (
					<button
						key={f.value}
						type="button"
						onClick={() => setStateFilter(f.value)}
						className={`rounded-full border px-3 py-1 text-xs transition-colors ${
							stateFilter === f.value
								? "bg-(--color-primary) text-(--color-primary-foreground)"
								: "bg-(--color-card) hover:bg-(--color-accent)"
						}`}
					>
						{f.label}
					</button>
				))}
				<select
					value={projectFilter}
					onChange={(e) => setProjectFilter(e.target.value)}
					className="h-8 w-full rounded-md border bg-(--color-card) px-2 text-xs sm:ml-auto sm:w-auto"
				>
					<option value="">All projects</option>
					{projects.data?.projects.map((p) => (
						<option key={p.id} value={p.id}>
							{p.gitUrl}
						</option>
					))}
				</select>
			</div>

			<Card>
				<CardHeader>
					<CardTitle>{planRuns.data?.planRuns.length ?? 0} plan runs</CardTitle>
				</CardHeader>
				<CardContent className="p-0">
					{planRuns.isLoading ? (
						<p className="p-6 text-sm text-(--color-muted-foreground)">Loading…</p>
					) : planRuns.isError ? (
						<p className="p-6 text-sm text-(--color-destructive)">
							{planRuns.error instanceof Error
								? planRuns.error.message
								: String(planRuns.error)}
						</p>
					) : planRuns.data?.planRuns.length === 0 ? (
						<p className="p-6 text-sm text-(--color-muted-foreground)">
							No plan runs match this filter. Dispatch one above.
						</p>
					) : (
						<Table>
							<TableHeader>
								<TableRow>
									<TableHead className="whitespace-nowrap">State</TableHead>
									<TableHead className="whitespace-nowrap">ID</TableHead>
									<TableHead className="whitespace-nowrap">Plan</TableHead>
									<TableHead className="whitespace-nowrap">Project</TableHead>
									<TableHead className="whitespace-nowrap">Agent</TableHead>
									<TableHead className="whitespace-nowrap">Children</TableHead>
									<TableHead className="whitespace-nowrap">Started</TableHead>
								</TableRow>
							</TableHeader>
							<TableBody>
								{planRuns.data?.planRuns.map((pr) => (
									<PlanRunListRow
										key={pr.id}
										planRunId={pr.id}
										planId={pr.planId}
										state={pr.state}
										startedAt={pr.startedAt}
										agentName={pr.agentName}
										projectLabel={projectIndex.get(pr.projectId) ?? pr.projectId}
									/>
								))}
							</TableBody>
						</Table>
					)}
				</CardContent>
			</Card>
		</div>
	);
}

/**
 * Per-row component so each plan run can fetch its own child-state counts
 * without one big GET. Detail endpoint is cheap (single tx) and the list
 * page polls every 5s — the cost is bounded and keeps the list endpoint
 * narrow (rows only, no children fan-out, mirrors `GET /runs` shape).
 */
function PlanRunListRow({
	planRunId,
	planId,
	state,
	startedAt,
	agentName,
	projectLabel,
}: {
	planRunId: string;
	planId: string;
	state: PlanRunState;
	startedAt: string | null;
	agentName: string;
	projectLabel: string;
}) {
	const detail = useQuery({
		queryKey: ["plan-runs", planRunId],
		queryFn: ({ signal }) => planRunsApi.get(planRunId, signal),
		refetchInterval: 5000,
	});
	const counts = summarizeChildren(detail.data?.children ?? []);
	return (
		<TableRow>
			<TableCell>
				<PlanRunStateBadge state={state} />
			</TableCell>
			<TableCell>
				<Link
					to={`/plan-runs/${encodeURIComponent(planRunId)}`}
					className="font-mono text-xs underline-offset-2 hover:underline"
				>
					{planRunId}
				</Link>
			</TableCell>
			<TableCell className="whitespace-nowrap font-mono text-xs">{planId}</TableCell>
			<TableCell className="whitespace-nowrap font-mono text-xs">{projectLabel}</TableCell>
			<TableCell className="whitespace-nowrap">{agentName}</TableCell>
			<TableCell className="whitespace-nowrap font-mono text-xs text-(--color-muted-foreground)">
				{counts}
			</TableCell>
			<TableCell className="whitespace-nowrap text-(--color-muted-foreground)">
				{relativeTime(startedAt)}
			</TableCell>
		</TableRow>
	);
}

function summarizeChildren(
	children: { state: PlanRunChildState }[],
): string {
	if (children.length === 0) return "—";
	const buckets: Record<"pending" | "inflight" | "merged" | "failed", number> = {
		pending: 0,
		inflight: 0,
		merged: 0,
		failed: 0,
	};
	for (const c of children) {
		if (c.state === "pending") buckets.pending += 1;
		else if (c.state === "dispatched" || c.state === "running" || c.state === "pr_open")
			buckets.inflight += 1;
		else if (c.state === "merged" || c.state === "skipped") buckets.merged += 1;
		else if (c.state === "failed") buckets.failed += 1;
	}
	return `${buckets.pending}p / ${buckets.inflight}i / ${buckets.merged}m / ${buckets.failed}f`;
}
