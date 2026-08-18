/**
 * Repository for the `tool_calls` rollup table (warren-7746 / pl-103e step 9).
 *
 * The rollup holds one structured row per `tool_use` event, extracted
 * through the per-runtime shape registries at event-append time (the
 * stream bridge) or by the boot-time backfill. `/analytics/behavior`
 * reads these rows instead of re-parsing raw event payloads under the
 * retired, silently-truncating `DEFAULT_TOOL_EVENT_CAP` scan.
 *
 * Writes come in two shapes:
 *
 *   - {@link recordUse} inserts the tool_use row. Idempotent on
 *     (run_id, seq) — the unique index plus ON CONFLICT DO NOTHING makes a
 *     backfill pass that races a live bridge a no-op instead of a dupe.
 *   - {@link recordResult} joins a tool_result back onto its tool_use row
 *     by (run_id, tool_use_id), filling `is_error` / `result_bytes`. A
 *     result whose tool_use row never landed (bridge attached mid-run)
 *     matches nothing and is dropped, mirroring the old read-time join's
 *     "no matching result ⇒ non-error" semantics in reverse.
 */

import { and, asc, eq, gt, gte, inArray, notExists, sql } from "drizzle-orm";
import type { SqliteDrizzleDb } from "../client.ts";
import type { ToolCallRow } from "../schema.ts";
import type { DrizzleAdapter } from "./drizzle-adapter.ts";

/**
 * Default row cap for {@link ToolCallsRepo.listForRuns}. Bounds the
 * analytics read; unlike the retired event-scan cap, hitting it is
 * REPORTED to the caller via `truncated: true`, never silent.
 */
export const DEFAULT_TOOL_CALL_CAP = 50_000;

export interface RecordToolUseInput {
	readonly runId: string;
	/** sandbox_event_seq of the tool_use event. */
	readonly seq: number;
	readonly ts: string;
	readonly toolName: string | null;
	readonly command: string | null;
	readonly filePaths: readonly string[];
	readonly toolUseId: string | null;
	readonly origin?: string | null;
}

export interface RecordToolResultInput {
	readonly runId: string;
	readonly toolUseId: string;
	readonly isError: boolean;
	readonly resultBytes: number | null;
}

export class ToolCallsRepo {
	constructor(private readonly adapter: DrizzleAdapter) {}

	private get db(): SqliteDrizzleDb {
		return this.adapter.drizzle as SqliteDrizzleDb;
	}

	private get toolCalls() {
		return this.adapter.schema.toolCalls;
	}

	private get events() {
		return this.adapter.schema.events;
	}

	/** Insert one tool_use row; a duplicate (run_id, seq) is a no-op. */
	async recordUse(input: RecordToolUseInput): Promise<void> {
		await this.adapter.runWrite(
			this.db
				.insert(this.toolCalls)
				.values({
					runId: input.runId,
					seq: input.seq,
					ts: input.ts,
					toolName: input.toolName,
					command: input.command,
					filePaths: input.filePaths,
					toolUseId: input.toolUseId,
					origin: input.origin ?? null,
				})
				.onConflictDoNothing(),
		);
	}

	/** Join a tool_result onto its tool_use row; unmatched ids are dropped. */
	async recordResult(input: RecordToolResultInput): Promise<void> {
		await this.adapter.runWrite(
			this.db
				.update(this.toolCalls)
				.set({ isError: input.isError, resultBytes: input.resultBytes })
				.where(
					and(eq(this.toolCalls.runId, input.runId), eq(this.toolCalls.toolUseId, input.toolUseId)),
				),
		);
	}

	/**
	 * Rollup rows across many runs in (runId, seq) order, for the
	 * `/analytics/behavior` command-mining read. Capped at `opts.limit`
	 * (default {@link DEFAULT_TOOL_CALL_CAP}); the read fetches one row
	 * past the cap so truncation is REPORTED in the returned `truncated`
	 * flag — the retired events scan truncated silently (warren-7746).
	 * Empty `runIds` short-circuits without a DB hit.
	 */
	async listForRuns(
		runIds: readonly string[],
		opts: { limit?: number } = {},
	): Promise<{ rows: ToolCallRow[]; truncated: boolean }> {
		if (runIds.length === 0) return { rows: [], truncated: false };
		const limit = opts.limit ?? DEFAULT_TOOL_CALL_CAP;
		const fetched = await this.adapter.pickAll(
			this.db
				.select()
				.from(this.toolCalls)
				.where(inArray(this.toolCalls.runId, runIds as string[]))
				.orderBy(asc(this.toolCalls.runId), asc(this.toolCalls.seq))
				.limit(limit + 1),
		);
		const truncated = fetched.length > limit;
		return { rows: truncated ? fetched.slice(0, limit) : fetched, truncated };
	}

	/**
	 * Run ids that have tool events at or after `sinceTs` but no rollup
	 * rows yet — the backfill candidate set (warren-7746). Bounded by
	 * `limit` so one boot pass never scans more than `limit` run histories;
	 * the next boot picks up another window's worth (incremental by
	 * construction, since a backfilled run leaves the candidate set).
	 */
	async listRunsMissingRollup(opts: { sinceTs: string; limit: number }): Promise<string[]> {
		const rows = await this.adapter.pickAll<{ runId: string }>(
			this.db
				.selectDistinct({ runId: this.events.runId })
				.from(this.events)
				.where(
					and(
						inArray(this.events.kind, ["tool_use", "tool_result"]),
						gte(this.events.ts, opts.sinceTs),
						notExists(
							this.db
								.select({ one: sql`1` })
								.from(this.toolCalls)
								.where(eq(this.toolCalls.runId, this.events.runId)),
						),
					),
				)
				.orderBy(asc(this.events.runId))
				.limit(opts.limit),
		);
		return rows.map((r) => r.runId);
	}

	/**
	 * Distinct run ids that already HAVE rollup rows, keyset-paged by run
	 * id — the corpus-repair walk (warren-677c). Where
	 * {@link listRunsMissingRollup} finds runs the backfill never touched,
	 * this finds runs it touched with a since-fixed shape, so a repair pass
	 * can re-extract them from retained events. Keyset pagination
	 * (`afterRunId`) keeps the walk stable while the pass itself rewrites
	 * the rows it pages over.
	 */
	async listRunsWithRollup(opts: { afterRunId?: string; limit: number }): Promise<string[]> {
		const rows = await this.adapter.pickAll<{ runId: string }>(
			this.db
				.selectDistinct({ runId: this.toolCalls.runId })
				.from(this.toolCalls)
				.where(
					opts.afterRunId === undefined ? undefined : gt(this.toolCalls.runId, opts.afterRunId),
				)
				.orderBy(asc(this.toolCalls.runId))
				.limit(opts.limit),
		);
		return rows.map((r) => r.runId);
	}

	/**
	 * Drop one run's rollup rows so a repair pass can re-extract them from
	 * events (warren-677c). Callers must verify the run's tool events are
	 * still retained BEFORE deleting — the rollup is derived state only as
	 * long as its source survives.
	 */
	async deleteForRun(runId: string): Promise<void> {
		await this.adapter.runWrite(
			this.db.delete(this.toolCalls).where(eq(this.toolCalls.runId, runId)),
		);
	}

	async countByRun(runId: string): Promise<number> {
		const row = await this.adapter.pickOne<{ n: number | string }>(
			this.db
				.select({ n: sql<number>`count(*)` })
				.from(this.toolCalls)
				.where(eq(this.toolCalls.runId, runId)),
		);
		return Number(row?.n ?? 0);
	}
}
