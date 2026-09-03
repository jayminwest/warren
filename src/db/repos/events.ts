/**
 * Repository for the `events` table.
 *
 * Warren's events table is a write-through cache of burrow's stream (docs/design/runtime-and-supervisor.md). Each row carries the burrow-side `seq` so we can resume the stream
 * at MAX(sandbox_event_seq) + 1 after a warren restart mid-run, and so the UI
 * replays events in the same order burrow emitted them.
 */

import { and, asc, desc, eq, gt, inArray, sql } from "drizzle-orm";
import { USAGE_ENVELOPE_TYPES } from "../../core/usage-shape.ts";
import type { SqliteDrizzleDb } from "../client.ts";
import type { EventRow, EventStream } from "../schema.ts";
import type { DrizzleAdapter } from "./drizzle-adapter.ts";

export interface AppendEventInput {
	runId: string;
	sandboxEventSeq: number;
	ts: string;
	kind: string;
	stream?: EventStream | null;
	/**
	 * Parse-boundary provenance (warren-5a07). Threaded from the stream
	 * view's `origin`; NULL on historical rows and on warren-authored
	 * internal appends reads as unknown — never fold into a real bucket.
	 */
	origin?: string | null;
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
					sandboxEventSeq: input.sandboxEventSeq,
					ts: input.ts,
					kind: input.kind,
					stream: input.stream ?? null,
					origin: input.origin ?? null,
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
				? and(eq(this.events.runId, runId), gt(this.events.sandboxEventSeq, opts.sinceSeq))
				: eq(this.events.runId, runId);
		const q = this.db
			.select()
			.from(this.events)
			.where(where)
			.orderBy(asc(this.events.sandboxEventSeq));
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
				.orderBy(desc(this.events.sandboxEventSeq))
				.limit(limit),
		);
		return rows.reverse();
	}

	/**
	 * Does the run carry at least one event of `kind`? Powers the cancel-intent
	 * probe (warren-fe9b): the watchdog terminal-reconcile net checks for a
	 * `cancel.requested` row so a pod warren deleted itself reconciles to
	 * `cancelled` rather than `failed(sandbox_run_lost)`.
	 *
	 * `stream` (optional, warren-7f0b) narrows the match — used by the
	 * watchdog-kill witness probe so an agent-origin line that merely CARRIES
	 * the `stdin_hold_timeout` kind on the stdout stream (the provenance gate
	 * downgrades agent-claimed system lines) cannot trigger an `agent_died`
	 * reap. System-stream events only ever originate from warren-owned writers.
	 */
	async hasKind(runId: string, kind: string, stream?: EventStream): Promise<boolean> {
		const row = await this.adapter.pickOne<{ id: number }>(
			this.db
				.select({ id: this.events.id })
				.from(this.events)
				.where(
					and(
						eq(this.events.runId, runId),
						eq(this.events.kind, kind),
						...(stream !== undefined ? [eq(this.events.stream, stream)] : []),
					),
				)
				.limit(1),
		);
		return row !== undefined;
	}

	/**
	 * Highest sandbox_event_seq we've persisted for a run, or null if none.
	 * Used at warren startup to compute the resume offset for live runs
	 * ("MAX(events.sandbox_event_seq) + 1", docs/design/runtime-and-supervisor.md).
	 */
	async maxSeqForRun(runId: string): Promise<number | null> {
		const row = await this.adapter.pickOne<{ max: number | null }>(
			this.db
				.select({ max: sql<number | null>`max(${this.events.sandboxEventSeq})` })
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
	 * warren-5dd5 also narrows on `payload.type` IN (turn_end, result):
	 * the same carrier also carries `turn_start`, `tool_execution_*`,
	 * `message_*` and `agent_end` rows (the last embedding the whole
	 * transcript), none of which any usage shape reads. The type list is
	 * sourced from `USAGE_ENVELOPE_TYPES` so the SQL predicate and the
	 * readers cannot drift. The JSON extraction is dialect-specific —
	 * sqlite stores `payload_json` as TEXT (`json_extract`), postgres as
	 * `jsonb` (`->>`).
	 *
	 * Empty `runIds` short-circuits without a DB hit. Ordered by
	 * (runId, seq) so callers can group + aggregate in a single pass.
	 */
	async listUsageEvents(runIds: readonly string[]): Promise<EventRow[]> {
		if (runIds.length === 0) return [];
		const column = this.events.payloadJson;
		const extracted =
			this.adapter.dialect === "postgres"
				? sql<string | null>`${column} ->> 'type'`
				: sql<string | null>`json_extract(${column}, '$.type')`;
		return this.adapter.pickAll(
			this.db
				.select()
				.from(this.events)
				.where(
					and(
						inArray(this.events.runId, runIds as string[]),
						eq(this.events.kind, "state_change"),
						eq(this.events.stream, "system"),
						inArray(extracted, [...USAGE_ENVELOPE_TYPES]),
					),
				)
				.orderBy(asc(this.events.runId), asc(this.events.sandboxEventSeq)),
		);
	}

	/**
	 * One run's tool-call trace rows (`kind=tool_use` / `kind=tool_result`)
	 * in seq order. Sole consumer is the tool-calls rollup backfill
	 * (`src/runs/tool-calls-backfill.ts`, warren-7746), which re-extracts a
	 * whole run's history in one pass — per-run bounded, so no row cap. The
	 * analytics behavior view itself reads the `tool_calls` rollup
	 * (`ToolCallsRepo.listForRuns`); the retired multi-run capped variant of
	 * this scan truncated silently at 20k rows.
	 */
	async listToolEventsForRun(runId: string): Promise<EventRow[]> {
		return this.adapter.pickAll(
			this.db
				.select()
				.from(this.events)
				.where(
					and(eq(this.events.runId, runId), inArray(this.events.kind, ["tool_use", "tool_result"])),
				)
				.orderBy(asc(this.events.sandboxEventSeq)),
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
				.orderBy(asc(this.events.runId), asc(this.events.sandboxEventSeq)),
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
