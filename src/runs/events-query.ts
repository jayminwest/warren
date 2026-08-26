/**
 * Global events query (pl-7e38 step 15 / warren-5eec) — the cross-run
 * search behind `GET /events`, for the operator console's Event explorer.
 *
 * The per-run surfaces (`GET /runs/:id/events`, `GET /plan-runs/:id/events`)
 * replay one run's transcript; this module queries the same `events` table
 * ACROSS runs. Everything that can be filtered is filtered in SQL — the
 * where clauses ride the existing indexes (`events_run_seq_idx` for a run
 * filter, `events_kind_ts_idx` for a kind filter) and the page is bounded
 * by `limit`, so no poll ever walks the whole table.
 *
 * Ordering is `id DESC` (newest-first). `events.id` is the append
 * monotone, so descending is the same as reverse-chronological without a
 * sort — and `limit` + `offset` slice it exactly the way `GET /runs`
 * paginates (`?limit` capped at 500, `?offset` non-negative).
 */

import { and, desc, eq, gte, lte, sql } from "drizzle-orm";
import type { EventStream } from "../core/wire.ts";
import type { SqliteDrizzleDb } from "../db/client.ts";
import type { DrizzleAdapter } from "../db/repos/drizzle-adapter.ts";
import type { EventRow } from "../db/schema.ts";

/** Page-size defaults and hard cap, matching the runs list. */
export const EVENTS_QUERY_DEFAULT_LIMIT = 100;
export const EVENTS_QUERY_MAX_LIMIT = 500;

/** Every filter `GET /events` accepts; all optional. */
export interface EventsQueryFilter {
	/** Run id — rides `events_run_seq_idx`. */
	readonly runId?: string;
	/** Project id — inner join through `runs`. */
	readonly projectId?: string;
	/** Event kind (open string: the harness vocabulary warren does not gate). */
	readonly kind?: string;
	/** Event stream, one of the canonical `EVENT_STREAMS` (validated upstream). */
	readonly stream?: EventStream;
	/** Inclusive lower bound on `ts` (ISO8601). */
	readonly since?: string;
	/** Inclusive upper bound on `ts` (ISO8601). */
	readonly until?: string;
}

/** A resolved page request. */
export interface EventsQueryPage {
	readonly limit: number;
	readonly offset: number;
}

export interface EventsQueryResult {
	readonly rows: EventRow[];
	/** Total rows matching the filter, ignoring limit/offset. */
	readonly total: number;
}

function buildWhere(adapter: DrizzleAdapter, filter: EventsQueryFilter) {
	const events = adapter.schema.events;
	const runs = adapter.schema.runs;
	const clauses = [];
	if (filter.runId !== undefined) clauses.push(eq(events.runId, filter.runId));
	if (filter.kind !== undefined) clauses.push(eq(events.kind, filter.kind));
	if (filter.stream !== undefined) clauses.push(eq(events.stream, filter.stream));
	if (filter.since !== undefined) clauses.push(gte(events.ts, filter.since));
	if (filter.until !== undefined) clauses.push(lte(events.ts, filter.until));
	if (filter.projectId !== undefined) clauses.push(eq(runs.projectId, filter.projectId));
	return clauses.length > 0 ? and(...clauses) : undefined;
}

/**
 * Query one page of events plus the filtered total. The `projectId` filter
 * rides an inner join through `runs`; every other predicate is a direct
 * column compare. Both the page query and the count share one `WHERE`,
 * so `total` and `rows` can never disagree about what matched.
 */
export async function queryGlobalEvents(
	adapter: DrizzleAdapter,
	filter: EventsQueryFilter,
	page: EventsQueryPage,
): Promise<EventsQueryResult> {
	// Same typed-as-sqlite convention as EventsRepo: both dialect modules
	// share structurally identical column shapes and the adapter dispatches
	// the terminators dialect-correctly.
	const db = adapter.drizzle as SqliteDrizzleDb;
	const events = adapter.schema.events;
	const runs = adapter.schema.runs;
	const where = buildWhere(adapter, filter);

	const eventColumns = {
		id: events.id,
		runId: events.runId,
		sandboxEventSeq: events.sandboxEventSeq,
		ts: events.ts,
		kind: events.kind,
		stream: events.stream,
		origin: events.origin,
		payloadJson: events.payloadJson,
	} as const;
	// Explicit column list, not `select()`: a joined select() nests rows under
	// the table key ({events: {...}}), and the page must stay flat `EventRow`s
	// whether or not the project filter joined `runs` in.
	const withJoin =
		filter.projectId === undefined
			? db.select(eventColumns).from(events)
			: db.select(eventColumns).from(events).innerJoin(runs, eq(events.runId, runs.id));
	const rows = await adapter.pickAll(
		(where !== undefined ? withJoin.where(where) : withJoin)
			.orderBy(desc(events.id))
			.limit(page.limit)
			.offset(page.offset),
	);

	const countWithJoin =
		filter.projectId === undefined
			? db.select({ n: sql<number>`count(*)`.as("n") }).from(events)
			: db
					.select({ n: sql<number>`count(*)`.as("n") })
					.from(events)
					.innerJoin(runs, eq(events.runId, runs.id));
	const [countRow] = await adapter.pickAll<{ n: number | string }>(
		where !== undefined ? countWithJoin.where(where) : countWithJoin,
	);
	return { rows, total: Number(countRow?.n ?? 0) };
}
