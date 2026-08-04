#!/usr/bin/env bun
/**
 * Postgres row-level-security gate (warren-3206).
 *
 * warren-b778 and warren-062e enabled RLS across the then-existing tables,
 * but nothing in the migration path enabled it by default — `run_inbox`
 * shipped in 0023 with RLS disabled and was only caught by the Supabase
 * security advisor at ERROR level months later. Manual advisor checks are
 * not a control, so this guard makes the migration set self-enforcing:
 * every `CREATE TABLE` in `src/db/migrations/postgres/*.sql` must have a
 * matching `ALTER TABLE <table> ENABLE ROW LEVEL SECURITY` somewhere in the
 * same migration set (the statement shape 0002_enable_rls.sql established).
 *
 * Matching is set-wide and stateful, not per-file: drizzle puts a table's
 * RLS statement in whichever migration adds it, and a table created in one
 * file may get its RLS in a later one (0020 covered conversations/messages
 * from 0012). The audit replays the set in filename order and checks the
 * END STATE: every table that is still live at the end of the chain must
 * have RLS enabled. A table that is later dropped (plots, retired in 0025)
 * stops being audited at the drop, so its teardown-time DISABLE statement
 * does not trip the gate. A live table whose RLS ends up DISABLED fails:
 * disabling is the exposure this gate exists to prevent.
 *
 * Owner-bypass note from the issue: all tables are owned by the connecting
 * role with relforcerowsecurity=false, so RLS never affects warren's own
 * access. It only denies PostgREST/Data-API roles, which is the intent.
 *
 * Chained into `bun run lint` (alongside check-layers.ts and
 * check-wire-types.ts) rather than registered as its own gate:
 * `scripts/check-all.ts` is byte-identical to the l5-toolkit template and
 * its gate vocabulary is frozen, so a repo-specific assertion folds into an
 * existing gate. Also runnable directly: `bun run check:rls`.
 */

import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const REPO_ROOT = resolve(import.meta.dir, "..");

/** The migration set under audit, repo-relative POSIX. */
export const PG_MIGRATIONS_DIR = "src/db/migrations/postgres";

const CREATE_TABLE_RE = /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?"([^"]+)"/i;
const ENABLE_RLS_RE =
	/ALTER\s+TABLE\s+(?:IF\s+EXISTS\s+)?"([^"]+)"\s+ENABLE\s+ROW\s+LEVEL\s+SECURITY/i;
const DISABLE_RLS_RE =
	/ALTER\s+TABLE\s+(?:IF\s+EXISTS\s+)?"([^"]+)"\s+DISABLE\s+ROW\s+LEVEL\s+SECURITY/i;
const DROP_TABLE_RE = /DROP\s+TABLE\s+(?:IF\s+EXISTS\s+)?"([^"]+)"/i;

export interface RlsViolation {
	readonly file: string;
	readonly table: string;
	readonly reason: "missing_enable";
}

/** True if a line is a SQL comment (whole-line `-- …`), never a statement. */
function isSqlComment(trimmed: string): boolean {
	return trimmed.startsWith("--");
}

/** Tables a migration file creates / drops / RLS-enables / RLS-disables. */
export interface MigrationEffects {
	readonly created: string[];
	readonly dropped: Set<string>;
	readonly enabled: Set<string>;
	readonly disabled: Set<string>;
}

/** The schema effects of one migration file's text. */
export function migrationEffects(text: string): MigrationEffects {
	const created: string[] = [];
	const dropped = new Set<string>();
	const enabled = new Set<string>();
	const disabled = new Set<string>();
	for (const line of text.split("\n")) {
		const trimmed = line.trim();
		if (isSqlComment(trimmed)) continue;
		const create = CREATE_TABLE_RE.exec(trimmed);
		if (create?.[1] !== undefined) created.push(create[1]);
		const drop = DROP_TABLE_RE.exec(trimmed);
		if (drop?.[1] !== undefined) dropped.add(drop[1]);
		const on = ENABLE_RLS_RE.exec(trimmed);
		if (on?.[1] !== undefined) enabled.add(on[1]);
		const off = DISABLE_RLS_RE.exec(trimmed);
		if (off?.[1] !== undefined) disabled.add(off[1]);
	}
	return { created, dropped, enabled, disabled };
}

/** The .sql members of the postgres migration set, journal order (filename-sorted). */
export function migrationFiles(repoRoot: string = REPO_ROOT): string[] {
	const dir = resolve(repoRoot, PG_MIGRATIONS_DIR);
	return readdirSync(dir)
		.filter((name) => name.endsWith(".sql"))
		.sort();
}

/**
 * Audit the whole migration set: replay it in journal order and require every
 * table still live at the end of the chain to have RLS enabled.
 */
export function scan(repoRoot: string = REPO_ROOT): RlsViolation[] {
	const dir = resolve(repoRoot, PG_MIGRATIONS_DIR);
	const live = new Map<string, string>(); // table -> file that created it
	const rlsOn = new Set<string>();
	for (const name of migrationFiles(repoRoot)) {
		const fx = migrationEffects(readFileSync(join(dir, name), "utf8"));
		for (const table of fx.created) live.set(table, name);
		for (const table of fx.enabled) rlsOn.add(table);
		for (const table of fx.disabled) rlsOn.delete(table);
		for (const table of fx.dropped) {
			live.delete(table);
			rlsOn.delete(table);
		}
	}
	const violations: RlsViolation[] = [];
	for (const [table, file] of live) {
		if (!rlsOn.has(table)) violations.push({ file, table, reason: "missing_enable" });
	}
	return violations;
}

function main(): void {
	const violations = scan();
	const files = migrationFiles();
	if (violations.length === 0) {
		console.log(
			`check:rls — ok (${files.length} postgres migrations, every CREATE TABLE has ENABLE ROW LEVEL SECURITY)`,
		);
		return;
	}

	console.error(`check:rls — ${violations.length} postgres table(s) without row-level security:\n`);
	for (const v of violations) {
		console.error(
			`  ${PG_MIGRATIONS_DIR}/${v.file} — creates "${v.table}": no live ` +
				"ALTER TABLE ... ENABLE ROW LEVEL SECURITY at the end of the migration set",
		);
	}
	console.error(
		"\nwarren-3206: every table a postgres migration creates must end the chain\n" +
			'deny-all for PostgREST roles. Add `ALTER TABLE "<table>" ENABLE ROW LEVEL SECURITY;`\n' +
			"(the shape 0002_enable_rls.sql established) in the migration that creates the\n" +
			"table, or a follow-up custom migration (`drizzle-kit generate --custom`).",
	);
	process.exit(1);
}

if (import.meta.main) main();
