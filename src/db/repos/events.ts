/**
 * Repository for the `events` table.
 *
 * Warren's events table is a write-through cache of burrow's stream (docs/design/runtime-and-supervisor.md). Each row carries the burrow-side `seq` so we can resume the stream
 * at MAX(burrow_event_seq) + 1 after a warren restart mid-run, and so the UI
 * replays events in the same order burrow emitted them.
 */

import { and, asc, desc, eq, gt, inArray, sql } from "drizzle-orm";
import type { SqliteDrizzleDb } from "../client.ts";
import type { EventRow, EventStream } from "../schema.ts";
import type { DrizzleAdapter } from "./drizzle-adapter.ts";

/**
 * Default row cap for {@link EventsRepo.listToolEventsForRuns}. Bounds the
 * cost of scanning the events table for the analytics behavior view; callers
 * that need a tighter (or looser) bound pass an explicit `limit`.
 */
export const DEFAULT_TOOL_EVENT_CAP = 20_000;

export interface AppendEventInput {
	runId: string;
	burrowEventSeq: number;
	ts: string;
	kind: string;
	stream?: EventStream | null;
	payload: unknown;
}

export class EventsRepo {
	constructor(private readonly adapter: DrizzleAdapter) {}

	private get db(): SqliteDrizzleDb {
		return this.adapter.drizzle as SqliteDrizzleDb;
	}

	private get events() {
		return this.adapter.schema.events;
	}

	async append(input: AppendEventInput): Promise<EventRow> {
		return this.adapter.runReturningOne<EventRow>(
			this.db
				.insert(this.events)
				.values({
					runId: input.runId,
					burrowEventSeq: input.burrowEventSeq,
					ts: input.ts,
					kind: input.kind,
					stream: input.stream ?? null,
					payloadJson: input.payload,
				})
				.returning(),
		);
	}

	/**
	 * Replay rows across many runs in ascending wall-clock order. Used by
	 * `GET /plan-runs/:id/events` (warren-f923) to snapshot the union of
	 * every child run's persisted history before the live broker
	 * subscriptions stream new ones. Empty `runIds` returns an empty
	 * array without a DB hit.
	 */
	async listByRunIds(runIds: readonly string[]): Promise<EventRow[]> {
		if (runIds.length === 0) return [];
		return this.adapter.pickAll(
			this.db
				.select()
				.from(this.events)
				.where(inArray(this.events.runId, runIds as string[]))
				.orderBy(asc(this.events.ts), asc(this.events.id)),
		);
	}

	async listByRun(
		runId: string,
		opts: { sinceSeq?: number; limit?: number } = {},
	): Promise<EventRow[]> {
		const where =
			opts.sinceSeq !== undefined
				? and(eq(this.events.runId, runId), gt(this.events.burrowEventSeq, opts.sinceSeq))
				: eq(this.events.runId, runId);
		const q = this.db
			.select()
			.from(this.events)
			.where(where)
			.orderBy(asc(this.events.burrowEventSeq));
		return this.adapter.pickAll(opts.limit ? q.limit(opts.limit) : q);
	}

	/**
	 * Last N events for a run, returned in ascending seq order (oldest-first
	 * within the window). Powers the UI's "tail buffer" — `listByRun({limit})`
	 * returns the FIRST N which is the wrong end for live tail.
	 */
	async listTail(runId: string, limit: number): Promise<EventRow[]> {
		if (limit <= 0) return [];
		const rows = await this.adapter.pickAll(
			this.db
				.select()
				.from(this.events)
				.where(eq(this.events.runId, runId))
				.orderBy(desc(this.events.burrowEventSeq))
				.limit(limit),
		);
		return rows.reverse();
	}

	/**
	 * Highest burrow_event_seq we've persisted for a run, or null if none.
	 * Used at warren startup to compute the resume offset for live runs
	 * ("MAX(events.burrow_event_seq) + 1", docs/design/runtime-and-supervisor.md).
	 */
	async maxSeqForRun(runId: string): Promise<number | null> {
		const row = await this.adapter.pickOne<{ max: number | null }>(
			this.db
				.select({ max: sql<number | null>`max(${this.events.burrowEventSeq})` })
				.from(this.events)
				.where(eq(this.events.runId, runId)),
		);
		const raw = row?.max ?? null;
		return raw === null ? null : Number(raw);
	}

	/**
	 * Events carrying runtime usage telemetry (warren-ab18). Both
	 * recognised shapes — pi `turn_end` and claude-code `result` — ride
	 * the `kind=state_change`, `stream=system` carrier, so this is the
	 * minimal scan the read-time cost hydrator needs to reconstruct
	 * totals for a run whose bridge died before its next checkpoint.
	 *
	 * Empty `runIds` short-circuits without a DB hit. Ordered by
	 * (runId, seq) so callers can group + aggregate in a single pass.
	 */
	async listUsageEvents(runIds: readonly string[]): Promise<EventRow[]> {
		if (runIds.length === 0) return [];
		return this.adapter.pickAll(
			this.db
				.select()
				.from(this.events)
				.where(
					and(
						inArray(this.events.runId, runIds as string[]),
						eq(this.events.kind, "state_change"),
						eq(this.events.stream, "system"),
					),
				)
				.orderBy(asc(this.events.runId), asc(this.events.burrowEventSeq)),
		);
	}

	/**
	 * Tool-call trace rows (`kind=tool_use` / `kind=tool_result`) across many
	 * runs, for the run-analytics behavior view (warren-e355 / pl-ad0f step 6).
	 * The command-mining aggregator parses `payload.input.command` from the
	 * `tool_use` rows and correlates outcomes by joining `tool_result` rows on
	 * `tool_use_id`, so both kinds must come back together.
	 *
	 * Ordered by (runId, seq) so callers can group + correlate in a single
	 * pass. Capped at `opts.limit` (default {@link DEFAULT_TOOL_EVENT_CAP}) to
	 * bound the scan cost on busy instances. Empty `runIds` short-circuits
	 * without a DB hit.
	 */
	async listToolEventsForRuns(
		runIds: readonly string[],
		opts: { limit?: number } = {},
	): Promise<EventRow[]> {
		if (runIds.length === 0) return [];
		const limit = opts.limit ?? DEFAULT_TOOL_EVENT_CAP;
		return this.adapter.pickAll(
			this.db
				.select()
				.from(this.events)
				.where(
					and(
						inArray(this.events.runId, runIds as string[]),
						inArray(this.events.kind, ["tool_use", "tool_result"]),
					),
				)
				.orderBy(asc(this.events.runId), asc(this.events.burrowEventSeq))
				.limit(limit),
		);
	}

	/**
	 * Fetch `steer.sent` events for the given runs. Used by the
	 * `GET /analytics/behavior` handler to build the {@link SteeringSignals}
	 * bundle fed into `buildInsights` (warren-92ad).
	 *
	 * Ordered by (runId, seq). Empty `runIds` short-circuits without a DB hit.
	 */
	async listSteeringEventsForRuns(runIds: readonly string[]): Promise<EventRow[]> {
		if (runIds.length === 0) return [];
		return this.adapter.pickAll(
			this.db
				.select()
				.from(this.events)
				.where(
					and(
						inArray(this.events.runId, runIds as string[]),
						inArray(this.events.kind, ["steer.sent"]),
					),
				)
				.orderBy(asc(this.events.runId), asc(this.events.burrowEventSeq)),
		);
	}

	/**
	 * Attempt history for one `payload_json` string key across every event of
	 * a kind (warren-55cf). Returns the total matching row count and the
	 * newest `ts`, both computed in SQL, so the healer's max-retries and
	 * cooldown gates are correct by construction: no global row window can
	 * scroll an exhausted fingerprint out of view.
	 *
	 * The JSON extraction is the one dialect-specific bit — sqlite stores
	 * `payload_json` as TEXT (`json_extract`), postgres as `jsonb` (`->>`).
	 * Both narrow on `kind` first, which `events_kind_ts_idx` covers.
	 */
	async payloadKeyHistory(
		kind: string,
		key: string,
		value: string,
	): Promise<{ count: number; lastTs: string | null }> {
		const column = this.events.payloadJson;
		const extracted =
			this.adapter.dialect === "postgres"
				? sql<string | null>`${column} ->> ${key}`
				: sql<string | null>`json_extract(${column}, ${`$.${key}`})`;
		const row = await this.adapter.pickOne<{ n: number | string; last: string | null }>(
			this.db
				.select({
					n: sql<number>`count(*)`,
					last: sql<string | null>`max(${this.events.ts})`,
				})
				.from(this.events)
				.where(and(eq(this.events.kind, kind), eq(extracted, value))),
		);
		return { count: Number(row?.n ?? 0), lastTs: row?.last ?? null };
	}

	/**
	 * Most-recent events of a single kind across all runs (warren-3db0).
	 * Ordered newest-first and capped so a long history never fans out into
	 * an unbounded scan. Read-only consumers (tests, ad-hoc inspection) only;
	 * gating decisions must use an aggregate such as
	 * {@link payloadKeyHistory} rather than this bounded window.
	 */
	async listByKind(kind: string, limit = 500): Promise<EventRow[]> {
		if (limit <= 0) return [];
		return this.adapter.pickAll(
			this.db
				.select()
				.from(this.events)
				.where(eq(this.events.kind, kind))
				.orderBy(desc(this.events.ts), desc(this.events.id))
				.limit(limit),
		);
	}

	async countByRun(runId: string): Promise<number> {
		const row = await this.adapter.pickOne<{ n: number | string }>(
			this.db
				.select({ n: sql<number>`count(*)` })
				.from(this.events)
				.where(eq(this.events.runId, runId)),
		);
		return Number(row?.n ?? 0);
	}
}
