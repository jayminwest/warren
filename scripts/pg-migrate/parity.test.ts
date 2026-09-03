import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { Client } from "pg";
import { openDatabase } from "../../src/db/client.ts";
import { compareParity, type ParityReport, parityDiffRows } from "./parity.ts";

/**
 * Parity check against two throwaway databases (warren-c4b7).
 *
 * Skips cleanly when no Postgres test DSN is configured — the same env gate
 * the dialect-polymorphic repo tests use (src/db/testing.ts): set
 * WARREN_TEST_DIALECT=postgres and WARREN_TEST_PG_URL=postgres://...
 * (or run through `bun run test:pg`). The test creates two databases on the
 * harness server, migrates both with warren's Postgres migration set, seeds
 * identical data, and asserts the parity pass/fail behavior end to end.
 */

const pgEnabled =
	process.env.WARREN_TEST_DIALECT === "postgres" &&
	!!process.env.WARREN_TEST_PG_URL &&
	process.env.WARREN_TEST_PG_URL.trim() !== "";

const SUITE = pgEnabled ? describe : describe.skip;

const ADMIN_DB = "postgres";

/** DSN for the harness server's admin (default) database. */
function adminUrl(): string {
	const base = process.env.WARREN_TEST_PG_URL ?? "";
	const url = new URL(base);
	url.pathname = `/${ADMIN_DB}`;
	return url.toString();
}

function dbUrl(name: string): string {
	const url = new URL(adminUrl());
	url.pathname = `/${name}`;
	return url.toString();
}

async function createDatabase(name: string): Promise<void> {
	const client = new Client({ connectionString: adminUrl() });
	try {
		await client.connect();
		await client.query(`DROP DATABASE IF EXISTS "${name}"`);
		await client.query(`CREATE DATABASE "${name}"`);
	} finally {
		await client.end().catch(() => {});
	}
}

async function dropDatabase(name: string): Promise<void> {
	const client = new Client({ connectionString: adminUrl() });
	try {
		await client.connect();
		await client.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
	} finally {
		await client.end().catch(() => {});
	}
}

interface ThrowawayDb {
	readonly name: string;
	readonly url: string;
	/** Client connected to the throwaway database itself. */
	readonly connect: () => Promise<Client>;
	readonly drop: () => Promise<void>;
}

function throwawayDb(prefix: string): ThrowawayDb {
	const name = `${prefix}_${randomBytes(4).toString("hex")}`;
	return {
		name,
		url: dbUrl(name),
		connect: async () => {
			const client = new Client({ connectionString: dbUrl(name) });
			await client.connect();
			return client;
		},
		drop: () => dropDatabase(name),
	};
}

async function migrateWarrenSchema(url: string): Promise<void> {
	// openDatabase runs the Postgres migration set (public schema + drizzle
	// journal in the `drizzle` schema) when skipMigrations is unset.
	const opened = await openDatabase({ url, pgPoolMax: 2 });
	expect(opened.dialect).toBe("postgres");
	await opened.close();
}

const INSERT_PROJECT = `
	INSERT INTO projects (id, git_url, local_path, default_branch, added_at)
	VALUES ($1, $2, $3, $4, $5)`;

const INSERT_RUN = `
	INSERT INTO runs (id, agent_name, rendered_agent_json, state, prompt, trigger, created_at)
	VALUES ($1, $2, $3, $4, $5, $6, $7)`;

const INSERT_EVENT = `
	INSERT INTO events (run_id, sandbox_event_seq, ts, kind, payload_json)
	VALUES ($1, $2, $3, $4, $5)`;

async function seedWarrenRows(url: string): Promise<void> {
	const client = new Client({ connectionString: url });
	try {
		await client.connect();
		await client.query(INSERT_PROJECT, [
			"p1",
			"https://example.com/repo",
			"/tmp/repo",
			"main",
			"2026-09-01T00:00:00Z",
		]);
		await client.query(INSERT_RUN, [
			"r1",
			"pi",
			"{}",
			"done",
			"prompt text",
			"manual",
			1725300000000,
		]);
		await client.query(INSERT_EVENT, ["r1", 1, "2026-09-01T00:00:01Z", "turn_end", "{}"]);
	} finally {
		await client.end().catch(() => {});
	}
}

let sourceDb: ThrowawayDb;
let targetDb: ThrowawayDb;

SUITE("pg-migrate parity", () => {
	beforeAll(async () => {
		sourceDb = throwawayDb("warren_parity_src");
		targetDb = throwawayDb("warren_parity_tgt");
		await createDatabase(sourceDb.name);
		await createDatabase(targetDb.name);
		await migrateWarrenSchema(sourceDb.url);
		await migrateWarrenSchema(targetDb.url);
		await seedWarrenRows(sourceDb.url);
		await seedWarrenRows(targetDb.url);
	});

	afterAll(async () => {
		if (sourceDb) await sourceDb.drop();
		if (targetDb) await targetDb.drop();
	});

	test("passes when both sides hold identical data and journal", async () => {
		const report = await compareParity(sourceDb.url, targetDb.url);
		expect(report.mismatches).toEqual([]);
		expect(report.maxEventId.source).toBe(report.maxEventId.target);
		expect(Number(report.maxEventId.source)).toBeGreaterThan(0);
		expect(report.maxRunCreatedAt.source).toBe("1725300000000");
		expect(report.maxRunCreatedAt.source).toBe(report.maxRunCreatedAt.target);
		expect(report.migrationHashes.source).toBe(report.migrationHashes.target);
		expect((report.migrationHashes.source ?? "").length).toBeGreaterThan(0);
	});

	test("fails with a row-count mismatch when the source has an extra row", async () => {
		const client = await sourceDb.connect();
		try {
			await client.query(INSERT_PROJECT, [
				"p2",
				"https://example.com/repo2",
				"/tmp/repo2",
				"main",
				"2026-09-01T01:00:00Z",
			]);
		} finally {
			await client.end().catch(() => {});
		}
		const report = await compareParity(sourceDb.url, targetDb.url);
		expect(report.mismatches.some((m) => m.includes("projects"))).toBe(true);
		const diff = parityDiffRows(report);
		const projectsRow = diff.find((r) => r.name === "rows: projects");
		expect(projectsRow?.match).toBe(false);
	});

	test("fails when a table is missing on the target", async () => {
		const client = await targetDb.connect();
		try {
			await client.query("DROP TABLE events CASCADE");
		} finally {
			await client.end().catch(() => {});
		}
		const report = await compareParity(sourceDb.url, targetDb.url);
		expect(report.mismatches.some((m) => m.includes("events"))).toBe(true);
		expect(report.maxEventId.target).toBeNull();
		expect(report.maxEventId.source).not.toBeNull();
	});

	test("fails when the drizzle journal hash lists differ", async () => {
		const client = await targetDb.connect();
		try {
			await client.query(
				"DELETE FROM drizzle.__drizzle_migrations WHERE id = (SELECT max(id) FROM drizzle.__drizzle_migrations)",
			);
		} finally {
			await client.end().catch(() => {});
		}
		const report: ParityReport = await compareParity(sourceDb.url, targetDb.url);
		expect(report.mismatches.some((m) => m.includes("__drizzle_migrations"))).toBe(true);
	});
});
