import { ArrowDown, ScrollText, Search } from "lucide-react";
import { memo, useCallback, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import type { RunEvent } from "@/api/types.ts";
import { Button } from "@/components/ui/button.tsx";
import { Card } from "@/components/ui/card.tsx";
import { EmptyState } from "@/components/ui/empty-state.tsx";
import { Input } from "@/components/ui/input.tsx";
import { Segmented } from "@/components/ui/segmented.tsx";
import { Skeleton } from "@/components/ui/skeleton.tsx";
import { StatusDot } from "@/components/ui/status.tsx";
import { cn } from "@/lib/utils.ts";
import { LogLineRow } from "./event-log.lines.tsx";
import {
	classifyEvent,
	countViews,
	filterLines,
	type LogLine,
	type LogView,
} from "./event-log-classify.ts";

/**
 * The run's event log (warren-4a47): events classified into prose, tool
 * calls, output, milestones and warnings (event-log-classify.ts), a view
 * switch, a text filter, and follow mode — the log tails while you sit at
 * the bottom, stops the moment you scroll up, and offers "Jump to latest".
 *
 * Rendering is windowed without a dependency: lines render in fixed-size
 * groups under `content-visibility: auto`, so the browser skips layout
 * and paint for groups off screen, and each group is memoized on its
 * first/last line so appending events re-renders only the tail group.
 */

const GROUP_SIZE = 40;
/** Estimated line height for off-screen groups (content-visibility). */
const LINE_ESTIMATE_PX = 24;
const BOTTOM_SLACK_PX = 48;

const LineGroup = memo(
	function LineGroup({ lines }: { lines: LogLine[] }) {
		return (
			<div
				className="[content-visibility:auto]"
				style={{ containIntrinsicSize: `auto ${lines.length * LINE_ESTIMATE_PX}px` }}
			>
				{lines.map((l) => (
					<LogLineRow key={l.event.id} line={l} />
				))}
			</div>
		);
	},
	(a, b) =>
		a.lines.length === b.lines.length &&
		a.lines[0] === b.lines[0] &&
		a.lines[a.lines.length - 1] === b.lines[b.lines.length - 1],
);

function groupLines(lines: LogLine[]): LogLine[][] {
	const groups: LogLine[][] = [];
	for (let i = 0; i < lines.length; i += GROUP_SIZE) groups.push(lines.slice(i, i + GROUP_SIZE));
	return groups;
}

function StreamState({ status, terminal }: { status: string; terminal: boolean }) {
	if (terminal) return null;
	if (status === "live") {
		return (
			<span className="inline-flex items-center gap-1.5 text-xs text-(--color-info)">
				<StatusDot state="live" size="sm" /> Live
			</span>
		);
	}
	if (status === "error") {
		return (
			<span className="inline-flex items-center gap-1.5 text-xs text-(--color-warning)">
				<StatusDot tone="warn" size="sm" /> Reconnecting
			</span>
		);
	}
	if (status === "connecting") {
		return <span className="text-xs text-(--color-text-3)">Connecting…</span>;
	}
	return null;
}

function LogSkeleton() {
	const widths = ["w-3/5", "w-2/5", "w-4/5", "w-1/3", "w-2/3", "w-1/2", "w-3/4", "w-2/5"];
	return (
		<div role="status" aria-label="Loading the log" className="space-y-2.5 px-4 py-3">
			{widths.map((w) => (
				<div key={w} className="flex items-center gap-3">
					<Skeleton className="w-14" />
					<Skeleton className="size-3.5 rounded-full" />
					<Skeleton className={w} />
				</div>
			))}
		</div>
	);
}

function TrimmedNote({ trimmed, shown }: { trimmed: number; shown: number }) {
	return (
		<div className="mx-4 my-2 rounded-sm border border-(--color-border) bg-(--color-surface-raised) px-3 py-2 text-xs text-(--color-text-2)">
			Showing the newest {shown.toLocaleString()} events. {trimmed.toLocaleString()} earlier{" "}
			{trimmed === 1 ? "event is" : "events are"} not kept here to keep the page fast.{" "}
			<Link to="/events" className="font-medium text-(--color-primary) hover:underline">
				Open the event explorer
			</Link>
		</div>
	);
}

function useFollow(visibleCount: number) {
	const scroller = useRef<HTMLDivElement>(null);
	const [follow, setFollow] = useState(true);
	const lastTop = useRef(0);
	const countAtUnfollow = useRef(0);

	// biome-ignore lint/correctness/useExhaustiveDependencies: a new line count is the trigger
	useLayoutEffect(() => {
		const el = scroller.current;
		if (!follow || el === null) return;
		el.scrollTop = el.scrollHeight;
		lastTop.current = el.scrollTop;
	}, [visibleCount, follow]);

	// Programmatic scrolls only ever move down, so an upward move is always
	// the reader's intent — no wheel/touch/drag special cases needed.
	const onScroll = useCallback(
		(e: React.UIEvent<HTMLDivElement>) => {
			const el = e.currentTarget;
			const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < BOTTOM_SLACK_PX;
			if (atBottom) setFollow(true);
			else if (el.scrollTop < lastTop.current - 2 && follow) {
				countAtUnfollow.current = visibleCount;
				setFollow(false);
			}
			lastTop.current = el.scrollTop;
		},
		[follow, visibleCount],
	);

	const jump = useCallback(() => setFollow(true), []);
	const unseen = follow ? 0 : Math.max(0, visibleCount - countAtUnfollow.current);
	return { scroller, follow, onScroll, jump, unseen };
}

export function EventLog({
	events,
	trimmed,
	status,
	error,
	terminal,
	className,
}: {
	events: RunEvent[];
	trimmed: number;
	status: string;
	error: string | null;
	terminal: boolean;
	className?: string;
}) {
	const [view, setView] = useState<LogView>("activity");
	const [query, setQuery] = useState("");
	const lines = useMemo(() => events.map(classifyEvent), [events]);
	const counts = useMemo(() => countViews(lines), [lines]);
	const visible = useMemo(() => filterLines(lines, view, query), [lines, view, query]);
	const groups = useMemo(() => groupLines(visible), [visible]);
	const { scroller, follow, onScroll, jump, unseen } = useFollow(visible.length);

	const loading = events.length === 0 && (status === "connecting" || status === "idle");

	return (
		<Card className={cn("flex flex-col self-stretch", className)}>
			<div className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-(--color-border) px-4 py-2.5">
				<h2 className="text-sm font-medium text-(--color-text)">Event log</h2>
				<StreamState status={status} terminal={terminal} />
				<span className="text-xs text-(--color-text-3) tabular-nums">
					{events.length.toLocaleString()} events
				</span>
				<div className="ml-auto flex min-w-0 flex-wrap items-center gap-2 max-sm:w-full">
					<Segmented<LogView>
						size="sm"
						label="Log view"
						value={view}
						onChange={setView}
						className="max-w-full overflow-x-auto"
						options={[
							{ value: "activity", label: "Activity" },
							{ value: "conversation", label: "Messages", count: counts.conversation },
							{ value: "tools", label: "Tools", count: counts.tools },
							{ value: "problems", label: "Problems", count: counts.problems },
							{ value: "all", label: "All" },
						]}
					/>
					<div className="relative min-w-0 max-sm:flex-1">
						<Search
							aria-hidden
							className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-(--color-text-3)"
						/>
						<Input
							value={query}
							onChange={(e) => setQuery(e.target.value)}
							placeholder="Filter log"
							aria-label="Filter log"
							className="pl-8 sm:w-44"
						/>
					</div>
				</div>
			</div>
			{error !== null && status === "error" ? (
				<p className="border-b border-(--color-border) bg-(--color-warning)/10 px-4 py-1.5 text-xs text-(--color-warning)">
					The live connection dropped ({error}). Reconnecting and resuming where it left off.
				</p>
			) : null}
			<div className="relative flex min-h-0 flex-1 flex-col">
				<div
					ref={scroller}
					onScroll={onScroll}
					className="h-[70vh] min-h-80 overflow-y-auto bg-(--color-bg) py-2 xl:h-auto xl:flex-1"
				>
					{trimmed > 0 ? <TrimmedNote trimmed={trimmed} shown={events.length} /> : null}
					{loading ? (
						<LogSkeleton />
					) : visible.length === 0 ? (
						<EmptyLog hasEvents={events.length > 0} onClear={() => setQuery("")} query={query} />
					) : (
						groups.map((g) => <LineGroup key={g[0]?.event.id} lines={g} />)
					)}
				</div>
				{!follow ? (
					<Button
						variant="outline"
						size="sm"
						onClick={jump}
						className="absolute bottom-3 left-1/2 -translate-x-1/2 rounded-full shadow-md"
					>
						<ArrowDown aria-hidden />
						{terminal ? "Jump to end" : "Jump to latest"}
						{unseen > 0 ? (
							<span className="text-(--color-text-3) tabular-nums">{unseen} new</span>
						) : null}
					</Button>
				) : null}
			</div>
		</Card>
	);
}

function EmptyLog({
	hasEvents,
	query,
	onClear,
}: {
	hasEvents: boolean;
	query: string;
	onClear: () => void;
}) {
	if (!hasEvents) {
		return (
			<EmptyState
				compact
				icon={ScrollText}
				title="No events yet"
				description="Lines appear here as soon as the agent starts working."
			/>
		);
	}
	return (
		<EmptyState
			compact
			title="No lines match"
			description="Try another view, or clear the filter."
			action={
				query !== "" ? (
					<Button variant="outline" size="sm" onClick={onClear}>
						Clear filter
					</Button>
				) : undefined
			}
		/>
	);
}
