import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { projectsApi, runsApi } from "@/api/client.ts";
import type { RunEvent, RunRow } from "@/api/types.ts";
import { isTerminalRunState } from "@/api/types.ts";
import { OperatorOnly } from "@/components/operator-only.tsx";
import { RunFailureBadge } from "@/components/status-indicator.tsx";
import { Alert } from "@/components/ui/alert.tsx";
import { Badge } from "@/components/ui/badge.tsx";
import { Spinner } from "@/components/ui/spinner.tsx";
import { useEventStream } from "@/hooks/use-event-stream.ts";
import { formatError } from "@/lib/format-error.ts";
import { formatPullRequestLifecycle } from "@/lib/labels.ts";
import { cn } from "@/lib/utils.ts";
import type { DispatchRouteState } from "@/pages/dispatch/dispatch-draft.ts";
import { EventTail } from "@/pages/run-detail/event-tail.tsx";
import { PhaseRail, PhaseRailStrip } from "@/pages/run-detail/phase-rail.tsx";
import { PreviewPanel } from "@/pages/run-detail/preview-panel.tsx";
import {
	BudgetPanel,
	PromptPanel,
	RunDefinitionPanel,
	RuntimePanel,
} from "@/pages/run-detail/side-panels.tsx";
import { CancelRunButton, SteerForm } from "@/pages/run-detail/steering-panel.tsx";
import { extractReapSummary, isBridgeStalled } from "@/pages/run-detail-format.ts";
import { projectLabel } from "@/pages/runs/runs-format.ts";

/**
 * Run detail — the Direction C workload inspector (warren-8c85 /
 * pl-7e38 step 4), translated from docs/ui-revamp/screens/run-detail.jsx:
 * breadcrumb + identity header, the five-cell lifecycle phase rail, the
 * structured event tail (main column), and the side column's Runtime /
 * Budget / Preview / Run definition / Prompt / Steering panels. Live
 * tailing rides the existing NDJSON stream reader (useEventStream);
 * operator affordances (cancel, re-run, steer, preview login/teardown)
 * ride OperatorOnly so the WARREN_AUTH=public spectator projection stays
 * read-only.
 */

/**
 * Event kinds whose arrival means the warren run row may have advanced
 * (state transition, cancel forwarded, reap finalized, preview flips).
 */
const REFETCH_TRIGGER_KINDS: ReadonlySet<string> = new Set([
	"state_change",
	"cancel.requested",
	"reap.completed",
	"reap_failed",
	"preview_launched",
	"preview_evicted",
	"preview_torn_down",
]);

/**
 * Invalidate the ["runs"] query family when an event with a
 * state-changing kind arrives. Tracked via index, not seq, so events
 * appended out of observed order would still be considered.
 */
function useRefetchOnTriggerEvents(events: RunEvent[], qc: QueryClientLike) {
	const processedEventCountRef = useRef(0);
	useEffect(() => {
		const len = events.length;
		if (len <= processedEventCountRef.current) {
			processedEventCountRef.current = len;
			return;
		}
		let trigger = false;
		for (let i = processedEventCountRef.current; i < len; i++) {
			const evt = events[i];
			if (evt !== undefined && REFETCH_TRIGGER_KINDS.has(evt.kind)) {
				trigger = true;
				break;
			}
		}
		processedEventCountRef.current = len;
		if (trigger) {
			void qc.invalidateQueries({ queryKey: ["runs"] });
		}
	}, [events, qc]);
}

interface QueryClientLike {
	invalidateQueries: (opts: { queryKey: string[] }) => Promise<unknown>;
}

function stateColor(state: string): string {
	switch (state) {
		case "running":
			return "text-(--color-info)";
		case "queued":
			return "text-(--color-warning)";
		case "succeeded":
			return "text-(--color-success)";
		case "failed":
			return "text-(--color-danger)";
		default:
			return "text-(--color-text-3)";
	}
}

function stateDotClass(state: RunRow["state"]): string {
	switch (state) {
		case "running":
			return "bg-(--color-info)";
		case "queued":
			return "bg-(--color-warning)";
		case "succeeded":
			return "bg-(--color-success)";
		case "failed":
			return "bg-(--color-danger)";
		default:
			return "bg-(--color-text-3)";
	}
}

/** Re-run / continue dispatch navigation (terminal runs only). */
function DispatchFromRunButtons({ run }: { run: RunRow }) {
	const navigate = useNavigate();
	const base = {
		agent: run.agentName,
		project: run.projectId ?? undefined,
		prompt: run.prompt,
	} as const;
	const btn =
		"inline-flex h-[31px] items-center rounded-(--radius-sm) border border-(--color-border-strong) bg-(--color-surface) px-[11px] text-[11px] leading-[14px] font-medium text-(--color-text) hover:bg-(--color-surface-hover)";
	return (
		<div className="flex gap-[7px]">
			<button
				type="button"
				className={btn}
				onClick={() =>
					navigate("/dispatch", {
						state: { cloneFromRunId: run.id, ...base } satisfies DispatchRouteState,
					})
				}
			>
				Re-run from scratch
			</button>
			<button
				type="button"
				className={btn}
				onClick={() =>
					navigate("/dispatch", {
						state: { continueFromRunId: run.id, ...base } satisfies DispatchRouteState,
					})
				}
			>
				Continue with follow-up
			</button>
		</div>
	);
}

function prBadgeVariant(prState: RunRow["prState"]): "succeeded" | "running" | "failed" {
	if (prState === "merged") return "succeeded";
	if (prState === "open") return "running";
	return "failed";
}

function PrBadge({ run }: { run: RunRow }) {
	if (run.prState === null) {
		return (
			<Badge
				variant="failed"
				className="font-mono text-xs"
				title="A PR exists but the merge watcher hasn't polled its state yet"
			>
				pr unknown
			</Badge>
		);
	}
	return (
		<Badge
			variant={prBadgeVariant(run.prState)}
			className="font-mono text-xs"
			title={
				run.prState === "merged" && run.prMergedAt !== null ? `merged ${run.prMergedAt}` : undefined
			}
		>
			{formatPullRequestLifecycle(run.prState)}
		</Badge>
	);
}

function HeaderBadges({ run, reap }: { run: RunRow; reap: ReturnType<typeof extractReapSummary> }) {
	const emptyPush = reap !== null && reap.branchPushed === true && reap.commitsAhead === 0;
	const hasCommits = run.commitsAhead !== null && run.commitsAhead > 0;
	const hasPr = run.prUrl !== null || run.prState !== null;
	return (
		<>
			{emptyPush ? (
				<Badge
					variant="cancelled"
					className="font-mono text-xs"
					title="Push succeeded but the branch has no new commits — the agent didn't commit"
				>
					empty push
				</Badge>
			) : null}
			{hasCommits ? (
				<Badge variant="succeeded" className="font-mono text-xs">
					+{run.commitsAhead} commit{run.commitsAhead === 1 ? "" : "s"}
				</Badge>
			) : null}
			{hasPr ? <PrBadge run={run} /> : null}
			{run.prUrl !== null ? (
				<a
					href={run.prUrl}
					target="_blank"
					rel="noreferrer noopener"
					className="font-mono text-[10px] leading-3 underline underline-offset-2 hover:text-(--color-primary)"
					title="Open the auto-opened pull request on GitHub"
				>
					PR ↗
				</a>
			) : null}
		</>
	);
}

function RunHeader({
	run,
	projectName,
	isTerminal,
	reap,
	onCancelSettled,
}: {
	run: RunRow;
	projectName: string;
	isTerminal: boolean;
	reap: ReturnType<typeof extractReapSummary>;
	onCancelSettled: () => void;
}) {
	return (
		<header className="flex shrink-0 flex-wrap items-center gap-2.5">
			<h1 className="font-mono text-[16px] leading-5 font-medium tracking-[-0.02em] text-(--color-text)">
				{run.id}
			</h1>
			<span className="flex items-center gap-[7px]">
				<span className={cn("h-1.5 w-1.5 rounded-full", stateDotClass(run.state))} aria-hidden />
				<span className={cn("font-mono text-[10px] leading-3", stateColor(run.state))}>
					{run.state}
				</span>
			</span>
			{run.state === "failed" && run.failureReason !== null ? (
				<RunFailureBadge reason={run.failureReason} />
			) : null}
			<HeaderBadges run={run} reap={reap} />
			<span className="font-mono text-[10px] leading-3 text-(--color-text-3)">
				{run.agentName} · {projectName}
				{run.provider !== null ? ` · ${run.provider}` : ""}
			</span>
			<span className="flex-1" />
			<OperatorOnly>
				{isTerminal ? (
					<DispatchFromRunButtons run={run} />
				) : (
					<CancelRunButton runId={run.id} disabled={isTerminal} onSettled={onCancelSettled} />
				)}
			</OperatorOnly>
		</header>
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
			if (!data) return 5000;
			return isTerminalRunState(data.state) ? false : 3000;
		},
	});

	// Shared projects list (same queryKey as Runs) resolves the
	// human-readable project name; fall back to the raw id (warren-6b21).
	const projects = useQuery({
		queryKey: ["projects"],
		queryFn: ({ signal }) => projectsApi.list(signal),
	});

	const isTerminal = run.data !== undefined && isTerminalRunState(run.data.state);
	const stream = useEventStream(id, !isTerminal);

	useRefetchOnTriggerEvents(stream.events, qc);

	if (run.isLoading) {
		return <Spinner label="Loading run" />;
	}
	if (run.isError) {
		return (
			<Alert variant="danger" title="Failed to load run">
				{formatError(run.error)}
			</Alert>
		);
	}
	if (!run.data) return null;
	const r = run.data;
	const reap = extractReapSummary(stream.events);
	const bridgeStalled = !isTerminal && isBridgeStalled(stream.events);
	const projectName =
		r.projectId === null
			? "deleted project"
			: projectLabel(
					projects.data?.projects.find((p) => p.id === r.projectId)?.gitUrl,
					r.projectId,
				);

	return (
		<div className="flex min-h-full flex-col gap-3 px-3.5 pt-[22px] pb-12 md:px-6">
			<nav className="shrink-0 font-mono text-[10px] leading-3 text-(--color-text-3)">
				RUNS / {r.id.toUpperCase()}
			</nav>

			<RunHeader
				run={r}
				projectName={projectName}
				isTerminal={isTerminal}
				reap={reap}
				onCancelSettled={() => void qc.invalidateQueries({ queryKey: ["runs"] })}
			/>

			{bridgeStalled ? (
				<Alert variant="warning" title="Agent infrastructure unreachable">
					Can't reach the sandbox; reconnects keep timing out. Retrying.
				</Alert>
			) : null}

			<div className="hidden md:block">
				<PhaseRail run={r} events={stream.events} />
			</div>
			<div className="md:hidden">
				<PhaseRailStrip run={r} events={stream.events} />
			</div>

			<div className="flex min-h-0 flex-1 flex-col gap-3 xl:flex-row">
				<div className="flex min-w-0 flex-1 flex-col gap-3">
					<EventTail
						events={stream.events}
						status={stream.status}
						error={stream.error}
						terminal={isTerminal}
					/>
				</div>
				<aside className="flex w-full shrink-0 flex-col gap-3 xl:w-[326px]">
					<RuntimePanel run={r} />
					<BudgetPanel run={r} />
					{r.previewState !== null ? <PreviewPanel run={r} /> : null}
					<RunDefinitionPanel run={r} projectName={projectName} />
					<PromptPanel run={r} />
					<OperatorOnly>
						<SteerForm runId={r.id} disabled={isTerminal} />
					</OperatorOnly>
				</aside>
			</div>
		</div>
	);
}
