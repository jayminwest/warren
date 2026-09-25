import { ChevronRight } from "lucide-react";
import { Fragment } from "react";
import { Link } from "react-router-dom";
import type { EventExplorerRow } from "@/api/client.ts";
import {
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from "@/components/ui/table.tsx";
import { cn } from "@/lib/utils.ts";
import {
	formatEventWhen,
	streamToneClass,
	summarizeEventPayload,
} from "./event-explorer-format.ts";

/**
 * The explorer's event table (warren-9474): one dense row per event —
 * sequence, time, kind (tinted by stream), run, and a payload summary.
 * A row click, or Enter on the J/K selection, expands the full payload
 * beneath it. On a phone the table scrolls inside its card.
 */

function EventRow({
	row,
	expanded,
	selected,
	onToggle,
	rowRef,
	now,
}: {
	row: EventExplorerRow;
	expanded: boolean;
	selected: boolean;
	onToggle: () => void;
	rowRef: (el: HTMLElement | null) => void;
	now: number;
}) {
	return (
		<Fragment>
			<TableRow
				ref={rowRef}
				data-selected={selected}
				className={cn("cursor-pointer", expanded && "border-b-0")}
				onClick={onToggle}
			>
				<TableCell className="w-8 pr-0">
					<button
						type="button"
						aria-expanded={expanded}
						aria-label={expanded ? "Hide payload" : "Show payload"}
						onClick={(e) => {
							e.stopPropagation();
							onToggle();
						}}
						className="flex size-6 items-center justify-center rounded-xs text-(--color-text-3) hover:text-(--color-text)"
					>
						<ChevronRight
							aria-hidden
							className={cn("size-3.5 transition-transform", expanded && "rotate-90")}
						/>
					</button>
				</TableCell>
				<TableCell className="whitespace-nowrap text-(--color-text-3)">
					{formatEventWhen(row.ts, now)}
				</TableCell>
				<TableCell
					className={cn("max-w-56 truncate font-mono text-xs", streamToneClass(row.stream))}
					title={row.stream ?? undefined}
				>
					{row.kind}
				</TableCell>
				<TableCell>
					<Link
						to={`/runs/${encodeURIComponent(row.runId)}`}
						onClick={(e) => e.stopPropagation()}
						className="font-mono text-xs whitespace-nowrap text-(--color-text-2) hover:text-(--color-primary) hover:underline"
					>
						{row.runId}
					</Link>
				</TableCell>
				<TableCell className="max-w-md truncate font-mono text-xs text-(--color-text-2)">
					{summarizeEventPayload(row.payload)}
				</TableCell>
				<TableCell className="text-right text-xs text-(--color-text-3)">{row.seq}</TableCell>
			</TableRow>
			{expanded ? (
				<TableRow className="hover:bg-transparent">
					<TableCell colSpan={6} className="pt-0">
						<pre className="max-h-96 overflow-auto rounded-sm border border-(--color-border) bg-(--color-bg) p-3 font-mono text-xs text-(--color-text-2)">
							{row.payload === undefined ? "—" : (JSON.stringify(row.payload, null, 2) ?? "—")}
						</pre>
					</TableCell>
				</TableRow>
			) : null}
		</Fragment>
	);
}

export function EventTable({
	rows,
	expandedId,
	selected,
	setRef,
	onToggle,
	now,
}: {
	rows: readonly EventExplorerRow[];
	expandedId: number | null;
	selected: number | null;
	setRef: (i: number) => (el: HTMLElement | null) => void;
	onToggle: (id: number) => void;
	now: number;
}) {
	return (
		<Table>
			<TableHeader>
				<TableRow>
					<TableHead className="w-8 pr-0">
						<span className="sr-only">Expand</span>
					</TableHead>
					<TableHead>Time</TableHead>
					<TableHead>Kind</TableHead>
					<TableHead>Run</TableHead>
					<TableHead>Summary</TableHead>
					<TableHead className="text-right">Seq</TableHead>
				</TableRow>
			</TableHeader>
			<TableBody>
				{rows.map((row, i) => (
					<EventRow
						key={row.id}
						row={row}
						expanded={expandedId === row.id}
						selected={selected === i}
						onToggle={() => onToggle(row.id)}
						rowRef={setRef(i)}
						now={now}
					/>
				))}
			</TableBody>
		</Table>
	);
}
