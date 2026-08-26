import type { EventsQueryFilterUI } from "../api/client.ts";
import type { EVENT_STREAMS } from "../api/types.ts";

/**
 * Event-explorer data plumbing (warren-24b9): filter-object assembly and
 * the paged export collector. Split out of the page component so the
 * page stays under the repo's cognitive-complexity budget.
 */

export interface FilterState {
	readonly stream: string;
	readonly kind: string;
	readonly runId: string;
	readonly projectId: string;
	readonly rangeId: string;
}

/** Build the API filter object from the strip's UI state. */
export function buildFilter(state: FilterState): EventsQueryFilterUI {
	const filter: EventsQueryFilterUI = {};
	if (state.stream !== "all") filter.stream = state.stream as (typeof EVENT_STREAMS)[number];
	if (state.kind.length > 0) filter.kind = state.kind;
	if (state.runId.length > 0) filter.runId = state.runId;
	if (state.projectId.length > 0) filter.projectId = state.projectId;
	return filter;
}

/** Export cap: 25 pages × the API's 500-row hard limit. */
export const EXPORT_MAX_ROWS = 25 * 500;

export interface EventPage {
	readonly events: readonly unknown[];
	readonly total: number;
}

export interface ExportResult {
	readonly lines: string[];
	readonly capped: boolean;
}

/**
 * Walk `GET /events` pages (newest-first) collecting one ndjson line per
 * row, stopping at the end of the filtered set or the export cap. Each
 * page is a bounded read — the collector never holds a stream open.
 */
export async function collectExportLines(
	fetchPage: (offset: number) => Promise<EventPage>,
): Promise<ExportResult> {
	const lines: string[] = [];
	let cursor = 0;
	for (let i = 0; i < 25; i++) {
		const page = await fetchPage(cursor);
		for (const row of page.events) lines.push(JSON.stringify(row));
		cursor += page.events.length;
		if (page.events.length === 0 || cursor >= page.total || cursor >= EXPORT_MAX_ROWS) {
			break;
		}
	}
	return { lines, capped: lines.length >= EXPORT_MAX_ROWS };
}
