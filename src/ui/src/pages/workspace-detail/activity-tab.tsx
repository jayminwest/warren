import { Link } from "react-router-dom";
import type { PlotEnvelope } from "@/api/types.ts";
import { Card, CardContent } from "@/components/ui/card.tsx";
import { ActivityFeed } from "@/pages/plot-detail/activity-feed.tsx";
import { SubstratePanel } from "@/pages/plot-detail/substrate-panel.tsx";

/**
 * Activity tab (pl-0008 step 10 / warren-ef97) — the lifecycle-at-a-glance
 * surface for a Plot.
 *
 * Collapses three previously-scattered views into one place so the full Plot
 * lifecycle is visible without bouncing between pages:
 *   - the event_log ActivityFeed (the durable timeline, with the inline
 *     answer/resume affordances) — ported verbatim from PlotDetail,
 *   - the SubstratePanel (attachments grouped by role + Add/Detach), and
 *   - a link to the read-only Plot summary.
 *
 * The Plot envelope already carries `event_log` + `paused_runs` (loaded by the
 * shell's `plotsApi.get`), so the feed/substrate render from props.
 */
export function ActivityTab({ plot }: { plot: PlotEnvelope }) {
	return (
		<div className="space-y-6">
			<Card>
				<CardContent className="flex flex-wrap items-center justify-between gap-3 p-4 text-sm">
					<span className="text-(--color-muted-foreground)">
						The read-only Plot summary collects intent, decisions, and artifacts in
						one printable view.
					</span>
					<Link
						to={`/plots/${encodeURIComponent(plot.id)}/summary`}
						className="font-medium underline-offset-2 hover:underline"
					>
						View summary ↗
					</Link>
				</CardContent>
			</Card>

			<SubstratePanel plot={plot} />

			<ActivityFeed
				plotId={plot.id}
				events={plot.event_log}
				pausedRuns={plot.paused_runs}
			/>
		</div>
	);
}
