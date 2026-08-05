/**
 * Durable per-run cursors in the extension's own SQLite store.
 *
 * The cursor is what makes collection at-least-once across restarts: it
 * advances only AFTER the sink has accepted an event, so a kill mid-page
 * replays the un-checkpointed tail on the next boot. Replays are exact
 * no-ops only if the sink is idempotent — that burden lands on the audit
 * store (plan step 3, warren-653a); this module's job is to never lose
 * and never skip.
 *
 * `seq` is monotonic per run, not global (FRICTION §1), so the cursor is
 * keyed by run id. A terminal run whose tail is fully drained is flagged
 * `drained` so later poll cycles never touch it again.
 */

import { Database } from "bun:sqlite";

export interface RunCursor {
	readonly runId: string;
	/** Last event seq durably handed to the sink. 0 = nothing applied yet. */
	readonly lastSeq: number;
	/** Run state as of the last checkpoint, for observability. */
	readonly runState: string | null;
	/** True once a terminal run's tail is fully replayed. */
	readonly drained: boolean;
	readonly updatedAt: string;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS run_cursors (
	run_id TEXT PRIMARY KEY,
	last_seq INTEGER NOT NULL DEFAULT 0,
	run_state TEXT,
	drained INTEGER NOT NULL DEFAULT 0,
	updated_at TEXT NOT NULL
);
`;

export class CursorStore {
	readonly #db: Database;

	/** `path` may be ":memory:" for tests. */
	constructor(path: string) {
		this.#db = new Database(path);
		this.#db.run("PRAGMA journal_mode = WAL;");
		this.#db.run(SCHEMA);
	}

	/** The cursor for a run, or the zero cursor if the run was never seen. */
	get(runId: string): RunCursor {
		const row = this.#db
			.query(
				"SELECT run_id, last_seq, run_state, drained, updated_at FROM run_cursors WHERE run_id = ?",
			)
			.get(runId) as
			| {
					run_id: string;
					last_seq: number;
					run_state: string | null;
					drained: number;
					updated_at: string;
			  }
			| null;
		if (row === null) {
			return { runId, lastSeq: 0, runState: null, drained: false, updatedAt: "" };
		}
		return {
			runId: row.run_id,
			lastSeq: row.last_seq,
			runState: row.run_state,
			drained: row.drained === 1,
			updatedAt: row.updated_at,
		};
	}

	/**
	 * Advance the cursor after the sink accepted `lastSeq`. Monotonic:
	 * a checkpoint never moves the cursor backwards, so a stale writer
	 * cannot resurrect already-applied events.
	 */
	checkpoint(
		runId: string,
		lastSeq: number,
		runState: string,
		drained: boolean,
		updatedAt: string,
	): void {
		this.#db.run(
			`INSERT INTO run_cursors (run_id, last_seq, run_state, drained, updated_at)
			 VALUES (?, ?, ?, ?, ?)
			 ON CONFLICT(run_id) DO UPDATE SET
				last_seq = MAX(last_seq, excluded.last_seq),
				run_state = excluded.run_state,
				drained = MAX(drained, excluded.drained),
				updated_at = excluded.updated_at`,
			[runId, lastSeq, runState, drained ? 1 : 0, updatedAt],
		);
	}

	/** Number of runs with a cursor row — observability for /healthz later. */
	trackedRuns(): number {
		const row = this.#db.query("SELECT COUNT(*) AS n FROM run_cursors").get() as { n: number };
		return row.n;
	}

	/** Runs not yet fully caught up — the lag number /healthz reports. */
	undrainedRuns(): number {
		const row = this.#db
			.query("SELECT COUNT(*) AS n FROM run_cursors WHERE drained = 0")
			.get() as { n: number };
		return row.n;
	}

	close(): void {
		this.#db.close();
	}
}
