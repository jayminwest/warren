import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CircleStop, ExternalLink, RefreshCw, Send, Trash2 } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import {
	buildPreviewLoginUrl,
	formatPreviewUrl,
	previewApi,
	runsApi,
} from "@/api/client.ts";
import type {
	CancelRunResponse,
	PreviewState,
	PreviewTeardownResponse,
	ReapCompletedPayload,
	RunEvent,
	RunRow,
} from "@/api/types.ts";
import { PREVIEW_ACTIVE_STATES, RUN_TERMINAL_STATES } from "@/api/types.ts";
import { PlotMetaCardContent } from "@/components/PlotMetaCardContent.tsx";
import { StateBadge } from "@/components/StateBadge.tsx";
import { StatusIndicator } from "@/components/StatusIndicator.tsx";
import { Alert } from "@/components/ui/alert.tsx";
import { Badge } from "@/components/ui/badge.tsx";
import { Button } from "@/components/ui/button.tsx";
import {
	responsiveFooterActions,
	responsiveFooterButton,
} from "@/components/ui/responsive.ts";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card.tsx";
import { Label } from "@/components/ui/label.tsx";
import { AnimatePresence, StreamItem } from "@/components/ui/motion.tsx";
import { Spinner } from "@/components/ui/spinner.tsx";
import { Textarea } from "@/components/ui/textarea.tsx";
import { useEventStream } from "@/hooks/useEventStream.ts";
import { formatError } from "@/lib/format-error.ts";
import { formatTimestamp, relativeTime } from "@/lib/utils.ts";
import type { NewRunRouteState } from "@/pages/NewRun.tsx";

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
	// Preview lifecycle events (R-19 / SPEC §11.L, warren-c0b9) — each
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
			return RUN_TERMINAL_STATES.includes(data.state) ? false : 3000;
		},
	});

	const isTerminal =
		run.data !== undefined && RUN_TERMINAL_STATES.includes(run.data.state);
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
	}, [stream.events, id, qc]);

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
							<Badge variant="cancelled" className="font-mono text-xs">
								{r.failureReason}
							</Badge>
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
											plotId: r.plotId ?? undefined,
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
											plotId: r.plotId ?? undefined,
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
				<MetaCard label="Burrow ID">
					<span className="font-mono text-xs">{r.burrowId ?? "—"}</span>
				</MetaCard>
				<MetaCard label="Burrow Run">
					<span className="font-mono text-xs">{r.burrowRunId ?? "—"}</span>
				</MetaCard>
				<MetaCard label="Updated">{relativeTime(r.endedAt ?? r.startedAt)}</MetaCard>
				{r.seedId !== null ? (
					<MetaCard label="Seed">
						<span
							className="font-mono text-xs"
							title="Seeds issue this run was dispatched against"
						>
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
				{r.plotId !== null ? (
					<MetaCard label="Plot">
						<PlotMetaCardContent plotId={r.plotId} />
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

			<EventTail
				events={stream.events}
				status={stream.status}
				error={stream.error}
				terminal={isTerminal}
			/>

			<SteerForm runId={r.id} disabled={isTerminal} />
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
				{mutation.error instanceof Error
					? mutation.error.message
					: String(mutation.error)}
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
		const burrowState = d.burrowRun?.state;
		return (
			<p className="text-xs text-emerald-700 dark:text-emerald-300">
				Cancel forwarded
				{burrowState !== undefined ? ` (burrow: ${burrowState})` : ""}.
			</p>
		);
	}
	return null;
}

/**
 * Cost + token breakdown card for /runs/:id (warren-a7ec). Promoted out
 * of a header badge with a hover-only tooltip so the token totals are
 * visible without interaction. Renders "—" when the run has no recorded
 * cost (pre-pi-extraction runs or non-pi runtimes); the breakdown line
 * is omitted when no token counters are populated.
 */
function CostCard({ run }: { run: RunRow }) {
	const tokens = formatTokenBreakdown(run);
	return (
		<Card>
			<CardContent className="space-y-1 p-4">
				<div className="text-xs uppercase tracking-wide text-(--color-muted-foreground)">
					Cost
				</div>
				<div className="font-mono text-lg">
					{run.costUsd !== null ? (
						formatCostUsd(run.costUsd)
					) : (
						<span className="text-(--color-muted-foreground)">—</span>
					)}
				</div>
				{tokens !== null ? (
					<div className="font-mono text-xs text-(--color-muted-foreground)">
						{tokens}
					</div>
				) : null}
			</CardContent>
		</Card>
	);
}

/**
 * Per-run preview environment surface (R-19 / SPEC §11.L, warren-c0b9).
 * Renders one of four states populated by reap's `preview_launch` sub-
 * step + the eviction / teardown paths:
 *
 *   - `starting`  — readiness probe pending; teardown is allowed (lets
 *                    the operator abort a hung sidecar).
 *   - `live`      — proxy can route; surface an "Open Preview ↗" link
 *                    that goes through the auth-exempt login handshake
 *                    (signs a `warren_preview` cookie, 302s to the
 *                    mode-correct target) and a teardown button. The
 *                    canonical URL is rendered as a copyable string so
 *                    operators can share it without the `?token=` query.
 *   - `failed`    — `previewFailureMessage` holds the stderr tail; no
 *                    URL, no teardown (already released).
 *   - `torn-down` — informational only; the port was released and the
 *                    sidecar killed. Workspace stays for repush.
 *
 * URL shape honors `WARREN_PREVIEW_MODE` (warren-016d) — path mode shows
 * `<origin>/p/<id>/`, subdomain mode shows `https://run-<id>.<host>/`.
 * Both reflect where the login handshake actually redirects.
 *
 * Visible only when the run row has a non-null `previewState` — the
 * caller guards on that.
 */
function PreviewCard({ run }: { run: RunRow }) {
	const state = run.previewState;
	const previewConfig = useQuery({
		queryKey: ["preview", "config"],
		queryFn: ({ signal }) => previewApi.config(signal),
		// Deployment-wide config; only a warren restart changes it.
		staleTime: Number.POSITIVE_INFINITY,
		gcTime: Number.POSITIVE_INFINITY,
	});
	if (state === null) return null;
	const isActive = PREVIEW_ACTIVE_STATES.includes(state);
	const loginUrl = state === "live" ? buildPreviewLoginUrl(run.id) : null;
	const canonicalUrl =
		state === "live" && previewConfig.data !== undefined
			? formatPreviewUrl(run.id, previewConfig.data, window.location.origin)
			: null;
	const mode = previewConfig.data?.mode;

	return (
		<Card>
			<CardHeader className="flex-row items-center justify-between space-y-0">
				<CardTitle className="flex items-center gap-2">
					Preview
					<PreviewStateBadge state={state} />
					{mode !== undefined ? (
						<Badge
							variant="secondary"
							className="font-mono text-xs"
							title={
								mode === "path"
									? "Path-mode previews ride on the warren host under /p/<run-id>/"
									: "Subdomain-mode previews ride on run-<id>.<host>"
							}
						>
							{mode}
						</Badge>
					) : null}
				</CardTitle>
				{loginUrl !== null ? (
					<a
						href={loginUrl}
						target="_blank"
						rel="noreferrer noopener"
						className="inline-flex items-center gap-1 font-mono text-xs underline underline-offset-2 hover:text-(--color-primary)"
						title="Open the live preview"
					>
						Open <ExternalLink className="h-3.5 w-3.5" />
					</a>
				) : null}
			</CardHeader>
			<CardContent className="space-y-3">
				{canonicalUrl !== null ? (
					<PreviewMetaLine label="URL" value={canonicalUrl} mono />
				) : null}
				<div className="grid gap-x-6 gap-y-1 text-xs sm:grid-cols-2">
					{run.previewPort !== null ? (
						<PreviewMetaLine label="Port" value={String(run.previewPort)} />
					) : null}
					{run.previewStartedAt !== null ? (
						<PreviewMetaLine label="Started" value={formatTimestamp(run.previewStartedAt)} />
					) : null}
					{run.previewLastHitAt !== null ? (
						<PreviewMetaLine label="Last hit" value={relativeTime(run.previewLastHitAt)} />
					) : null}
				</div>
				{state === "failed" && run.previewFailureMessage !== null ? (
					<pre
						className="max-h-40 overflow-auto whitespace-pre-wrap break-words rounded-md bg-(--color-muted) p-2 font-mono text-xs text-(--color-destructive)"
						title="Sidecar stderr / readiness-probe failure tail"
					>
						{run.previewFailureMessage}
					</pre>
				) : null}
				{isActive ? <PreviewTeardownButton runId={run.id} mode={mode} /> : null}
			</CardContent>
		</Card>
	);
}

function PreviewMetaLine({
	label,
	value,
	mono,
}: {
	label: string;
	value: string;
	mono?: boolean;
}) {
	return (
		<div className="flex items-baseline gap-2">
			<span className="uppercase tracking-wide text-(--color-muted-foreground)">{label}</span>
			<span className={mono === true ? "font-mono break-all" : "font-mono"}>{value}</span>
		</div>
	);
}

function PreviewStateBadge({ state }: { state: PreviewState }) {
	// warren-3849: delegate to the unified StatusIndicator registry so
	// preview state colour/icon/pulse stays in lockstep with Plot/Run.
	return <StatusIndicator kind="preview" status={state} />;
}

function PreviewTeardownButton({
	runId,
	mode,
}: {
	runId: string;
	mode: "path" | "subdomain" | undefined;
}) {
	const qc = useQueryClient();
	const teardown = useMutation({
		mutationFn: () => runsApi.previewTeardown(runId, { actor: "ui" }),
		onSettled: () => qc.invalidateQueries({ queryKey: ["runs", runId] }),
	});
	// Mode-aware tooltip (warren-016d): path-mode previews share the warren
	// host so the `warren_preview` cookie is scoped to `/p/<id>/` and stays
	// in the browser after teardown until the path is reused; subdomain-mode
	// previews retire the dedicated `run-<id>.<host>` origin entirely. Both
	// land on the same idempotent endpoint — the copy just sets expectations.
	const base = "Stop the preview sidecar and release the port";
	const title =
		mode === "path"
			? `${base}. /p/<run-id>/ returns 404 after teardown.`
			: mode === "subdomain"
				? `${base}; the subdomain returns 404.`
				: `${base}.`;
	return (
		<div className="flex flex-col items-start gap-1">
			<Button
				variant="destructive"
				size="sm"
				onClick={() => teardown.mutate()}
				disabled={teardown.isPending}
				title={title}
			>
				<Trash2 className="h-4 w-4" />
				{teardown.isPending ? "Tearing down…" : "Tear down"}
			</Button>
			<PreviewTeardownStatusLine mutation={teardown} />
		</div>
	);
}

function PreviewTeardownStatusLine({
	mutation,
}: {
	mutation: ReturnType<typeof useMutation<PreviewTeardownResponse, Error, void>>;
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
		const tone = d.tornDown
			? "text-emerald-700 dark:text-emerald-300"
			: "text-(--color-muted-foreground)";
		return <p className={`text-xs ${tone}`}>{d.status}</p>;
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

function EventTail({
	events,
	status,
	error,
	terminal,
}: {
	events: RunEvent[];
	status: string;
	error: string | null;
	terminal: boolean;
}) {
	const ref = useRef<HTMLDivElement>(null);
	const [autoScroll, setAutoScroll] = useState(true);

	const sorted = useMemo(() => {
		const copy = [...events];
		copy.sort((a, b) => a.seq - b.seq);
		return copy;
	}, [events]);

	useEffect(() => {
		if (autoScroll && ref.current) {
			ref.current.scrollTop = ref.current.scrollHeight;
		}
	}, [autoScroll]);

	useEffect(() => {
		if (!autoScroll || !ref.current) return;
		ref.current.scrollTop = ref.current.scrollHeight;
	}, [sorted.length, autoScroll]);

	// Disable autoscroll on user intent (wheel up, touch drag), not on scroll position:
	// programmatic scrolls also fire `scroll`, and during event bursts the handler
	// runs after additional content has appended, reading a stale (non-bottom) position
	// and falsely turning autoscroll off. `scroll` here only re-enables, never disables.
	const onWheel = (e: React.WheelEvent<HTMLDivElement>): void => {
		if (e.deltaY < 0) setAutoScroll(false);
	};
	const onTouchMove = (): void => {
		setAutoScroll(false);
	};
	const onScroll = (e: React.UIEvent<HTMLDivElement>): void => {
		const el = e.currentTarget;
		if (el.scrollHeight - el.clientHeight - el.scrollTop < 32) {
			setAutoScroll(true);
		}
	};

	return (
		<Card>
			<CardHeader className="flex-row items-center justify-between space-y-0">
				<CardTitle>Events ({sorted.length})</CardTitle>
				<div className="flex items-center gap-2">
					{terminal ? (
						<StatusIndicator kind="run" status="cancelled" label="terminal" />
					) : (
						<StatusIndicator kind="eventStream" status={status} />
					)}
					<label className="flex items-center gap-1 text-xs text-(--color-muted-foreground)">
						<input
							type="checkbox"
							checked={autoScroll}
							onChange={(e) => setAutoScroll(e.target.checked)}
						/>
						auto-scroll
					</label>
				</div>
			</CardHeader>
			<CardContent>
				{error !== null ? (
					<p className="mb-2 text-xs text-(--color-destructive)">{error}</p>
				) : null}
				<div
					ref={ref}
					onScroll={onScroll}
					onWheel={onWheel}
					onTouchMove={onTouchMove}
					className="h-[480px] overflow-auto rounded-md border bg-(--color-muted)/30 p-2 font-mono text-xs"
				>
					{sorted.length === 0 ? (
						<p className="p-4 text-(--color-muted-foreground)">No events yet.</p>
					) : (
						<AnimatePresence initial={false}>
							{sorted.map((e) => <EventLine key={e.id} event={e} />)}
						</AnimatePresence>
					)}
				</div>
			</CardContent>
		</Card>
	);
}

/**
 * Pull the latest `reap.completed` payload off the stream so the header
 * can show whether the push actually shipped commits (warren-f3bb). The
 * run row itself doesn't carry `commitsAhead` — it lives only in the
 * event payload — so without this read the empty-push shape (push exit-0
 * against unchanged HEAD) would be visually identical to a successful
 * real-work run.
 */
function extractReapSummary(events: RunEvent[]): ReapCompletedPayload | null {
	for (let i = events.length - 1; i >= 0; i--) {
		const ev = events[i];
		if (ev?.kind !== "reap.completed") continue;
		if (ev.payload === null || typeof ev.payload !== "object" || Array.isArray(ev.payload)) {
			return null;
		}
		return ev.payload as ReapCompletedPayload;
	}
	return null;
}

/**
 * warren-6376: true when the bridge's most recent degraded-state signal
 * is a `bridge_stalled` (N failed burrow reconnects) not yet cleared by a
 * later `bridge_recovered`. Drives the "infrastructure unreachable" banner.
 */
function isBridgeStalled(events: RunEvent[]): boolean {
	for (let i = events.length - 1; i >= 0; i--) {
		const k = events[i]?.kind;
		if (k === "bridge_stalled") return true;
		if (k === "bridge_recovered") return false;
	}
	return false;
}

/**
 * Format `costUsd` for the header badge (warren-a7dc). Sub-dollar costs
 * show three significant decimals so a $0.005 cache-only turn doesn't
 * round to "$0.00"; anything ≥ $1 shows two decimals like a normal
 * currency display.
 */
export function formatCostUsd(cost: number): string {
	if (cost >= 1) return `$${cost.toFixed(2)}`;
	if (cost === 0) return "$0.00";
	const minor = cost.toFixed(3);
	return `$${minor}`;
}

function formatTokens(n: number): string {
	if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
	if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
	return String(n);
}

function formatTokenBreakdown(r: RunRow): string | null {
	const parts: string[] = [];
	if (r.tokensInput !== null) parts.push(`${formatTokens(r.tokensInput)} in`);
	if (r.tokensOutput !== null) parts.push(`${formatTokens(r.tokensOutput)} out`);
	if (r.tokensCacheRead !== null && r.tokensCacheRead > 0) {
		parts.push(`${formatTokens(r.tokensCacheRead)} cache-r`);
	}
	if (r.tokensCacheWrite !== null && r.tokensCacheWrite > 0) {
		parts.push(`${formatTokens(r.tokensCacheWrite)} cache-w`);
	}
	return parts.length === 0 ? null : parts.join(" · ");
}

/**
 * Pi-runtime event kinds whose payload carries meaningful auxiliary
 * detail (warren-70af). Burrow's pi parser (`src/runtime/parsers/pi.ts`)
 * collapses these into `state_change` / `telemetry` on the `system`
 * stream and preserves the pi envelope `type` inside `payload.type`, so
 * we detect them by peeking at the payload. If a future burrow release
 * promotes any of them to first-class `event.kind` values, the same
 * label is used (kind-direct match takes precedence).
 *
 * Unknown kinds fall through to the generic renderer (mx-0db923).
 */
const PI_SUBKIND_LABELS: Readonly<Record<string, string>> = {
	compaction_start: "compaction ▶",
	compaction_end: "compaction ✓",
	auto_retry_start: "auto-retry ▶",
	auto_retry_end: "auto-retry ✓",
	extension_error: "extension error",
	queue_update: "queue update",
};

function piSubKind(event: RunEvent): string | null {
	if (event.kind in PI_SUBKIND_LABELS) return event.kind;
	if (event.kind !== "state_change" && event.kind !== "telemetry") return null;
	const p = event.payload;
	if (p === null || typeof p !== "object" || Array.isArray(p)) return null;
	const t = (p as { type?: unknown }).type;
	if (typeof t !== "string") return null;
	return t in PI_SUBKIND_LABELS ? t : null;
}

function EventLine({ event }: { event: RunEvent }) {
	return (
		<StreamItem>
			<EventLineInner event={event} />
		</StreamItem>
	);
}

function EventLineInner({ event }: { event: RunEvent }) {
	const sub = piSubKind(event);
	const isError = event.stream === "stderr" || sub === "extension_error";
	const colour = isError
		? "text-rose-700 dark:text-rose-300"
		: event.stream === "system"
			? "text-emerald-700 dark:text-emerald-300"
			: "text-(--color-fg)";
	const displayKind = sub !== null ? (PI_SUBKIND_LABELS[sub] ?? event.kind) : event.kind;
	const summary = summarizeEvent(event);
	const expanded =
		typeof event.payload === "string"
			? event.payload
			: JSON.stringify(event.payload, null, 2);
	return (
		<details className={`group ${colour}`}>
			<summary className="flex cursor-pointer items-baseline gap-2 select-none [&::-webkit-details-marker]:hidden">
				<span className="shrink-0 text-(--color-muted-foreground)">
					[{event.seq}] {formatWallClock(event.ts)}
				</span>
				<span className="shrink-0 font-medium">{displayKind}</span>
				{event.stream ? (
					<span className="shrink-0 text-(--color-muted-foreground)">{event.stream}</span>
				) : null}
				<span className="min-w-0 flex-1 truncate text-(--color-muted-foreground) group-open:hidden">
					{summary}
				</span>
			</summary>
			<pre className="mt-1 mb-2 ml-4 max-h-[420px] overflow-auto whitespace-pre-wrap break-words rounded bg-(--color-card) p-2 text-(--color-fg)">
				{expanded}
			</pre>
		</details>
	);
}

/**
 * Extract HH:MM:SS wall-clock from an ISO timestamp for compact display
 * in the events pane (warren-3ad4). Falls back to the raw string when
 * the timestamp doesn't match — events with a non-ISO `ts` are rare but
 * possible (forward-compat with future burrow shapes).
 */
function formatWallClock(ts: string): string {
	const m = /T(\d{2}:\d{2}:\d{2})/.exec(ts);
	return m?.[1] ?? ts;
}

function truncateSummary(s: string, max = 140): string {
	if (s.length <= max) return s;
	return `${s.slice(0, max - 1)}…`;
}

function readString(v: unknown): string | null {
	return typeof v === "string" ? v : null;
}

function readNumber(v: unknown): number | null {
	return typeof v === "number" ? v : null;
}

function readCostTotal(v: unknown): number | null {
	if (typeof v === "number") return v;
	if (v === null || typeof v !== "object" || Array.isArray(v)) return null;
	const total = (v as { total?: unknown }).total;
	return typeof total === "number" ? total : null;
}

function findToolUseName(content: unknown): string | null {
	if (!Array.isArray(content)) return null;
	for (const part of content) {
		if (part === null || typeof part !== "object" || Array.isArray(part)) continue;
		const obj = part as Record<string, unknown>;
		if (obj.type === "tool_use" && typeof obj.name === "string") return obj.name;
	}
	return null;
}

function findFirstText(content: unknown): string | null {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return null;
	for (const part of content) {
		if (typeof part === "string") return part;
		if (part === null || typeof part !== "object" || Array.isArray(part)) continue;
		const obj = part as Record<string, unknown>;
		if (typeof obj.text === "string") return obj.text;
	}
	return null;
}

function summarizeMessage(message: Record<string, unknown>): string[] {
	const parts: string[] = [];
	const tool = findToolUseName(message.content);
	if (tool !== null) {
		parts.push(`message (toolCall: ${tool})`);
	} else {
		const text = findFirstText(message.content);
		if (text !== null) parts.push(`message: ${truncateSummary(text.trim(), 80)}`);
		else if (typeof message.role === "string") parts.push(`message (${message.role})`);
		else parts.push("message");
	}
	const usage = message.usage;
	if (usage !== null && typeof usage === "object" && !Array.isArray(usage)) {
		const u = usage as Record<string, unknown>;
		const inT = readNumber(u.input);
		const outT = readNumber(u.output);
		if (inT !== null || outT !== null) {
			const a = inT !== null ? formatTokens(inT) : "?";
			const b = outT !== null ? formatTokens(outT) : "?";
			parts.push(`usage ${a}/${b}`);
		}
		const cost = readCostTotal(u.cost);
		if (cost !== null) parts.push(formatCostUsd(cost));
	}
	return parts;
}

function summarizeStateChange(payload: Record<string, unknown>): string {
	const t = readString(payload.type);
	if (t === null) return truncateSummary(JSON.stringify(payload));
	const parts: string[] = [t];
	const msg = payload.message;
	if (msg !== null && typeof msg === "object" && !Array.isArray(msg)) {
		parts.push(...summarizeMessage(msg as Record<string, unknown>));
	}
	if (t === "result") {
		if (payload.is_error === true) parts.push("error");
		const subtype = readString(payload.subtype);
		if (subtype !== null) parts.push(subtype);
		const cost = readNumber(payload.total_cost_usd);
		if (cost !== null) parts.push(formatCostUsd(cost));
	}
	return parts.join(" · ");
}

function summarizeTool(payload: Record<string, unknown>): string {
	const name =
		readString(payload.name) ??
		readString(payload.tool) ??
		readString(payload.tool_name);
	const exit = readNumber(payload.exit_code) ?? readNumber(payload.exitCode);
	const parts: string[] = [];
	if (name !== null) parts.push(name);
	if (exit !== null) parts.push(`exit ${exit}`);
	if (parts.length === 0) return truncateSummary(JSON.stringify(payload));
	return parts.join(" · ");
}

function summarizeReap(kind: string, payload: Record<string, unknown>): string {
	if (kind === "reap.completed") {
		const parts: string[] = [];
		const state = readString(payload.state);
		if (state !== null) parts.push(state);
		if (payload.branchPushed === true) {
			const ahead = readNumber(payload.commitsAhead);
			parts.push(ahead === null ? "pushed" : `pushed (+${ahead})`);
		} else if (payload.branchPushed === false) {
			parts.push("no push");
		}
		if (typeof payload.prUrl === "string") parts.push("PR opened");
		const errs = payload.errors;
		if (Array.isArray(errs) && errs.length > 0) parts.push(`${errs.length} error(s)`);
		return parts.join(" · ") || "reap completed";
	}
	if (kind === "reap.pr_opened") {
		const url = readString(payload.prUrl);
		const mode = readString(payload.mode);
		return [mode, url].filter((v): v is string => v !== null).join(" · ") || "pr opened";
	}
	if (kind === "reap.empty_push") {
		return readString(payload.message) ?? "empty push";
	}
	if (kind === "reap.orphaned") {
		return readString(payload.message) ?? "orphaned";
	}
	if (kind === "reap_failed") {
		const step = readString(payload.step) ?? "?";
		const message = readString(payload.message);
		return message !== null ? `${step}: ${truncateSummary(message, 100)}` : `failed in ${step}`;
	}
	return truncateSummary(JSON.stringify(payload));
}

/**
 * Derive a one-line summary from a RunEvent payload for the events pane
 * (warren-3ad4). Defensive against unknown shapes — anything we can't
 * recognise falls through to a truncated JSON dump. The full payload is
 * still available via the expand toggle, so the summary is allowed to
 * elide detail.
 */
function summarizeEvent(event: RunEvent): string {
	const p = event.payload;
	if (typeof p === "string") return truncateSummary(p);
	if (p === null) return "";
	if (typeof p !== "object" || Array.isArray(p)) return truncateSummary(JSON.stringify(p));
	const obj = p as Record<string, unknown>;

	if (event.kind === "state_change") return summarizeStateChange(obj);
	if (event.kind === "cancel.requested") {
		return readString(obj.reason) ?? "cancel requested";
	}
	if (event.kind === "agent_start") return "agent_start";
	if (event.kind === "agent_end") return readString(obj.reason) ?? "agent_end";
	if (event.kind === "text" || event.kind === "message_update") {
		const t = readString(obj.text) ?? readString(obj.delta);
		if (t !== null) return truncateSummary(t);
	}
	if (event.kind.startsWith("reap")) return summarizeReap(event.kind, obj);
	if (
		event.kind.startsWith("toolcall_") ||
		event.kind.startsWith("tool_execution_") ||
		event.kind.startsWith("tool_")
	) {
		return summarizeTool(obj);
	}

	const fallback =
		readString(obj.text) ??
		readString(obj.message) ??
		readString(obj.reason) ??
		readString(obj.type);
	if (fallback !== null) return truncateSummary(fallback);
	return truncateSummary(JSON.stringify(obj));
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
							{steer.error instanceof Error
								? steer.error.message
								: String(steer.error)}
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
