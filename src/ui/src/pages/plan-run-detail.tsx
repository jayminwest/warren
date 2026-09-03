import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CircleStop } from "lucide-react";
import { useParams } from "react-router-dom";
import { planRunsApi, projectsApi } from "@/api/client.ts";
import type { CancelPlanRunResponse, PlanRunDetailResponse } from "@/api/types.ts";
import { isTerminalPlanRunState } from "@/api/types.ts";
import { OperatorOnly } from "@/components/operator-only.tsx";
import { Alert } from "@/components/ui/alert.tsx";
import { Spinner } from "@/components/ui/spinner.tsx";
import { formatError } from "@/lib/format-error.ts";
import { formatPlanRunFailureReason } from "@/lib/labels.ts";
import { ChildWalkPanel } from "./plan-run-detail/child-walk.tsx";
import { DetailRail } from "./plan-run-detail/detail-rail.tsx";
import { PLAN_RUN_STATE_COLOR, summarizeCost } from "./plan-runs/walk-state.ts";

/**
 * Plan run detail — the Direction C walk inspector (warren-2520 /
 * pl-7e38 step 8, from docs/ui-revamp/screens/plan-run-detail.jsx).
 * Child-by-child gate state in the main panel, the source plan
 * definition + prompt + delivered PRs in the right rail. No summary
 * cards; the walk is the product.
 *
 * Keeps the legacy page's data behavior: one `GET /plan-runs/:id`
 * round-trip under the `["plan-runs", id]` key (shared with the
 * inventory's per-row detail fetch), 5s poll while active, and the
 * Tier-1 lifecycle stream invalidates the key globally
 * (use-lifecycle-stream-invalidation). The read surface is readPublic,
 * so a spectator sees the same walk read-only — the only operator
 * affordance is the Cancel plan run button, which `OperatorOnly` drops.
 */

const ACTIVE_STATES = new Set<PlanRunDetailResponse["planRun"]["state"]>(["queued", "running"]);

export function PlanRunDetailPage() {
	const { id = "" } = useParams<{ id: string }>();
	const qc = useQueryClient();

	const detail = useQuery({
		queryKey: ["plan-runs", id],
		queryFn: ({ signal }) => planRunsApi.get(id, signal),
		refetchInterval: (q) => {
			const data = q.state.data;
			if (!data) return 5000;
			return isTerminalPlanRunState(data.planRun.state) ? false : 5000;
		},
	});

	// Same key as the inventory pages: resolves the project git URL for
	// the hero meta line, falling back to the raw project id.
	const projects = useQuery({
		queryKey: ["projects"],
		queryFn: ({ signal }) => projectsApi.list(signal),
	});

	const cancel = useMutation({
		mutationFn: () => planRunsApi.cancel(id),
		onSettled: () => qc.invalidateQueries({ queryKey: ["plan-runs"] }),
	});

	if (detail.isLoading) {
		return <Spinner label="Loading plan run" />;
	}
	if (detail.isError) {
		return (
			<Alert variant="danger" title="Failed to load plan run">
				{formatError(detail.error)}
			</Alert>
		);
	}
	if (!detail.data) return null;
	const { planRun, children, runs } = detail.data;

	const project = projects.data?.projects.find((p) => p.id === planRun.projectId);
	const projectLabel = project
		? project.gitUrl.replace(/^https:\/\/github\.com\//, "") || project.gitUrl
		: planRun.projectId;
	const canCancel = ACTIVE_STATES.has(planRun.state);
	const cost = summarizeCost(runs);

	return (
		<div className="flex min-h-full flex-col px-3.5 pb-12 pt-[22px] md:px-6">
			<div className="shrink-0 pb-2.5">
				<span className="font-mono text-[10px] leading-3 text-(--color-text-3)">
					PLAN RUNS / {id.toUpperCase()}
				</span>
			</div>

			<header className="flex shrink-0 flex-wrap items-center gap-3 pb-5">
				<h1 className="font-mono text-[16px] leading-5 font-medium text-(--color-text)">{id}</h1>
				<StateLabel state={planRun.state} />
				{planRun.planId !== null ? <PlanChip planId={planRun.planId} /> : null}
				<span className="text-[11px] leading-[14px] text-(--color-text-2)">
					{projectLabel} · {planRun.agentName} · {planRun.trigger}
				</span>
				<div className="min-w-0 flex-1" />
				{canCancel ? (
					<OperatorOnly>
						<div className="flex flex-col items-end gap-1">
							<button
								type="button"
								onClick={() => cancel.mutate()}
								disabled={cancel.isPending}
								className="flex h-[31px] items-center justify-center gap-[7px] rounded-(--radius-sm) border border-(--color-border-strong) bg-(--color-surface) px-[11px] text-[11px] leading-[14px] font-medium text-(--color-text) disabled:opacity-60"
							>
								<CircleStop className="h-2 w-2 text-(--color-danger)" aria-hidden />
								{cancel.isPending ? "Cancelling…" : "Cancel plan run"}
							</button>
							<CancelStatus mutation={cancel} />
						</div>
					</OperatorOnly>
				) : null}
			</header>

			{planRun.state === "failed" && planRun.failureReason != null ? (
				<Alert variant="danger" title="Walk failed">
					{/* Prose for the visitor, raw reason in the tooltip for the
					    operator (warren-14fc / #641). Redacted to undefined for
					    spectators (warren-17d7). */}
					<span title={planRun.failureReason}>
						{formatPlanRunFailureReason(planRun.failureReason)}
					</span>
				</Alert>
			) : null}

			<div className="flex min-h-0 flex-1 flex-col gap-4 lg:flex-row">
				<ChildWalkPanel planRun={planRun} childRows={children} runs={runs} />
				<DetailRail detail={detail.data} projectLabel={projectLabel} cost={cost} />
			</div>
		</div>
	);
}

function StateLabel({ state }: { state: PlanRunDetailResponse["planRun"]["state"] }) {
	const color = PLAN_RUN_STATE_COLOR[state];
	return (
		<span className="flex items-center gap-[7px]">
			<span
				className="h-1.5 w-1.5 shrink-0 rounded-full"
				style={{ backgroundColor: color }}
				aria-hidden
			/>
			<span className="font-mono text-[10px] leading-3" style={{ color }}>
				{state}
			</span>
		</span>
	);
}

function PlanChip({ planId }: { planId: string }) {
	return (
		<span className="flex h-5 items-center rounded-(--radius-xs) border border-(--color-primary-border, var(--color-border-strong)) px-1.5 font-mono text-[9px] leading-3 text-(--color-primary)">
			{planId}
		</span>
	);
}

function CancelStatus({
	mutation,
}: {
	mutation: ReturnType<typeof useMutation<CancelPlanRunResponse, Error, void>>;
}) {
	if (mutation.isError) {
		return (
			<p className="text-[10px] leading-3 text-(--color-danger)">{formatError(mutation.error)}</p>
		);
	}
	if (mutation.isSuccess && mutation.data !== undefined) {
		return (
			<p className="text-[10px] leading-3 text-(--color-success)">
				{mutation.data.alreadyTerminal
					? "Walk was already terminal."
					: `Cancel forwarded${mutation.data.cancelledChild !== null ? ` (child ${mutation.data.cancelledChild.childSeq})` : ""}.`}
			</p>
		);
	}
	return null;
}
