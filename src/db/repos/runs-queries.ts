/**
 * Read/query run methods (warren-ac7f), extracted from `RunsRepo` to keep
 * `runs.ts` under the file-size budget. Mirrors the `runs-ci-fixer.ts` /
 * `runs-stats.ts` precedent: each method becomes a free function taking the
 * `DrizzleAdapter` as its first argument, and `RunsRepo` delegates to it so
 * the call surface is unchanged.
 */

import {
	and,
	asc,
	desc,
	eq,
	gte,
	inArray,
	isNotNull,
	isNull,
	lte,
	or,
	type SQL,
	sql,
} from "drizzle-orm";
import type { SqliteDrizzleDb } from "../client.ts";
import type { RunRow, RunState } from "../schema.ts";
import type { DrizzleAdapter } from "./drizzle-adapter.ts";

type RunsTable = DrizzleAdapter["schema"]["runs"];

/**
 * Order key for the listAll / listByProject / listByAgent triplet
 * (warren-fd4b). 'started' = startedAt DESC, the historical default
 * (covered by runsProjectStarted). 'cost' = costUsd, with explicit
 * NULLS LAST in both directions so unbilled runs always sink — the
 * "spot expensive runs" goal cares about the populated tail, and a
 * pile of NULLs at the top of a DESC sort would defeat the feature.
 * id ASC remains the stable tiebreaker.
 */
function orderByClause(
	runs: RunsTable,
	sort: "started" | "cost" = "started",
	dir: "asc" | "desc" = "desc",
): SQL[] {
	if (sort === "cost") {
		const col = runs.costUsd;
		const primary = dir === "asc" ? sql`${col} ASC NULLS LAST` : sql`${col} DESC NULLS LAST`;
		return [primary, asc(runs.id)];
	}
	const col = runs.startedAt;
	return [dir === "asc" ? asc(col) : desc(col), asc(runs.id)];
}

export async function listAll(
	adapter: DrizzleAdapter,
	options: {
		limit?: number;
		offset?: number;
		sort?: "started" | "cost";
		dir?: "asc" | "desc";
	} = {},
): Promise<RunRow[]> {
	const db = adapter.drizzle as SqliteDrizzleDb;
	const runs = adapter.schema.runs;
	const { limit = 100, offset = 0, sort = "started", dir = "desc" } = options;
	return adapter.pickAll(
		db
			.select()
			.from(runs)
			.orderBy(...orderByClause(runs, sort, dir))
			.limit(limit)
			.offset(offset),
	);
}

export async function listByProject(
	adapter: DrizzleAdapter,
	projectId: string,
	options: {
		limit?: number;
		offset?: number;
		sort?: "started" | "cost";
		dir?: "asc" | "desc";
	} = {},
): Promise<RunRow[]> {
	const db = adapter.drizzle as SqliteDrizzleDb;
	const runs = adapter.schema.runs;
	const { limit = 100, offset = 0, sort = "started", dir = "desc" } = options;
	return adapter.pickAll(
		db
			.select()
			.from(runs)
			.where(eq(runs.projectId, projectId))
			.orderBy(...orderByClause(runs, sort, dir))
			.limit(limit)
			.offset(offset),
	);
}

export async function listByAgent(
	adapter: DrizzleAdapter,
	agentName: string,
	options: {
		limit?: number;
		offset?: number;
		sort?: "started" | "cost";
		dir?: "asc" | "desc";
	} = {},
): Promise<RunRow[]> {
	const db = adapter.drizzle as SqliteDrizzleDb;
	const runs = adapter.schema.runs;
	const { limit = 100, offset = 0, sort = "started", dir = "desc" } = options;
	return adapter.pickAll(
		db
			.select()
			.from(runs)
			.where(eq(runs.agentName, agentName))
			.orderBy(...orderByClause(runs, sort, dir))
			.limit(limit)
			.offset(offset),
	);
}

/**
 * Filtered-set aggregates for the Runs page header (warren-ee50 /
 * pl-b0c0 step 1). Returns the full `total` count + cost rollup for the
 * same predicate the list*() siblings page over. `costTotalUsd` sums
 * runs.cost_usd where non-null; `costPricedCount` counts those rows.
 * Ghost runs whose cost is only recoverable via in-stream extraction
 * (hydrateRunsUsage) are NOT folded in — a deliberate trade-off to keep
 * the header cheap (single DB pass) at a small underestimate.
 */
export async function aggregate(
	adapter: DrizzleAdapter,
	filter: { projectId?: string; agentName?: string } = {},
): Promise<{
	total: number;
	costTotalUsd: number;
	costPricedCount: number;
}> {
	const db = adapter.drizzle as SqliteDrizzleDb;
	const runs = adapter.schema.runs;
	const conds: SQL[] = [];
	if (filter.projectId !== undefined) {
		conds.push(eq(runs.projectId, filter.projectId));
	}
	if (filter.agentName !== undefined) {
		conds.push(eq(runs.agentName, filter.agentName));
	}
	const where = conds.length === 0 ? undefined : conds.length === 1 ? conds[0] : and(...conds);
	const baseQuery = db
		.select({
			total: sql<number>`count(*)`,
			costTotalUsd: sql<number | null>`sum(${runs.costUsd})`,
			costPricedCount: sql<number>`count(${runs.costUsd})`,
		})
		.from(runs);
	const rows = await adapter.pickAll(where === undefined ? baseQuery : baseQuery.where(where));
	const row = rows[0];
	return {
		total: Number(row?.total ?? 0),
		costTotalUsd: Number(row?.costTotalUsd ?? 0),
		costPricedCount: Number(row?.costPricedCount ?? 0),
	};
}

/**
 * Filtered listing for the cost analytics endpoint (warren-cf63 /
 * pl-b0c0 step 6). `from`/`to` clip on `startedAt` as ISO8601 strings
 * (lexicographic == chronological). Both optional; omitting both returns
 * every row (the endpoint defaults to the last 30 days). Rows with a null
 * `startedAt` are excluded when either bound is set, mirroring SQL.
 * Capped at {@link ANALYTICS_MAX_ROWS} as defence in depth: the handler
 * already bounds the window (warren-30cc), but a caller that reaches
 * this repo directly still can't pull the whole table.
 */
export const ANALYTICS_MAX_ROWS = 10_000;

export async function listForAnalytics(
	adapter: DrizzleAdapter,
	filter: { projectId?: string; from?: string; to?: string } = {},
): Promise<RunRow[]> {
	const db = adapter.drizzle as SqliteDrizzleDb;
	const runs = adapter.schema.runs;
	const conds: SQL[] = [];
	if (filter.projectId !== undefined) {
		conds.push(eq(runs.projectId, filter.projectId));
	}
	if (filter.from !== undefined) {
		conds.push(gte(runs.startedAt, filter.from));
	}
	if (filter.to !== undefined) {
		conds.push(lte(runs.startedAt, filter.to));
	}
	const where = conds.length === 0 ? undefined : conds.length === 1 ? conds[0] : and(...conds);
	const baseQuery = db.select().from(runs);
	const filtered = where === undefined ? baseQuery : baseQuery.where(where);
	return adapter.pickAll(filtered.orderBy(desc(runs.startedAt)).limit(ANALYTICS_MAX_ROWS));
}

/**
 * Fetch the rows matching `ids` in a single query. Missing ids are
 * silently omitted — the caller decides whether a partial result is
 * an error. Used by `GET /plan-runs/:id` (warren-f923) to fan child
 * runIds out into the detail payload without an N+1 round-trip.
 */
export async function listByIds(
	adapter: DrizzleAdapter,
	ids: readonly string[],
): Promise<RunRow[]> {
	if (ids.length === 0) return [];
	const db = adapter.drizzle as SqliteDrizzleDb;
	const runs = adapter.schema.runs;
	return adapter.pickAll(
		db
			.select()
			.from(runs)
			.where(inArray(runs.id, ids as string[])),
	);
}

export async function listByState(
	adapter: DrizzleAdapter,
	state: RunState | RunState[],
): Promise<RunRow[]> {
	const db = adapter.drizzle as SqliteDrizzleDb;
	const runs = adapter.schema.runs;
	const where = Array.isArray(state) ? inArray(runs.state, state) : eq(runs.state, state);
	return adapter.pickAll(db.select().from(runs).where(where).orderBy(asc(runs.id)));
}

/**
 * The retry run a `sandbox_run_lost` original spawned (warren-4af7), if any.
 * At most one row can exist — the retry decision checks this before
 * dispatching — so a `pickOne` read is exact.
 */
export async function findByRetryOf(
	adapter: DrizzleAdapter,
	runId: string,
): Promise<RunRow | null> {
	const db = adapter.drizzle as SqliteDrizzleDb;
	const runs = adapter.schema.runs;
	const row = await adapter.pickOne(db.select().from(runs).where(eq(runs.retryOf, runId)));
	return row ?? null;
}

/**
 * Runs whose PR the merge watcher still has to settle (warren-3bc6):
 * `pr_url` is set and `pr_state` is not yet terminal (NULL — never polled,
 * or a historical row — or `open`). Boot re-adoption enumerates these so a
 * restart never orphans an in-flight poll.
 */
export async function listWithUnresolvedPr(adapter: DrizzleAdapter): Promise<RunRow[]> {
	const db = adapter.drizzle as SqliteDrizzleDb;
	const runs = adapter.schema.runs;
	return adapter.pickAll(
		db
			.select()
			.from(runs)
			.where(and(isNotNull(runs.prUrl), or(isNull(runs.prState), eq(runs.prState, "open"))))
			.orderBy(asc(runs.id)),
	);
}
