/**
 * Migration 0030 (sqlite) / 0024 (postgres) — drop the `conversations` +
 * `messages` tables as part of the conversations deletion pass (warren-d93e,
 * plan pl-3a79 step 3).
 *
 * Two angles are covered:
 *
 *   1. The migrated schema no longer declares `conversations` / `messages`
 *      (exercised on both dialects: sqlite always, postgres when
 *      `WARREN_TEST_PG_URL` is set).
 *   2. The raw sqlite drop SQL, replayed against a hand-built OLD schema that
 *      HAS both tables plus data, drops them cleanly.
 */

import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { PostgresWarrenDb, SqliteWarrenDb } from "../client.ts";
import { isPostgresTestEnabled, withDb } from "../testing.ts";

const SQLITE_DROP_SQL = join(import.meta.dir, "0030_moaning_tombstone.sql");

function sqliteTableNames(raw: Database): Set<string> {
	const rows = raw
		.query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type = 'table'")
		.all();
	return new Set(rows.map((r) => r.name));
}

describe("drop conversations + messages tables (warren-d93e)", () => {
	test("sqlite: migrated schema no longer declares either table", async () => {
		await using handle = await withDb({ dialect: "sqlite" });
		const raw = (handle.db as SqliteWarrenDb).raw;

		const tables = sqliteTableNames(raw);
		expect(tables.has("conversations")).toBe(false);
		expect(tables.has("messages")).toBe(false);
	});

	test("sqlite: replaying the drop SQL against an old populated schema", () => {
		const db = new Database(":memory:");
		try {
			// Reconstruct the pre-0030 shape of both tables plus data.
			db.exec(`
				CREATE TABLE conversations (
					id TEXT PRIMARY KEY,
					project_id TEXT,
					plot_id TEXT,
					anchoring_run_id TEXT,
					status TEXT NOT NULL DEFAULT 'active',
					title TEXT,
					created_at TEXT NOT NULL,
					last_activity_at TEXT NOT NULL,
					closed_at TEXT
				);
				CREATE TABLE messages (
					id TEXT PRIMARY KEY,
					conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
					seq INTEGER NOT NULL,
					role TEXT NOT NULL,
					content TEXT NOT NULL,
					run_id TEXT,
					created_at TEXT NOT NULL
				);
			`);
			db.exec(
				"INSERT INTO conversations (id, status, created_at, last_activity_at) VALUES ('conv_old', 'active', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')",
			);
			db.exec(
				"INSERT INTO messages (id, conversation_id, seq, role, content, created_at) VALUES ('msg_old', 'conv_old', 0, 'user', 'hi', '2026-01-01T00:00:00.000Z')",
			);

			// Apply the real generated migration body (statement-breakpoint split
			// mirrors how drizzle's bun-sqlite migrator executes it).
			const sql = readFileSync(SQLITE_DROP_SQL, "utf8");
			for (const stmt of sql.split("--> statement-breakpoint")) {
				const trimmed = stmt.trim();
				if (trimmed.length > 0) db.exec(trimmed);
			}

			const tables = sqliteTableNames(db);
			expect(tables.has("conversations")).toBe(false);
			expect(tables.has("messages")).toBe(false);
		} finally {
			db.close();
		}
	});

	test.skipIf(!isPostgresTestEnabled())(
		"postgres: migrated schema no longer declares either table",
		async () => {
			await using handle = await withDb({ dialect: "postgres" });
			const pool = (handle.db as PostgresWarrenDb).raw;

			const tableRows = await pool.query<{ table_name: string }>(
				"SELECT table_name FROM information_schema.tables WHERE table_name IN ('conversations', 'messages')",
			);
			const tables = new Set(tableRows.rows.map((r) => r.table_name));
			expect(tables.has("conversations")).toBe(false);
			expect(tables.has("messages")).toBe(false);
		},
	);
});
