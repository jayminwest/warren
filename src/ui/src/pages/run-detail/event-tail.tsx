import { useEffect, useMemo, useRef, useState } from "react";
import type { RunEvent } from "@/api/types.ts";
import { cn } from "@/lib/utils.ts";
import { eventKindLabel, isEventError, summarizeEvent } from "@/pages/run-detail/event-summary.ts";
import { formatWallClock } from "@/pages/run-detail-format.ts";

/**
 * The Direction C structured event tail (warren-8c85 / pl-7e38 step 4),
 * translated from docs/ui-revamp/screens/run-detail.jsx: a bordered card
 * whose header carries the count chip, the live dot, the All / Agent /
 * System / Errors segmented filter, and the Tail toggle; body rows are
 * dense mono lines — seq, wall-clock, kind, summary — with the full
 * payload behind an expand toggle. Live tailing rides the existing
 * NDJSON stream reader (useEventStream feeds `events`); Tail toggles
 * auto-scroll, matching the export's "Tail: on" control.
 */

const FILTERS = ["all", "agent", "system", "errors"] as const;
type EventFilter = (typeof FILTERS)[number];

/**
 * Filter arms mapped onto the wire's stream vocabulary
 * (`stdout`/`stderr`/`system`, src/core/wire.ts): the export's "Agent"
 * arm is agent-generated output (stdout), "System" is the warren
 * stream, "Errors" is stderr + pi extension errors.
 */
function matchesFilter(event: RunEvent, filter: EventFilter): boolean {
	if (filter === "all") return true;
	if (filter === "errors") return isEventError(event);
	if (filter === "agent") return event.stream === "stdout" || event.stream === "stderr";
	return event.stream === "system";
}

function kindColor(event: RunEvent): string {
	if (isEventError(event)) return "text-(--color-danger)";
	if (event.stream === "system") return "text-(--color-success)";
	return "text-(--color-info)";
}

function EventRow({ event }: { event: RunEvent }) {
	const expanded =
		typeof event.payload === "string" ? event.payload : JSON.stringify(event.payload, null, 2);
	const summary = summarizeEvent(event);
	return (
		<details className="group border-b border-(--color-border) last:border-b-0">
			<summary className="flex cursor-pointer items-start gap-[7px] px-2.5 py-1.5 select-none [&::-webkit-details-marker]:hidden hover:bg-(--color-surface-hover)">
				<span className="w-[42px] shrink-0 font-mono text-[9px] leading-3 text-(--color-text-3)">
					{String(event.seq).padStart(6, "0")}
				</span>
				<span className="w-[68px] shrink-0 font-mono text-[9px] leading-3 text-(--color-text-3)">
					{formatWallClock(event.ts)}
				</span>
				<span className={cn("w-[108px] shrink-0 font-mono text-[9px] leading-3", kindColor(event))}>
					{eventKindLabel(event)}
				</span>
				<span className="min-w-0 flex-1 font-mono text-[9px] leading-[13px] break-words text-(--color-text-2)">
					{summary}
				</span>
			</summary>
			{event.payload !== null ? (
				<div className="px-2.5 pb-2">
					<pre className="ml-[117px] max-h-[420px] overflow-auto rounded-(--radius-sm) border-l border-(--color-border-strong) px-2.5 py-1.5 font-mono text-[9px] leading-[13px] break-words whitespace-pre-wrap text-(--color-text-3)">
						{expanded}
					</pre>
				</div>
			) : null}
		</details>
	);
}

export function EventTail({
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
	const [filter, setFilter] = useState<EventFilter>("all");

	const sorted = useMemo(() => {
		const copy = [...events];
		copy.sort((a, b) => a.seq - b.seq);
		return copy;
	}, [events]);

	const visible = useMemo(() => sorted.filter((e) => matchesFilter(e, filter)), [sorted, filter]);

	// biome-ignore lint/correctness/useExhaustiveDependencies: sorted.length is the trigger, not a read
	useEffect(() => {
		if (autoScroll && ref.current) {
			ref.current.scrollTop = ref.current.scrollHeight;
		}
	}, [sorted.length, autoScroll]);

	// Disable autoscroll on user intent (wheel up, touch drag), not on
	// scroll position: programmatic scrolls also fire `scroll`, and during
	// event bursts the handler runs after additional content has appended,
	// reading a stale (non-bottom) position and falsely turning autoscroll
	// off. `scroll` here only re-enables, never disables.
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

	const live = !terminal && (status === "open" || status === "connecting");

	return (
		<section className="flex min-h-0 flex-col overflow-clip rounded-(--radius-md) border border-(--color-border) bg-(--color-surface)">
			<header className="flex h-[39px] shrink-0 items-center gap-2 border-b border-(--color-border) px-2.5">
				<h2 className="text-[11px] leading-[14px] font-semibold text-(--color-text)">
					Event stream
				</h2>
				<span className="inline-flex h-5 items-center rounded-(--radius-xs) border border-(--color-border-strong) px-1.5 font-mono text-[9px] leading-3 text-(--color-text-2)">
					{visible.length} EVENTS
				</span>
				{live ? (
					<span className="flex items-center gap-[7px]">
						<span className="h-1.5 w-1.5 rounded-full bg-(--color-success)" aria-hidden />
						<span className="font-mono text-[10px] leading-3 text-(--color-success)">live</span>
					</span>
				) : terminal ? (
					<span className="font-mono text-[10px] leading-3 text-(--color-text-3)">terminal</span>
				) : (
					<span className="font-mono text-[10px] leading-3 text-(--color-warning)">{status}</span>
				)}
				<span className="flex-1" />
				<fieldset
					className="flex overflow-clip rounded-(--radius-sm) border border-(--color-border)"
					aria-label="Event stream filter"
				>
					{FILTERS.map((f) => (
						<button
							key={f}
							type="button"
							onClick={() => setFilter(f)}
							className={cn(
								"h-7 border-r border-(--color-border) px-2.5 text-[10px] leading-3 last:border-r-0",
								filter === f
									? "bg-(--color-surface-raised) text-(--color-text)"
									: "text-(--color-text-3) hover:text-(--color-text-2)",
							)}
						>
							{f === "all" ? "All" : f === "errors" ? "Errors" : f === "agent" ? "Agent" : "System"}
						</button>
					))}
				</fieldset>
				<button
					type="button"
					onClick={() => setAutoScroll((v) => !v)}
					className={cn(
						"inline-flex h-[25px] items-center rounded-(--radius-sm) border px-2 text-[10px] leading-3 font-medium",
						autoScroll
							? "border-(--color-border-strong) bg-(--color-surface) text-(--color-text-2)"
							: "border-(--color-border) text-(--color-text-3)",
					)}
					title="Auto-scroll the tail as new events arrive"
				>
					Tail: {autoScroll ? "on" : "off"}
				</button>
			</header>
			{error !== null ? (
				<p className="border-b border-(--color-border) px-2.5 py-1.5 font-mono text-[10px] text-(--color-danger)">
					{error}
				</p>
			) : null}
			<div
				ref={ref}
				onScroll={onScroll}
				onWheel={onWheel}
				onTouchMove={onTouchMove}
				className="h-[520px] overflow-auto bg-(--color-sidebar)"
			>
				{visible.length === 0 ? (
					<p className="p-4 text-[11px] text-(--color-text-3)">
						{sorted.length === 0 ? "No events yet." : "No events match this filter."}
					</p>
				) : (
					visible.map((e) => <EventRow key={e.id} event={e} />)
				)}
			</div>
		</section>
	);
}
