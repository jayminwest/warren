import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { eventsApi } from "@/api/client.ts";
import { formatError } from "@/lib/format-error.ts";
import {
	formatEventClock,
	streamToneClass,
	summarizeEventPayload,
} from "../event-explorer-format.ts";

/**
 * Recent run events panel (warren-4cf8): a bounded recent
 * tail from `GET /events` (warren-5eec, spectator-safe readPublic
 * projection). One polled bounded read, not a held-open stream, so it
 * respects the one-connection-per-tab rule (warren-f566); the Event
 * explorer at /events (warren-24b9) carries the full feed.
 *
 * Mobile (warren-10d3, mobile/operations.jsx:338-401): the card sits on
 * --color-sidebar with an in-card header bar ("Recent run events" +
 * LIVE TAIL caption), and the footer link reads "Open event explorer →"
 * with the bounded seq range. The md+ shape is unchanged.
 */

const TAIL_LIMIT = 12;
const POLL_MS = 45_000;

export function EventsPanel() {
	const events = useQuery({
		queryKey: ["operations-events-tail"],
		queryFn: ({ signal }) => eventsApi.list({ limit: TAIL_LIMIT }, signal),
		refetchInterval: POLL_MS,
	});

	const rows = events.data?.events ?? [];
	const seqRange =
		rows.length === 0
			? null
			: `SEQ ${String(rows[0]?.seq ?? "—")}–${String(rows[rows.length - 1]?.seq ?? "—")}`;

	return (
		<div className="flex min-w-0 flex-col md:min-w-[320px] md:flex-1">
			<header className="hidden h-7 shrink-0 items-center pb-1.25 md:flex">
				<h2 className="text-[11px] leading-3.5 font-semibold text-(--color-text-2)">
					Recent run events
				</h2>
				<span className="flex-1" />
				<span className="font-mono text-[9px] leading-3 text-(--color-text-3)">RECENT EVENTS</span>
			</header>
			<div className="flex flex-1 flex-col justify-center overflow-clip rounded-(--radius-md) border border-(--color-border) bg-(--color-sidebar) md:bg-(--color-surface)">
				<div className="flex items-center gap-2 border-b border-(--color-border) bg-(--color-thead) px-3 py-2.5 md:hidden">
					<h2 className="text-[12px] leading-[15px] font-semibold text-(--color-text)">
						Recent run events
					</h2>
					<span className="flex-1" />
					<span className="font-mono text-[9px] leading-[11px] text-(--color-text-3)">
						LIVE TAIL
					</span>
				</div>
				{events.isPending ? (
					<p className="px-3 py-4 font-mono text-[10px] leading-4 text-(--color-text-3)">
						loading run events…
					</p>
				) : events.isError ? (
					<p className="px-3 py-4 font-mono text-[10px] leading-4 text-(--color-danger)">
						{formatError(events.error)}
					</p>
				) : rows.length === 0 ? (
					<p className="px-3 py-4 font-mono text-[10px] leading-4 text-(--color-text-3)">
						No run events recorded yet.
					</p>
				) : (
					rows.map((event) => (
						<div
							key={event.id}
							className="flex min-h-[26px] items-baseline gap-2.5 border-b border-(--color-border) px-3 py-1 last:border-b-0"
						>
							<span className="w-[52px] shrink-0 font-mono text-[10px] leading-3 text-(--color-text-3)">
								{formatEventClock(event.ts)}
							</span>
							<span
								className={`w-[64px] shrink-0 truncate font-mono text-[10px] leading-3 uppercase ${streamToneClass(event.stream)}`}
							>
								{event.stream ?? "—"}
							</span>
							<span className="min-w-0 flex-1 truncate font-mono text-[10px] leading-3 text-(--color-text-2)">
								{summarizeEventPayload(event.payload)}
							</span>
						</div>
					))
				)}
				<div className="flex h-[30px] shrink-0 items-center gap-3 border-t border-(--color-border) px-3">
					<span className="font-mono text-[9px] leading-3 text-(--color-text-3)">
						{seqRange ?? "NEWEST FIRST · BOUNDED POLL"}
					</span>
					<span className="flex-1" />
					<Link
						to="/events"
						className="text-[11px] leading-3.5 text-(--color-primary) hover:underline md:hidden"
					>
						Open event explorer →
					</Link>
					<Link
						to="/events"
						className="hidden text-[11px] leading-3.5 text-(--color-primary) hover:underline md:inline"
					>
						View all →
					</Link>
				</div>
			</div>
		</div>
	);
}
