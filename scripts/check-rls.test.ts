import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { migrationEffects, PG_MIGRATIONS_DIR, scan } from "./check-rls.ts";

const REPO_ROOT = resolve(import.meta.dir, "..");

/** Write a fake repo whose `src/db/migrations/postgres/` holds `files`. */
function withFixtureRepo(files: Record<string, string>, run: (dir: string) => void): void {
	const dir = mkdtempSync(join(tmpdir(), "warren-rls-"));
	try {
		for (const [name, text] of Object.entries(files)) {
			const abs = join(dir, PG_MIGRATIONS_DIR, name);
			mkdirSync(dirname(abs), { recursive: true });
			writeFileSync(abs, text);
		}
		run(dir);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

describe("migrationEffects", () => {
	test("reads the drizzle statement shapes, comments excluded", () => {
		const fx = migrationEffects(
			[
				'CREATE TABLE "widgets" (',
				'\t"id" text PRIMARY KEY',
				");--> statement-breakpoint",
				'ALTER TABLE "widgets" ENABLE ROW LEVEL SECURITY;',
				'-- ALTER TABLE "widgets" DISABLE ROW LEVEL SECURITY; (a comment, not a statement)',
			].join("\n"),
		);
		expect(fx.created).toEqual(["widgets"]);
		expect([...fx.enabled]).toEqual(["widgets"]);
		expect(fx.disabled.size).toBe(0);
	});

	test("recognises IF NOT EXISTS / IF EXISTS qualifiers and drops", () => {
		const fx = migrationEffects(
			[
				'CREATE TABLE IF NOT EXISTS "widgets" ("id" text);',
				'DROP TABLE IF EXISTS "old_widgets" CASCADE;',
			].join("\n"),
		);
		expect(fx.created).toEqual(["widgets"]);
		expect([...fx.dropped]).toEqual(["old_widgets"]);
	});
});

describe("scan", () => {
	test("passes when every created table has a matching ENABLE ROW LEVEL SECURITY", () => {
		withFixtureRepo(
			{
				"0000_init.sql": [
					'CREATE TABLE "widgets" ("id" text);',
					'ALTER TABLE "widgets" ENABLE ROW LEVEL SECURITY;',
				].join("\n"),
			},
			(dir) => {
				expect(scan(dir)).toEqual([]);
			},
		);
	});

	test("fails with file + table when a created table never gets RLS", () => {
		withFixtureRepo(
			{
				"0000_init.sql": 'CREATE TABLE "widgets" ("id" text);\n',
			},
			(dir) => {
				expect(scan(dir)).toEqual([
					{ file: "0000_init.sql", table: "widgets", reason: "missing_enable" },
				]);
			},
		);
	});

	test("matches set-wide: RLS may land in a later migration file", () => {
		withFixtureRepo(
			{
				"0000_init.sql": 'CREATE TABLE "widgets" ("id" text);\n',
				"0001_rls.sql": 'ALTER TABLE "widgets" ENABLE ROW LEVEL SECURITY;\n',
			},
			(dir) => {
				expect(scan(dir)).toEqual([]);
			},
		);
	});

	test("fails a live table whose RLS ends the chain disabled", () => {
		withFixtureRepo(
			{
				"0000_init.sql": [
					'CREATE TABLE "widgets" ("id" text);',
					'ALTER TABLE "widgets" ENABLE ROW LEVEL SECURITY;',
				].join("\n"),
				"0001_off.sql": 'ALTER TABLE "widgets" DISABLE ROW LEVEL SECURITY;\n',
			},
			(dir) => {
				expect(scan(dir)).toEqual([
					{ file: "0000_init.sql", table: "widgets", reason: "missing_enable" },
				]);
			},
		);
	});

	test("stops auditing a table once it is dropped (teardown DISABLE is not exposure)", () => {
		withFixtureRepo(
			{
				"0000_init.sql": [
					'CREATE TABLE "widgets" ("id" text);',
					'ALTER TABLE "widgets" ENABLE ROW LEVEL SECURITY;',
				].join("\n"),
				"0001_retire.sql": [
					'ALTER TABLE "widgets" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint',
					'DROP TABLE "widgets" CASCADE;',
				].join("\n"),
			},
			(dir) => {
				expect(scan(dir)).toEqual([]);
			},
		);
	});

	test("passes on the real migration set (warren-3206: run_inbox covered by 0032)", () => {
		expect(scan(REPO_ROOT)).toEqual([]);
	});
});
