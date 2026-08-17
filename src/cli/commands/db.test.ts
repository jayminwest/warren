/**
 * Unit tests for `runMigrateToPostgres` (warren-14ac).
 *
 * Skips when `WARREN_TEST_PG_URL` is unset — matches the env-gated test
 * substrate the rest of the pg path uses (mx-c1cd3a). When the env is
 * set, each test provisions its own fresh pg DATABASE via a maintenance
 * connection (same shape as acceptance scenario 19) and DROPs it on
 * teardown. The per-database isolation sidesteps a known wart in the
 * generated pg migration set where FK constraints embed a literal
 * `"public"."<parent>"` qualifier — that prevents `withDb()`'s schema-
 * isolation path from running migrations cleanly, but a brand-new
 * database that uses the default `public` schema migrates fine.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { Client } from "pg";
import { openDatabase, type PostgresWarrenDb, type SqliteWarrenDb } from "../../db/client.ts";
import { createRepos } from "../../db/repos/index.ts";
import { WARREN_TEST_PG_URL_ENV } from "../../db/testing.ts";
import type { CliContext } from "../output.ts";
import { runMigrateToPostgres } from "./db.ts";

function captureContext(): { context: CliContext; out: string[]; err: string[] } {
	const out: string[] = [];
	const err: string[] = [];
	return {
		context: {
			env: {},
			stdio: {
				stdout: { write: (c) => out.push(c) },
				stderr: { write: (c) => err.push(c) },
			},
			spawn: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
		},
		out,
		err,
	};
}

function swapDatabaseName(baseUrl: string, dbName: string): string {
	const u = new URL(baseUrl);
	u.pathname = `/${dbName}`;
	return u.toString();
}

async function createDatabase(baseUrl: string, dbName: string): Promise<void> {
	const client = new Client({ connectionString: baseUrl });
	await client.connect();
	try {
		await client.query(`CREATE DATABASE "${dbName.replace(/"/g, '""')}"`);
	} finally {
		await client.end().catch(() => undefined);
	}
}

async function dropDatabase(baseUrl: string, dbName: string): Promise<void> {
	const client = new Client({ connectionString: baseUrl });
	await client.connect();
	try {
		await client.query(`DROP DATABASE IF EXISTS "${dbName.replace(/"/g, '""')}" WITH (FORCE)`);
	} finally {
		await client.end().catch(() => undefined);
	}
}

const pgBaseUrl = process.env[WARREN_TEST_PG_URL_ENV]?.trim() ?? "";
const pgEnabled = pgBaseUrl !== "";

describe.skipIf(!pgEnabled)("runMigrateToPostgres", () => {
	let source: SqliteWarrenDb;
	let target: PostgresWarrenDb;
	let scratchDbName: string;

	beforeEach(async () => {
		const opened = await openDatabase({ url: ":memory:" });
		if (opened.dialect !== "sqlite") throw new Error("expected sqlite");
		source = opened;

		scratchDbName = `warren_mig_test_${randomBytes(4).toString("hex")}`;
		await createDatabase(pgBaseUrl, scratchDbName);
		const opened2 = await openDatabase({ url: swapDatabaseName(pgBaseUrl, scratchDbName) });
		if (opened2.dialect !== "postgres") throw new Error("expected postgres");
		target = opened2;
	});

	afterEach(async () => {
		await source.close().catch(() => undefined);
		await target.close().catch(() => undefined);
		await dropDatabase(pgBaseUrl, scratchDbName).catch(() => undefined);
	});

	test("copies a populated SQLite DB into Postgres with PKs preserved", async () => {
		const sourceRepos = createRepos(source);
		await sourceRepos.agents.upsert({
			name: "claude-code",
			renderedJson: { provider: "anthropic" },
		});
		const project = await sourceRepos.projects.create({
			id: "prj_test",
			gitUrl: "https://example.com/repo.git",
			localPath: "/data/projects/example/repo",
			defaultBranch: "main",
		});
		const run = await sourceRepos.runs.create({
			id: "run_test",
			agentName: "claude-code",
			projectId: project.id,
			prompt: "hello",
			renderedAgentJson: { agent: "stub" },
			trigger: "cli",
		});
		await sourceRepos.events.append({
			runId: run.id,
			sandboxEventSeq: 1,
			ts: "2026-05-14T00:00:00.000Z",
			kind: "burrow.stream.line",
			stream: "stdout",
			payload: { text: "hi" },
		});
		await sourceRepos.events.append({
			runId: run.id,
			sandboxEventSeq: 2,
			ts: "2026-05-14T00:00:01.000Z",
			kind: "burrow.stream.line",
			stream: "stdout",
			payload: { text: "there" },
		});
		await sourceRepos.triggers.upsert({
			projectId: project.id,
			triggerId: "nightly",
			nextFireAt: "2026-05-15T00:00:00.000Z",
			lastRunId: run.id,
		});

		const { context, out } = captureContext();
		const result = await runMigrateToPostgres(context, { source, target, chunkSize: 2 });

		expect(result.exitCode).toBe(0);
		const byName = new Map(result.tables.map((t) => [t.name, t]));
		expect(byName.get("agents")).toEqual({
			name: "agents",
			sourceRows: 1,
			inserted: 1,
			skipped: 0,
		});
		expect(byName.get("projects")?.inserted).toBe(1);
		expect(byName.get("runs")?.inserted).toBe(1);
		expect(byName.get("events")?.inserted).toBe(2);
		expect(byName.get("triggers")?.inserted).toBe(1);

		// JSON summary emitted on stdout.
		const parsed = JSON.parse(out.join("").trim());
		expect(parsed.ok).toBe(true);
		expect(parsed.tables).toHaveLength(5);

		// PKs preserved byte-for-byte on the pg target.
		const runRows = await target.raw.query<{ id: string; state: string; project_id: string }>(
			"SELECT id, state, project_id FROM runs WHERE id = $1",
			["run_test"],
		);
		expect(runRows.rows[0]).toEqual({ id: "run_test", state: "queued", project_id: "prj_test" });

		const eventRows = await target.raw.query<{
			id: number;
			sandbox_event_seq: number;
			payload_json: unknown;
		}>("SELECT id, sandbox_event_seq, payload_json FROM events ORDER BY id");
		expect(eventRows.rows.map((r) => r.sandbox_event_seq)).toEqual([1, 2]);
		expect(eventRows.rows[0]?.payload_json).toEqual({ text: "hi" });

		const triggerRows = await target.raw.query<{ id: string; last_run_id: string }>(
			"SELECT id, last_run_id FROM triggers",
		);
		expect(triggerRows.rows).toEqual([{ id: "prj_test:nightly", last_run_id: "run_test" }]);

		// `events.id` sequence is advanced so a subsequent native insert
		// picks `MAX(id) + 1` instead of colliding with the seeded PKs.
		const seededMaxId = Math.max(...eventRows.rows.map((r) => r.id));
		const nextInsert = await target.raw.query<{ id: number }>(
			"INSERT INTO events (run_id, sandbox_event_seq, ts, kind, stream, payload_json) " +
				"VALUES ($1, $2, $3, $4, $5, $6::jsonb) RETURNING id",
			[
				"run_test",
				99,
				"2026-05-14T00:00:02.000Z",
				"burrow.stream.line",
				"stdout",
				JSON.stringify({ text: "n" }),
			],
		);
		expect(nextInsert.rows[0]?.id).toBeGreaterThan(seededMaxId);
	});

	test("re-running is idempotent: existing rows are skipped by PK", async () => {
		const sourceRepos = createRepos(source);
		await sourceRepos.agents.upsert({ name: "claude-code", renderedJson: {} });
		await sourceRepos.projects.create({
			id: "prj_idem",
			gitUrl: "https://example.com/idem.git",
			localPath: "/data/projects/example/idem",
			defaultBranch: "main",
		});

		const first = captureContext();
		const firstResult = await runMigrateToPostgres(first.context, { source, target });
		expect(firstResult.tables.find((t) => t.name === "agents")).toEqual({
			name: "agents",
			sourceRows: 1,
			inserted: 1,
			skipped: 0,
		});

		// Second pass — every row is now a PK collision under
		// ON CONFLICT DO NOTHING, so the report should show all-skipped.
		const second = captureContext();
		const secondResult = await runMigrateToPostgres(second.context, { source, target });
		expect(secondResult.exitCode).toBe(0);
		for (const report of secondResult.tables) {
			expect(report.inserted).toBe(0);
			expect(report.skipped).toBe(report.sourceRows);
		}

		// Row counts on the pg side are unchanged after the second pass.
		const agentCount = await target.raw.query<{ count: string }>(
			"SELECT COUNT(*)::text AS count FROM agents",
		);
		expect(agentCount.rows[0]?.count).toBe("1");
	});

	test("empty source: every table reports zero rows; sequence step is skipped", async () => {
		const { context } = captureContext();
		const result = await runMigrateToPostgres(context, { source, target });
		expect(result.exitCode).toBe(0);
		for (const report of result.tables) {
			expect(report.sourceRows).toBe(0);
			expect(report.inserted).toBe(0);
			expect(report.skipped).toBe(0);
		}
		// A fresh insert after an empty migration still works — i.e. the
		// (skipped) setval call didn't poison the sequence.
		await target.raw.query(
			"INSERT INTO agents (name, rendered_json, registered_at, last_refreshed) " +
				"VALUES ('a', '{}'::jsonb, 't', 't')",
		);
		await target.raw.query(
			"INSERT INTO projects (id, git_url, local_path, default_branch, added_at) VALUES ('p1', 'g', 'l', 'main', 't')",
		);
		await target.raw.query(
			"INSERT INTO runs (id, agent_name, project_id, rendered_agent_json, state, prompt, trigger) " +
				"VALUES ('r1', 'a', 'p1', '{}'::jsonb, 'queued', 'p', 'cli')",
		);
		const inserted = await target.raw.query<{ id: number }>(
			"INSERT INTO events (run_id, sandbox_event_seq, ts, kind, stream, payload_json) " +
				"VALUES ('r1', 1, 't', 'k', 'stdout', '{}'::jsonb) RETURNING id",
		);
		expect(inserted.rows[0]?.id).toBe(1);
	});
});
