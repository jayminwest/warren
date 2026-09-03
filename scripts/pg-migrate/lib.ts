#!/usr/bin/env bun
/**
 * Shared helpers for the pg-migrate scripts (warren-c4b7, plan pl-6076 step 7).
 *
 * The cutover from Supabase to the in-cluster Postgres component
 * (`deploy/k8s/components/postgres/`) leans on three operator scripts:
 * `dump.ts`, `restore.ts`, and `parity.ts` beside this module. They share
 * credential resolution, timestamped artifact naming, and output formatting,
 * so those live here once.
 *
 * Nothing in this directory connects to a database unless the operator
 * points a `*_DB_URL` at it. The scripts wrap the standard Postgres client
 * binaries (`pg_dump`, `pg_restore`) plus the `pg` npm package for the
 * query-level checks.
 */

import { basename } from "node:path";

/** Env vars the scripts read. Kept beside the resolver so docs and code agree. */
export const SOURCE_DB_URL_ENV = "SOURCE_DB_URL";
export const TARGET_DB_URL_ENV = "TARGET_DB_URL";

/**
 * Resolve a database URL for one of the pg-migrate scripts. Precedence is
 * flag over environment, matching the rest of the repo's credential
 * resolution (flags > env > config). Throws with a copy-paste hint when
 * neither source supplies a URL.
 */
export function requireDbUrl(role: string, flagValue?: string): string {
	if (flagValue !== undefined && flagValue.trim() !== "") return flagValue;
	const fromEnv = process.env[role];
	if (fromEnv !== undefined && fromEnv.trim() !== "") return fromEnv;
	throw new Error(
		`${role} is required. Pass --${role === "SOURCE_DB_URL" ? "source" : "target"} <url> ` +
			`or export ${role}=postgres://...`,
	);
}

/** Dated dump-file name: `warren-pg-dump-2026-09-02T191500.dump` (UTC, filename-safe). */
export function dumpFileName(now: Date = new Date()): string {
	const iso = now.toISOString();
	const stamp = `${iso.slice(0, 10)}T${iso.slice(11, 13)}${iso.slice(14, 16)}${iso.slice(17, 19)}`;
	return `warren-pg-dump-${stamp}.dump`;
}

/** Human-readable byte size: `1.7 GB`, `204 B`, `13.0 kB`. */
export function humanSize(bytes: number): string {
	if (!Number.isFinite(bytes) || bytes < 0) return "?";
	if (bytes < 1024) return `${bytes} B`;
	const units = ["kB", "MB", "GB", "TB"];
	let value = bytes;
	let unit = "B";
	for (const next of units) {
		if (value < 1024) break;
		value /= 1024;
		unit = next;
	}
	return `${value.toFixed(1)} ${unit}`;
}

/**
 * Extract the table list from `pg_restore --list` output. Table-data TOC
 * entries look like `215; 1259 16456 TABLE DATA public events warren` —
 * schema and table may be quoted. Returns `schema.table` strings in TOC
 * order.
 */
export function tableListFromToc(toc: string): string[] {
	const tables: string[] = [];
	for (const line of toc.split("\n")) {
		const marker = line.indexOf(" TABLE DATA ");
		if (marker === -1) continue;
		const rest = line.slice(marker + " TABLE DATA ".length).trim();
		if (rest === "") continue;
		// Everything after TABLE DATA is `<schema> <table> [<owner> …]`.
		const parts = rest.split(/\s+/);
		const schema = stripQuotes(parts[0] ?? "");
		const table = stripQuotes(parts[1] ?? "");
		if (schema === "" || table === "") continue;
		tables.push(`${schema}.${table}`);
	}
	return tables;
}

function stripQuotes(value: string): string {
	if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
		return value.slice(1, -1).replaceAll('""', '"');
	}
	return value;
}

/**
 * Render the parity diff table. Matched rows render with an `=` marker;
 * each mismatch carries a `!` marker and a reason column.
 */
export function renderParityDiff(
	title: string,
	rows: ReadonlyArray<{
		readonly name: string;
		readonly source: string;
		readonly target: string;
		readonly match: boolean;
		readonly reason?: string;
	}>,
): string {
	const width = (values: readonly string[], min: number): number =>
		Math.max(min, ...values.map((v) => v.length));
	const header = ["check", "source", "target", "", "note"];
	const all = [
		header,
		...rows.map((r) => [r.name, r.source, r.target, r.match ? "=" : "!", r.reason ?? ""]),
	];
	const w0 = width(
		all.map((r) => r[0] ?? ""),
		"check".length,
	);
	const w1 = width(
		all.map((r) => r[1] ?? ""),
		"source".length,
	);
	const w2 = width(
		all.map((r) => r[2] ?? ""),
		"target".length,
	);
	const w4 = width(
		all.map((r) => r[4] ?? ""),
		"note".length,
	);
	const line = (cells: readonly string[]): string =>
		[
			(cells[0] ?? "").padEnd(w0),
			(cells[1] ?? "").padEnd(w1),
			(cells[2] ?? "").padEnd(w2),
			cells[3] ?? "",
			(cells[4] ?? "").padEnd(w4),
		]
			.join("  ")
			.trimEnd();
	const out = [title, line(header), `${"-".repeat(w0)}  ${"-".repeat(w1)}  ${"-".repeat(w2)}  -`];
	for (const row of rows) {
		out.push(line([row.name, row.source, row.target, row.match ? "=" : "!", row.reason ?? ""]));
	}
	return out.join("\n");
}

/** Basename helper re-exported so scripts stay one-import clean. */
export function fileLabel(path: string): string {
	return basename(path);
}
