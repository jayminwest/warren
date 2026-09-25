import { useQuery } from "@tanstack/react-query";
import { Activity } from "lucide-react";
import { Link } from "react-router-dom";
import { eventsApi } from "@/api/client.ts";
import { Button } from "@/components/ui/button.tsx";
import { Card, CardHeader } from "@/components/ui/card.tsx";
import { EmptyState } from "@/components/ui/empty-state.tsx";
import { SkeletonRows } from "@/components/ui/skeleton.tsx";
import { formatError } from "@/lib/format-error.ts";
import { cn } from "@/lib/utils.ts";
import {
	formatEventWhen,
	streamToneClass,
	summarizeEventPayload,
} from "../event-explorer-format.ts";

/**
 * Recent events (warren-4cf8, warren-9474): the newest run events from
 * the spectator-safe events read. One slow poll, not a held-open stream,
 * so it respects the one-connection-per-tab rule (warren-f566); the
 * Event explorer at /events carries the full feed and live follow.
 */

const TAIL_LIMIT = 12;
/** Events are not lifecycle-invalidated; a minute keeps the tail current. */
const POLL_MS = 60_000;

function EventsBody({ query }: { query: ReturnType<typeof useEventsTail> }) {
	if (query.isPending) return <SkeletonRows rows={5} />;
	if (query.isError) {
		return (
			<div className="flex flex-col items-start gap-2 px-4 py-4">
				<p className="text-sm text-(--color-danger)">
					Couldn't load recent events. {formatError(query.error)}
				</p>
				<Button variant="outline" size="sm" onClick={() => void query.refetch()}>
					Retry
				</Button>
			</div>
		);
	}
	const rows = query.data.events;
	if (rows.length === 0) {
		return (
			<EmptyState
				compact
				icon={Activity}
				title="No events yet"
				description="Runs write their progress here as they work."
			/>
		);
	}
	return (
		<ul className="divide-y divide-(--color-border)">
			{rows.map((event) => (
				<li key={event.id} className="flex min-h-9 items-baseline gap-3 px-4 py-2">
					<span className="w-24 shrink-0 text-xs text-(--color-text-3) tabular-nums">
						{formatEventWhen(event.ts)}
					</span>
					<span
						className={cn(
							"w-14 shrink-0 truncate font-mono text-xs",
							streamToneClass(event.stream),
						)}
					>
						{event.stream ?? "event"}
					</span>
					<span className="min-w-0 flex-1 truncate font-mono text-xs text-(--color-text-2)">
						{summarizeEventPayload(event.payload)}
					</span>
				</li>
			))}
		</ul>
	);
}

function useEventsTail() {
	return useQuery({
		queryKey: ["operations-events-tail"],
		queryFn: ({ signal }) => eventsApi.list({ limit: TAIL_LIMIT }, signal),
		refetchInterval: POLL_MS,
		refetchIntervalInBackground: false,
	});
}

export function EventsPanel() {
	const events = useEventsTail();
	return (
		<Card>
			<CardHeader
				title="Recent events"
				actions={
					<Button asChild variant="ghost" size="sm">
						<Link to="/events">Open explorer</Link>
					</Button>
				}
			/>
			<EventsBody query={events} />
		</Card>
	);
}
