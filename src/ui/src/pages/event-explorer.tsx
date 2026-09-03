import { useQuery } from "@tanstack/react-query";
import { Download, Pause, Play } from "lucide-react";
import { useState } from "react";
import { type EventExplorerRow, eventsApi, projectsApi } from "@/api/client.ts";
import type { ProjectRow } from "@/api/types.ts";
import { Alert } from "@/components/ui/alert.tsx";
import { Button } from "@/components/ui/button.tsx";
import { EmptyState } from "@/components/ui/empty-state.tsx";
import { FilterPill } from "@/components/ui/filter-pill.tsx";
import { Input } from "@/components/ui/input.tsx";
import { responsiveFormControl } from "@/components/ui/responsive.ts";
import { Spinner } from "@/components/ui/spinner.tsx";
import { useToast } from "@/components/ui/toast.tsx";
import { formatError } from "@/lib/format-error.ts";
import { cn } from "@/lib/utils.ts";
import {
	buildFilter,
	collectExportLines,
	EXPORT_MAX_ROWS,
	type FilterState,
} from "./event-explorer-export.ts";
import {
	formatEventClock,
	sinceForPreset,
	streamToneClass,
	summarizeEventPayload,
	TIME_RANGES,
} from "./event-explorer-format.ts";
import { MobileFilterStrip, STREAM_FILTERS } from "./event-explorer-mobile-filter-strip.tsx";

/**
 * Event explorer (warren-24b9 / pl-7e38 step 16) — every structured
 * event this instance emits, in sequence order, from `GET /events`
 * (warren-5eec). Filter by project, run, stream/kind and time range;
 * follow mode re-polls the bounded read (no held-open stream); export
 * writes the filtered rows as ndjson.
 *
 * Spectator note: everything here is a read — `GET /events` is
 * `readPublic` with the same per-row projection as the per-run stream,
 * so a public visitor gets a working read-only page with no broken
 * operator affordances.
 */

const PAGE_SIZE = 100;
/** Follow mode re-poll cadence for the bounded read. */
const FOLLOW_POLL_MS = 5_000;
/** Slow fallback poll, the runs-list pattern (warren-f566). */
const FALLBACK_POLL_MS = 45_000;

export function EventExplorerPage() {
	const [state, setState] = useState<FilterState>({
		stream: "all",
		kind: "",
		runId: "",
		projectId: "",
		rangeId: "24h",
	});
	const [offset, setOffset] = useState(0);
	const [follow, setFollow] = useState(false);
	const [expandedId, setExpandedId] = useState<number | null>(null);
	const [exporting, setExporting] = useState(false);
	const { toast } = useToast();

	const range = TIME_RANGES.find((r) => r.id === state.rangeId) ?? null;
	const filter = buildFilter(state);

	// `since` is computed at query time, not in the key, so follow mode
	// keeps the window sliding forward on each poll.
	const events = useQuery({
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
		refetchInterval: follow ? FOLLOW_POLL_MS : FALLBACK_POLL_MS,
	});

	const projects = useQuery({
		queryKey: ["projects"],
		queryFn: ({ signal }) => projectsApi.list(signal),
	});

	const rows = events.data?.events ?? [];
	const total = events.data?.total ?? 0;

	// Any filter change resets to page 1 — a stale offset can land past
	// the end of a narrowed result set.
	const patch = (next: Partial<FilterState>): void => {
		setState((prev) => ({ ...prev, ...next }));
		setOffset(0);
	};

	const toggleExpanded = (id: number): void => {
		setExpandedId((prev) => (prev === id ? null : id));
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
			const blob = new Blob([lines.join("\n") + (lines.length > 0 ? "\n" : "")], {
				type: "application/x-ndjson",
			});
			const url = URL.createObjectURL(blob);
			const a = document.createElement("a");
			a.href = url;
			a.download = "warren-events.ndjson";
			a.click();
			URL.revokeObjectURL(url);
			toast({
				title: "Exported events",
				description: capped
					? `${EXPORT_MAX_ROWS} rows (export cap) written to warren-events.ndjson`
					: `${lines.length} rows written to warren-events.ndjson`,
			});
		} catch (err) {
			toast({ title: "Export failed", description: formatError(err), variant: "danger" });
		} finally {
			setExporting(false);
		}
	};

	return (
		<div className="flex min-h-full flex-col gap-4 px-3.5 pt-5 pb-12 md:px-6">
			<div className="font-mono text-[10px] leading-3 tracking-[0.06em] text-(--color-text-3)">
				OPERATIONS / EVENT EXPLORER
			</div>

			<div className="flex flex-wrap items-end justify-between gap-3">
				<div className="flex min-w-0 flex-grow flex-col gap-1.5">
					<div className="flex items-center gap-2.5">
						<h1 className="text-[17px] font-semibold leading-[22px] tracking-[-0.02em] text-(--color-text) md:text-[22px] md:leading-7 md:tracking-[-0.025em]">
							Event explorer
						</h1>
						{follow && <LiveBadge className="hidden md:inline-flex" />}
					</div>
					<p className="max-w-prose text-[13px] leading-[18px] text-(--color-text-2)">
						Search, filter, follow, and export run events.
					</p>
				</div>
				<div className="flex items-center gap-2">
					{follow && <LiveBadge className="md:hidden" />}
					<Button
						variant="outline"
						size="sm"
						aria-label={follow ? "Pause tail" : "Follow tail"}
						onClick={() => {
							setFollow((prev) => !prev);
							setOffset(0);
						}}
					>
						{follow ? <Pause className="h-3.5 w-3.5" /> : <Play className="h-3.5 w-3.5" />}
						<span className="hidden md:inline">{follow ? "Pause tail" : "Follow tail"}</span>
					</Button>
					<Button
						variant="outline"
						size="sm"
						aria-label="Export ndjson"
						onClick={() => void exportNdjson()}
						disabled={exporting}
					>
						<Download className="h-3.5 w-3.5" />
						<span className="hidden md:inline">{exporting ? "Exporting…" : "Export ndjson"}</span>
					</Button>
				</div>
			</div>

			<MobileFilterStrip state={state} patch={patch} projects={projects.data?.projects} />

			<FilterStrip state={state} patch={patch} projects={projects.data?.projects} />

			<RowsPanel
				pending={events.isPending}
				error={events.isError ? events.error : null}
				success={events.isSuccess}
				rows={rows}
				total={total}
				offset={offset}
				expandedId={expandedId}
				onToggleExpanded={toggleExpanded}
				onPrev={() => setOffset(Math.max(0, offset - PAGE_SIZE))}
				onNext={() => setOffset(offset + PAGE_SIZE)}
			/>
		</div>
	);
}

function LiveBadge({ className }: { className?: string }) {
	return (
		<span
			className={cn(
				"flex items-center gap-1.5 rounded-xs border border-(--color-success)/40 px-1.5 py-0.5",
				className,
			)}
		>
			<span className="h-1.5 w-1.5 rounded-full bg-(--color-success)" />
			<span className="font-mono text-[9px] leading-3 tracking-[0.08em] text-(--color-success)">
				LIVE
			</span>
		</span>
	);
}

function FilterStrip({
	state,
	patch,
	projects,
}: {
	state: FilterState;
	patch: (next: Partial<FilterState>) => void;
	projects: readonly ProjectRow[] | undefined;
}) {
	return (
		<div className="hidden flex-wrap items-center gap-2 rounded-t border border-(--color-border) bg-(--color-surface) px-2.5 py-2 md:flex">
			{STREAM_FILTERS.map((f) => (
				<FilterPill
					key={f.id}
					label={f.label}
					active={state.stream === f.id}
					onClick={() => patch({ stream: f.id })}
					className="rounded-sm font-mono text-[10px] leading-3"
				/>
			))}
			<div className="min-w-0 flex-1" />
			<Input
				value={state.runId}
				onChange={(e) => patch({ runId: e.target.value })}
				placeholder="run id"
				aria-label="Filter by run id"
				className={cn(responsiveFormControl, "w-36 font-mono sm:h-7 sm:text-[10px]")}
			/>
			<Input
				value={state.kind}
				onChange={(e) => patch({ kind: e.target.value })}
				placeholder="kind"
				aria-label="Filter by event kind"
				className={cn(responsiveFormControl, "w-32 font-mono sm:h-7 sm:text-[10px]")}
			/>
			{projects !== undefined && (
				<select
					value={state.projectId}
					onChange={(e) => patch({ projectId: e.target.value })}
					aria-label="Filter by project"
					className={cn(
						responsiveFormControl,
						"max-w-48 rounded-sm border border-(--color-border) bg-(--color-bg) px-2 font-mono text-(--color-text-2) sm:h-7 sm:text-[10px]",
					)}
				>
					<option value="">all projects</option>
					{projects.map((p) => (
						<option key={p.id} value={p.id}>
							{p.id}
						</option>
					))}
				</select>
			)}
			<div className="flex overflow-clip rounded-sm border border-(--color-border-strong)">
				{TIME_RANGES.map((r) => (
					<button
						key={r.id}
						type="button"
						onClick={() => patch({ rangeId: r.id })}
						className={cn(
							responsiveFormControl,
							state.rangeId === r.id
								? "bg-(--color-surface-raised) px-2.5 font-mono leading-[17px] text-(--color-text) sm:h-auto sm:py-1.5 sm:text-[10px] sm:leading-3"
								: "px-2.5 font-mono leading-[17px] text-(--color-text-3) hover:text-(--color-text-2) sm:h-auto sm:py-1.5 sm:text-[10px] sm:leading-3",
						)}
					>
						{r.label}
					</button>
				))}
			</div>
		</div>
	);
}

function RowsPanel({
	pending,
	error,
	success,
	rows,
	total,
	offset,
	expandedId,
	onToggleExpanded,
	onPrev,
	onNext,
}: {
	pending: boolean;
	error: unknown;
	success: boolean;
	rows: readonly EventExplorerRow[];
	total: number;
	offset: number;
	expandedId: number | null;
	onToggleExpanded: (id: number) => void;
	onPrev: () => void;
	onNext: () => void;
}) {
	const lastRow = offset + rows.length;
	return (
		<div className="-mt-4 flex flex-col rounded-b border border-t-0 border-(--color-border) bg-(--color-sidebar)">
			{pending && (
				<div className="flex items-center justify-center gap-2 py-10">
					<Spinner label="Loading events" />
				</div>
			)}
			{error !== null && (
				<div className="p-4">
					<Alert variant="danger" title="Can't load events">
						{formatError(error)}
					</Alert>
				</div>
			)}
			{success && rows.length === 0 && (
				<EmptyState
					compact
					title="No events match"
					description="Nothing in this window matches the current filters. Widen the time range or clear a filter."
				/>
			)}
			{rows.map((row) => (
				<EventRowView
					key={row.id}
					row={row}
					expanded={expandedId === row.id}
					onToggle={() => onToggleExpanded(row.id)}
				/>
			))}
			{success && rows.length > 0 && (
				<div className="flex items-center justify-between px-3 py-2 font-mono text-[9px] leading-[11px] text-(--color-text-3) md:text-[10px] md:leading-3">
					<span>
						{offset + 1}–{lastRow} of {total}
					</span>
					<span className="flex items-center gap-2">
						<Button
							variant="ghost"
							size="sm"
							disabled={offset === 0}
							onClick={onPrev}
							className={cn(responsiveFormControl, "sm:h-8 sm:text-xs")}
						>
							Prev
						</Button>
						<Button
							variant="ghost"
							size="sm"
							disabled={lastRow >= total}
							onClick={onNext}
							className={cn(responsiveFormControl, "sm:h-8 sm:text-xs")}
						>
							Next
						</Button>
					</span>
				</div>
			)}
		</div>
	);
}

/** One dense evidence row: id, clock, kind (stream-colored), run · summary. */
function EventRowView({
	row,
	expanded,
	onToggle,
}: {
	row: EventExplorerRow;
	expanded: boolean;
	onToggle: () => void;
}) {
	const payloadJson =
		row.payload === undefined ? "—" : (JSON.stringify(row.payload, null, 2) ?? "—");
	return (
		<div className="border-b border-(--color-border) last:border-b-0">
			<button
				type="button"
				onClick={onToggle}
				aria-expanded={expanded}
				className="flex w-full flex-col items-start gap-0.5 px-3 py-[7px] text-left hover:bg-(--color-surface-hover) md:flex-row md:gap-2.5"
			>
				<div className="flex w-full items-center gap-2 md:contents">
					<span className="hidden shrink-0 font-mono text-[10px] leading-3 text-(--color-text-3) md:block md:w-12">
						{row.id}
					</span>
					<span className="w-[46px] shrink-0 font-mono text-[10px] leading-3 text-(--color-text-3) md:w-16">
						{formatEventClock(row.ts)}
					</span>
					<span
						className={`w-[58px] shrink-0 truncate font-mono text-[10px] leading-3 md:w-24 ${streamToneClass(row.stream)}`}
					>
						{row.kind}
					</span>
					<span className="min-w-0 flex-1 truncate font-mono text-[10px] leading-[14px] text-(--color-text-2)">
						{row.runId} · {summarizeEventPayload(row.payload)}
					</span>
				</div>
				{/* Mobile line 2 (warren-e2e2): the wire row carries no per-event
				agent/project fields, so the indented metadata line shows seq + run. */}
				<span className="pl-[54px] font-mono text-[9px] leading-3 text-(--color-text-3) md:hidden">
					seq {row.seq} · {row.runId}
				</span>
			</button>
			{expanded && (
				<pre className="mx-2 mb-2 overflow-x-auto rounded-sm border-l border-(--color-border-strong) px-2.5 py-[7px] font-mono text-[10px] leading-[15px] text-(--color-text-3) md:mx-[5.5rem]">
					{payloadJson}
				</pre>
			)}
		</div>
	);
}
