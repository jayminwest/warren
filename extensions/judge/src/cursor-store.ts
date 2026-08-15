/**
 * Durable per-run judgment cursors in the extension's own SQLite store.
 *
 * The cursor is what makes collection at-least-once across restarts: it
 * advances only AFTER the verdict store has accepted the judgment result
 * (verdict or unjudged marker), so a kill mid-judgment replays the run on
 * the next boot. Replays are exact no-ops because the verdict store's
 * dedupe key `(runId, rubricVersion, judgeModelId)` makes a re-applied
 * judgment `ON CONFLICT DO NOTHING` — the audit-log delivery discipline.
 *
 * The cursor records WHICH rubric version and judge model the run was
 * judged under. A run sighted under a different pair needs judging again
 * (a re-judge under a new rubric version appends, never overwrites), so
 * `needsJudgment` compares the pair, not mere presence.
 */

import { Database } from "bun:sqlite";

export interface JudgmentCursor {
	readonly runId: string;
	/** Rubric version the recorded judgment was produced under. */
	readonly rubricVersion: string;
	/** Judge model id the recorded judgment was produced by. */
	readonly judgeModelId: string;
	/** "verdict" | "unjudged" — how the last accepted judgment resolved. */
	readonly outcome: string;
	readonly updatedAt: string;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS judgment_cursors (
	run_id TEXT PRIMARY KEY,
	rubric_version TEXT NOT NULL,
	judge_model_id TEXT NOT NULL,
	outcome TEXT NOT NULL,
	updated_at TEXT NOT NULL
);
`;

export class JudgmentCursorStore {
	readonly #db: Database;

	/** `path` may be ":memory:" for tests. */
	constructor(path: string) {
		this.#db = new Database(path);
		this.#db.run("PRAGMA journal_mode = WAL;");
		this.#db.run(SCHEMA);
	}

	/** The cursor for a run, or null if the run was never judged. */
	get(runId: string): JudgmentCursor | null {
		const row = this.#db
			.query(
				"SELECT run_id, rubric_version, judge_model_id, outcome, updated_at FROM judgment_cursors WHERE run_id = ?",
			)
			.get(runId) as
			| {
					run_id: string;
					rubric_version: string;
					judge_model_id: string;
					outcome: string;
					updated_at: string;
			  }
			| null;
		if (row === null) return null;
		return {
			runId: row.run_id,
			rubricVersion: row.rubric_version,
			judgeModelId: row.judge_model_id,
			outcome: row.outcome,
			updatedAt: row.updated_at,
		};
	}

	/** True when the run has no accepted judgment under this exact pair. */
	needsJudgment(runId: string, rubricVersion: string, judgeModelId: string): boolean {
		const cursor = this.get(runId);
		return (
			cursor === null ||
			cursor.rubricVersion !== rubricVersion ||
			cursor.judgeModelId !== judgeModelId
		);
	}

	/**
	 * Advance the cursor after the verdict store accepted the outcome.
	 * Never called before the accept — a crash between accept and
	 * checkpoint replays the run, and the store's dedupe key absorbs it.
	 */
	checkpoint(
		runId: string,
		opts: {
			rubricVersion: string;
			judgeModelId: string;
			outcome: "verdict" | "unjudged";
			updatedAt: string;
		},
	): void {
		this.#db.run(
			`INSERT INTO judgment_cursors (run_id, rubric_version, judge_model_id, outcome, updated_at)
			 VALUES (?, ?, ?, ?, ?)
			 ON CONFLICT(run_id) DO UPDATE SET
				rubric_version = excluded.rubric_version,
				judge_model_id = excluded.judge_model_id,
				outcome = excluded.outcome,
				updated_at = excluded.updated_at`,
			[runId, opts.rubricVersion, opts.judgeModelId, opts.outcome, opts.updatedAt],
		);
	}

	/** Number of runs with a cursor row — observability. */
	trackedRuns(): number {
		const row = this.#db.query("SELECT COUNT(*) AS n FROM judgment_cursors").get() as {
			n: number;
		};
		return row.n;
	}

	close(): void {
		this.#db.close();
	}
}
