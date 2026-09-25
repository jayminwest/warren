import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronRight, RefreshCw } from "lucide-react";
import { type ReactNode, useMemo } from "react";
import { useParams } from "react-router-dom";
import { projectsApi, runsApi } from "@/api/client.ts";
import { isTerminalRunState } from "@/api/types.ts";
import { OperatorOnly } from "@/components/operator-only.tsx";
import { Button } from "@/components/ui/button.tsx";
import { Skeleton } from "@/components/ui/skeleton.tsx";
import { useEventStream } from "@/hooks/use-event-stream.ts";
import { useNow } from "@/hooks/use-now.ts";
import { formatError } from "@/lib/format-error.ts";
import { extractReapSummary, isBridgeStalled } from "@/pages/run-detail-format.ts";
import { projectLabel } from "@/pages/runs/runs-format.ts";
import { EventLog } from "./event-log.tsx";
import { PreviewPanel } from "./preview-panel.tsx";
import { ProblemNote } from "./problem-note.tsx";
import { RunHeader } from "./run-header.tsx";
import { useRunRefreshOnEvents } from "./run-refresh.ts";
import { PromptPanel, RunDefinitionPanel, RuntimePanel, SpendPanel } from "./side-panels.tsx";
import { StageTimeline } from "./stage-timeline.tsx";
import { SteerForm } from "./steering-panel.tsx";

/**
 * Run detail (warren-8c85, polished in warren-7d17 / warren-4a47): the
 * header with status and outcome, the stage timeline, the event log as
 * the main column, and the side column's Runtime / Spend / Preview / Run
 * definition / Prompt / Steering cards. Operator affordances ride
 * OperatorOnly so the WARREN_AUTH=public spectator projection stays
 * read-only.
 *
 * The row refreshes from the run's own event stream (run-refresh.ts)
 * rather than a 3s poll; a slow fallback poll covers a dropped stream.
 */

/** Fallback re-read of an active run when the stream goes quiet. */
const ACTIVE_FALLBACK_POLL_MS = 20_000;

function Disclosure({ title, children }: { title: string; children: ReactNode }) {
	return (
		<details className="group">
			<summary className="flex min-h-11 cursor-pointer list-none items-center rounded-md border border-(--color-border) bg-(--color-surface) px-4 text-sm font-medium text-(--color-text) [&::-webkit-details-marker]:hidden">
				{title}
				<ChevronRight
					aria-hidden
					className="ml-auto size-4 text-(--color-text-3) transition-transform group-open:rotate-90"
				/>
			</summary>
			<div className="pt-3">{children}</div>
		</details>
	);
}

function RunDetailSkeleton() {
	return (
		<div role="status" aria-label="Loading run" className="flex flex-col gap-4 px-4 pt-6 md:px-6">
			<Skeleton className="h-3 w-40" />
			<Skeleton className="h-6 w-72" />
			<div className="flex gap-2">
				<Skeleton className="h-5.5 w-24 rounded-full" />
				<Skeleton className="h-5.5 w-20" />
				<Skeleton className="h-5.5 w-44" />
			</div>
			<Skeleton className="h-3.5 w-2/3" />
			<Skeleton className="h-16 w-full rounded-md" />
			<div className="flex flex-col gap-4 xl:flex-row">
				<Skeleton className="h-96 flex-1 rounded-md" />
				<div className="flex flex-col gap-4 xl:w-80">
					<Skeleton className="h-40 rounded-md" />
					<Skeleton className="h-40 rounded-md" />
				</div>
			</div>
		</div>
	);
}

function LoadError({ message, onRetry }: { message: string; onRetry: () => void }) {
	return (
		<div className="px-4 pt-6 md:px-6">
			<ProblemNote
				title="Couldn't load this run"
				action={
					<Button variant="outline" size="sm" onClick={onRetry}>
						<RefreshCw aria-hidden />
						Try again
					</Button>
				}
			>
				{message}
			</ProblemNote>
		</div>
	);
}

export function RunDetailPage() {
	const { id = "" } = useParams<{ id: string }>();
	const qc = useQueryClient();

	const run = useQuery({
		queryKey: ["runs", id],
		queryFn: ({ signal }) => runsApi.get(id, signal),
		refetchInterval: (q) => {
			const data = q.state.data;
			return data !== undefined && !isTerminalRunState(data.state)
				? ACTIVE_FALLBACK_POLL_MS
				: false;
		},
	});

	// Shared projects list (same queryKey as Runs) resolves the
	// human-readable project name; fall back to the raw id (warren-6b21).
	const projects = useQuery({
		queryKey: ["projects"],
		queryFn: ({ signal }) => projectsApi.list(signal),
	});

	const isTerminal = run.data !== undefined && isTerminalRunState(run.data.state);
	// Open the stream once the row says whether to tail or replay.
	const stream = useEventStream(id, !isTerminal, run.data !== undefined);
	useRunRefreshOnEvents(id, stream.events);
	const now = useNow(1000, run.data !== undefined && !isTerminal);

	const reap = useMemo(() => extractReapSummary(stream.events), [stream.events]);
	const bridgeStalled = useMemo(
		() => !isTerminal && isBridgeStalled(stream.events),
		[isTerminal, stream.events],
	);

	if (run.isLoading) return <RunDetailSkeleton />;
	if (run.isError || !run.data) {
		return (
			<LoadError
				message={run.isError ? formatError(run.error) : "The run was not found."}
				onRetry={() => void run.refetch()}
			/>
		);
	}
	const r = run.data;
	const projectName =
		r.projectId === null
			? "a deleted project"
			: projectLabel(
					projects.data?.projects.find((p) => p.id === r.projectId)?.gitUrl,
					r.projectId,
				);

	return (
		<div className="flex min-h-full flex-col gap-4 px-4 pt-6 pb-12 md:px-6 xl:h-full xl:pb-6">
			<RunHeader
				run={r}
				projectName={projectName}
				isTerminal={isTerminal}
				reap={reap}
				now={now}
				onCancelSettled={() => void qc.invalidateQueries({ queryKey: ["runs"] })}
			/>

			{bridgeStalled ? (
				<ProblemNote tone="warning" title="Can't reach the sandbox">
					Reconnects keep timing out. Warren keeps retrying; the log resumes when it reconnects.
				</ProblemNote>
			) : null}

			<StageTimeline run={r} events={stream.events} now={now} />

			{/*
			 * Mobile section order (warren-3399, mx-a07322): below md the stack
			 * reads Runtime → Spend → Event log → Steering, with Preview / Run
			 * definition / Prompt collapsed into disclosures. The two-column
			 * row cuts over at xl; `max-xl:contents` promotes the aside's
			 * children into this flex container below xl so order-* can
			 * interleave them with the log. At xl the row is height-bound so
			 * the log scrolls internally (warren-57fb).
			 */}
			<div className="flex min-h-0 flex-1 flex-col gap-4 xl:flex-row xl:overflow-hidden">
				<div className="order-3 flex min-h-0 min-w-0 flex-1 flex-col md:order-none">
					<EventLog
						events={stream.events}
						trimmed={stream.trimmed}
						status={stream.status}
						error={stream.error}
						terminal={isTerminal}
						className="xl:min-h-0 xl:flex-1"
					/>
				</div>
				<aside className="flex w-full shrink-0 flex-col gap-4 max-xl:contents xl:min-h-0 xl:w-80 xl:overflow-y-auto xl:*:shrink-0">
					<div className="order-1 md:order-none">
						<RuntimePanel run={r} />
					</div>
					<div className="order-2 md:order-none">
						<SpendPanel run={r} />
					</div>
					<OperatorOnly>
						{!isTerminal ? (
							<div className="order-4 md:order-none">
								<SteerForm runId={r.id} disabled={isTerminal} />
							</div>
						) : null}
					</OperatorOnly>
					<div className="hidden md:contents md:*:shrink-0">
						{r.previewState !== null ? <PreviewPanel run={r} /> : null}
						<RunDefinitionPanel run={r} projectName={projectName} />
						<PromptPanel run={r} />
					</div>
					<div className="order-5 flex flex-col gap-3 md:hidden">
						{r.previewState !== null ? (
							<Disclosure title="Preview">
								<PreviewPanel run={r} />
							</Disclosure>
						) : null}
						<Disclosure title="Run definition">
							<RunDefinitionPanel run={r} projectName={projectName} />
						</Disclosure>
						<Disclosure title="Prompt">
							<PromptPanel run={r} />
						</Disclosure>
					</div>
				</aside>
			</div>
		</div>
	);
}
