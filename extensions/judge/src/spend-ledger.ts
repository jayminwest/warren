/**
 * The fleet-wide spend ledger: every judgment's accrued USD cost, durable
 * in the extension's own SQLite, summed per UTC day to enforce
 * `JUDGE_DAILY_BUDGET_USD` (agent-analytics §12.5).
 *
 * Warren exposes no cost surface an observer can read back (FRICTION §3),
 * so the extension ledgers its own spend. Durable, not in-memory: a
 * collector restart must not reset the day's budget. Spend is recorded
 * for EVERY judgment attempt outcome — verdict or unjudged — because the
 * provider billed the tokens either way; an unjudged marker is not a
 * refund.
 */

import { Database } from "bun:sqlite";

/** The UTC day key (`YYYY-MM-DD`) the daily budget buckets by. */
export function dayKey(date: Date): string {
	return date.toISOString().slice(0, 10);
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS judge_spend (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	day TEXT NOT NULL,
	cost_usd REAL NOT NULL,
	recorded_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS judge_spend_day_idx ON judge_spend (day);
`;

export class SpendLedger {
	readonly #db: Database;

	/** `path` may be ":memory:" for tests. */
	constructor(path: string) {
		this.#db = new Database(path);
		this.#db.run("PRAGMA journal_mode = WAL;");
		this.#db.run(SCHEMA);
	}

	/** Record one judgment's accrued cost against its UTC day. */
	record(costUsd: number, at: Date): void {
		if (!Number.isFinite(costUsd) || costUsd < 0) {
			throw new Error(`spend must be a non-negative finite number; got ${costUsd}`);
		}
		this.#db.run("INSERT INTO judge_spend (day, cost_usd, recorded_at) VALUES (?, ?, ?)", [
			dayKey(at),
			costUsd,
			at.toISOString(),
		]);
	}

	/** Total USD spent on one UTC day — the number the daily gate compares. */
	spendForDay(day: string): number {
		const row = this.#db
			.query("SELECT COALESCE(SUM(cost_usd), 0) AS total FROM judge_spend WHERE day = ?")
			.get(day) as { total: number };
		return row.total;
	}

	close(): void {
		this.#db.close();
	}
}
