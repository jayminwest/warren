/**
 * The audit store: append-only audit rows in the extension's own SQLite,
 * with idempotent apply so at-least-once replay is an exact no-op.
 *
 * Delivery recap (collector.ts): the cursor advances only AFTER the sink
 * accepts an event, so a kill between apply and checkpoint replays the
 * un-checkpointed tail next boot. This store is what makes that replay
 * safe: every fact carries a deterministic dedupe key —
 *
 *   `${runId}|${event}|${sourceSeq ?? "-"}`
 *
 * — and inserts are `ON CONFLICT DO NOTHING`. Re-deriving a fact from the
 * same wire event (or re-sighting the same run) reproduces the same key
 * and changes nothing: no new row, no new id, no timestamp drift. The
 * singleton lifecycle facts (`run.dispatched`, `run.terminal`) use a
 * null source seq, so the list-derived and event-derived derivations of
 * the same fact conflict and the first writer wins.
 *
 * `id` is the append-only sequence the export surface (step 4,
 * warren-9c7c) pages with `?since=<id>`. Ids are assigned by SQLite's
 * rowid: monotonic under this single-writer store, and a replayed fact
 * never consumes one.
 *
 * Actor attribution is `unknown` on every row — FRICTION §3, no actor
 * kind exists on the wire yet (warren-3754).
 */

import { Database } from "bun:sqlite";
import type { EventSink } from "./collector.ts";
import {
	type AuditEventType,
	type AuditFact,
	factsFromEvent,
	factsFromRun,
} from "./normalize.ts";
import type { RunEvent, RunListRow } from "./wire.ts";

/** One stored audit row — the export surface's wire shape in step 4. */
export interface AuditRow {
	readonly id: number;
	readonly runId: string;
	readonly event: AuditEventType;
	readonly at: string;
	readonly actorKind: string;
	readonly detail: unknown;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS audit_rows (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	run_id TEXT NOT NULL,
	event TEXT NOT NULL,
	at TEXT NOT NULL,
	actor_kind TEXT NOT NULL,
	detail TEXT,
	dedupe_key TEXT NOT NULL UNIQUE
);
CREATE INDEX IF NOT EXISTS audit_rows_run_idx ON audit_rows (run_id, id);
`;

interface RawRow {
	id: number;
	run_id: string;
	event: string;
	at: string;
	actor_kind: string;
	detail: string | null;
}

function toAuditRow(row: RawRow): AuditRow {
	return {
		id: row.id,
		runId: row.run_id,
		event: row.event as AuditEventType,
		at: row.at,
		actorKind: row.actor_kind,
		detail: row.detail === null ? null : (JSON.parse(row.detail) as unknown),
	};
}

export class AuditStore implements EventSink {
	readonly #db: Database;
	readonly #now: () => Date;

	/** `path` may be ":memory:" for tests. `now` is injected for golden determinism. */
	constructor(path: string, opts?: { now?: () => Date }) {
		this.#db = new Database(path);
		this.#db.run("PRAGMA journal_mode = WAL;");
		this.#db.run(SCHEMA);
		this.#now = opts?.now ?? (() => new Date());
	}

	/**
	 * EventSink: normalize one wire event and append its facts. The
	 * `run.dispatched` / `run.started` synthesis is gated on what the
	 * store already holds, so a run first seen via `observeRun` (queued,
	 * no events yet) still gets its `run.started` when the first event
	 * eventually arrives.
	 */
	apply(event: RunEvent): void {
		const facts = factsFromEvent(event, {
			includeDispatched: !this.#hasFact(event.runId, "run.dispatched"),
			includeStarted: !this.#hasFact(event.runId, "run.started"),
		});
		this.#insertAll(facts);
	}

	/**
	 * EventSink hook the collector calls once per discovered run per
	 * cycle, after the run's tail drains. Records the list-derived
	 * candidates; dedupe makes repeat sightings no-ops.
	 */
	observeRun(run: RunListRow): void {
		this.#insertAll(factsFromRun(run, this.#now()));
	}

	#hasFact(runId: string, event: AuditEventType): boolean {
		const row = this.#db
			.query("SELECT 1 AS x FROM audit_rows WHERE run_id = ? AND event = ? LIMIT 1")
			.get(runId, event);
		return row !== null;
	}

	/** Insert one fact; returns true when a row was actually appended. */
	#insert(fact: AuditFact): boolean {
		const dedupeKey = `${fact.runId}|${fact.event}|${fact.sourceSeq ?? "-"}`;
		const result = this.#db.run(
			`INSERT INTO audit_rows (run_id, event, at, actor_kind, detail, dedupe_key)
			 VALUES (?, ?, ?, ?, ?, ?)
			 ON CONFLICT(dedupe_key) DO NOTHING`,
			[
				fact.runId,
				fact.event,
				fact.at,
				fact.actorKind,
				fact.detail === null ? null : JSON.stringify(fact.detail),
				dedupeKey,
			],
		);
		return result.changes > 0;
	}

	#insertAll(facts: readonly AuditFact[]): void {
		for (const fact of facts) this.#insert(fact);
	}

	/** Every row in append order. Test support and step 4's small exports. */
	all(): AuditRow[] {
		const rows = this.#db
			.query("SELECT * FROM audit_rows ORDER BY id")
			.all() as unknown as RawRow[];
		return rows.map(toAuditRow);
	}

	/** The page the export surface serves: rows after `sinceId`, oldest first. */
	rowsSince(sinceId: number, limit: number): AuditRow[] {
		const rows = this.#db
			.query("SELECT * FROM audit_rows WHERE id > ? ORDER BY id LIMIT ?")
			.all(sinceId, limit) as unknown as RawRow[];
		return rows.map(toAuditRow);
	}

	/** Rows for one run in append order — health and debugging surface. */
	rowsForRun(runId: string): AuditRow[] {
		const rows = this.#db
			.query("SELECT * FROM audit_rows WHERE run_id = ? ORDER BY id")
			.all(runId) as unknown as RawRow[];
		return rows.map(toAuditRow);
	}

	/** Highest assigned id — the `since` cursor the export hands back. 0 when empty. */
	maxId(): number {
		const row = this.#db.query("SELECT COALESCE(MAX(id), 0) AS m FROM audit_rows").get() as {
			m: number;
		};
		return row.m;
	}

	/**
	 * Retention (step 4): delete the oldest rows beyond `maxRows` and/or
	 * older than `maxAgeMs` relative to `now`. 0 disables a bound. Deleting
	 * the oldest rows means a `since` cursor behind the horizon sees a gap,
	 * not an error — the export surface documents this. Returns the number
	 * of rows deleted.
	 */
	pruneRetention(opts: { maxRows?: number; maxAgeMs?: number; now?: Date }): number {
		let deleted = 0;
		const maxAgeMs = opts.maxAgeMs ?? 0;
		if (maxAgeMs > 0) {
			const horizon = (opts.now ?? this.#now()).getTime() - maxAgeMs;
			const result = this.#db.run("DELETE FROM audit_rows WHERE at < ?", [
				new Date(horizon).toISOString(),
			]);
			deleted += result.changes;
		}
		const maxRows = opts.maxRows ?? 0;
		if (maxRows > 0) {
			// Delete oldest-first beyond the cap, keeping the newest maxRows.
			const result = this.#db.run(
				`DELETE FROM audit_rows WHERE id <= (
					SELECT COALESCE(MAX(id), 0) - ? FROM audit_rows
				)`,
				[maxRows],
			);
			deleted += result.changes;
		}
		return deleted;
	}

	count(): number {
		const row = this.#db.query("SELECT COUNT(*) AS n FROM audit_rows").get() as { n: number };
		return row.n;
	}

	close(): void {
		this.#db.close();
	}
}
