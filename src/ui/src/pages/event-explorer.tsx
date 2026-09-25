import { useQuery } from "@tanstack/react-query";
import { Activity, Download, Pause, Play } from "lucide-react";
import { useState } from "react";
import { type EventExplorerRow, eventsApi, projectsApi } from "@/api/client.ts";
import { Button } from "@/components/ui/button.tsx";
import { Card, CardFooter } from "@/components/ui/card.tsx";
import { EmptyState } from "@/components/ui/empty-state.tsx";
import { PageHeader } from "@/components/ui/page-header.tsx";
import { SkeletonRows } from "@/components/ui/skeleton.tsx";
import { StatusDot } from "@/components/ui/status.tsx";
import { useToast } from "@/components/ui/toast.tsx";
import { useListKeys } from "@/hooks/use-list-keys.ts";
import { useNow } from "@/hooks/use-now.ts";
import { formatError } from "@/lib/format-error.ts";
import {
	buildFilter,
	collectExportLines,
	EXPORT_MAX_ROWS,
	type FilterState,
} from "./event-explorer-export.ts";
import { EventFilters } from "./event-explorer-filters.tsx";
import { sinceForPreset, TIME_RANGES } from "./event-explorer-format.ts";
import { EventTable } from "./event-explorer-rows.tsx";

/**
 * Event explorer (warren-24b9, migrated in warren-9474) — every event
 * this instance records, newest first. Filter by stream, time window,
 * run, kind, and project; follow mode refreshes the newest page every
 * few seconds while the tab is visible; export writes the filtered rows
 * as ndjson. J/K moves through rows and Enter expands the payload.
 *
 * Everything here is a read, and the events read is spectator-safe, so a
 * public visitor gets a working read-only page.
 */

const PAGE_SIZE = 100;
/** Follow mode refresh cadence — only while following and visible. */
const FOLLOW_POLL_MS = 5_000;

const INITIAL_FILTERS: FilterState = {
	stream: "all",
	kind: "",
	runId: "",
	projectId: "",
	rangeId: "24h",
};

function useEventsPage(state: FilterState, offset: number, follow: boolean) {
	const range = TIME_RANGES.find((r) => r.id === state.rangeId) ?? null;
	const filter = buildFilter(state);
	// `since` is computed at query time, not in the key, so follow mode
	// keeps the window sliding forward on each refresh.
	const query = useQuery({
		queryKey: ["event-explorer", filter, state.rangeId, offset],
		queryFn: ({ signal }) =>
			eventsApi.list(
				{
					...filter,
					since: range === null ? undefined : sinceForPreset(range),
					limit: PAGE_SIZE,
					offset,
				},
				signal,
			),
		// Events are not lifecycle-invalidated: a static view stays still
		// until the operator follows or refreshes; follow polls while visible.
		refetchInterval: follow ? FOLLOW_POLL_MS : false,
		refetchIntervalInBackground: false,
	});
	return { query, filter, range };
}

function downloadNdjson(lines: readonly string[]): void {
	const blob = new Blob([lines.join("\n") + (lines.length > 0 ? "\n" : "")], {
		type: "application/x-ndjson",
	});
	const url = URL.createObjectURL(blob);
	const a = document.createElement("a");
	a.href = url;
	a.download = "warren-events.ndjson";
	a.click();
	URL.revokeObjectURL(url);
}

export function EventExplorerPage() {
	const [state, setState] = useState<FilterState>(INITIAL_FILTERS);
	const [offset, setOffset] = useState(0);
	const [follow, setFollow] = useState(false);
	const [expandedId, setExpandedId] = useState<number | null>(null);
	const [exporting, setExporting] = useState(false);
	const { toast } = useToast();
	const { query: events, filter, range } = useEventsPage(state, offset, follow);
	const projects = useQuery({
		queryKey: ["projects"],
		queryFn: ({ signal }) => projectsApi.list(signal),
		staleTime: 60_000,
	});

	const rows = events.data?.events ?? [];
	const toggleExpanded = (id: number): void => {
		setExpandedId((prev) => (prev === id ? null : id));
	};
	const keys = useListKeys(rows.length, (i) => {
		const row = rows[i];
		if (row) toggleExpanded(row.id);
	});

	// Any filter change resets to page 1 — a stale offset can land past
	// the end of a narrowed result set.
	const patch = (next: Partial<FilterState>): void => {
		setState((prev) => ({ ...prev, ...next }));
		setOffset(0);
	};

	const exportNdjson = async (): Promise<void> => {
		setExporting(true);
		try {
			const { lines, capped } = await collectExportLines((pageOffset) =>
				eventsApi.list({
					...filter,
					since: range === null ? undefined : sinceForPreset(range),
					limit: 500,
					offset: pageOffset,
				}),
			);
			downloadNdjson(lines);
			toast({
				title: "Events exported",
				description: capped
					? `The first ${EXPORT_MAX_ROWS.toLocaleString()} events were saved to warren-events.ndjson.`
					: `${lines.length.toLocaleString()} events saved to warren-events.ndjson.`,
			});
		} catch (err) {
			toast({ title: "Export failed", description: formatError(err), variant: "danger" });
		} finally {
			setExporting(false);
		}
	};

	return (
		<div className="flex min-h-full flex-col gap-5 px-4 pt-5 pb-12 md:px-6">
			<PageHeader
				title="Event explorer"
				description="Every event runs record, newest first. Filter, follow live, or export."
				actions={
					<>
						<Button
							variant="outline"
							aria-pressed={follow}
							onClick={() => {
								setFollow((prev) => !prev);
								setOffset(0);
							}}
						>
							{follow ? <StatusDot state="live" size="sm" /> : <Play aria-hidden />}
							{follow ? "Following" : "Follow"}
							{follow ? <Pause aria-hidden className="text-(--color-text-3)" /> : null}
						</Button>
						<Button variant="outline" onClick={() => void exportNdjson()} disabled={exporting}>
							<Download aria-hidden />
							{exporting ? "Exporting…" : "Export"}
						</Button>
					</>
				}
			/>

			<EventFilters state={state} patch={patch} projects={projects.data?.projects} />

			<Card className="self-stretch">
				<EventsBody
					query={events}
					rows={rows}
					expandedId={expandedId}
					keys={keys}
					onToggle={toggleExpanded}
					onShowAll={() => patch({ rangeId: "all" })}
					rangeId={state.rangeId}
				/>
				{events.isSuccess && rows.length > 0 ? (
					<Pager
						offset={offset}
						shown={rows.length}
						total={events.data.total}
						onPrev={() => setOffset(Math.max(0, offset - PAGE_SIZE))}
						onNext={() => setOffset(offset + PAGE_SIZE)}
					/>
				) : null}
			</Card>
		</div>
	);
}

function EventsBody({
	query,
	rows,
	expandedId,
	keys,
	onToggle,
	onShowAll,
	rangeId,
}: {
	query: ReturnType<typeof useEventsPage>["query"];
	rows: readonly EventExplorerRow[];
	expandedId: number | null;
	keys: ReturnType<typeof useListKeys>;
	onToggle: (id: number) => void;
	onShowAll: () => void;
	rangeId: string;
}) {
	// Row times switch to a date past midnight; a minute tick is enough.
	const now = useNow(60_000);
	if (query.isPending) return <SkeletonRows rows={10} />;
	if (query.isError) {
		return (
			<EmptyState
				compact
				title="Couldn't load events"
				description={formatError(query.error)}
				action={
					<Button variant="outline" size="sm" onClick={() => void query.refetch()}>
						Retry
					</Button>
				}
			/>
		);
	}
	if (rows.length === 0) {
		return (
			<EmptyState
				compact
				icon={Activity}
				title="No events match"
				description="Nothing in this window matches the filters. Widen the time window or clear a filter."
				action={
					rangeId === "all" ? undefined : (
						<Button variant="outline" size="sm" onClick={onShowAll}>
							Show all time
						</Button>
					)
				}
			/>
		);
	}
	return (
		<EventTable
			rows={rows}
			expandedId={expandedId}
			selected={keys.selected}
			setRef={keys.setRef}
			onToggle={onToggle}
			now={now}
		/>
	);
}

function Pager({
	offset,
	shown,
	total,
	onPrev,
	onNext,
}: {
	offset: number;
	shown: number;
	total: number;
	onPrev: () => void;
	onNext: () => void;
}) {
	const last = offset + shown;
	return (
		<CardFooter>
			<span className="tabular-nums">
				{(offset + 1).toLocaleString()}–{last.toLocaleString()} of {total.toLocaleString()}
			</span>
			<span className="flex items-center gap-1">
				<Button variant="ghost" size="sm" disabled={offset === 0} onClick={onPrev}>
					Previous
				</Button>
				<Button variant="ghost" size="sm" disabled={last >= total} onClick={onNext}>
					Next
				</Button>
			</span>
		</CardFooter>
	);
}
