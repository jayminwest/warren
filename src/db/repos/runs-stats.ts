/**
 * Operational-stats run aggregates (warren-b2dd / pl-f700 step 6),
 * extracted from `RunsRepo` to keep `runs.ts` under the file-size
 * budget. `RunsRepo` delegates its `countByState` / `aggregateCost`
 * methods here so the call surface is unchanged. Both feed the periodic
 * `ops.stats` log line and run as single aggregate queries — they never
 * load run bodies.
 */

import { and, eq, inArray, sql } from "drizzle-orm";
import type { SqliteDrizzleDb } from "../client.ts";
import { RUN_STATES, type RunState } from "../schema.ts";
import type { DrizzleAdapter } from "./drizzle-adapter.ts";

/** Lifecycle states that still occupy a queue/admission slot. */
const NON_TERMINAL_STATES = ["queued", "running"] as const satisfies readonly RunState[];

/** Cost + token totals across all runs. */
export interface RunCostAggregate {
	readonly costUsd: number;
	readonly tokensInput: number;
	readonly tokensOutput: number;
}

/**
 * Count every run grouped by lifecycle state. Returns a dense record —
 * states with zero rows are present as `0` so the log shape is stable
 * tick-to-tick. One `GROUP BY state` query.
 */
export async function countRunsByState(adapter: DrizzleAdapter): Promise<Record<RunState, number>> {
	const db = adapter.drizzle as SqliteDrizzleDb;
	const runs = adapter.schema.runs;
	const rows = await adapter.pickAll<{ state: RunState; count: number | string }>(
		db
			.select({ state: runs.state, count: sql<number>`count(*)`.as("count") })
			.from(runs)
			.groupBy(runs.state),
	);
	const out = Object.fromEntries(RUN_STATES.map((s) => [s, 0])) as Record<RunState, number>;
	for (const r of rows) out[r.state] = Number(r.count);
	return out;
}

/**
 * Sum the persisted cost + token columns across every run. Nulls (non-pi
 * runs, or pi runs whose stats RPC failed) coalesce to 0. One aggregate
 * query; backs the cost panel of the operational-stats log line.
 */
/**
 * Count non-terminal runs (`queued` + `running`) for the dispatch-context
 * queue snapshot (warren-e1f1). Instance-wide when `projectId` is omitted;
 * scoped to one project otherwise. Source is the runs table — not the k8s
 * admission gate's in-memory pod counts, which never reach the dispatch site.
 */
export async function countNonTerminal(
	adapter: DrizzleAdapter,
	projectId?: string,
): Promise<number> {
	const db = adapter.drizzle as SqliteDrizzleDb;
	const runs = adapter.schema.runs;
	const stateCond = inArray(runs.state, [...NON_TERMINAL_STATES]);
	const where = projectId === undefined ? stateCond : and(stateCond, eq(runs.projectId, projectId));
	const [row] = await adapter.pickAll<{ count: number | string }>(
		db
			.select({ count: sql<number>`count(*)`.as("count") })
			.from(runs)
			.where(where),
	);
	return Number(row?.count ?? 0);
}

export async function aggregateRunCost(adapter: DrizzleAdapter): Promise<RunCostAggregate> {
	const db = adapter.drizzle as SqliteDrizzleDb;
	const runs = adapter.schema.runs;
	const [row] = await adapter.pickAll<{
		costUsd: number | string | null;
		tokensInput: number | string | null;
		tokensOutput: number | string | null;
	}>(
		db
			.select({
				costUsd: sql<number>`coalesce(sum(${runs.costUsd}), 0)`.as("cost_usd"),
				tokensInput: sql<number>`coalesce(sum(${runs.tokensInput}), 0)`.as("tokens_input"),
				tokensOutput: sql<number>`coalesce(sum(${runs.tokensOutput}), 0)`.as("tokens_output"),
			})
			.from(runs),
	);
	return {
		costUsd: Number(row?.costUsd ?? 0),
		tokensInput: Number(row?.tokensInput ?? 0),
		tokensOutput: Number(row?.tokensOutput ?? 0),
	};
}
