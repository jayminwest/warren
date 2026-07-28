/**
 * Migration 0032 (sqlite) / 0026 (postgres) — drop the canopy project tier
 * from the agents table (warren-f787, plan pl-3a79 step 13): the
 * `agents.project_id` column and the `agents_project_name_idx` /
 * `agents_global_name_idx` indexes in both dialects. Agents now key on
 * `name` alone, enforced by a single `agents_name_idx` unique index.
 *
 * Two angles are covered:
 *
 *   1. The migrated schema no longer declares `agents.project_id` and
 *      carries the `agents_name_idx` unique index (exercised on both
 *      dialects: sqlite always, postgres when `WARREN_TEST_PG_URL` is set).
 *   2. The raw sqlite migration, replayed against a hand-built OLD schema
 *      that HAS the project_id column + old indexes plus data, drops the
 *      column and preserves the surviving rows.
 */

import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { PostgresWarrenDb, SqliteWarrenDb } from "../client.ts";
import { isPostgresTestEnabled, withDb } from "../testing.ts";

const SQLITE_DROP_SQL = join(import.meta.dir, "0032_spotty_otto_octavius.sql");

function sqliteColumnNames(raw: Database, table: string): Set<string> {
	const rows = raw.query<{ name: string }, []>(`PRAGMA table_info(${table})`).all();
	return new Set(rows.map((r) => r.name));
}

function sqliteIndexNames(raw: Database, table: string): Set<string> {
	const rows = raw.query<{ name: string }, []>(`PRAGMA index_list(${table})`).all();
	return new Set(rows.map((r) => r.name));
}

describe("drop agents.project_id (warren-f787)", () => {
	test("sqlite: migrated schema drops project_id and keeps agents_name_idx", async () => {
		await using handle = await withDb({ dialect: "sqlite" });
		const raw = (handle.db as SqliteWarrenDb).raw;

		expect(sqliteColumnNames(raw, "agents").has("project_id")).toBe(false);
		expect(sqliteIndexNames(raw, "agents").has("agents_name_idx")).toBe(true);
		expect(sqliteIndexNames(raw, "agents").has("agents_project_name_idx")).toBe(false);
		expect(sqliteIndexNames(raw, "agents").has("agents_global_name_idx")).toBe(false);
	});

	test("sqlite: replaying the drop SQL against an old populated schema", () => {
		const db = new Database(":memory:");
		try {
			// Reconstruct the pre-0032 shape of the agents table plus a row.
			db.exec(`
				CREATE TABLE agents (
					id INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
					project_id TEXT,
					name TEXT NOT NULL,
					rendered_json TEXT NOT NULL,
					registered_at TEXT NOT NULL,
					last_refreshed TEXT NOT NULL
				);
				CREATE UNIQUE INDEX agents_project_name_idx ON agents (project_id, name);
				CREATE UNIQUE INDEX agents_global_name_idx ON agents (name) WHERE project_id IS NULL;
			`);
			db.exec(
				"INSERT INTO agents (name, project_id, rendered_json, registered_at, last_refreshed) VALUES ('claude-code', NULL, '{}', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')",
			);

			// Apply the real generated migration body (statement-breakpoint split
			// mirrors how drizzle's bun-sqlite migrator executes it).
			const sql = readFileSync(SQLITE_DROP_SQL, "utf8");
			for (const stmt of sql.split("--> statement-breakpoint")) {
				const trimmed = stmt.trim();
				if (trimmed.length > 0) db.exec(trimmed);
			}

			expect(sqliteColumnNames(db, "agents").has("project_id")).toBe(false);
			expect(sqliteIndexNames(db, "agents").has("agents_name_idx")).toBe(true);
			const rows = db.query<{ name: string }, []>("SELECT name FROM agents ORDER BY name").all();
			expect(rows.map((r) => r.name)).toEqual(["claude-code"]);
		} finally {
			db.close();
		}
	});

	test.skipIf(!isPostgresTestEnabled())("postgres: migrated schema drops project_id", async () => {
		await using handle = await withDb({ dialect: "postgres" });
		const pool = (handle.db as PostgresWarrenDb).raw;

		const colRows = await pool.query<{ column_name: string }>(
			`SELECT column_name FROM information_schema.columns
				 WHERE table_name = 'agents' AND column_name = 'project_id'`,
		);
		expect(colRows.rows.length).toBe(0);
	});
});
