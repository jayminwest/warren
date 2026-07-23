/**
 * Migration 0031 (sqlite) / 0025 (postgres) — drop the plot DB surface as
 * part of the plot deletion pass (warren-0b13, plan pl-3a79 step 9): the
 * `plots` projection table, `runs.plot_id`, `plan_runs.plot_id`, and
 * `projects.has_plot` (plus their indexes) in both dialects.
 *
 * Two angles are covered:
 *
 *   1. The migrated schema no longer declares `plots` nor the `plot_id` /
 *      `has_plot` columns (exercised on both dialects: sqlite always,
 *      postgres when `WARREN_TEST_PG_URL` is set).
 *   2. The raw sqlite drop SQL, replayed against a hand-built OLD schema that
 *      HAS the plots table + columns plus data, drops them cleanly.
 */

import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { PostgresWarrenDb, SqliteWarrenDb } from "../client.ts";
import { isPostgresTestEnabled, withDb } from "../testing.ts";

const SQLITE_DROP_SQL = join(import.meta.dir, "0031_normal_johnny_blaze.sql");

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

describe("drop plot DB surface (warren-0b13)", () => {
	test("sqlite: migrated schema drops the plots table + plot columns", async () => {
		await using handle = await withDb({ dialect: "sqlite" });
		const raw = (handle.db as SqliteWarrenDb).raw;

		expect(sqliteTableNames(raw).has("plots")).toBe(false);
		expect(sqliteColumnNames(raw, "runs").has("plot_id")).toBe(false);
		expect(sqliteColumnNames(raw, "plan_runs").has("plot_id")).toBe(false);
		expect(sqliteColumnNames(raw, "projects").has("has_plot")).toBe(false);
	});

	test("sqlite: replaying the drop SQL against an old populated schema", () => {
		const db = new Database(":memory:");
		try {
			// Reconstruct the pre-0031 shape of the plot surface plus data.
			db.exec(`
				CREATE TABLE projects (
					id TEXT PRIMARY KEY,
					has_plot INTEGER NOT NULL DEFAULT 0,
					has_seeds INTEGER NOT NULL DEFAULT 0
				);
				CREATE TABLE runs (
					id TEXT PRIMARY KEY,
					plot_id TEXT
				);
				CREATE INDEX runs_plot_id_idx ON runs (plot_id);
				CREATE TABLE plan_runs (
					id TEXT PRIMARY KEY,
					plot_id TEXT
				);
				CREATE INDEX plan_runs_plot_id_idx ON plan_runs (plot_id);
				CREATE TABLE plots (
					id TEXT PRIMARY KEY,
					project_id TEXT NOT NULL,
					status TEXT NOT NULL,
					title TEXT,
					updated_at TEXT NOT NULL,
					state_json TEXT NOT NULL
				);
			`);
			db.exec("INSERT INTO projects (id, has_plot) VALUES ('prj_old', 1)");
			db.exec("INSERT INTO runs (id, plot_id) VALUES ('run_old', 'plot-old')");
			db.exec("INSERT INTO plan_runs (id, plot_id) VALUES ('plr_old', 'plot-old')");
			db.exec(
				"INSERT INTO plots (id, project_id, status, updated_at, state_json) VALUES ('plot-old', 'prj_old', 'active', '2026-01-01T00:00:00.000Z', '{}')",
			);

			// Apply the real generated migration body (statement-breakpoint split
			// mirrors how drizzle's bun-sqlite migrator executes it).
			const sql = readFileSync(SQLITE_DROP_SQL, "utf8");
			for (const stmt of sql.split("--> statement-breakpoint")) {
				const trimmed = stmt.trim();
				if (trimmed.length > 0) db.exec(trimmed);
			}

			expect(sqliteTableNames(db).has("plots")).toBe(false);
			expect(sqliteColumnNames(db, "runs").has("plot_id")).toBe(false);
			expect(sqliteColumnNames(db, "plan_runs").has("plot_id")).toBe(false);
			expect(sqliteColumnNames(db, "projects").has("has_plot")).toBe(false);
		} finally {
			db.close();
		}
	});

	test.skipIf(!isPostgresTestEnabled())(
		"postgres: migrated schema drops the plots table + plot columns",
		async () => {
			await using handle = await withDb({ dialect: "postgres" });
			const pool = (handle.db as PostgresWarrenDb).raw;

			const tableRows = await pool.query<{ table_name: string }>(
				"SELECT table_name FROM information_schema.tables WHERE table_name = 'plots'",
			);
			expect(tableRows.rows.length).toBe(0);

			const colRows = await pool.query<{ table_name: string; column_name: string }>(
				`SELECT table_name, column_name FROM information_schema.columns
				 WHERE (table_name = 'runs' AND column_name = 'plot_id')
				    OR (table_name = 'plan_runs' AND column_name = 'plot_id')
				    OR (table_name = 'projects' AND column_name = 'has_plot')`,
			);
			expect(colRows.rows.length).toBe(0);
		},
	);
});
