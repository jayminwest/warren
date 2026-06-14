import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { planRunsApi } from "@/api/client.ts";
import type { PlanRunRow, PlotEnvelope } from "@/api/types.ts";
import { PLAN_RUN_TERMINAL_STATES } from "@/api/types.ts";
import { PlanRunStateBadge } from "@/components/PlanRunStateBadge.tsx";
import { Card, CardContent } from "@/components/ui/card.tsx";
import { formatError } from "@/lib/format-error.ts";
import { relativeTime } from "@/lib/utils.ts";
import { PlanRunChildTable } from "@/pages/plan-run-detail/child-table.tsx";

/**
 * Run tab (pl-0008 step 9 / warren-d17f) — embeds plan-run execution for the
 * plan dispatched against this Plot.
 *
 * Resolution: the dispatched plan-run carries a `plotId` back-link
 * (warren-06dc), so we list the project's plan-runs and keep those bound to
 * this Plot, newest first. The selected plan-run's children are loaded via
 * `planRunsApi.get` and rendered with the shared `PlanRunChildTable` (the same
 * surface PlanRunDetail uses) — per-child run links, PR-merge status, and
 * terminal/failure state.
 *
 * When the final child merges, the §11.P coordinator flips the Plot to `done`
 * server-side; we surface that auto-done transition inline so the operator
 * sees the lifecycle close from the Run tab without bouncing to PlanRunDetail.
 */
export function RunTab({ plot }: { plot: PlotEnvelope }) {
	const planRuns = useQuery({
		queryKey: ["plan-runs", { project: plot.project_id }],
		queryFn: ({ signal }) => planRunsApi.list({ project: plot.project_id }, signal),
		refetchInterval: 5000,
	});

	if (planRuns.isLoading) {
		return <p className="text-sm text-(--color-muted-foreground)">Loading plan run…</p>;
	}
	if (planRuns.isError) {
		return (
			<p className="text-sm text-(--color-destructive)">{formatError(planRuns.error)}</p>
		);
	}

	const forPlot = (planRuns.data?.planRuns ?? [])
		.filter((pr) => pr.plotId === plot.id)
		.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
	const planRun = forPlot[0];

	if (planRun === undefined) {
		return (
			<Card>
				<CardContent className="p-6 text-sm text-(--color-muted-foreground)">
					No plan run yet. Once you sign off and dispatch the plan from the{" "}
					<strong className="font-medium text-(--color-foreground)">Plan</strong> tab, its
					per-child execution shows up here.
				</CardContent>
			</Card>
		);
	}

	return <PlanRunExecution planRun={planRun} plot={plot} />;
}

function PlanRunExecution({ planRun, plot }: { planRun: PlanRunRow; plot: PlotEnvelope }) {
	const detail = useQuery({
		queryKey: ["plan-runs", planRun.id],
		queryFn: ({ signal }) => planRunsApi.get(planRun.id, signal),
		refetchInterval: (q) => {
			const data = q.state.data;
			if (!data) return 5000;
			return PLAN_RUN_TERMINAL_STATES.includes(data.planRun.state) ? false : 5000;
		},
	});

	const head = detail.data?.planRun ?? planRun;
	const children = detail.data?.children ?? [];
	const runs = detail.data?.runs ?? [];
	const allMerged = children.length > 0 && children.every((c) => c.prMergedAt !== null);

	return (
		<div className="space-y-4">
			<Card>
				<CardContent className="space-y-3 p-6 text-sm">
					<div className="flex flex-wrap items-center justify-between gap-3">
						<div className="space-y-1">
							<p className="font-medium text-(--color-foreground)">Plan run</p>
							<Link
								to={`/plan-runs/${encodeURIComponent(head.id)}`}
								className="font-mono text-xs underline-offset-2 hover:underline"
							>
								{head.id} ↗
							</Link>
							<p className="text-xs text-(--color-muted-foreground)">
								Plan <span className="font-mono">{head.planId}</span> ·{" "}
								<span className="font-medium">{head.agentName}</span> · created{" "}
								{relativeTime(head.createdAt)}
							</p>
						</div>
						<PlanRunStateBadge state={head.state} />
					</div>
					{head.state === "failed" && head.failureReason !== null ? (
						<p className="text-xs text-(--color-destructive)">{head.failureReason}</p>
					) : null}
					<PlotAutoDoneNotice plot={plot} allMerged={allMerged} />
				</CardContent>
			</Card>

			{detail.isLoading ? (
				<p className="text-sm text-(--color-muted-foreground)">Loading children…</p>
			) : detail.isError ? (
				<p className="text-sm text-(--color-destructive)">{formatError(detail.error)}</p>
			) : (
				<PlanRunChildTable children={children} runs={runs} />
			)}
		</div>
	);
}

/**
 * Surface the Plot's §11.P auto-done transition: when the final child's PR
 * merges, the coordinator flips the Plot to `done` server-side. We mirror that
 * here so the operator sees the lifecycle close inline.
 */
function PlotAutoDoneNotice({ plot, allMerged }: { plot: PlotEnvelope; allMerged: boolean }) {
	if (plot.status === "done") {
		return (
			<p className="rounded-md bg-(--color-muted) px-3 py-2 text-xs text-(--color-foreground)">
				✓ Every child PR merged — warren auto-transitioned this Plot to{" "}
				<strong className="font-medium">done</strong> (SPEC §11.P).
			</p>
		);
	}
	if (allMerged) {
		return (
			<p className="rounded-md bg-(--color-muted) px-3 py-2 text-xs text-(--color-muted-foreground)">
				All child PRs have merged — warren is finalizing the Plot's auto-done
				transition.
			</p>
		);
	}
	return null;
}
