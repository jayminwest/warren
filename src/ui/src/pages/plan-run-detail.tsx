import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CircleStop, RefreshCw } from "lucide-react";
import type { ReactNode } from "react";
import { Link, useParams } from "react-router-dom";
import { planRunsApi, projectsApi } from "@/api/client.ts";
import type { CancelPlanRunResponse, PlanRunRow } from "@/api/types.ts";
import { isTerminalPlanRunState } from "@/api/types.ts";
import { OperatorOnly } from "@/components/operator-only.tsx";
import { Button } from "@/components/ui/button.tsx";
import { Skeleton } from "@/components/ui/skeleton.tsx";
import { StatusBadge } from "@/components/ui/status.tsx";
import { Tag } from "@/components/ui/tag.tsx";
import { useNow } from "@/hooks/use-now.ts";
import { formatError } from "@/lib/format-error.ts";
import { formatPlanRunFailureReason } from "@/lib/labels.ts";
import { formatElapsedMs } from "@/pages/runs/runs-format.ts";
import { ChildWalkPanel } from "./plan-run-detail/child-walk.tsx";
import { DetailRail } from "./plan-run-detail/detail-rail.tsx";
import { summarizeCost } from "./plan-runs/walk-state.ts";
import { ProblemNote } from "./run-detail/problem-note.tsx";
import { formatTrigger } from "./run-detail/run-detail-format.ts";

/**
 * Plan run detail — the walk inspector (warren-2520, migrated in
 * warren-9474 / warren-0690). Child-by-child gate state in the main card,
 * the plan definition, delivered PRs and prompt template in the rail.
 *
 * One `GET /plan-runs/:id` round-trip under the `["plan-runs", id]` key.
 * The lifecycle stream invalidates that key as children move
 * (use-lifecycle-stream-invalidation), so the page only keeps a slow
 * fallback poll while the walk is active. The read surface is public; the
 * one operator affordance, Cancel, rides OperatorOnly.
 */

/** Fallback re-read of an active walk when the lifecycle stream is quiet. */
const ACTIVE_FALLBACK_POLL_MS = 30_000;

function PlanRunSkeleton() {
	return (
		<div
			role="status"
			aria-label="Loading plan run"
			className="flex flex-col gap-4 px-4 pt-6 md:px-6"
		>
			<Skeleton className="h-3 w-40" />
			<Skeleton className="h-6 w-72" />
			<Skeleton className="h-3.5 w-1/2" />
			<div className="flex flex-col gap-4 lg:flex-row lg:items-start">
				<Skeleton className="h-96 w-full rounded-md lg:flex-1" />
				<Skeleton className="h-80 w-full rounded-md lg:w-84" />
			</div>
		</div>
	);
}

function CancelStatus({
	mutation,
}: {
	mutation: ReturnType<typeof useMutation<CancelPlanRunResponse, Error, void>>;
}) {
	if (mutation.isError) {
		return <p className="text-xs text-(--color-danger)">{formatError(mutation.error)}</p>;
	}
	if (!mutation.isSuccess || mutation.data === undefined) return null;
	const { alreadyTerminal, cancelledChild } = mutation.data;
	return (
		<p className="text-xs text-(--color-text-3)">
			{alreadyTerminal
				? "The walk had already finished."
				: `Cancelling${cancelledChild !== null ? ` child ${cancelledChild.childSeq}` : ""}; no further children will start.`}
		</p>
	);
}

function CancelWalk({ id }: { id: string }) {
	const qc = useQueryClient();
	const cancel = useMutation({
		mutationFn: () => planRunsApi.cancel(id),
		onSettled: () => qc.invalidateQueries({ queryKey: ["plan-runs"] }),
	});
	return (
		<div className="flex flex-col items-end gap-1">
			<Button variant="outline" onClick={() => cancel.mutate()} disabled={cancel.isPending}>
				<CircleStop aria-hidden className="text-(--color-danger)" />
				{cancel.isPending ? "Cancelling…" : "Cancel plan run"}
			</Button>
			<CancelStatus mutation={cancel} />
		</div>
	);
}

function Dot() {
	return (
		<span aria-hidden className="text-(--color-text-3)">
			·
		</span>
	);
}

function elapsedLabel(planRun: PlanRunRow, now: number): string | null {
	if (planRun.startedAt === null) return null;
	const start = Date.parse(planRun.startedAt);
	const end = planRun.endedAt !== null ? Date.parse(planRun.endedAt) : now;
	const prefix = planRun.endedAt !== null ? "Took" : "Running for";
	return `${prefix} ${formatElapsedMs(Math.max(0, end - start))}`;
}

function Header({
	planRun,
	projectLabel,
	now,
}: {
	planRun: PlanRunRow;
	projectLabel: string;
	now: number;
}) {
	const failed = planRun.state === "failed" && planRun.failureReason != null;
	const elapsed = elapsedLabel(planRun, now);
	const meta: [string, ReactNode][] = [
		[
			"agent",
			<span key="agent">
				<span className="text-(--color-text)">{planRun.agentName}</span> on {projectLabel}
			</span>,
		],
		["trigger", <span key="trigger">{formatTrigger(planRun.trigger)}</span>],
	];
	if (elapsed !== null) meta.push(["elapsed", <span key="elapsed">{elapsed}</span>]);
	return (
		<header className="flex shrink-0 flex-col gap-2.5">
			<nav aria-label="Breadcrumb" className="text-xs text-(--color-text-3)">
				<Link to="/plan-runs" className="hover:text-(--color-text)">
					Plan runs
				</Link>
				<span aria-hidden className="px-1.5">
					/
				</span>
				<span className="font-mono">{planRun.id}</span>
			</nav>
			<div className="flex flex-wrap items-start justify-between gap-x-6 gap-y-3">
				<div className="flex min-w-0 flex-col gap-2">
					<h1 className="truncate font-mono text-xl font-semibold tracking-tight text-(--color-text)">
						{planRun.id}
					</h1>
					<div className="flex flex-wrap items-center gap-2">
						<StatusBadge
							state={planRun.state}
							reason={planRun.failureReason}
							label={failed ? "Failed" : undefined}
						/>
						{planRun.planId !== null ? (
							<Tag className="font-mono" title="Source plan">
								{planRun.planId}
							</Tag>
						) : (
							<Tag>Issue list</Tag>
						)}
					</div>
				</div>
				{!isTerminalPlanRunState(planRun.state) ? (
					<OperatorOnly>
						<CancelWalk id={planRun.id} />
					</OperatorOnly>
				) : null}
			</div>
			<p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-(--color-text-2)">
				{meta.flatMap(([key, node], i) => (i === 0 ? [node] : [<Dot key={`dot-${key}`} />, node]))}
			</p>
		</header>
	);
}

export function PlanRunDetailPage() {
	const { id = "" } = useParams<{ id: string }>();

	const detail = useQuery({
		queryKey: ["plan-runs", id],
		queryFn: ({ signal }) => planRunsApi.get(id, signal),
		refetchInterval: (q) => {
			const data = q.state.data;
			return data !== undefined && !isTerminalPlanRunState(data.planRun.state)
				? ACTIVE_FALLBACK_POLL_MS
				: false;
		},
	});

	// Same key as the inventory pages: resolves the project's repo name,
	// falling back to the raw project id.
	const projects = useQuery({
		queryKey: ["projects"],
		queryFn: ({ signal }) => projectsApi.list(signal),
	});

	const active = detail.data !== undefined && !isTerminalPlanRunState(detail.data.planRun.state);
	const now = useNow(1000, active);

	if (detail.isLoading) return <PlanRunSkeleton />;
	if (detail.isError || !detail.data) {
		return (
			<div className="px-4 pt-6 md:px-6">
				<ProblemNote
					title="Couldn't load this plan run"
					action={
						<Button variant="outline" size="sm" onClick={() => void detail.refetch()}>
							<RefreshCw aria-hidden />
							Try again
						</Button>
					}
				>
					{detail.isError ? formatError(detail.error) : "The plan run was not found."}
				</ProblemNote>
			</div>
		);
	}
	const { planRun, children, runs } = detail.data;

	const project = projects.data?.projects.find((p) => p.id === planRun.projectId);
	const projectLabel = project
		? project.gitUrl.replace(/^https:\/\/github\.com\//, "") || project.gitUrl
		: planRun.projectId;
	const cost = summarizeCost(runs);

	return (
		<div className="flex min-h-full flex-col gap-4 px-4 pt-6 pb-12 md:px-6">
			<Header planRun={planRun} projectLabel={projectLabel} now={now} />

			{planRun.state === "failed" && planRun.failureReason != null ? (
				<ProblemNote title="The walk stopped">
					{/* Prose for the visitor, the raw reason in the tooltip for the
					    operator (warren-14fc / #641). Redacted for spectators
					    (warren-17d7). */}
					<span title={planRun.failureReason}>
						{formatPlanRunFailureReason(planRun.failureReason)}
					</span>
				</ProblemNote>
			) : null}

			{/* items-start: the child walk sizes to its rows rather than
			    stretching to the rail's height (warren-dac1). */}
			<div className="flex flex-col gap-4 lg:flex-row lg:items-start">
				<ChildWalkPanel planRun={planRun} childRows={children} runs={runs} />
				<DetailRail detail={detail.data} projectLabel={projectLabel} cost={cost} />
			</div>
		</div>
	);
}
