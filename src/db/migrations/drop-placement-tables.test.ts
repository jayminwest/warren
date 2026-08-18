/**
 * Migration 0028 (sqlite) / 0022 (postgres) — drop the `workers` + `burrows`
 * placement tables, retain `runs.worker_id` / `runs.sandbox_id` /
 * `runs.sandbox_run_id` for historical rows (warren-3743, plan pl-829f step 24).
 * The two sandbox columns were named `burrow_id` / `burrow_run_id` until
 * migration 0049 renamed them (warren-572d); the replay case below still
 * creates the old names on purpose, because it starts from the old schema.
 *
 * Two angles are covered:
 *
 *   1. The migrated schema no longer declares `workers` / `burrows`, but `runs`
 *      keeps the three retained columns (exercised on both dialects: sqlite
 *      always, postgres when `WARREN_TEST_PG_URL` is set).
 *   2. The raw sqlite drop SQL, replayed against a hand-built OLD schema that
 *      HAS the two tables plus data, drops them cleanly and leaves an existing
 *      `runs` row (with its worker/burrow ids) untouched.
 */

import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { PostgresWarrenDb, SqliteWarrenDb } from "../client.ts";
import { isPostgresTestEnabled, withDb } from "../testing.ts";

const SQLITE_DROP_SQL = join(import.meta.dir, "0028_modern_spencer_smythe.sql");

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

describe("drop workers + burrows placement tables (warren-3743)", () => {
	test("sqlite: migrated schema drops both tables and retains runs columns", async () => {
		await using handle = await withDb({ dialect: "sqlite" });
		const raw = (handle.db as SqliteWarrenDb).raw;

		const tables = sqliteTableNames(raw);
		expect(tables.has("workers")).toBe(false);
		expect(tables.has("burrows")).toBe(false);
		expect(tables.has("runs")).toBe(true);

		const runCols = sqliteColumnNames(raw, "runs");
		expect(runCols.has("worker_id")).toBe(true);
		expect(runCols.has("sandbox_id")).toBe(true);
		expect(runCols.has("sandbox_run_id")).toBe(true);
	});

	test("sqlite: replaying the drop SQL against an old populated schema", () => {
		const db = new Database(":memory:");
		try {
			// Reconstruct the pre-0028 shape of the two tables plus a minimal runs
			// table that carries the retained columns, and seed each with data.
			db.exec(`
				CREATE TABLE workers (
					name TEXT PRIMARY KEY,
					url TEXT NOT NULL,
					state TEXT NOT NULL DEFAULT 'healthy',
					added_at TEXT NOT NULL
				);
				CREATE TABLE burrows (
					id TEXT PRIMARY KEY,
					worker_id TEXT NOT NULL,
					added_at TEXT NOT NULL
				);
				CREATE INDEX burrows_worker_idx ON burrows (worker_id);
				CREATE TABLE runs (
					id TEXT PRIMARY KEY,
					worker_id TEXT,
					burrow_id TEXT,
					burrow_run_id TEXT
				);
			`);
			db.exec(
				"INSERT INTO workers (name, url, state, added_at) VALUES ('local', 'unix:///x.sock', 'healthy', '2026-01-01T00:00:00.000Z')",
			);
			db.exec(
				"INSERT INTO burrows (id, worker_id, added_at) VALUES ('bur_old', 'local', '2026-01-01T00:00:00.000Z')",
			);
			db.exec(
				"INSERT INTO runs (id, worker_id, burrow_id, burrow_run_id) VALUES ('run_old', 'local', 'bur_old', 'rb_old')",
			);

			// Apply the real generated migration body (statement-breakpoint split
			// mirrors how drizzle's bun-sqlite migrator executes it).
			const sql = readFileSync(SQLITE_DROP_SQL, "utf8");
			for (const stmt of sql.split("--> statement-breakpoint")) {
				const trimmed = stmt.trim();
				if (trimmed.length > 0) db.exec(trimmed);
			}

			const tables = sqliteTableNames(db);
			expect(tables.has("workers")).toBe(false);
			expect(tables.has("burrows")).toBe(false);

			// The historical runs row and its retained ids survive the drop.
			const row = db
				.query<
					{
						id: string;
						worker_id: string | null;
						burrow_id: string | null;
						burrow_run_id: string | null;
					},
					[]
				>("SELECT id, worker_id, burrow_id, burrow_run_id FROM runs WHERE id = 'run_old'")
				.get();
			expect(row).toEqual({
				id: "run_old",
				worker_id: "local",
				burrow_id: "bur_old",
				burrow_run_id: "rb_old",
			});
		} finally {
			db.close();
		}
	});

	test.skipIf(!isPostgresTestEnabled())(
		"postgres: migrated schema drops both tables and retains runs columns",
		async () => {
			await using handle = await withDb({ dialect: "postgres" });
			const pool = (handle.db as PostgresWarrenDb).raw;

			const tableRows = await pool.query<{ table_name: string }>(
				"SELECT table_name FROM information_schema.tables WHERE table_name IN ('workers', 'burrows', 'runs')",
			);
			const tables = new Set(tableRows.rows.map((r) => r.table_name));
			expect(tables.has("workers")).toBe(false);
			expect(tables.has("burrows")).toBe(false);
			expect(tables.has("runs")).toBe(true);

			const colRows = await pool.query<{ column_name: string }>(
				"SELECT column_name FROM information_schema.columns WHERE table_name = 'runs'",
			);
			const cols = new Set(colRows.rows.map((r) => r.column_name));
			expect(cols.has("worker_id")).toBe(true);
			expect(cols.has("sandbox_id")).toBe(true);
			expect(cols.has("sandbox_run_id")).toBe(true);
		},
	);
});
