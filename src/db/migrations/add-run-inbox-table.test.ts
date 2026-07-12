/**
 * Migration 0029 (sqlite) / 0023 (postgres) — add the `run_inbox` steering
 * table (warren-3d0b, plan pl-829f step 18).
 *
 * Two angles, mirroring `drop-placement-tables.test.ts`:
 *
 *   1. The migrated schema declares `run_inbox` with the expected columns on
 *      both dialects (sqlite always, postgres when `WARREN_TEST_PG_URL` is set).
 *   2. The raw sqlite create SQL, replayed against a hand-built schema that has
 *      a `runs` row, creates the table + FK + index cleanly and accepts an
 *      inbox row that cascades away when its run is deleted.
 */

import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { PostgresWarrenDb, SqliteWarrenDb } from "../client.ts";
import { isPostgresTestEnabled, withDb } from "../testing.ts";

const SQLITE_CREATE_SQL = join(import.meta.dir, "0029_gray_post.sql");

const EXPECTED_COLUMNS = [
	"id",
	"run_id",
	"seq",
	"body",
	"priority",
	"from_actor",
	"state",
	"created_at",
	"delivered_at",
];

function sqliteTableNames(raw: Database): Set<string> {
	const rows = raw
		.query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type = 'table'")
		.all();
	return new Set(rows.map((r) => r.name));
}

function sqliteColumnNames(raw: Database, table: string): Set<string> {
	const rows = raw.query<{ name: string }, []>(`PRAGMA table_info(${table})`).all();
	return new Set(rows.map((r) => r.name));
}

describe("add run_inbox table (warren-3d0b)", () => {
	test("sqlite: migrated schema declares run_inbox with the expected columns", async () => {
		await using handle = await withDb({ dialect: "sqlite" });
		const raw = (handle.db as SqliteWarrenDb).raw;

		expect(sqliteTableNames(raw).has("run_inbox")).toBe(true);
		const cols = sqliteColumnNames(raw, "run_inbox");
		for (const col of EXPECTED_COLUMNS) {
			expect(cols.has(col)).toBe(true);
		}
	});

	test("sqlite: replaying the create SQL builds the table with a cascading FK", () => {
		const db = new Database(":memory:");
		try {
			db.exec("PRAGMA foreign_keys = ON");
			// A minimal runs table the FK can target.
			db.exec(`
				CREATE TABLE runs (
					id TEXT PRIMARY KEY
				);
			`);
			db.exec("INSERT INTO runs (id) VALUES ('run_x')");

			// Apply the real generated migration body (statement-breakpoint split
			// mirrors how drizzle's bun-sqlite migrator executes it).
			const sql = readFileSync(SQLITE_CREATE_SQL, "utf8");
			for (const stmt of sql.split("--> statement-breakpoint")) {
				const trimmed = stmt.trim();
				if (trimmed.length > 0) db.exec(trimmed);
			}

			expect(sqliteTableNames(db).has("run_inbox")).toBe(true);

			db.exec(
				`INSERT INTO run_inbox (id, run_id, seq, body, priority, from_actor, state, created_at, delivered_at)
				 VALUES ('msg_1', 'run_x', 1, 'steer', 'normal', 'operator', 'unread', '2026-01-01T00:00:00.000Z', NULL)`,
			);
			const before = db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM run_inbox").get();
			expect(before?.n).toBe(1);

			// Deleting the run cascades the inbox row away.
			db.exec("DELETE FROM runs WHERE id = 'run_x'");
			const after = db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM run_inbox").get();
			expect(after?.n).toBe(0);
		} finally {
			db.close();
		}
	});

	test.skipIf(!isPostgresTestEnabled())(
		"postgres: migrated schema declares run_inbox with the expected columns",
		async () => {
			await using handle = await withDb({ dialect: "postgres" });
			const pool = (handle.db as PostgresWarrenDb).raw;

			const tableRows = await pool.query<{ table_name: string }>(
				"SELECT table_name FROM information_schema.tables WHERE table_name = 'run_inbox'",
			);
			expect(tableRows.rows.length).toBe(1);

			const colRows = await pool.query<{ column_name: string }>(
				"SELECT column_name FROM information_schema.columns WHERE table_name = 'run_inbox'",
			);
			const cols = new Set(colRows.rows.map((r) => r.column_name));
			for (const col of EXPECTED_COLUMNS) {
				expect(cols.has(col)).toBe(true);
			}
		},
	);
});
