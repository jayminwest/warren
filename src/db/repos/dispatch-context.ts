/**
 * Repository for the `dispatch_context` fact table (warren-36e7 / pl-a37b
 * Track A).
 *
 * One insert-only row per dispatched run, keyed by `run_id`. The writer
 * (warren-d6ca) lives beside spawnRun and calls {@link insert} immediately
 * after the runs row lands — before any runtime contact — so never-started
 * failures still get a row. This module deliberately exposes no UPDATE
 * path: the row is a dispatch-time snapshot, not a live projection.
 *
 * Facts only. NULL means unknown, never a bucket. No derived scores.
 */

import { and, desc, eq, gte, inArray, lte, type SQL } from "drizzle-orm";
import type { PullRequestLifecycle, RunFailureReason, RunState } from "../../core/wire.ts";
import type { SqliteDrizzleDb } from "../client.ts";
import type { DispatchContextInsert, DispatchContextRow } from "../schema.ts";
import type { DrizzleAdapter } from "./drizzle-adapter.ts";
import { ANALYTICS_MAX_ROWS } from "./runs-queries.ts";

/**
 * Input for {@link DispatchContextRepo.insert}. Mirrors the table columns
 * minus nothing — every field the writer can observe is optional so a
 * partial snapshot still lands rather than failing the fire-and-log path.
 * `runId` and `createdAt` are required so the PK and analytics window are
 * always present.
 */
export type InsertDispatchContextInput = DispatchContextInsert;

/**
 * Joined dispatch_context × runs row for the analytics report (warren-5423).
 * Shape matches `DispatchAnalyticsRow` in `src/runs/analytics/dispatch-analytics.ts`
 * — defined here so the repo does not import the pure aggregator module.
 */
export interface DispatchContextAnalyticsRow {
	readonly runId: string;
	readonly createdAt: string;
	readonly agentName: string | null;
	readonly provider: string | null;
	readonly model: string | null;
	readonly dispatchOrigin: string | null;
	readonly retryKind: string | null;
	readonly queueQueuedRuns: number | null;
	readonly queueRunningRuns: number | null;
	readonly queueProjectNonTerminal: number | null;
	readonly projectId: string | null;
	readonly state: RunState;
	readonly failureReason: RunFailureReason | null;
	readonly costUsd: number | null;
	readonly prState: PullRequestLifecycle | null;
}

/**
 * Per-run dispatch facts the runs list overlays onto its projected rows
 * (warren-a0f4): the USD spend cap plus the runtime backend kind
 * (`local` | `docker` | `k8s`) frozen pre-spawn. NULL means unknown
 * (no dispatch-context row, or a row written before the column).
 */
export interface DispatchFacts {
	readonly maxCostUsd: number | null;
	readonly runtimeBackend: string | null;
}

export class DispatchContextRepo {
	constructor(private readonly adapter: DrizzleAdapter) {}

	private get db(): SqliteDrizzleDb {
		return this.adapter.drizzle as SqliteDrizzleDb;
	}

	private get dispatchContext() {
		return this.adapter.schema.dispatchContext;
	}

	/**
	 * Insert one dispatch-context row. Idempotent on `run_id` — a second
	 * insert for the same run is a no-op (ON CONFLICT DO NOTHING) so a
	 * retried spawn path cannot dupe the snapshot. Returns the persisted
	 * row when the insert landed, or `null` when a row already existed.
	 * Uses {@link DrizzleAdapter.runReturningAll} (not One) because a
	 * conflict no-op yields zero rows and One would throw.
	 */
	async insert(input: InsertDispatchContextInput): Promise<DispatchContextRow | null> {
		const inserted = await this.adapter.runReturningAll<DispatchContextRow>(
			this.db.insert(this.dispatchContext).values(input).onConflictDoNothing().returning(),
		);
		return inserted[0] ?? null;
	}

	/** Fetch the snapshot for one run, or `undefined` when none was written. */
	async getByRunId(runId: string): Promise<DispatchContextRow | undefined> {
		return await this.adapter.pickOne<DispatchContextRow>(
			this.db.select().from(this.dispatchContext).where(eq(this.dispatchContext.runId, runId)),
		);
	}

	/** Widened from getMaxCostUsdByRunIds (warren-a0f4) to carry runtimeBackend too. */
	async getDispatchFactsByRunIds(runIds: readonly string[]): Promise<Map<string, DispatchFacts>> {
		const facts = new Map<string, DispatchFacts>();
		if (runIds.length === 0) return facts;
		const dc = this.dispatchContext;
		const rows = await this.adapter.pickAll<{
			runId: string;
			maxCostUsd: number | null;
			runtimeBackend: string | null;
		}>(
			this.db
				.select({ runId: dc.runId, maxCostUsd: dc.maxCostUsd, runtimeBackend: dc.runtimeBackend })
				.from(dc)
				.where(inArray(dc.runId, [...runIds])),
		);
		for (const row of rows) {
			facts.set(row.runId, { maxCostUsd: row.maxCostUsd, runtimeBackend: row.runtimeBackend });
		}
		return facts;
	}

	/**
	 * Joined listing for `GET /analytics/dispatch` (warren-5423).
	 *
	 * Windows on `dispatch_context.created_at`, NOT `runs.started_at`.
	 * `RunsRepo.listForAnalytics` clips on `started_at` and silently drops
	 * never-started dispatches — the rows this report most needs. Optional
	 * `projectId` filters via the joined runs row. Capped at
	 * {@link ANALYTICS_MAX_ROWS}. Ordered newest-first by created_at.
	 */
	async listForAnalytics(
		filter: { projectId?: string; from?: string; to?: string } = {},
	): Promise<DispatchContextAnalyticsRow[]> {
		const runs = this.adapter.schema.runs;
		const dc = this.dispatchContext;
		const conds: SQL[] = [];
		if (filter.projectId !== undefined) {
			conds.push(eq(runs.projectId, filter.projectId));
		}
		if (filter.from !== undefined) {
			conds.push(gte(dc.createdAt, filter.from));
		}
		if (filter.to !== undefined) {
			conds.push(lte(dc.createdAt, filter.to));
		}
		const where = conds.length === 0 ? undefined : conds.length === 1 ? conds[0] : and(...conds);
		const base = this.db
			.select({
				runId: dc.runId,
				createdAt: dc.createdAt,
				agentName: dc.agentName,
				provider: dc.provider,
				model: dc.model,
				dispatchOrigin: dc.dispatchOrigin,
				retryKind: dc.retryKind,
				queueQueuedRuns: dc.queueQueuedRuns,
				queueRunningRuns: dc.queueRunningRuns,
				queueProjectNonTerminal: dc.queueProjectNonTerminal,
				projectId: runs.projectId,
				state: runs.state,
				failureReason: runs.failureReason,
				costUsd: runs.costUsd,
				prState: runs.prState,
			})
			.from(dc)
			.innerJoin(runs, eq(runs.id, dc.runId));
		const filtered = where === undefined ? base : base.where(where);
		return this.adapter.pickAll(filtered.orderBy(desc(dc.createdAt)).limit(ANALYTICS_MAX_ROWS));
	}
}
