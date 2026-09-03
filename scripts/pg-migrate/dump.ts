#!/usr/bin/env bun
/**
 * pg-migrate dump — pre-cutover snapshot (warren-c4b7, plan pl-6076 step 7).
 *
 * Wraps `pg_dump -Fc -n public -n drizzle --no-owner --no-privileges` against
 * SOURCE_DB_URL and writes a dated custom-format archive next to the working
 * directory (override with --out). After the dump it prints the archive size
 * and the table list read back out of the archive via `pg_restore --list`,
 * so the operator confirms the TOC before any restore touches a target.
 *
 * Usage:
 *
 *   SOURCE_DB_URL=postgres://... bun run scripts/pg-migrate/dump.ts
 *   bun run scripts/pg-migrate/dump.ts --source postgres://... --out /tmp
 *
 * Both `public` and `drizzle` schemas are dumped: warren's data lives in
 * `public`, and drizzle's journal (`drizzle.__drizzle_migrations`) is what
 * makes the restore land with a migration history parity can verify.
 *
 * Never run this against a database you do not intend to read — the script
 * is read-only against the source, but the credentials it prints in errors
 * come from the URL you handed it.
 */

import { spawnSync } from "node:child_process";
import { stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { dumpFileName, humanSize, requireDbUrl, tableListFromToc } from "./lib.ts";

export interface DumpArgs {
	readonly source?: string;
	readonly out?: string;
	readonly help: boolean;
}

export function parseArgs(argv: readonly string[]): DumpArgs {
	let source: string | undefined;
	let out: string | undefined;
	let help = false;
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i] ?? "";
		if (arg === "--help" || arg === "-h") {
			help = true;
		} else if (arg === "--source") {
			source = argv[++i];
		} else if (arg.startsWith("--source=")) {
			source = arg.slice("--source=".length);
		} else if (arg === "--out") {
			out = argv[++i];
		} else if (arg.startsWith("--out=")) {
			out = arg.slice("--out=".length);
		} else {
			throw new Error(`unknown argument ${JSON.stringify(arg)}; try --help`);
		}
	}
	return { source, out, help };
}

function runPgDump(url: string, file: string): void {
	const result = spawnSync(
		"pg_dump",
		[
			"--format=custom",
			"--no-owner",
			"--no-privileges",
			"--schema=public",
			"--schema=drizzle",
			"--file",
			file,
			url,
		],
		{ encoding: "utf8" },
	);
	if (result.error !== undefined) {
		throw new Error(
			`failed to run pg_dump: ${result.error.message}. Install the postgresql client tools.`,
		);
	}
	if (result.status !== 0) {
		throw new Error(`pg_dump exited ${result.status}: ${stderrOf(result)}`);
	}
}

function runPgRestoreList(file: string): string {
	const result = spawnSync("pg_restore", ["--list", file], { encoding: "utf8" });
	if (result.error !== undefined) {
		throw new Error(
			`failed to run pg_restore: ${result.error.message}. Install the postgresql client tools.`,
		);
	}
	if (result.status !== 0) {
		throw new Error(`pg_restore --list exited ${result.status}: ${stderrOf(result)}`);
	}
	return result.stdout ?? "";
}

function stderrOf(result: { stderr?: string | Buffer }): string {
	const raw = result.stderr ?? "";
	return typeof raw === "string" ? raw.trim() : raw.toString().trim();
}

export async function dumpMain(argv: readonly string[], now: Date = new Date()): Promise<number> {
	const args = parseArgs(argv);
	if (args.help) {
		console.log(
			"usage: dump.ts [--source <url>] [--out <dir>]\n" +
				"  source defaults to $SOURCE_DB_URL\n" +
				"  out    defaults to the working directory",
		);
		return 0;
	}
	const url = requireDbUrl("SOURCE_DB_URL", args.source);
	const outDir = resolve(args.out ?? process.cwd());
	const file = join(outDir, dumpFileName(now));

	runPgDump(url, file);

	const info = await stat(file);
	const toc = runPgRestoreList(file);
	const tables = tableListFromToc(toc);

	console.log(`dump written: ${file}`);
	console.log(`size: ${humanSize(info.size)} (${info.size} bytes)`);
	console.log(`tables (${tables.length}):`);
	for (const table of tables) console.log(`  - ${table}`);
	return 0;
}

if (import.meta.main) {
	dumpMain(process.argv.slice(2))
		.then((code) => process.exit(code))
		.catch((err: unknown) => {
			console.error(`[pg-migrate dump] ${err instanceof Error ? err.message : String(err)}`);
			process.exit(1);
		});
}
