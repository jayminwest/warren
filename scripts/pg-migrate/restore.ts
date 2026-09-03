#!/usr/bin/env bun
/**
 * pg-migrate restore — load a dump into the in-cluster Postgres (warren-c4b7).
 *
 * Wraps `pg_restore --clean --if-exists --no-owner -d TARGET_DB_URL <file>`.
 * Before it touches anything the script connects to the target and refuses
 * to run when `pg_stat_activity` shows live client backends other than its
 * own connection — a restore with `--clean` drops and recreates every
 * public table, so any concurrent reader or writer loses data mid-command.
 * Pass --force to override once you have confirmed the connections are
 * safe to ignore.
 *
 * Usage:
 *
 *   TARGET_DB_URL=postgres://... bun run scripts/pg-migrate/restore.ts \
 *     warren-pg-dump-2026-09-02T191500.dump
 *   bun run scripts/pg-migrate/restore.ts --target postgres://... --force <file>
 */

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { Client } from "pg";
import { requireDbUrl } from "./lib.ts";

export interface RestoreArgs {
	readonly file?: string;
	readonly target?: string;
	readonly force: boolean;
	readonly help: boolean;
}

interface MutableRestoreArgs {
	file?: string;
	target?: string;
	force: boolean;
	help: boolean;
}

export function parseArgs(argv: readonly string[]): RestoreArgs {
	const out: MutableRestoreArgs = { force: false, help: false };
	let i = 0;
	while (i < argv.length) {
		i = consumeArg(out, argv, i);
	}
	return { file: out.file, target: out.target, force: out.force, help: out.help };
}

/** Consumes one argv entry into `out` and returns the next index. */
function consumeArg(out: MutableRestoreArgs, argv: readonly string[], i: number): number {
	const arg = argv[i] ?? "";
	if (arg === "--help" || arg === "-h") {
		out.help = true;
		return i + 1;
	}
	if (arg === "--force") {
		out.force = true;
		return i + 1;
	}
	if (arg.startsWith("--target=")) {
		out.target = arg.slice("--target=".length);
		return i + 1;
	}
	if (arg === "--target") {
		out.target = argv[i + 1];
		return i + 2;
	}
	if (arg.startsWith("--")) {
		throw new Error(`unknown argument ${JSON.stringify(arg)}; try --help`);
	}
	if (out.file !== undefined) {
		throw new Error("exactly one dump file is expected");
	}
	out.file = arg;
	return i + 1;
}

export interface ForeignConnection {
	readonly pid: number;
	readonly usename: string;
	readonly applicationName: string;
	readonly clientAddr: string | null;
	readonly state: string;
	readonly backendStart: string;
}

const FOREIGN_CONNECTIONS_SQL = `
	SELECT pid, usename, application_name, client_addr, state, backend_start
	FROM pg_stat_activity
	WHERE datname = current_database()
	  AND pid <> pg_backend_pid()
	  AND backend_type = 'client backend'
	ORDER BY pid`;

export async function listForeignConnections(url: string): Promise<ForeignConnection[]> {
	const client = new Client({ connectionString: url });
	try {
		await client.connect();
		const result = await client.query<{
			pid: number;
			usename: string;
			application_name: string;
			client_addr: string | null;
			state: string;
			backend_start: string;
		}>(FOREIGN_CONNECTIONS_SQL);
		return result.rows.map((row) => ({
			pid: row.pid,
			usename: row.usename,
			applicationName: row.application_name,
			clientAddr: row.client_addr,
			state: row.state,
			backendStart: row.backend_start,
		}));
	} finally {
		await client.end().catch(() => {});
	}
}

export function formatConnections(connections: readonly ForeignConnection[]): string {
	return connections
		.map(
			(c) =>
				`  pid ${c.pid} user=${c.usename} app=${JSON.stringify(c.applicationName)} ` +
				`addr=${c.clientAddr ?? "-"} state=${c.state} since=${c.backendStart}`,
		)
		.join("\n");
}

function runPgRestore(target: string, file: string): void {
	const result = spawnSync(
		"pg_restore",
		["--clean", "--if-exists", "--no-owner", "--dbname", target, file],
		{ encoding: "utf8" },
	);
	if (result.error !== undefined) {
		throw new Error(
			`failed to run pg_restore: ${result.error.message}. Install the postgresql client tools.`,
		);
	}
	if (result.status !== 0) {
		throw new Error(`pg_restore exited ${result.status}: ${(result.stderr ?? "").trim()}`);
	}
}

export async function restoreMain(argv: readonly string[]): Promise<number> {
	const args = parseArgs(argv);
	if (args.help) {
		console.log(
			"usage: restore.ts [--target <url>] [--force] <dump-file>\n" +
				"  target defaults to $TARGET_DB_URL\n" +
				"  --force skips the live-connection refusal",
		);
		return 0;
	}
	if (args.file === undefined || args.file === "") {
		throw new Error("a dump file argument is required; try --help");
	}
	const file = resolve(args.file);
	if (!existsSync(file)) throw new Error(`dump file not found: ${file}`);
	const target = requireDbUrl("TARGET_DB_URL", args.target);

	const connections = await listForeignConnections(target);
	if (connections.length > 0 && !args.force) {
		console.error(
			`refusing to restore: ${connections.length} live connection(s) other than this script\n` +
				`${formatConnections(connections)}\n` +
				"Scale warren to 0 first (see docs/RUNBOOK-K8S.md §1.5) or re-run with --force.",
		);
		return 1;
	}
	if (connections.length > 0 && args.force) {
		console.warn(
			`--force set; proceeding with ${connections.length} live connection(s) on the target`,
		);
	}

	console.log(`restoring ${file} into target…`);
	runPgRestore(target, file);
	console.log("restore complete");
	return 0;
}

if (import.meta.main) {
	restoreMain(process.argv.slice(2))
		.then((code) => process.exit(code))
		.catch((err: unknown) => {
			console.error(`[pg-migrate restore] ${err instanceof Error ? err.message : String(err)}`);
			process.exit(1);
		});
}
