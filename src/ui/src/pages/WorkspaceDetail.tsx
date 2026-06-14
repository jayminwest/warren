import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";
import { conversationsApi, plotsApi, runsApi } from "@/api/client.ts";
import { RUN_TERMINAL_STATES } from "@/api/types.ts";
import type { ConversationRow, PlotEnvelope } from "@/api/types.ts";
import { RefreshProjectsCTA } from "@/components/RefreshProjectsCTA.tsx";
import { StatusIndicator } from "@/components/StatusIndicator.tsx";
import { Card, CardContent } from "@/components/ui/card.tsx";
import { ConversationSplitView } from "@/pages/conversation-detail/conversation-surface.tsx";
import { DispatchPlanButton } from "@/pages/conversation-detail/dispatch-plan-dialog.tsx";
import { RewakeButton } from "@/pages/conversation-detail/rewake-button.tsx";
import {
	PlotNameEditor,
	PlotSyncButton,
	StatusTransitionControl,
} from "@/pages/plot-detail/header-controls.tsx";
import { NewConversationButton } from "@/pages/leveret/new-conversation-dialog.tsx";
import { ActivityTab } from "@/pages/workspace-detail/activity-tab.tsx";
import { RunTab } from "@/pages/workspace-detail/run-tab.tsx";
import { formatError } from "@/lib/format-error.ts";

/**
 * /workspace/:id — the tabbed Workspace detail shell (warren-6e7d / pl-0008
 * step 6).
 *
 * The Plot is the durable spine; this page is keyed by `plotId` and frames a
 * persistent header (name editor, status transition, GitHub sync, project +
 * summary links) above four tabs — Shape / Plan / Run / Activity — whose
 * panels are filled in by pl-0008 steps 7-10. Tab state lives in a `?tab=`
 * query param so deep links survive a refresh.
 *
 * Loading, error, and 404 branches reuse the existing PlotDetail behaviour:
 * a missing Plot usually means the project hasn't been refreshed since the
 * Plot was committed (mx-62ef33), so we surface the refresh-projects CTA.
 */

const TABS = [
	{ value: "shape", label: "Shape" },
	{ value: "plan", label: "Plan" },
	{ value: "run", label: "Run" },
	{ value: "activity", label: "Activity" },
] as const;

type TabValue = (typeof TABS)[number]["value"];

const DEFAULT_TAB: TabValue = "shape";

function isTabValue(value: string | null): value is TabValue {
	return TABS.some((t) => t.value === value);
}

export function WorkspaceDetailPage() {
	const { id } = useParams<{ id: string }>();
	const plotId = id ?? "";
	const [searchParams, setSearchParams] = useSearchParams();
	const rawTab = searchParams.get("tab");
	const activeTab: TabValue = isTabValue(rawTab) ? rawTab : DEFAULT_TAB;

	const selectTab = (tab: TabValue): void => {
		const next = new URLSearchParams(searchParams);
		next.set("tab", tab);
		setSearchParams(next, { replace: true });
	};

	const query = useQuery({
		queryKey: ["plot", plotId],
		queryFn: ({ signal }) => plotsApi.get(plotId, signal),
		enabled: plotId.length > 0,
		refetchInterval: 5_000,
		staleTime: 5_000,
	});

	if (plotId.length === 0) {
		return <p className="text-sm text-(--color-destructive)">Missing plot id in URL.</p>;
	}
	if (query.isLoading) {
		return <p className="text-sm text-(--color-muted-foreground)">Loading…</p>;
	}
	if (query.isError || query.data === undefined) {
		const message =
			query.error instanceof Error ? query.error.message : "Failed to load plot.";
		// warren-bb22: a 404 here usually means the Plot was committed in a
		// project clone but the project hasn't been refreshed since
		// (detectProjectFeatures only flips hasPlot during refresh — mx-62ef33).
		// Surface a refresh-all CTA so the user can recover inline.
		return (
			<Card>
				<CardContent className="space-y-3 p-4 text-sm">
					<p className="text-(--color-destructive)">{message}</p>
					<p className="text-(--color-muted-foreground)">
						If you just committed this Plot in a project clone, refresh
						projects so warren rediscovers it.
					</p>
					<RefreshProjectsCTA />
				</CardContent>
			</Card>
		);
	}

	const plot = query.data;

	return (
		<div className="space-y-6">
			<header className="flex flex-wrap items-start justify-between gap-4">
				<div className="space-y-1">
					<PlotNameEditor plot={plot} />
					<div className="font-mono text-xs text-(--color-muted-foreground)">
						{plot.id} · project{" "}
						<Link
							to={`/projects/${encodeURIComponent(plot.project_id)}`}
							className="underline-offset-2 hover:underline"
						>
							{plot.project_id}
						</Link>
						{" · "}
						<Link
							to={`/plots/${encodeURIComponent(plot.id)}/summary`}
							className="underline-offset-2 hover:underline"
						>
							view summary
						</Link>
					</div>
				</div>
				<div className="flex flex-col items-end gap-3">
					<StatusTransitionControl plot={plot} />
					<PlotSyncButton plotId={plot.id} />
				</div>
			</header>

			<nav
				aria-label="Workspace tabs"
				className="flex flex-wrap items-center gap-1 border-b"
			>
				{TABS.map((t) => (
					<button
						key={t.value}
						type="button"
						role="tab"
						aria-selected={activeTab === t.value}
						onClick={() => selectTab(t.value)}
						className={`-mb-px border-b-2 px-4 py-2 text-sm transition-colors ${
							activeTab === t.value
								? "border-(--color-primary) font-medium text-(--color-foreground)"
								: "border-transparent text-(--color-muted-foreground) hover:text-(--color-foreground)"
						}`}
					>
						{t.label}
					</button>
				))}
			</nav>

			<section role="tabpanel">
				{activeTab === "shape" && <ShapeTab plot={plot} />}
				{activeTab === "plan" && <PlanTab plot={plot} />}
				{activeTab === "run" && <RunTab plot={plot} />}
				{activeTab === "activity" && <ActivityTab plot={plot} />}
			</section>
		</div>
	);
}

/**
 * Shape tab (pl-0008 step 7 / warren-3de4) — the live conversation surface
 * for the Plot. Resolves the Plot's conversation via
 * `conversationsApi.list({plot})`: an `active` conversation wins, otherwise the
 * most-recent (e.g. a closed, post-send-off) conversation renders read-only so
 * the tab stays quiet. When the Plot has no conversation at all, a
 * Start-conversation affordance is shown instead.
 */
function ShapeTab({ plot }: { plot: PlotEnvelope }) {
	const conversations = useQuery({
		queryKey: ["conversations", { plot: plot.id }],
		queryFn: ({ signal }) => conversationsApi.list({ plot: plot.id }, signal),
		refetchInterval: 5000,
	});

	if (conversations.isLoading) {
		return <p className="text-sm text-(--color-muted-foreground)">Loading conversation…</p>;
	}
	if (conversations.isError) {
		return (
			<p className="text-sm text-(--color-destructive)">
				{formatError(conversations.error)}
			</p>
		);
	}

	const rows = conversations.data?.conversations ?? [];
	// `?plot` lists most-recent-activity first; prefer the live one, else fall
	// back to the latest (post-send-off it's closed → the surface renders quiet).
	const conversation = rows.find((c) => c.status === "active") ?? rows[0];

	if (conversation === undefined) {
		return (
			<Card>
				<CardContent className="flex flex-col items-start gap-3 p-6 text-sm">
					<p className="text-(--color-muted-foreground)">
						No conversation yet — start one to shape this Plot's intent with the
						leveret.
					</p>
					<NewConversationButton />
				</CardContent>
			</Card>
		);
	}

	return <ShapeConversation conversation={conversation} />;
}

function ShapeConversation({ conversation }: { conversation: ConversationRow }) {
	const anchoringRunId = conversation.anchoringRunId;
	const anchoringRun = useQuery({
		queryKey: ["run", anchoringRunId],
		queryFn: ({ signal }) => runsApi.get(anchoringRunId ?? "", signal),
		enabled: anchoringRunId !== null && anchoringRunId !== "",
		refetchInterval: (query) => {
			const data = query.state.data;
			if (!data) return 5000;
			return RUN_TERMINAL_STATES.includes(data.state) ? false : 3000;
		},
	});

	const isAnchoringRunTerminal =
		anchoringRun.data !== undefined && RUN_TERMINAL_STATES.includes(anchoringRun.data.state);

	return (
		<div className="space-y-4">
			<div className="flex flex-wrap items-center justify-end gap-2">
				<RewakeButton
					conversation={conversation}
					isAnchoringRunTerminal={isAnchoringRunTerminal}
				/>
				{conversation.plannerRunId != null &&
				conversation.plannerRunId !== "" &&
				conversation.projectId !== null ? (
					<DispatchPlanButton
						projectId={conversation.projectId}
						plotId={conversation.plotId}
						plannerRunId={conversation.plannerRunId}
					/>
				) : null}
			</div>
			<ConversationSplitView conversationId={conversation.id} />
		</div>
	);
}

/**
 * Plan tab (pl-0008 step 8 / warren-e33f) — minimal planner hand-off surface.
 *
 * Once the merge-poller stamps `conversation.plannerRunId`, the planner has
 * been dispatched and a synthesized seeds plan exists (or is in flight). This
 * tab does NOT render the plan inline — it shows the planner run's live status
 * and links out to the planner run detail (where the generated plan id is
 * surfaced), then an operator Sign-off gate that enables the existing
 * `DispatchPlanButton`. Dispatch itself flows over the unchanged `/plan-runs`
 * path (`dispatch-plan-dialog.tsx`).
 *
 * Before send-off / planner dispatch there is nothing to plan against, so the
 * tab stays quiet with a pointer back to Shape.
 */
function PlanTab({ plot }: { plot: PlotEnvelope }) {
	const conversations = useQuery({
		queryKey: ["conversations", { plot: plot.id }],
		queryFn: ({ signal }) => conversationsApi.list({ plot: plot.id }, signal),
		refetchInterval: 5000,
	});

	if (conversations.isLoading) {
		return <p className="text-sm text-(--color-muted-foreground)">Loading planner…</p>;
	}
	if (conversations.isError) {
		return (
			<p className="text-sm text-(--color-destructive)">
				{formatError(conversations.error)}
			</p>
		);
	}

	const rows = conversations.data?.conversations ?? [];
	// Prefer the conversation that's already been sent to the planner; else the
	// most-recent (post-send-off it's closed but still carries plannerRunId).
	const conversation =
		rows.find((c) => c.plannerRunId != null && c.plannerRunId !== "") ?? rows[0];

	const plannerRunId =
		conversation?.plannerRunId != null && conversation.plannerRunId !== ""
			? conversation.plannerRunId
			: null;

	if (conversation === undefined || plannerRunId === null) {
		return (
			<Card>
				<CardContent className="p-6 text-sm text-(--color-muted-foreground)">
					No plan yet. Shape this Plot's intent and send it to the planner from the{" "}
					<strong className="font-medium text-(--color-foreground)">Shape</strong> tab;
					once the send-off PR merges, the planner runs and its plan shows up here.
				</CardContent>
			</Card>
		);
	}

	return (
		<PlanHandoff
			projectId={conversation.projectId}
			plotId={conversation.plotId}
			plannerRunId={plannerRunId}
		/>
	);
}

function PlanHandoff({
	projectId,
	plotId,
	plannerRunId,
}: {
	projectId: string | null;
	plotId: string | null;
	plannerRunId: string;
}) {
	const [signedOff, setSignedOff] = useState(false);
	const run = useQuery({
		queryKey: ["run", plannerRunId],
		queryFn: ({ signal }) => runsApi.get(plannerRunId, signal),
		refetchInterval: (query) => {
			const data = query.state.data;
			if (!data) return 5000;
			return RUN_TERMINAL_STATES.includes(data.state) ? false : 3000;
		},
	});

	const runState = run.data?.state ?? null;
	const isTerminal = runState !== null && RUN_TERMINAL_STATES.includes(runState);
	const succeeded = runState === "succeeded";

	return (
		<Card>
			<CardContent className="space-y-5 p-6 text-sm">
				<div className="flex flex-wrap items-center justify-between gap-3">
					<div className="space-y-1">
						<p className="font-medium text-(--color-foreground)">Planner run</p>
						<Link
							to={`/runs/${encodeURIComponent(plannerRunId)}`}
							className="font-mono text-xs underline-offset-2 hover:underline"
						>
							{plannerRunId} ↗
						</Link>
					</div>
					{runState !== null ? (
						<StatusIndicator kind="run" status={runState} />
					) : (
						<span className="text-xs text-(--color-muted-foreground)">loading…</span>
					)}
				</div>

				<p className="text-(--color-muted-foreground)">
					The planner emitted a seeds plan from this Plot's intent and stopped — open the{" "}
					<Link
						to={`/runs/${encodeURIComponent(plannerRunId)}`}
						className="underline-offset-2 hover:underline"
					>
						planner run
					</Link>{" "}
					to read the generated plan and copy its plan id.
				</p>

				{!isTerminal ? (
					<p className="text-xs text-(--color-muted-foreground)">
						The planner is still running — wait for it to finish before dispatching.
					</p>
				) : null}

				{isTerminal && !succeeded ? (
					<p className="text-xs text-(--color-destructive)">
						The planner run ended <code className="font-mono">{runState}</code> without a
						usable plan. Re-wake the conversation from Shape and try again.
					</p>
				) : null}

				{succeeded ? (
					<div className="space-y-3 border-t pt-4">
						<label className="flex items-start gap-2 text-(--color-foreground)">
							<input
								type="checkbox"
								checked={signedOff}
								onChange={(e) => setSignedOff(e.target.checked)}
								className="mt-0.5 h-4 w-4"
							/>
							<span>
								I've reviewed the generated plan and sign off on dispatching it.
								Dispatch stays operator-gated.
							</span>
						</label>
						<div>
							{signedOff && projectId !== null ? (
								<DispatchPlanButton
									projectId={projectId}
									plotId={plotId}
									plannerRunId={plannerRunId}
								/>
							) : (
								<p className="text-xs text-(--color-muted-foreground)">
									{projectId === null
										? "This conversation has no bound project — dispatch is unavailable."
										: "Sign off above to enable dispatch."}
								</p>
							)}
						</div>
					</div>
				) : null}
			</CardContent>
		</Card>
	);
}


