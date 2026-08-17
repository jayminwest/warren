import { describe, expect, test } from "bun:test";
import {
	copyFileSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "./client.ts";

const REAL_MIGRATIONS = join(import.meta.dir, "migrations");

interface JournalEntry {
	idx: number;
	version: string;
	when: number;
	tag: string;
	breakpoints: boolean;
}

interface Journal {
	version: string;
	dialect: string;
	entries: JournalEntry[];
}

/**
 * Build a partial migrations folder containing the first `count` migrations
 * from the real folder. Used to simulate "partial-state upgrade" — boot on an
 * older build, accumulate data, then upgrade with new migrations added.
 */
function makePartialMigrations(count: number): string {
	const dir = mkdtempSync(join(tmpdir(), "warren-mig-"));
	mkdirSync(join(dir, "meta"));
	const realJournal: Journal = JSON.parse(
		readFileSync(join(REAL_MIGRATIONS, "meta", "_journal.json"), "utf8"),
	);
	const partialJournal: Journal = { ...realJournal, entries: realJournal.entries.slice(0, count) };
	writeFileSync(join(dir, "meta", "_journal.json"), JSON.stringify(partialJournal, null, 2));
	for (const entry of partialJournal.entries) {
		copyFileSync(join(REAL_MIGRATIONS, `${entry.tag}.sql`), join(dir, `${entry.tag}.sql`));
	}
	return dir;
}

describe("openDatabase", () => {
	test("runs migrations against a fresh in-memory db", async () => {
		const db = await openDatabase({ path: ":memory:" });
		try {
			const tables = db.raw
				.query<{ name: string }, []>(
					"SELECT name FROM sqlite_master WHERE type='table' ORDER BY name",
				)
				.all();
			const names = tables.map((t) => t.name);
			for (const expected of ["agents", "projects", "runs", "events"]) {
				expect(names).toContain(expected);
			}
		} finally {
			db.close();
		}
	});

	test("enables WAL on file-backed databases and creates parent dirs", async () => {
		const tmp = mkdtempSync(join(tmpdir(), "warren-db-"));
		const dbPath = join(tmp, "nested", "warren.db");
		const db = await openDatabase({ path: dbPath });
		try {
			const mode = db.raw.query<{ journal_mode: string }, []>("PRAGMA journal_mode").get();
			expect(mode?.journal_mode).toBe("wal");
			const fk = db.raw.query<{ foreign_keys: number }, []>("PRAGMA foreign_keys").get();
			expect(fk?.foreign_keys).toBe(1);
		} finally {
			db.close();
			rmSync(tmp, { recursive: true, force: true });
		}
	});

	test("re-opening an existing db is idempotent for migrations", async () => {
		const tmp = mkdtempSync(join(tmpdir(), "warren-db-"));
		const dbPath = join(tmp, "warren.db");
		const a = await openDatabase({ path: dbPath });
		a.close();
		const b = await openDatabase({ path: dbPath });
		try {
			const tables = b.raw
				.query<{ name: string }, []>(
					"SELECT name FROM sqlite_master WHERE type='table' AND name='runs'",
				)
				.all();
			expect(tables).toHaveLength(1);
		} finally {
			b.close();
			rmSync(tmp, { recursive: true, force: true });
		}
	});

	test("upgrades a populated db across an ALTER-rebuild migration without data loss", async () => {
		// Regression for warren-b060: migration 0003 rebuilds runs via DROP TABLE,
		// which fails with FK ON when events rows reference runs. Drizzle wraps the
		// migration body in BEGIN/COMMIT, so the migration's own
		// `PRAGMA foreign_keys=OFF` is a no-op — the toggle has to happen at the
		// connection level before migrate() runs.
		const tmp = mkdtempSync(join(tmpdir(), "warren-db-"));
		const dbPath = join(tmp, "warren.db");
		const partial = makePartialMigrations(3); // 0000-0002 only
		try {
			const a = await openDatabase({ path: dbPath, migrationsFolder: partial });
			a.raw.exec(
				"INSERT INTO agents (name, rendered_json, registered_at, last_refreshed) VALUES ('claude-code', '{}', '2026-05-09T00:00:00Z', '2026-05-09T00:00:00Z')",
			);
			a.raw.exec(
				"INSERT INTO projects (id, git_url, local_path, default_branch, added_at) VALUES ('p1', 'https://github.com/x/y', '/data/projects/p1', 'main', '2026-05-09T00:00:00Z')",
			);
			a.raw.exec(
				"INSERT INTO runs (id, agent_name, project_id, rendered_agent_json, state, prompt, trigger) VALUES ('r1', 'claude-code', 'p1', '{}', 'running', 'hi', 'manual')",
			);
			for (let seq = 0; seq < 5; seq++) {
				a.raw.exec(
					`INSERT INTO events (run_id, burrow_event_seq, ts, kind, payload_json) VALUES ('r1', ${seq}, '2026-05-09T00:00:00Z', 'message', '{}')`, // pre-0049 column name: partial folder stops at 0002
				);
			}
			a.close();

			// Re-open with the real migrations folder — 0003 must succeed despite
			// FK-referencing rows in events.
			const b = await openDatabase({ path: dbPath });
			try {
				const runs = b.raw.query<{ c: number }, []>("SELECT COUNT(*) as c FROM runs").get();
				const events = b.raw.query<{ c: number }, []>("SELECT COUNT(*) as c FROM events").get();
				expect(runs?.c).toBe(1);
				expect(events?.c).toBe(5);
				const fk = b.raw.query<{ foreign_keys: number }, []>("PRAGMA foreign_keys").get();
				expect(fk?.foreign_keys).toBe(1);
			} finally {
				b.close();
			}
		} finally {
			rmSync(tmp, { recursive: true, force: true });
			rmSync(partial, { recursive: true, force: true });
		}
	});

	test("created indexes match the schema", async () => {
		const db = await openDatabase({ path: ":memory:" });
		try {
			const idx = db.raw
				.query<{ name: string }, []>(
					"SELECT name FROM sqlite_master WHERE type='index' AND name NOT LIKE 'sqlite_%' ORDER BY name",
				)
				.all();
			const names = idx.map((i) => i.name);
			for (const expected of [
				"events_run_seq_idx",
				"events_run_ts_idx",
				"projects_git_url_idx",
				"runs_agent_started_idx",
				"runs_project_started_idx",
				"runs_state_idx",
			]) {
				expect(names).toContain(expected);
			}
		} finally {
			db.close();
		}
	});

	test("`{ url: ':memory:' }` opens a sqlite in-memory db", async () => {
		const db = await openDatabase({ url: ":memory:" });
		try {
			if (db.dialect !== "sqlite") throw new Error("expected sqlite dialect");
			const tables = db.raw
				.query<{ name: string }, []>(
					"SELECT name FROM sqlite_master WHERE type='table' AND name='runs'",
				)
				.all();
			expect(tables).toHaveLength(1);
		} finally {
			await db.close();
		}
	});

	test("`{ url: 'sqlite:///...' }` opens a file-backed sqlite db", async () => {
		const tmp = mkdtempSync(join(tmpdir(), "warren-db-"));
		const dbPath = join(tmp, "warren.db");
		const db = await openDatabase({ url: `sqlite://${dbPath}` });
		try {
			if (db.dialect !== "sqlite") throw new Error("expected sqlite dialect");
			const mode = db.raw.query<{ journal_mode: string }, []>("PRAGMA journal_mode").get();
			expect(mode?.journal_mode).toBe("wal");
		} finally {
			await db.close();
			rmSync(tmp, { recursive: true, force: true });
		}
	});

	test("`url` wins over `path` when both are set", async () => {
		const tmp = mkdtempSync(join(tmpdir(), "warren-db-"));
		const pathOnly = join(tmp, "ignored.db");
		const urlPath = join(tmp, "preferred.db");
		const db = await openDatabase({ path: pathOnly, url: `sqlite://${urlPath}` });
		try {
			expect(db.dialect).toBe("sqlite");
			// The file at urlPath should have been created; pathOnly should not.
			expect(existsSync(urlPath)).toBe(true);
			expect(existsSync(pathOnly)).toBe(false);
		} finally {
			await db.close();
			rmSync(tmp, { recursive: true, force: true });
		}
	});

	test("calling with neither `url` nor `path` throws", async () => {
		await expect(openDatabase({})).rejects.toThrow(/requires `url` or `path`/);
	});

	test("invalid `pgPoolMax` is rejected before opening the pool", async () => {
		await expect(
			openDatabase({ url: "postgres://u:p@127.0.0.1:5432/db", pgPoolMax: 0 }),
		).rejects.toThrow(/pgPoolMax/);
		await expect(
			openDatabase({ url: "postgres://u:p@127.0.0.1:5432/db", pgPoolMax: -3 }),
		).rejects.toThrow(/pgPoolMax/);
	});
});
