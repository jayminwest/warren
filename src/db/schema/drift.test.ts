/**
 * Schema drift parity check (R-13, pl-f17e step 2, acceptance #6).
 *
 * Walks the SQLite and Postgres physical schemas via drizzle's `getTableConfig`
 * and asserts they declare the same tables, columns, FK targets, primary
 * keys, and indexes. Catches the common drift mode: a column added to one
 * dialect but not the other. Type-level differences (jsonb vs text mode:json,
 * doublePrecision vs real, serial vs integer-autoincrement) are intentionally
 * not compared — those are the sanctioned dialect-specific bits documented in
 * `./postgres.ts`.
 */

import { describe, expect, test } from "bun:test";
import { is, SQL } from "drizzle-orm";
import { getTableConfig as getPgTableConfig, type PgTable } from "drizzle-orm/pg-core";
import { getTableConfig as getSqliteTableConfig, type SQLiteTable } from "drizzle-orm/sqlite-core";
import {
	agents as pgAgents,
	burrows as pgBurrows,
	events as pgEvents,
	planRunChildren as pgPlanRunChildren,
	planRuns as pgPlanRuns,
	plots as pgPlots,
	projects as pgProjects,
	runs as pgRuns,
	triggers as pgTriggers,
	workers as pgWorkers,
} from "./postgres.ts";
import {
	agents as sqliteAgents,
	burrows as sqliteBurrows,
	events as sqliteEvents,
	planRunChildren as sqlitePlanRunChildren,
	planRuns as sqlitePlanRuns,
	plots as sqlitePlots,
	projects as sqliteProjects,
	runs as sqliteRuns,
	triggers as sqliteTriggers,
	workers as sqliteWorkers,
} from "./sqlite.ts";

const SQLITE_TABLES: Record<string, SQLiteTable> = {
	agents: sqliteAgents,
	projects: sqliteProjects,
	runs: sqliteRuns,
	events: sqliteEvents,
	triggers: sqliteTriggers,
	workers: sqliteWorkers,
	burrows: sqliteBurrows,
	planRuns: sqlitePlanRuns,
	planRunChildren: sqlitePlanRunChildren,
	plots: sqlitePlots,
};

const PG_TABLES: Record<string, PgTable> = {
	agents: pgAgents,
	projects: pgProjects,
	runs: pgRuns,
	events: pgEvents,
	triggers: pgTriggers,
	workers: pgWorkers,
	burrows: pgBurrows,
	planRuns: pgPlanRuns,
	planRunChildren: pgPlanRunChildren,
	plots: pgPlots,
};

type AnyTable = keyof typeof SQLITE_TABLES;

interface ColumnShape {
	name: string;
	notNull: boolean;
	primary: boolean;
	hasDefault: boolean;
}

interface FkShape {
	columnNames: string[];
	foreignTable: string;
	foreignColumnNames: string[];
	onDelete: string | undefined;
	onUpdate: string | undefined;
}

interface IndexShape {
	name: string;
	unique: boolean;
	columns: string[];
}

interface NormalizedTable {
	name: string;
	columns: ColumnShape[];
	primaryKeyColumns: string[];
	foreignKeys: FkShape[];
	indexes: IndexShape[];
}

function normalizeColumn(col: {
	name: string;
	notNull: boolean;
	primary: boolean;
	hasDefault: boolean;
}): ColumnShape {
	return {
		name: col.name,
		notNull: col.notNull,
		primary: col.primary,
		hasDefault: col.hasDefault,
	};
}

function normalizeIndexColumn(col: unknown): string {
	if (is(col, SQL)) {
		return "<sql>";
	}
	// Both sqlite-core's raw `SQLiteColumn` and pg-core's `IndexedColumn` wrapper
	// expose `.name`; duck-type to handle either without `is()` brand checks.
	if (
		col &&
		typeof col === "object" &&
		"name" in col &&
		typeof (col as { name: unknown }).name === "string"
	) {
		return (col as { name: string }).name;
	}
	return "<unknown>";
}

function normalizeSqliteTable(table: AnyTable): NormalizedTable {
	const t = SQLITE_TABLES[table];
	if (!t) throw new Error(`unknown sqlite table: ${table}`);
	const cfg = getSqliteTableConfig(t);
	return {
		name: cfg.name,
		columns: cfg.columns.map(normalizeColumn).sort((a, b) => a.name.localeCompare(b.name)),
		primaryKeyColumns: cfg.columns
			.filter((c) => c.primary)
			.map((c) => c.name)
			.sort(),
		foreignKeys: cfg.foreignKeys
			.map((fk) => {
				const ref = fk.reference();
				return {
					columnNames: ref.columns.map((c) => c.name).sort(),
					foreignTable: getSqliteTableConfig(ref.foreignTable).name,
					foreignColumnNames: ref.foreignColumns.map((c) => c.name).sort(),
					onDelete: fk.onDelete ?? "no action",
					onUpdate: fk.onUpdate ?? "no action",
				} satisfies FkShape;
			})
			.sort((a, b) => a.columnNames.join(",").localeCompare(b.columnNames.join(","))),
		indexes: cfg.indexes
			.map((idx) => ({
				name: idx.config.name ?? "<unnamed>",
				unique: idx.config.unique,
				columns: idx.config.columns.map(normalizeIndexColumn),
			}))
			.sort((a, b) => a.name.localeCompare(b.name)),
	};
}

function normalizePgTable(table: AnyTable): NormalizedTable {
	const t = PG_TABLES[table];
	if (!t) throw new Error(`unknown pg table: ${table}`);
	const cfg = getPgTableConfig(t);
	return {
		name: cfg.name,
		columns: cfg.columns.map(normalizeColumn).sort((a, b) => a.name.localeCompare(b.name)),
		primaryKeyColumns: cfg.columns
			.filter((c) => c.primary)
			.map((c) => c.name)
			.sort(),
		foreignKeys: cfg.foreignKeys
			.map((fk) => {
				const ref = fk.reference();
				return {
					columnNames: ref.columns.map((c) => c.name).sort(),
					foreignTable: getPgTableConfig(ref.foreignTable).name,
					foreignColumnNames: ref.foreignColumns.map((c) => c.name).sort(),
					onDelete: fk.onDelete ?? "no action",
					onUpdate: fk.onUpdate ?? "no action",
				} satisfies FkShape;
			})
			.sort((a, b) => a.columnNames.join(",").localeCompare(b.columnNames.join(","))),
		indexes: cfg.indexes
			.map((idx) => ({
				name: idx.config.name ?? "<unnamed>",
				unique: idx.config.unique,
				columns: idx.config.columns.map(normalizeIndexColumn),
			}))
			.sort((a, b) => a.name.localeCompare(b.name)),
	};
}

const TABLE_KEYS: AnyTable[] = [
	"agents",
	"projects",
	"runs",
	"events",
	"triggers",
	"workers",
	"burrows",
	"planRuns",
	"planRunChildren",
	"plots",
];

describe("schema dialect parity (sqlite ↔ postgres)", () => {
	test("both modules declare the same set of tables", () => {
		const sqliteNames = TABLE_KEYS.map((k) => normalizeSqliteTable(k).name).sort();
		const pgNames = TABLE_KEYS.map((k) => normalizePgTable(k).name).sort();
		expect(pgNames).toEqual(sqliteNames);
	});

	for (const table of TABLE_KEYS) {
		test(`${table}: columns + PK + FKs + indexes match`, () => {
			expect(normalizePgTable(table)).toEqual(normalizeSqliteTable(table));
		});
	}
});
