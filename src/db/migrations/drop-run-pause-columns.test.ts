/**
 * Migration 0034 (sqlite) / 0028 (postgres) — drop the dead pause-machinery
 * columns from the runs table (warren-801e, plan pl-1c02 step 7): `paused_at`
 * and `paused_question_event_id`. The pause detector (`src/runs/pause.ts`) and
 * the `paused` run state were retired with the Plot deletion pass (pl-3a79) and
 * the K8s migration; nothing ever wrote these columns, so they are rule-8 dead
 * code.
 *
 * Two angles are covered:
 *
 *   1. The migrated schema no longer declares either column (exercised on both
 *      dialects: sqlite always, postgres when `WARREN_TEST_PG_URL` is set).
 *   2. The raw sqlite migration, replayed against a hand-built OLD schema that
 *      HAS both columns plus a row, drops the columns and preserves the row.
 */

import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { PostgresWarrenDb, SqliteWarrenDb } from "../client.ts";
import { isPostgresTestEnabled, withDb } from "../testing.ts";

const SQLITE_DROP_SQL = join(import.meta.dir, "0034_amazing_newton_destine.sql");

function sqliteColumnNames(raw: Database, table: string): Set<string> {
	const rows = raw.query<{ name: string }, []>(`PRAGMA table_info(${table})`).all();
	return new Set(rows.map((r) => r.name));
}

describe("drop runs pause columns (warren-801e)", () => {
	test("sqlite: migrated schema drops paused_at + paused_question_event_id", async () => {
		await using handle = await withDb({ dialect: "sqlite" });
		const raw = (handle.db as SqliteWarrenDb).raw;
		const cols = sqliteColumnNames(raw, "runs");
		expect(cols.has("paused_at")).toBe(false);
		expect(cols.has("paused_question_event_id")).toBe(false);
	});

	test("sqlite: replaying the drop SQL against an old populated schema", () => {
		const db = new Database(":memory:");
		try {
			db.exec(`
				CREATE TABLE runs (
					id TEXT PRIMARY KEY NOT NULL,
					state TEXT NOT NULL,
					paused_at TEXT,
					paused_question_event_id TEXT
				);
			`);
			db.exec(
				"INSERT INTO runs (id, state, paused_at, paused_question_event_id) VALUES ('run-1', 'running', NULL, NULL)",
			);

			const sql = readFileSync(SQLITE_DROP_SQL, "utf8");
			for (const stmt of sql.split("--> statement-breakpoint")) {
				const trimmed = stmt.trim();
				if (trimmed.length > 0) db.exec(trimmed);
			}

			const cols = sqliteColumnNames(db, "runs");
			expect(cols.has("paused_at")).toBe(false);
			expect(cols.has("paused_question_event_id")).toBe(false);
			const rows = db.query<{ id: string }, []>("SELECT id FROM runs ORDER BY id").all();
			expect(rows.map((r) => r.id)).toEqual(["run-1"]);
		} finally {
			db.close();
		}
	});

	test.skipIf(!isPostgresTestEnabled())(
		"postgres: migrated schema drops both columns",
		async () => {
			await using handle = await withDb({ dialect: "postgres" });
			const pool = (handle.db as PostgresWarrenDb).raw;
			const colRows = await pool.query<{ column_name: string }>(
				`SELECT column_name FROM information_schema.columns
				 WHERE table_name = 'runs'
				   AND column_name IN ('paused_at', 'paused_question_event_id')`,
			);
			expect(colRows.rows.length).toBe(0);
		},
	);
});
