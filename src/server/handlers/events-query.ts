/**
 * Global events query handler — `GET /events` (pl-7e38 step 15 /
 * warren-5eec). Thin surface over `queryGlobalEvents`
 * (`src/runs/events-query.ts`); this file only parses/validates the query
 * string and applies the public projection.
 *
 * Public projection: the route is `readPublic`, so a `WARREN_AUTH=public`
 * spectator reaches it — and every row is narrowed through the SAME
 * `projectedWireEvent` the per-run NDJSON stream uses
 * (`./runs/event-projection.ts`, warren-1cb7): internal kinds dropped
 * whole, raw-failure payloads split to body/marker, secrets scrubbed. A
 * spectator sees exactly what the per-run public stream would show for
 * each row, never more — the wire object is the same eight-key allowlist
 * the NDJSON encoder emits.
 *
 * Pagination is `?limit`/`?offset` — the `GET /runs` pattern
 * (`parseRunsPagination`), with the same 500-row hard cap, so a spectator
 * poll can never ask for a page big enough to matter as a scan. Time
 * bounds reuse the analytics date parser.
 */

import { ValidationError } from "../../core/errors.ts";
import { EVENT_STREAMS } from "../../core/wire.ts";
import { type EventsQueryFilter, queryGlobalEvents } from "../../runs/events-query.ts";
import { jsonResponse } from "../response.ts";
import type { RouteHandler, ServerDeps } from "../types.ts";
import { projectedWireEvent, type WireEventRow } from "./runs/event-projection.ts";

/** One event as it appears on the wire — the NDJSON line keys, as JSON. */
export type QueriedEvent = import("./runs/event-projection.ts").WireEvent;

import { parseAnalyticsDateBound, parseRunsPagination } from "./runs/lifecycle.ts";

/**
 * Parse the filter params. Unknown/empty params are ignored; `stream` is
 * validated against the canonical `EVENT_STREAMS` vocabulary from
 * `src/core/wire.ts` (the single copy — nothing here re-declares it).
 */
function parseFilter(ctx: { url: URL }): EventsQueryFilter {
	const p = ctx.url.searchParams;
	const filter: {
		projectId?: string;
		runId?: string;
		kind?: string;
		stream?: string;
		since?: string;
		until?: string;
	} = {};
	const project = p.get("project");
	if (project !== null && project !== "") filter.projectId = project;
	const run = p.get("run");
	if (run !== null && run !== "") filter.runId = run;
	const kind = p.get("kind");
	if (kind !== null && kind !== "") filter.kind = kind;
	const stream = p.get("stream");
	if (stream !== null && stream !== "") {
		if (!(EVENT_STREAMS as readonly string[]).includes(stream)) {
			throw new ValidationError(
				`?stream must be one of ${EVENT_STREAMS.join(", ")}; got '${stream}'`,
			);
		}
		filter.stream = stream;
	}
	const since = p.get("since");
	if (since !== null && since !== "") filter.since = parseAnalyticsDateBound(ctx, "since");
	const until = p.get("until");
	if (until !== null && until !== "") filter.until = parseAnalyticsDateBound(ctx, "until");
	return filter as EventsQueryFilter;
}

export function listEventsHandler(deps: ServerDeps): RouteHandler {
	return async (ctx) => {
		const filter = parseFilter(ctx);
		const page = parseRunsPagination(ctx);
		const adapter = deps.dbAdapter;
		const { rows, total } =
			adapter === undefined
				? { rows: [] as WireEventRow[], total: 0 }
				: await queryGlobalEvents(adapter, filter, page);
		const events: QueriedEvent[] = [];
		for (const row of rows) {
			const mapped = projectedWireEvent(row, ctx.actor);
			if (mapped !== null) events.push(mapped);
		}
		// Body varies with Authorization (the projection drops/narrows rows
		// for spectators); Vary keeps a shared cache honest about that.
		return jsonResponse(
			200,
			{ events, total, limit: page.limit, offset: page.offset },
			{
				headers: { vary: "Authorization" },
			},
		);
	};
}
