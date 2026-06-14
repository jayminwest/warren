import { useQuery } from "@tanstack/react-query";
import { Link, useParams } from "react-router-dom";
import { plotsApi } from "@/api/client.ts";
import { RefreshProjectsCTA } from "@/components/RefreshProjectsCTA.tsx";
import { Card, CardContent } from "@/components/ui/card.tsx";
import { ActivityFeed } from "@/pages/plot-detail/activity-feed.tsx";
import {
	PlotNameEditor,
	PlotSyncButton,
	StatusTransitionControl,
} from "@/pages/plot-detail/header-controls.tsx";
import { IntentPanel } from "@/pages/plot-detail/intent-panel.tsx";
import { SubstratePanel } from "@/pages/plot-detail/substrate-panel.tsx";

/**
 * /plots/:id — three-panel Plot detail page (warren-bdbf, pl-9d6a step 13).
 *
 * Layout:
 *   - Header: name + status badge + project link.
 *   - IntentPanel  (left)   — editable goal/non_goals/constraints/success_criteria
 *                             via POST /plots/:id/intent; disabled when status
 *                             is done/archived (server also rejects with 409).
 *   - SubstratePanel (right)— attachments grouped by role + Add/Detach dialog.
 *   - ActivityFeed  (full)  — event_log timeline; collapses runs of 3+
 *                             same-kind same-actor events into a fold.
 *
 * Polling: tanstack-query with staleTime + refetchInterval at 5s
 * (mx-268674 pattern). No live event stream yet — that's deferred per
 * SPEC §11.O.Plot.UI (pl-2047 risk #6).
 *
 * Phase-7 decomposition (warren-2221 / pl-55a3 step 8): the 3000-line
 * monolith that used to live here has been split into the
 * `plot-detail/` sub-tree (header-controls, intent-panel,
 * substrate-panel, run-plan, batch-dispatch, activity-feed,
 * interactive-panel + shared helpers). This page now owns only the
 * query, the loading / error / 404 branches, and the layout shell.
 */
export function PlotDetailPage() {
	const { id } = useParams<{ id: string }>();
	const plotId = id ?? "";

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
		// warren-bb22: 404 here usually means the Plot was committed in a
		// project clone but the project hasn't been refreshed since
		// (detectProjectFeatures only flips hasPlot during refresh — see
		// mx-62ef33). Surface a refresh-all CTA so the user can recover
		// inline without bouncing to /projects.
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
	const frozen = plot.status === "done" || plot.status === "archived";

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

			<div className="grid gap-6 lg:grid-cols-2">
				<IntentPanel plot={plot} frozen={frozen} />
				<SubstratePanel plot={plot} />
			</div>

			<ActivityFeed
				plotId={plot.id}
				events={plot.event_log}
				pausedRuns={plot.paused_runs}
			/>
		</div>
	);
}
