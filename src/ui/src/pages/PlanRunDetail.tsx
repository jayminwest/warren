import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CircleStop } from "lucide-react";
import { useParams } from "react-router-dom";
import { planRunsApi } from "@/api/client.ts";
import { PlotMetaCardContent } from "@/components/PlotMetaCardContent.tsx";
import type { PlanRunRow, RunRow } from "@/api/types.ts";
import { PLAN_RUN_TERMINAL_STATES } from "@/api/types.ts";
import { PlanRunStateBadge } from "@/components/PlanRunStateBadge.tsx";
import { Alert } from "@/components/ui/alert.tsx";
import { Button } from "@/components/ui/button.tsx";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card.tsx";
import { Spinner } from "@/components/ui/spinner.tsx";
import { formatError } from "@/lib/format-error.ts";
import { formatTimestamp, relativeTime } from "@/lib/utils.ts";
import { PlanRunChildTable } from "./plan-run-detail/child-table.tsx";
import { formatCostUsd } from "./RunDetail.tsx";

const ACTIVE_STATES = new Set<PlanRunRow["state"]>(["queued", "running"]);

export function PlanRunDetailPage() {
	const { id = "" } = useParams<{ id: string }>();
	const qc = useQueryClient();

	const detail = useQuery({
		queryKey: ["plan-runs", id],
		queryFn: ({ signal }) => planRunsApi.get(id, signal),
		refetchInterval: (q) => {
			const data = q.state.data;
			if (!data) return 5000;
			return PLAN_RUN_TERMINAL_STATES.includes(data.planRun.state) ? false : 5000;
		},
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
	const canCancel = ACTIVE_STATES.has(planRun.state);
	const cost = summarizeRunCost(runs);

	return (
		<div className="space-y-6">
			<header className="flex flex-wrap items-start justify-between gap-3">
				<div>
					<div className="flex items-center gap-3">
						<h1 className="font-mono text-xl font-semibold">{planRun.id}</h1>
						<PlanRunStateBadge state={planRun.state} />
						{planRun.state === "failed" && planRun.failureReason !== null ? (
							<span
								className="font-mono text-xs text-(--color-destructive)"
								title={planRun.failureReason}
							>
								{planRun.failureReason}
							</span>
						) : null}
					</div>
					<p className="mt-1 text-sm text-(--color-muted-foreground)">
						Plan <span className="font-mono">{planRun.planId}</span> ·{" "}
						<span className="font-medium">{planRun.agentName}</span> ·{" "}
						<span className="font-mono">{planRun.projectId}</span>
					</p>
				</div>
				{canCancel ? (
					<div className="flex flex-col items-end gap-1">
						<Button
							variant="destructive"
							onClick={() => cancel.mutate()}
							disabled={cancel.isPending}
						>
							<CircleStop className="h-4 w-4" />
							{cancel.isPending ? "Cancelling…" : "Cancel"}
						</Button>
						<CancelStatus mutation={cancel} />
					</div>
				) : null}
			</header>

			<div className="grid gap-4 md:grid-cols-3">
				<MetaCard label="Plan">
					<span className="font-mono text-xs">{planRun.planId}</span>
				</MetaCard>
				<MetaCard label="Agent">{planRun.agentName}</MetaCard>
				<MetaCard label="Project">
					<span className="font-mono text-xs">{planRun.projectId}</span>
				</MetaCard>
				<MetaCard label="Dispatcher">{planRun.dispatcherHandle}</MetaCard>
				<MetaCard label="Trigger">{planRun.trigger}</MetaCard>
				<MetaCard label="Children">{children.length}</MetaCard>
				<MetaCard label="Cost">
					<span
						className="font-mono text-xs"
						title={
							cost.priced === 0
								? "No child runs have a recorded cost yet"
								: `${cost.priced} of ${runs.length} child runs have a recorded cost`
						}
					>
						{cost.priced === 0 ? "—" : formatCostUsd(cost.sum)}
					</span>
				</MetaCard>
				<MetaCard label="Started">{formatTimestamp(planRun.startedAt)}</MetaCard>
				<MetaCard label="Ended">{formatTimestamp(planRun.endedAt)}</MetaCard>
				<MetaCard label="Duration">{formatDuration(planRun)}</MetaCard>
				{planRun.providerOverride !== null ? (
					<MetaCard label="Provider override">
						<span className="font-mono text-xs">{planRun.providerOverride}</span>
					</MetaCard>
				) : null}
				{planRun.modelOverride !== null ? (
					<MetaCard label="Model override">
						<span className="font-mono text-xs">{planRun.modelOverride}</span>
					</MetaCard>
				) : null}
				{planRun.ref !== null ? (
					<MetaCard label="Ref">
						<span className="font-mono text-xs">{planRun.ref}</span>
					</MetaCard>
				) : null}
				{planRun.plotId !== null ? (
					<MetaCard label="Plot">
						<PlotMetaCardContent plotId={planRun.plotId} />
					</MetaCard>
				) : null}
				<MetaCard label="Created">{relativeTime(planRun.createdAt)}</MetaCard>
			</div>

			<Card>
				<CardHeader>
					<CardTitle>Prompt template</CardTitle>
				</CardHeader>
				<CardContent>
					<pre className="whitespace-pre-wrap break-words rounded-md bg-(--color-muted) p-3 text-sm">
						{planRun.promptTemplate}
					</pre>
				</CardContent>
			</Card>

			<PlanRunChildTable children={children} runs={runs} />
		</div>
	);
}

function CancelStatus({
	mutation,
}: {
	mutation: ReturnType<typeof useMutation<unknown, Error, void>>;
}) {
	if (mutation.isError) {
		return (
			<p className="text-xs text-(--color-destructive)">{formatError(mutation.error)}</p>
		);
	}
	if (mutation.isSuccess) {
		return (
			<p className="text-xs text-emerald-700 dark:text-emerald-300">
				Cancel forwarded.
			</p>
		);
	}
	return null;
}

function MetaCard({ label, children }: { label: string; children: React.ReactNode }) {
	return (
		<Card>
			<CardContent className="space-y-1 p-4">
				<div className="text-xs uppercase tracking-wide text-(--color-muted-foreground)">
					{label}
				</div>
				<div className="text-sm">{children}</div>
			</CardContent>
		</Card>
	);
}

/**
 * Sum non-null `costUsd` across a plan-run's child runs (warren-2235 /
 * pl-b0c0 step 5). NULL-aware: matches RunsRepo.aggregate's posture so
 * the Cost meta card displays the same number a future server-side
 * rollup would, and the `priced` counter surfaces ghost runs whose cost
 * was never recorded.
 */
function summarizeRunCost(runs: RunRow[]): { sum: number; priced: number } {
	let sum = 0;
	let priced = 0;
	for (const r of runs) {
		if (r.costUsd !== null) {
			sum += r.costUsd;
			priced += 1;
		}
	}
	return { sum, priced };
}

function formatDuration(planRun: PlanRunRow): string {
	if (planRun.startedAt === null) return "—";
	const start = Date.parse(planRun.startedAt);
	if (Number.isNaN(start)) return "—";
	const endRaw = planRun.endedAt ?? new Date().toISOString();
	const end = Date.parse(endRaw);
	if (Number.isNaN(end)) return "—";
	const ms = end - start;
	if (ms < 0) return "—";
	const sec = Math.floor(ms / 1000);
	if (sec < 60) return `${sec}s`;
	const min = Math.floor(sec / 60);
	if (min < 60) return `${min}m ${sec % 60}s`;
	const hr = Math.floor(min / 60);
	return `${hr}h ${min % 60}m`;
}
