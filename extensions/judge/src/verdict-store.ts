/**
 * The verdict store: append-only judge verdicts and unjudged markers in the
 * extension's own SQLite, with idempotent apply so replay is an exact no-op.
 *
 * Dedupe key: `${runId}|${rubricVersion}|${judgeModelId}` —
 * `ON CONFLICT DO NOTHING` makes re-emitting the same judgment (a killed
 * collector replaying an un-checkpointed tail, or a re-sighted terminal run)
 * a no-op: no new row, no new id. A re-judge under a NEW rubric version (or
 * a different judge model, e.g. the calibration pass) produces a different
 * key and appends — the store never overwrites a verdict.
 *
 * `id` is SQLite's rowid: the monotonic export paging sequence the
 * `/verdicts.jsonl` surface (plan pl-17ca step 8) pages with `?since=<id>`.
 * A replayed judgment never consumes one.
 *
 * Write-path discipline: `recordVerdict` accepts only wire.ts-validated
 * verdicts. It re-runs `validateVerdict` before touching the DB, so nothing
 * outside the §12.3 contract can land even from an in-memory caller that
 * skipped the parse boundary. `recordUnjudged` stores a marker with a
 * machine-readable reason; a judgment resolves to a validated verdict or an
 * unjudged marker, nothing else (agent-analytics §12.5).
 */

import { Database } from "bun:sqlite";
import { type JudgeVerdict, validateVerdict } from "./wire.ts";

/** The closed set of unjudged-marker reasons. */
export const UNJUDGED_REASONS = [
	/** The retry budget was exhausted on malformed or missing verdicts. */
	"malformed_verdict",
	/** JUDGE_MAX_COST_USD or JUDGE_DAILY_BUDGET_USD would be breached. */
	"budget_exceeded",
	/** The judge loop itself failed (provider error, transport, crash). */
	"judge_error",
] as const;
export type UnjudgedReason = (typeof UNJUDGED_REASONS)[number];

/** One stored row — a validated verdict. */
export interface VerdictRow {
	readonly id: number;
	readonly kind: "verdict";
	readonly runId: string;
	readonly rubricVersion: string;
	readonly judgeModelId: string;
	readonly verdict: JudgeVerdict;
	readonly reason: null;
	readonly detail: null;
}

/** One stored row — an unjudged marker. */
export interface UnjudgedRow {
	readonly id: number;
	readonly kind: "unjudged";
	readonly runId: string;
	readonly rubricVersion: string;
	readonly judgeModelId: string;
	readonly verdict: null;
	readonly reason: UnjudgedReason;
	readonly detail: string | null;
}

export type StoreRow = VerdictRow | UnjudgedRow;

/**
 * One leg of the calibration join (§12.5): the cheap judge's verdict and the
 * strong judge's verdict for the same runId + rubricVersion, paired so the
 * agreement-rate computation can compare band assignments class by class.
 */
export interface CalibrationPair {
	readonly runId: string;
	readonly rubricVersion: string;
	readonly cheapModelId: string;
	readonly strongModelId: string;
	readonly cheap: JudgeVerdict;
	readonly strong: JudgeVerdict;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS verdict_rows (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	kind TEXT NOT NULL CHECK (kind IN ('verdict', 'unjudged')),
	run_id TEXT NOT NULL,
	rubric_version TEXT NOT NULL,
	judge_model_id TEXT NOT NULL,
	verdict TEXT,
	reason TEXT,
	detail TEXT,
	recorded_at TEXT NOT NULL,
	dedupe_key TEXT NOT NULL UNIQUE
);
CREATE INDEX IF NOT EXISTS verdict_rows_run_idx ON verdict_rows (run_id, id);
CREATE INDEX IF NOT EXISTS verdict_rows_rubric_idx ON verdict_rows (rubric_version, id);
`;

interface RawRow {
	id: number;
	kind: string;
	run_id: string;
	rubric_version: string;
	judge_model_id: string;
	verdict: string | null;
	reason: string | null;
	detail: string | null;
}

function toStoreRow(row: RawRow): StoreRow {
	const base = {
		id: row.id,
		runId: row.run_id,
		rubricVersion: row.rubric_version,
		judgeModelId: row.judge_model_id,
	};
	if (row.kind === "verdict") {
		if (row.verdict === null) {
			throw new Error(`verdict row ${row.id} has no verdict payload — store invariant broken`);
		}
		return {
			...base,
			kind: "verdict",
			verdict: validateVerdict(JSON.parse(row.verdict)),
			reason: null,
			detail: null,
		};
	}
	if (row.reason === null || !(UNJUDGED_REASONS as readonly string[]).includes(row.reason)) {
		throw new Error(`unjudged row ${row.id} has unknown reason — store invariant broken`);
	}
	return {
		...base,
		kind: "unjudged",
		verdict: null,
		reason: row.reason as UnjudgedReason,
		detail: row.detail ?? null,
	};
}

export class VerdictStore {
	readonly #db: Database;
	readonly #now: () => Date;

	/** `path` may be ":memory:" for tests. `now` is injected for determinism. */
	constructor(path: string, opts?: { now?: () => Date }) {
		this.#db = new Database(path);
		this.#db.run("PRAGMA journal_mode = WAL;");
		this.#db.run(SCHEMA);
		this.#ensureDetailColumn();
		this.#now = opts?.now ?? (() => new Date());
	}

	#ensureDetailColumn(): void {
		const columns = this.#db
			.query("PRAGMA table_info(verdict_rows)")
			.all() as Array<{ name: string }>;
		if (!columns.some((col) => col.name === "detail")) {
			this.#db.run("ALTER TABLE verdict_rows ADD COLUMN detail TEXT;");
		}
	}

	/**
	 * Append a validated verdict. `value` is re-validated against the
	 * wire.ts contract before the DB is touched — anything else throws
	 * `VerdictValidationError`. Returns the new row id, or null when the
	 * dedupe key already exists (replay no-op).
	 */
	recordVerdict(value: unknown): number | null {
		const verdict = validateVerdict(value);
		return this.#insert({
			kind: "verdict",
			runId: verdict.runId,
			rubricVersion: verdict.provenance.rubricVersion,
			judgeModelId: verdict.provenance.model,
			verdictJson: JSON.stringify(verdict),
			reason: null,
			detail: null,
		});
	}

	/**
	 * Append an unjudged marker. Idempotent under the same dedupe key, so a
	 * budget-skip replay does not stack markers. Returns the new row id, or
	 * null on replay.
	 */
	recordUnjudged(opts: {
		runId: string;
		rubricVersion: string;
		judgeModelId: string;
		reason: UnjudgedReason;
		detail?: string | null;
	}): number | null {
		if (!(UNJUDGED_REASONS as readonly string[]).includes(opts.reason)) {
			throw new Error(`unjudged reason must be one of ${UNJUDGED_REASONS.join("/")}`);
		}
		return this.#insert({
			kind: "unjudged",
			runId: opts.runId,
			rubricVersion: opts.rubricVersion,
			judgeModelId: opts.judgeModelId,
			verdictJson: null,
			reason: opts.reason,
			detail: opts.detail ?? null,
		});
	}

	#insert(row: {
		kind: "verdict" | "unjudged";
		runId: string;
		rubricVersion: string;
		judgeModelId: string;
		verdictJson: string | null;
		reason: string | null;
		detail: string | null;
	}): number | null {
		const dedupeKey = `${row.runId}|${row.rubricVersion}|${row.judgeModelId}`;
		const result = this.#db.run(
			`INSERT INTO verdict_rows
				(kind, run_id, rubric_version, judge_model_id, verdict, reason, detail, recorded_at, dedupe_key)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
			 ON CONFLICT(dedupe_key) DO NOTHING`,
			[
				row.kind,
				row.runId,
				row.rubricVersion,
				row.judgeModelId,
				row.verdictJson,
				row.reason,
				row.detail,
				this.#now().toISOString(),
				dedupeKey,
			],
		);
		return result.changes > 0 ? Number(result.lastInsertRowid) : null;
	}

	/**
	 * The export page: rows after `sinceId`. Oldest first by default;
	 * `order: "desc"` serves the newest page (the client's newest-window
	 * fetch, warren-f282) with rows in descending id order.
	 */
	rowsSince(
		sinceId: number,
		limit: number,
		order: "asc" | "desc" = "asc",
	): StoreRow[] {
		const rows = this.#db
			.query(`SELECT * FROM verdict_rows WHERE id > ? ORDER BY id ${order === "desc" ? "DESC" : "ASC"} LIMIT ?`)
			.all(sinceId, limit) as unknown as RawRow[];
		return rows.map(toStoreRow);
	}

	/** Highest assigned id — the `since` cursor the export hands back. 0 when empty. */
	maxId(): number {
		const row = this.#db.query("SELECT COALESCE(MAX(id), 0) AS m FROM verdict_rows").get() as {
			m: number;
		};
		return row.m;
	}

	/** All rows for one run in append order — debugging and the judge loop's prior check. */
	rowsForRun(runId: string): StoreRow[] {
		const rows = this.#db
			.query("SELECT * FROM verdict_rows WHERE run_id = ? ORDER BY id")
			.all(runId) as unknown as RawRow[];
		return rows.map(toStoreRow);
	}

	/**
	 * Per-rubric-version read: every row judged under `rubricVersion`, in
	 * append order. Trend lines must never mix rubric versions (§12.3), so
	 * this is the analytics surface's primary query.
	 */
	rowsForRubricVersion(rubricVersion: string): StoreRow[] {
		const rows = this.#db
			.query("SELECT * FROM verdict_rows WHERE rubric_version = ? ORDER BY id")
			.all(rubricVersion) as unknown as RawRow[];
		return rows.map(toStoreRow);
	}

	/**
	 * The calibration join (§12.5): for one rubric version, pair every run
	 * that has a verdict from BOTH `cheapModelId` and `strongModelId`. The
	 * disagreement rate between the two legs is the tracked signal that
	 * drives any future taxonomy narrowing. Unjudged markers never join.
	 */
	calibrationPairs(rubricVersion: string, cheapModelId: string, strongModelId: string): CalibrationPair[] {
		const rows = this.#db
			.query(
				`SELECT
					c.run_id AS run_id,
					c.rubric_version AS rubric_version,
					c.judge_model_id AS cheap_model_id,
					s.judge_model_id AS strong_model_id,
					c.verdict AS cheap_verdict,
					s.verdict AS strong_verdict
				 FROM verdict_rows c
				 JOIN verdict_rows s
				   ON s.run_id = c.run_id
				  AND s.rubric_version = c.rubric_version
				  AND s.judge_model_id = ?
				  AND s.kind = 'verdict'
				 WHERE c.rubric_version = ?
				   AND c.judge_model_id = ?
				   AND c.kind = 'verdict'
				 ORDER BY c.id`,
			)
			.all(strongModelId, rubricVersion, cheapModelId) as unknown as Array<{
			run_id: string;
			rubric_version: string;
			cheap_model_id: string;
			strong_model_id: string;
			cheap_verdict: string;
			strong_verdict: string;
		}>;
		return rows.map((row) => ({
			runId: row.run_id,
			rubricVersion: row.rubric_version,
			cheapModelId: row.cheap_model_id,
			strongModelId: row.strong_model_id,
			cheap: validateVerdict(JSON.parse(row.cheap_verdict)),
			strong: validateVerdict(JSON.parse(row.strong_verdict)),
		}));
	}

	count(): number {
		const row = this.#db.query("SELECT COUNT(*) AS n FROM verdict_rows").get() as { n: number };
		return row.n;
	}

	close(): void {
		this.#db.close();
	}
}
