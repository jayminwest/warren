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
import { INBOX_STATES, type InboxState, RUN_STATES, type RunState } from "../schema.ts";
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

/**
 * Cost aggregate over runs created at-or-after `sinceEpochMs` (warren-d850 /
 * pl-7e38 step 12 — the ops-overview spend-rate section). `runs.created_at`
 * is epoch-ms stamped at insert (warren-0af9); NULL rows (pre-column legacy)
 * are excluded, never folded in as zero-cost runs. One aggregate query.
 */
export async function aggregateRunCostSince(
	adapter: DrizzleAdapter,
	sinceEpochMs: number,
): Promise<RunCostAggregate> {
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
			.from(runs)
			.where(sql`${runs.createdAt} is not null and ${runs.createdAt} >= ${sinceEpochMs}`),
	);
	return {
		costUsd: Number(row?.costUsd ?? 0),
		tokensInput: Number(row?.tokensInput ?? 0),
		tokensOutput: Number(row?.tokensOutput ?? 0),
	};
}

/**
 * Delivery facts for the ops-overview snapshot (warren-d850): branch pushes
 * that landed commits (commits_ahead > 0 — the reap-measured outcome fact),
 * PRs opened (pr_url set by reap's pr_open step), and PRs merged
 * (pr_merged_at set by the merge watcher). One aggregate query with FILTER
 * clauses; NULL reads as "not delivered", never as zero-delivered.
 */
export interface RunDeliveryStats {
	readonly branchesPushed: number;
	readonly prsOpened: number;
	readonly prsMerged: number;
}

export async function countRunDeliveryStats(adapter: DrizzleAdapter): Promise<RunDeliveryStats> {
	const db = adapter.drizzle as SqliteDrizzleDb;
	const runs = adapter.schema.runs;
	const [row] = await adapter.pickAll<{
		branchesPushed: number | string;
		prsOpened: number | string;
		prsMerged: number | string;
	}>(
		db
			.select({
				branchesPushed:
					sql<number>`count(*) filter (where ${runs.commitsAhead} is not null and ${runs.commitsAhead} > 0)`.as(
						"branches_pushed",
					),
				prsOpened: sql<number>`count(*) filter (where ${runs.prUrl} is not null)`.as("prs_opened"),
				prsMerged: sql<number>`count(*) filter (where ${runs.prMergedAt} is not null)`.as(
					"prs_merged",
				),
			})
			.from(runs),
	);
	return {
		branchesPushed: Number(row?.branchesPushed ?? 0),
		prsOpened: Number(row?.prsOpened ?? 0),
		prsMerged: Number(row?.prsMerged ?? 0),
	};
}

/**
 * Steering-inbox rows grouped by delivery state (warren-d850 — the
 * ops-overview pending-interventions section). Dense record over
 * INBOX_STATES: absent states read 0 so the snapshot shape is stable
 * poll-to-poll. One `GROUP BY state` query.
 */
export async function countRunInboxByState(
	adapter: DrizzleAdapter,
): Promise<Record<InboxState, number>> {
	const db = adapter.drizzle as SqliteDrizzleDb;
	const runInbox = adapter.schema.runInbox;
	const rows = await adapter.pickAll<{ state: InboxState; count: number | string }>(
		db
			.select({ state: runInbox.state, count: sql<number>`count(*)`.as("count") })
			.from(runInbox)
			.groupBy(runInbox.state),
	);
	const out = Object.fromEntries(INBOX_STATES.map((s) => [s, 0])) as Record<InboxState, number>;
	for (const r of rows) out[r.state] = Number(r.count);
	return out;
}
