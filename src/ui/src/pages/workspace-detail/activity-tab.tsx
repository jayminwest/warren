import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { conversationsApi } from "@/api/client.ts";
import type { ConversationRow, PlotEnvelope } from "@/api/types.ts";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card.tsx";
import { formatError } from "@/lib/format-error.ts";
import { relativeTime } from "@/lib/utils.ts";
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
 *   - the SubstratePanel (attachments grouped by role + Add/Detach),
 *   - a link to the read-only Plot summary, and
 *   - past/closed conversations for this Plot as history entries.
 *
 * The Plot envelope already carries `event_log` + `paused_runs` (loaded by the
 * shell's `plotsApi.get`), so the feed/substrate render from props. Past
 * conversations are fetched separately via `conversationsApi.list({plot})`.
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

			<ConversationHistory plotId={plot.id} />

			<ActivityFeed
				plotId={plot.id}
				events={plot.event_log}
				pausedRuns={plot.paused_runs}
			/>
		</div>
	);
}

/**
 * Past/closed conversations for the Plot, surfaced as history entries so the
 * whole conversational lifecycle reads from one place. Active conversations
 * live in the Shape tab; here we show the closed ones (most-recent first) with
 * their send-off PR, when present.
 */
function ConversationHistory({ plotId }: { plotId: string }) {
	const conversations = useQuery({
		queryKey: ["conversations", { plot: plotId }],
		queryFn: ({ signal }) => conversationsApi.list({ plot: plotId }, signal),
		refetchInterval: 5000,
	});

	if (conversations.isLoading) {
		return (
			<Card>
				<CardHeader>
					<CardTitle>Conversation history</CardTitle>
				</CardHeader>
				<CardContent className="text-sm text-(--color-muted-foreground)">
					Loading conversations…
				</CardContent>
			</Card>
		);
	}
	if (conversations.isError) {
		return (
			<Card>
				<CardHeader>
					<CardTitle>Conversation history</CardTitle>
				</CardHeader>
				<CardContent className="text-sm text-(--color-destructive)">
					{formatError(conversations.error)}
				</CardContent>
			</Card>
		);
	}

	const past = (conversations.data?.conversations ?? [])
		.filter((c) => c.status === "closed")
		.sort((a, b) => b.lastActivityAt.localeCompare(a.lastActivityAt));

	return (
		<Card>
			<CardHeader>
				<CardTitle>Conversation history</CardTitle>
			</CardHeader>
			<CardContent>
				{past.length === 0 ? (
					<p className="text-sm text-(--color-muted-foreground)">
						No past conversations yet — closed conversations for this Plot show up
						here.
					</p>
				) : (
					<ul className="divide-y rounded-md border">
						{past.map((c) => (
							<ConversationHistoryRow key={c.id} conversation={c} />
						))}
					</ul>
				)}
			</CardContent>
		</Card>
	);
}

function ConversationHistoryRow({ conversation }: { conversation: ConversationRow }) {
	const { id, title, status, lastActivityAt, submittedPrUrl } = conversation;
	return (
		<li className="flex items-center justify-between gap-3 px-3 py-2 text-sm">
			<div className="min-w-0 space-y-0.5">
				<div className="flex items-baseline gap-2">
					<span className="shrink-0 rounded-full border px-2 py-0.5 text-xs text-(--color-muted-foreground)">
						{status}
					</span>
					<Link
						to={`/leveret/${encodeURIComponent(id)}`}
						className="truncate font-medium underline-offset-2 hover:underline"
					>
						{title !== null && title.length > 0 ? title : id}
					</Link>
				</div>
				<div className="font-mono text-xs text-(--color-muted-foreground)">
					{id} · {relativeTime(lastActivityAt)}
					{submittedPrUrl != null && submittedPrUrl.length > 0 ? (
						<>
							{" · "}
							<a
								href={submittedPrUrl}
								target="_blank"
								rel="noreferrer"
								className="underline-offset-2 hover:underline"
							>
								send-off PR ↗
							</a>
						</>
					) : null}
				</div>
			</div>
		</li>
	);
}
