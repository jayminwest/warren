#!/usr/bin/env bun
/**
 * pg-migrate parity — DSN-to-DSN cutover verification (warren-c4b7).
 *
 * Connects to SOURCE_DB_URL and TARGET_DB_URL and compares:
 *
 *   1. per-table row counts for every table in the `public` schema
 *      (union of the two sides; a table on one side only is a mismatch),
 *   2. `max(events.id)`,
 *   3. `max(runs.created_at)`,
 *   4. the drizzle migration journal hash list
 *      (`drizzle.__drizzle_migrations`, ordered by created_at).
 *
 * On any mismatch it prints a diff table and exits non-zero. A clean run
 * prints `parity: OK` and exits zero.
 *
 * Usage:
 *
 *   SOURCE_DB_URL=... TARGET_DB_URL=... bun run scripts/pg-migrate/parity.ts
 *   bun run scripts/pg-migrate/parity.ts --source ... --target ...
 *
 * The comparison is read-only on both sides.
 */

import { Client } from "pg";
import { renderParityDiff, requireDbUrl } from "./lib.ts";

export interface TableParity {
	readonly table: string;
	readonly sourceCount: number | null;
	readonly targetCount: number | null;
}

export interface ScalarParity {
	readonly source: string | null;
	readonly target: string | null;
}

export interface ParityReport {
	readonly tables: readonly TableParity[];
	readonly maxEventId: ScalarParity;
	readonly maxRunCreatedAt: ScalarParity;
	readonly migrationHashes: ScalarParity;
	readonly mismatches: readonly string[];
}

interface SideHandle {
	readonly client: Client;
	readonly tables: ReadonlySet<string>;
	readonly hasTable: (schema: string, table: string) => Promise<boolean>;
}

const PUBLIC_TABLES_SQL = `
	SELECT table_name
	FROM information_schema.tables
	WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
	ORDER BY table_name`;

const MIGRATION_HASHES_SQL = `
	SELECT hash FROM drizzle.__drizzle_migrations ORDER BY created_at, id`;

async function openSide(url: string): Promise<SideHandle> {
	const client = new Client({ connectionString: url });
	await client.connect();
	const tableRows = await client.query<{ table_name: string }>(PUBLIC_TABLES_SQL);
	const tables = new Set(tableRows.rows.map((r) => r.table_name));
	const cache = new Map<string, boolean>();
	const hasTable = async (schema: string, table: string): Promise<boolean> => {
		const key = `${schema}.${table}`;
		const cached = cache.get(key);
		if (cached !== undefined) return cached;
		const rows = await client.query<{ present: boolean }>(
			`SELECT EXISTS (
				SELECT 1 FROM information_schema.tables
				WHERE table_schema = $1 AND table_name = $2
			) AS present`,
			[schema, table],
		);
		const present = rows.rows[0]?.present === true;
		cache.set(key, present);
		return present;
	};
	return { client, tables, hasTable };
}

async function tableCount(side: SideHandle, table: string): Promise<number | null> {
	if (!(await side.hasTable("public", table))) return null;
	const rows = await side.client.query<{ count: string }>(
		`SELECT count(*)::text AS count FROM "public"."${table.replaceAll('"', '""')}"`,
	);
	const raw = rows.rows[0]?.count;
	return raw === undefined ? null : Number(raw);
}

/** Scalar max over a table, null when the table is absent or empty. */
async function scalarMax(side: SideHandle, table: string, column: string): Promise<string | null> {
	if (!(await side.hasTable("public", table))) return null;
	const rows = await side.client.query<{ max: unknown }>(
		`SELECT max("${column.replaceAll('"', '""')}")::text AS max FROM "public"."${table.replaceAll('"', '""')}"`,
	);
	const raw = rows.rows[0]?.max;
	return raw === null || raw === undefined ? null : String(raw);
}

async function migrationHashes(side: SideHandle): Promise<string[] | null> {
	if (!(await side.hasTable("drizzle", "__drizzle_migrations"))) return null;
	const rows = await side.client.query<{ hash: string }>(MIGRATION_HASHES_SQL);
	return rows.rows.map((r) => r.hash);
}

function compareScalar(
	label: string,
	source: string | null,
	target: string | null,
	mismatches: string[],
): void {
	if (source === target) return;
	mismatches.push(`${label}: source=${source ?? "absent"} target=${target ?? "absent"}`);
}

export async function compareParity(sourceUrl: string, targetUrl: string): Promise<ParityReport> {
	const source = await openSide(sourceUrl);
	const target = await openSide(targetUrl);
	const mismatches: string[] = [];
	try {
		const tableNames = [...new Set([...source.tables, ...target.tables])].sort();
		const tables: TableParity[] = [];
		for (const table of tableNames) {
			const sourceCount = await tableCount(source, table);
			const targetCount = await tableCount(target, table);
			tables.push({ table, sourceCount, targetCount });
			if (sourceCount === null || targetCount === null) {
				mismatches.push(
					`table ${table}: ${sourceCount === null ? "missing on source" : `${sourceCount} rows`} / ` +
						`${targetCount === null ? "missing on target" : `${targetCount} rows`}`,
				);
			} else if (sourceCount !== targetCount) {
				mismatches.push(
					`table ${table}: ${sourceCount} rows on source, ${targetCount} rows on target`,
				);
			}
		}

		const maxEventId = {
			source: await scalarMax(source, "events", "id"),
			target: await scalarMax(target, "events", "id"),
		};
		compareScalar("max(events.id)", maxEventId.source, maxEventId.target, mismatches);

		const maxRunCreatedAt = {
			source: await scalarMax(source, "runs", "created_at"),
			target: await scalarMax(target, "runs", "created_at"),
		};
		compareScalar(
			"max(runs.created_at)",
			maxRunCreatedAt.source,
			maxRunCreatedAt.target,
			mismatches,
		);

		const [sourceHashes, targetHashes] = await Promise.all([
			migrationHashes(source),
			migrationHashes(target),
		]);
		const migrationHashesResult: ScalarParity = {
			source: sourceHashes === null ? null : sourceHashes.join(","),
			target: targetHashes === null ? null : targetHashes.join(","),
		};
		compareScalar(
			"drizzle.__drizzle_migrations hash list",
			migrationHashesResult.source,
			migrationHashesResult.target,
			mismatches,
		);

		return {
			tables,
			maxEventId,
			maxRunCreatedAt,
			migrationHashes: migrationHashesResult,
			mismatches,
		};
	} finally {
		await source.client.end().catch(() => {});
		await target.client.end().catch(() => {});
	}
}

export interface ParityDiffRow {
	readonly name: string;
	readonly source: string;
	readonly target: string;
	readonly match: boolean;
	readonly reason?: string;
}

/** Flat rows for the diff-table renderer in lib.ts. */
export function parityDiffRows(report: ParityReport): ParityDiffRow[] {
	const rows: ParityDiffRow[] = report.tables.map((t) => ({
		name: `rows: ${t.table}`,
		source: t.sourceCount === null ? "absent" : String(t.sourceCount),
		target: t.targetCount === null ? "absent" : String(t.targetCount),
		match: t.sourceCount !== null && t.sourceCount === t.targetCount,
		reason:
			t.sourceCount === null || t.targetCount === null
				? "table present on one side only"
				: t.sourceCount === t.targetCount
					? undefined
					: "row count differs",
	}));
	rows.push({
		name: "max(events.id)",
		source: report.maxEventId.source ?? "absent",
		target: report.maxEventId.target ?? "absent",
		match: report.maxEventId.source === report.maxEventId.target,
		reason: report.maxEventId.source === report.maxEventId.target ? undefined : "value differs",
	});
	rows.push({
		name: "max(runs.created_at)",
		source: report.maxRunCreatedAt.source ?? "absent",
		target: report.maxRunCreatedAt.target ?? "absent",
		match: report.maxRunCreatedAt.source === report.maxRunCreatedAt.target,
		reason:
			report.maxRunCreatedAt.source === report.maxRunCreatedAt.target ? undefined : "value differs",
	});
	rows.push({
		name: "drizzle journal hashes",
		source:
			report.migrationHashes.source === null
				? "absent"
				: `${report.migrationHashes.source.split(",").length} entries`,
		target:
			report.migrationHashes.target === null
				? "absent"
				: `${report.migrationHashes.target.split(",").length} entries`,
		match: report.migrationHashes.source === report.migrationHashes.target,
		reason:
			report.migrationHashes.source === report.migrationHashes.target
				? undefined
				: "hash list differs",
	});
	return rows;
}

export interface ParityArgs {
	readonly source?: string;
	readonly target?: string;
	readonly help: boolean;
}

export function parseArgs(argv: readonly string[]): ParityArgs {
	let source: string | undefined;
	let target: string | undefined;
	let help = false;
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i] ?? "";
		if (arg === "--help" || arg === "-h") {
			help = true;
		} else if (arg === "--source") {
			source = argv[++i];
		} else if (arg.startsWith("--source=")) {
			source = arg.slice("--source=".length);
		} else if (arg === "--target") {
			target = argv[++i];
		} else if (arg.startsWith("--target=")) {
			target = arg.slice("--target=".length);
		} else {
			throw new Error(`unknown argument ${JSON.stringify(arg)}; try --help`);
		}
	}
	return { source, target, help };
}

export async function parityMain(argv: readonly string[]): Promise<number> {
	const args = parseArgs(argv);
	if (args.help) {
		console.log(
			"usage: parity.ts [--source <url>] [--target <url>]\n" +
				"  source defaults to $SOURCE_DB_URL; target to $TARGET_DB_URL",
		);
		return 0;
	}
	const sourceUrl = requireDbUrl("SOURCE_DB_URL", args.source);
	const targetUrl = requireDbUrl("TARGET_DB_URL", args.target);

	const report = await compareParity(sourceUrl, targetUrl);
	console.log(renderParityDiff("parity: source vs target", parityDiffRows(report)));
	if (report.mismatches.length > 0) {
		console.error(`parity: FAILED — ${report.mismatches.length} mismatch(es)`);
		for (const m of report.mismatches) console.error(`  - ${m}`);
		return 1;
	}
	console.log("parity: OK");
	return 0;
}

if (import.meta.main) {
	parityMain(process.argv.slice(2))
		.then((code) => process.exit(code))
		.catch((err: unknown) => {
			console.error(`[pg-migrate parity] ${err instanceof Error ? err.message : String(err)}`);
			process.exit(1);
		});
}
