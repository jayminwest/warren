import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CircleStop, RefreshCw, Send } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { runsApi } from "@/api/client.ts";
import type { CancelRunResponse } from "@/api/types.ts";
import { isTerminalRunState } from "@/api/types.ts";
import { OperatorOnly } from "@/components/OperatorOnly.tsx";
import { StateBadge } from "@/components/StateBadge.tsx";
import { RunFailureBadge } from "@/components/StatusIndicator.tsx";
import { Alert } from "@/components/ui/alert.tsx";
import { Badge } from "@/components/ui/badge.tsx";
import { Button } from "@/components/ui/button.tsx";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card.tsx";
import { Label } from "@/components/ui/label.tsx";
import { responsiveFooterActions, responsiveFooterButton } from "@/components/ui/responsive.ts";
import { Spinner } from "@/components/ui/spinner.tsx";
import { Textarea } from "@/components/ui/textarea.tsx";
import { useEventStream } from "@/hooks/useEventStream.ts";
import { formatError } from "@/lib/format-error.ts";
import { formatTimestamp, relativeTime } from "@/lib/utils.ts";
import type { NewRunRouteState } from "@/pages/NewRun.tsx";
import { CostCard } from "@/pages/run-detail-cost.tsx";
import { EventTail } from "@/pages/run-detail-events.tsx";
import { extractReapSummary, isBridgeStalled } from "@/pages/run-detail-format.ts";
import { PreviewCard } from "@/pages/run-detail-preview.tsx";

// warren-9679: formatCostUsd moved to run-detail-format.ts; re-exported
// here so the existing import sites (Runs, PlanRuns, PlanRunDetail,
// CostAnalytics, run-analytics/format) keep working unchanged.
export { formatCostUsd } from "@/pages/run-detail-format.ts";

/**
 * Event kinds whose arrival means the warren run row may have advanced
 * (state transition, cancel forwarded, reap finalized). When we observe
 * one in the live event stream we invalidate the run query so the badge
 * and metadata refresh without waiting for the polling backstop.
 */
const REFETCH_TRIGGER_KINDS: ReadonlySet<string> = new Set([
	"state_change",
	"cancel.requested",
	"reap.completed",
	"reap_failed",
	// Preview lifecycle events (R-19 / docs/design/preview-environments.md, warren-c0b9) — each
	// flips one of the `previewState` / `previewPort` / `previewStartedAt`
	// columns on the run row, so refresh the query to surface the new
	// badge + URL + teardown affordance.
	"preview_launched",
	"preview_evicted",
	"preview_torn_down",
]);

export function RunDetailPage() {
	const { id = "" } = useParams<{ id: string }>();
	const qc = useQueryClient();
	const navigate = useNavigate();

	const run = useQuery({
		queryKey: ["runs", id],
		queryFn: ({ signal }) => runsApi.get(id, signal),
		refetchInterval: (q) => {
			const data = q.state.data;
			if (!data) return 5000;
			return isTerminalRunState(data.state) ? false : 3000;
		},
	});

	const isTerminal = run.data !== undefined && isTerminalRunState(run.data.state);
	const stream = useEventStream(id, !isTerminal);

	// Invalidate the run query when an event with a state-changing kind
	// arrives. Tracked via index, not seq, so events appended out of
	// observed order would still be considered (the hook appends in seq
	// order so this is mostly a guard).
	const processedEventCountRef = useRef(0);
	useEffect(() => {
		const len = stream.events.length;
		if (len <= processedEventCountRef.current) {
			processedEventCountRef.current = len;
			return;
		}
		let trigger = false;
		for (let i = processedEventCountRef.current; i < len; i++) {
			const evt = stream.events[i];
			if (evt !== undefined && REFETCH_TRIGGER_KINDS.has(evt.kind)) {
				trigger = true;
				break;
			}
		}
		processedEventCountRef.current = len;
		if (trigger) {
			// `["runs"]` (no exact) covers both this row and the list page's
			// `["runs", filter]` cache so navigating back doesn't show stale
			// badges either.
			void qc.invalidateQueries({ queryKey: ["runs"] });
		}
	}, [stream.events, qc]);

	const cancel = useMutation({
		mutationFn: () => runsApi.cancel(id, {}),
		onSettled: () => qc.invalidateQueries({ queryKey: ["runs"] }),
	});

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

	return (
		<div className="space-y-6">
			<header className="flex flex-wrap items-start justify-between gap-3">
				<div>
					<div className="flex items-center gap-3">
						<h1 className="font-mono text-xl font-semibold">{r.id}</h1>
						<StateBadge state={r.state} />
						{r.state === "failed" && r.failureReason !== null ? (
							<RunFailureBadge reason={r.failureReason} />
						) : null}
						{reap !== null && reap.branchPushed === true && reap.commitsAhead === 0 ? (
							<Badge
								variant="cancelled"
								className="font-mono text-xs"
								title="Push succeeded but the branch has no new commits — the agent didn't commit"
							>
								empty push
							</Badge>
						) : null}
						{reap !== null &&
						reap.branchPushed === true &&
						typeof reap.commitsAhead === "number" &&
						reap.commitsAhead > 0 ? (
							<Badge variant="succeeded" className="font-mono text-xs">
								+{reap.commitsAhead} commit{reap.commitsAhead === 1 ? "" : "s"}
							</Badge>
						) : null}
						{r.prUrl !== null ? (
							<a
								href={r.prUrl}
								target="_blank"
								rel="noreferrer noopener"
								className="font-mono text-xs underline underline-offset-2 text-(--color-fg) hover:text-(--color-primary)"
								title="Open the auto-opened pull request on GitHub"
							>
								PR ↗
							</a>
						) : null}
					</div>
					<p className="mt-1 text-sm text-(--color-muted-foreground)">
						<span className="font-medium">{r.agentName}</span> ·{" "}
						{r.projectId === null ? (
							<span className="italic">(deleted project)</span>
						) : (
							<span className="font-mono">{r.projectId}</span>
						)}
					</p>
				</div>
				<OperatorOnly>
					<div className="flex flex-col items-end gap-1">
						{isTerminal ? (
							<div className="flex gap-2">
								<Button
									variant="outline"
									onClick={() =>
										navigate("/runs/new", {
											state: {
												cloneFromRunId: r.id,
												agent: r.agentName,
												project: r.projectId ?? undefined,
												prompt: r.prompt,
											} satisfies NewRunRouteState,
										})
									}
								>
									<RefreshCw className="h-4 w-4" />
									Re-run from scratch
								</Button>
								<Button
									variant="outline"
									onClick={() =>
										navigate("/runs/new", {
											state: {
												continueFromRunId: r.id,
												agent: r.agentName,
												project: r.projectId ?? undefined,
												prompt: r.prompt,
											} satisfies NewRunRouteState,
										})
									}
								>
									<Send className="h-4 w-4" />
									Continue with follow-up
								</Button>
							</div>
						) : (
							<Button
								variant="destructive"
								onClick={() => cancel.mutate()}
								disabled={cancel.isPending || isTerminal}
							>
								<CircleStop className="h-4 w-4" />
								{cancel.isPending ? "Cancelling…" : "Cancel"}
							</Button>
						)}
						<CancelStatus mutation={cancel} />
					</div>
				</OperatorOnly>
			</header>

			{bridgeStalled ? (
				<Alert variant="warning" title="Agent infrastructure unreachable">
					Can't reach the sandbox; reconnects keep timing out. Retrying.
				</Alert>
			) : null}

			<div className="grid gap-4 md:grid-cols-3">
				<CostCard run={r} />
				<MetaCard label="Started">{formatTimestamp(r.startedAt)}</MetaCard>
				<MetaCard label="Ended">{formatTimestamp(r.endedAt)}</MetaCard>
				<MetaCard label="Trigger">{r.trigger}</MetaCard>
				{/* Gated on presence (warren-f53e): runtime handles — burrow ids under
				    burrow, pod name/UID under k8s (NOT null there; warren-0965) — and
				    absent from a spectator's projection, where they rendered as two
				    empty "—" jargon cards on the hero page. */}
				{r.burrowId ? (
					<MetaCard label="Sandbox ID">
						<span className="font-mono text-xs">{r.burrowId}</span>
					</MetaCard>
				) : null}
				{r.burrowRunId ? (
					<MetaCard label="Sandbox Run">
						<span className="font-mono text-xs">{r.burrowRunId}</span>
					</MetaCard>
				) : null}
				<MetaCard label="Updated">{relativeTime(r.endedAt ?? r.startedAt)}</MetaCard>
				{r.seedId !== null ? (
					<MetaCard label="Seed">
						<span className="font-mono text-xs" title="Seeds issue this run was dispatched against">
							{r.seedId}
						</span>
					</MetaCard>
				) : null}
				{r.prUrl !== null ? (
					<MetaCard label="Pull Request">
						<a
							href={r.prUrl}
							target="_blank"
							rel="noreferrer noopener"
							className="break-all font-mono text-xs underline underline-offset-2 hover:text-(--color-primary)"
						>
							{r.prUrl}
						</a>
					</MetaCard>
				) : null}
				{r.parentRunId !== null ? (
					<MetaCard label={r.cloneKind === "replicate" ? "Re-run of" : "Continued from"}>
						<Link
							to={`/runs/${encodeURIComponent(r.parentRunId)}`}
							className="font-mono text-xs underline hover:text-(--color-primary)"
						>
							{r.cloneKind === "replicate" ? "⟳" : "↪"} {r.parentRunId}
						</Link>
					</MetaCard>
				) : null}
			</div>

			{r.previewState !== null ? <PreviewCard run={r} /> : null}

			<Card>
				<CardHeader>
					<CardTitle>Prompt</CardTitle>
				</CardHeader>
				<CardContent>
					<pre className="whitespace-pre-wrap break-words rounded-md bg-(--color-muted) p-3 text-sm">
						{r.prompt}
					</pre>
				</CardContent>
			</Card>

			{/* Steer sits ABOVE the event tail (warren-f53e): the tail is a
			    fixed 480px log, so steering used to mean scrolling past the
			    whole thing to reach the box you want to type in while the
			    agent is running. */}
			<OperatorOnly>
				<SteerForm runId={r.id} disabled={isTerminal} />
			</OperatorOnly>

			<EventTail
				events={stream.events}
				status={stream.status}
				error={stream.error}
				terminal={isTerminal}
			/>
		</div>
	);
}

function CancelStatus({
	mutation,
}: {
	mutation: ReturnType<typeof useMutation<CancelRunResponse, Error, void>>;
}) {
	if (mutation.isError) {
		return (
			<p className="text-xs text-(--color-destructive)">
				{mutation.error instanceof Error ? mutation.error.message : String(mutation.error)}
			</p>
		);
	}
	if (mutation.isSuccess && mutation.data !== undefined) {
		const d = mutation.data;
		if (d.alreadyTerminal) {
			return (
				<p className="text-xs text-(--color-muted-foreground)">
					Run was already terminal ({d.state}).
				</p>
			);
		}
		const runtimeState = d.burrowRun?.state; // pod phase under k8s (warren-0965)
		return (
			<p className="text-xs text-emerald-700 dark:text-emerald-300">
				Cancel forwarded
				{runtimeState !== undefined ? ` (sandbox: ${runtimeState})` : ""}.
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

function SteerForm({ runId, disabled }: { runId: string; disabled: boolean }) {
	const [body, setBody] = useState("");
	const [success, setSuccess] = useState(false);

	const steer = useMutation({
		mutationFn: () => runsApi.steer(runId, { body }),
		onSuccess: () => {
			setBody("");
			setSuccess(true);
			window.setTimeout(() => setSuccess(false), 3000);
		},
	});

	return (
		<Card>
			<CardHeader>
				<CardTitle>Steer</CardTitle>
			</CardHeader>
			<CardContent>
				<form
					onSubmit={(e) => {
						e.preventDefault();
						if (body.trim().length === 0) return;
						steer.mutate();
					}}
					className="space-y-3"
				>
					<div className="space-y-1.5">
						<Label htmlFor="steer-body">Message</Label>
						<Textarea
							id="steer-body"
							rows={3}
							value={body}
							onChange={(e) => setBody(e.target.value)}
							disabled={disabled}
							placeholder={
								disabled
									? "Run is terminal; steering is disabled."
									: "Send a steering message to the agent's inbox."
							}
						/>
					</div>
					{steer.isError ? (
						<p className="text-sm text-(--color-destructive)">
							{steer.error instanceof Error ? steer.error.message : String(steer.error)}
						</p>
					) : null}
					{success ? (
						<p className="text-sm text-emerald-700 dark:text-emerald-300">
							Steering message delivered.
						</p>
					) : null}
					<div className={responsiveFooterActions}>
						<Button
							type="submit"
							disabled={disabled || steer.isPending || body.trim().length === 0}
							className={responsiveFooterButton}
						>
							<Send className="h-4 w-4" />
							{steer.isPending ? "Sending…" : "Send"}
						</Button>
					</div>
				</form>
			</CardContent>
		</Card>
	);
}
