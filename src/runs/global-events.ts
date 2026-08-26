/**
 * Global events query (pl-7e38 step 15 / warren-5eec).
 *
 * The cross-run backing query for `GET /events` — the Event explorer
 * page's (warren-24b9) server surface. One bounded, newest-first page
 * over the whole `events` table with every filter pushed into SQL so an
 * operator console poll never walks rows in JS:
 *
 * - `runId` / `stream` / `kind` narrow with equality predicates
 *   (`events_run_seq_idx` / `events_run_ts_idx` / `events_kind_ts_idx`
 *   keep them index-friendly).
 * - `since` / `until` bound the `ts` text column lexicographically
 *   (ISO8601), the same compare the analytics windows rely on.
 * - `projectId` filters through an inner join on `runs`.
 * - `limit` is hard-capped and `offset` pages forward, the same
 *   `?limit`/`?offset` contract `GET /runs` uses.
 *
 * Ordering is `ts DESC, id DESC` (newest first, `id` as the total-order
 * tiebreaker), so the explorer's default view is "what just happened"
 * without scanning past the page. `total` comes back alongside the page
 * from a second `count(*)` over the identical predicate set, matching
 * the `/runs` list envelope.
 */

import { and, desc, eq, gte, lte, notInArray, type SQL, sql } from "drizzle-orm";
import type { EventStream } from "../core/wire.ts";
import type { SqliteDrizzleDb } from "../db/client.ts";
import type { DrizzleAdapter } from "../db/repos/drizzle-adapter.ts";
import type { EventRow } from "../db/schema.ts";

/** The row shape `GET /events` serves, re-exported for the handler seam. */
export type GlobalEventRow = EventRow;

/** Default page size when the caller sends no `?limit`. */
export const GLOBAL_EVENTS_DEFAULT_LIMIT = 100;
/** Hard ceiling on `?limit` — a poll must never demand the whole table. */
export const GLOBAL_EVENTS_MAX_LIMIT = 500;

/** Normalized filter for the global events query. */
export interface GlobalEventsFilter {
	readonly projectId?: string;
	readonly runId?: string;
	readonly stream?: EventStream;
	readonly kind?: string;
	/** ISO8601 inclusive lower bound on `ts`. */
	readonly since?: string;
	/** ISO8601 inclusive upper bound on `ts`. */
	readonly until?: string;
	/** Event kinds excluded from both the page and the count. */
	readonly excludedKinds?: readonly string[];
	readonly limit: number;
	readonly offset: number;
}

/** Result page: newest-first rows plus the filtered-set row count. */
export interface GlobalEventsPage {
	readonly events: readonly EventRow[];
	readonly total: number;
}

/** Clamp a caller-supplied limit into `[1, GLOBAL_EVENTS_MAX_LIMIT]`. */
export function clampGlobalEventsLimit(raw: number): number {
	if (!Number.isFinite(raw)) return GLOBAL_EVENTS_DEFAULT_LIMIT;
	return Math.min(Math.max(Math.trunc(raw), 1), GLOBAL_EVENTS_MAX_LIMIT);
}

/**
 * Run the query. Ordering is deterministic (`ts DESC, id DESC`), so
 * offset pagination is stable across polls the same way the runs list
 * is. The `runs` join is only emitted when `projectId` is set, so the
 * unfiltered default path stays a single-table scan under the page cap.
 */
export async function queryGlobalEvents(
	adapter: DrizzleAdapter,
	filter: GlobalEventsFilter,
): Promise<GlobalEventsPage> {
	const db = adapter.drizzle as SqliteDrizzleDb;
	const events = adapter.schema.events;
	const runs = adapter.schema.runs;
	const conds: SQL[] = [];
	if (filter.projectId !== undefined) conds.push(eq(runs.projectId, filter.projectId));
	if (filter.runId !== undefined) conds.push(eq(events.runId, filter.runId));
	if (filter.stream !== undefined) conds.push(eq(events.stream, filter.stream));
	if (filter.kind !== undefined) conds.push(eq(events.kind, filter.kind));
	if (filter.since !== undefined) conds.push(gte(events.ts, filter.since));
	if (filter.until !== undefined) conds.push(lte(events.ts, filter.until));
	if (filter.excludedKinds !== undefined && filter.excludedKinds.length > 0) {
		conds.push(notInArray(events.kind, [...filter.excludedKinds]));
	}
	const where = conds.length === 0 ? undefined : conds.length === 1 ? conds[0] : and(...conds);
	const apply = <T extends { where: (c: SQL) => T }>(qb: T): T =>
		where === undefined ? qb : qb.where(where);

	// Explicit column list: the `runs` join (projectId filter) must not
	// change the emitted row shape — consumers see `EventRow` either way.
	const eventColumns = {
		id: events.id,
		runId: events.runId,
		sandboxEventSeq: events.sandboxEventSeq,
		ts: events.ts,
		kind: events.kind,
		stream: events.stream,
		origin: events.origin,
		payloadJson: events.payloadJson,
	};
	const scoped = filter.projectId === undefined;
	const pageQuery = scoped
		? apply(db.select(eventColumns).from(events).$dynamic())
		: apply(
				db.select(eventColumns).from(events).innerJoin(runs, eq(runs.id, events.runId)).$dynamic(),
			);
	const rows = await adapter.pickAll(
		pageQuery.orderBy(desc(events.ts), desc(events.id)).limit(filter.limit).offset(filter.offset),
	);
	const countBase = scoped
		? db.select({ n: sql<number>`count(*)`.as("n") }).from(events)
		: db
				.select({ n: sql<number>`count(*)`.as("n") })
				.from(events)
				.innerJoin(runs, eq(runs.id, events.runId));
	const [countRow] = await adapter.pickAll<{ n: number | string }>(apply(countBase.$dynamic()));
	return { events: rows, total: Number(countRow?.n ?? 0) };
}
