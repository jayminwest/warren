/**
 * `warren db migrate-to-postgres` — one-shot SQLite → Postgres copy
 * (R-13, pl-f17e step 8, warren-14ac).
 *
 * Operators upgrading an existing warren deploy from the default SQLite
 * backend to Postgres point this at the on-disk warren.db and a freshly
 * provisioned pg database; the tool walks every warren-owned table in
 * FK-safe order and copies rows across with `INSERT ... ON CONFLICT DO
 * NOTHING`. Re-running is idempotent: existing rows (matched by PK) are
 * skipped, so a paused-and-resumed migration converges to the same end
 * state regardless of where it was interrupted.
 *
 * ## FK-safe table walk
 *
 * Source rows are copied in this order so a child row's parent always
 * exists in the target before the child is inserted:
 *
 *   agents, projects                    — no inbound FKs
 *   runs                                — refs agents.name, projects.id
 *   events                              — refs runs.id
 *   triggers                            — refs projects.id, runs.id
 *
 * The `workers` + `burrows` placement tables were dropped in warren-3743, so
 * they are no longer copied. `runs.worker_id` is retained but plain text
 * (no FK) and left NULL for new runs.
 *
 * ## Shape compatibility
 *
 * The dialect schemas (src/db/schema/sqlite.ts vs schema/postgres.ts)
 * are kept byte-identical at the column-list level by the drift test
 * (mx-de2250). At the JS-value level:
 *
 *   text mode:"json"      → jsonb              both materialize as the
 *                                              deserialized JS value at
 *                                              the drizzle boundary
 *   integer (incl. PK)    → integer / serial   plain number
 *   real (cost_usd)       → doublePrecision    plain number
 *   text (incl. enums)    → text               plain string
 *
 * So a row selected from sqlite plugs straight into a pg insert with no
 * field-level conversion. The PK is preserved verbatim — including the
 * SERIAL `events.id` and `agents.id` (R-03 step 1, pl-fef5, warren-094a) —
 * and the tool advances both sequences to `MAX(id)` after the copy so
 * future appends from warren-on-pg don't collide with seeded rows.
 *
 * ## CLI shape
 *
 *   warren db migrate-to-postgres \
 *     --from /data/warren.db \
 *     --to postgres://warren:warren@host:5432/warren
 *
 * `--from` accepts any sqlite shape `parseDatabaseUrl` recognizes (bare
 * path, `sqlite:///abs/path`, `file:///abs/path`, `:memory:`). `--to`
 * must be a `postgres://` / `postgresql://` URL. Mismatched dialects
 * are a usage error (exit 2). The target's migration set is applied on
 * open, so a fresh empty pg database is a valid target.
 *
 * Emits a single trailing JSON object on stdout summarizing the per-
 * table row counts, so the result is pipe-friendly:
 *
 *   {"ok": true, "tables": [{"name": "agents", "sourceRows": 5,
 *     "inserted": 5, "skipped": 0}, ...]}
 */

import type { PostgresWarrenDb, SqliteWarrenDb } from "../../db/client.ts";
import * as pgSchema from "../../db/schema/postgres.ts";
import * as sqliteSchema from "../../db/schema/sqlite.ts";
import type { CliContext } from "../output.ts";
import { writeJsonLine } from "../output.ts";

/**
 * Default chunk size for pg insert batches. node-postgres binds one
 * parameter per column-value; the widest warren table is `runs` (20
 * columns), so 500 rows/batch = 10k params — well under pg's per-query
 * cap (~65535 bound parameters). Tunable via `chunkSize` for tests.
 */
export const DEFAULT_MIGRATE_CHUNK_SIZE = 500;

export interface MigrateToPostgresDeps {
	readonly source: SqliteWarrenDb;
	readonly target: PostgresWarrenDb;
	/** Override insert batch size. Defaults to `DEFAULT_MIGRATE_CHUNK_SIZE`. */
	readonly chunkSize?: number;
}

export interface MigrateTableReport {
	readonly name: string;
	readonly sourceRows: number;
	readonly inserted: number;
	readonly skipped: number;
}

export interface MigrateToPostgresResult {
	readonly exitCode: number;
	readonly tables: readonly MigrateTableReport[];
}

export async function runMigrateToPostgres(
	context: CliContext,
	deps: MigrateToPostgresDeps,
): Promise<MigrateToPostgresResult> {
	const chunkSize = deps.chunkSize ?? DEFAULT_MIGRATE_CHUNK_SIZE;
	if (!Number.isInteger(chunkSize) || chunkSize <= 0) {
		throw new Error(`chunkSize must be a positive integer (got ${JSON.stringify(chunkSize)})`);
	}

	const { source, target } = deps;
	const tables: MigrateTableReport[] = [];

	// FK-free roots first. Each block follows the same shape: select all
	// rows from sqlite, chunk-insert into pg with `ON CONFLICT DO NOTHING`,
	// count the returned PKs to derive inserted-vs-skipped.
	let agentsRowCount = 0;
	{
		const rows = source.drizzle.select().from(sqliteSchema.agents).all();
		agentsRowCount = rows.length;
		let inserted = 0;
		for (let i = 0; i < rows.length; i += chunkSize) {
			const ret = await target.drizzle
				.insert(pgSchema.agents)
				.values(rows.slice(i, i + chunkSize))
				.onConflictDoNothing()
				.returning({ pk: pgSchema.agents.id });
			inserted += ret.length;
		}
		tables.push({
			name: "agents",
			sourceRows: rows.length,
			inserted,
			skipped: rows.length - inserted,
		});
	}

	{
		const rows = source.drizzle.select().from(sqliteSchema.projects).all();
		let inserted = 0;
		for (let i = 0; i < rows.length; i += chunkSize) {
			const ret = await target.drizzle
				.insert(pgSchema.projects)
				.values(rows.slice(i, i + chunkSize))
				.onConflictDoNothing()
				.returning({ pk: pgSchema.projects.id });
			inserted += ret.length;
		}
		tables.push({
			name: "projects",
			sourceRows: rows.length,
			inserted,
			skipped: rows.length - inserted,
		});
	}

	{
		const rows = source.drizzle.select().from(sqliteSchema.runs).all();
		let inserted = 0;
		for (let i = 0; i < rows.length; i += chunkSize) {
			const ret = await target.drizzle
				.insert(pgSchema.runs)
				.values(rows.slice(i, i + chunkSize))
				.onConflictDoNothing()
				.returning({ pk: pgSchema.runs.id });
			inserted += ret.length;
		}
		tables.push({
			name: "runs",
			sourceRows: rows.length,
			inserted,
			skipped: rows.length - inserted,
		});
	}

	let eventsRowCount = 0;
	{
		const rows = source.drizzle.select().from(sqliteSchema.events).all();
		eventsRowCount = rows.length;
		let inserted = 0;
		for (let i = 0; i < rows.length; i += chunkSize) {
			const ret = await target.drizzle
				.insert(pgSchema.events)
				.values(rows.slice(i, i + chunkSize))
				.onConflictDoNothing()
				.returning({ pk: pgSchema.events.id });
			inserted += ret.length;
		}
		tables.push({
			name: "events",
			sourceRows: rows.length,
			inserted,
			skipped: rows.length - inserted,
		});
	}

	{
		const rows = source.drizzle.select().from(sqliteSchema.triggers).all();
		let inserted = 0;
		for (let i = 0; i < rows.length; i += chunkSize) {
			const ret = await target.drizzle
				.insert(pgSchema.triggers)
				.values(rows.slice(i, i + chunkSize))
				.onConflictDoNothing()
				.returning({ pk: pgSchema.triggers.id });
			inserted += ret.length;
		}
		tables.push({
			name: "triggers",
			sourceRows: rows.length,
			inserted,
			skipped: rows.length - inserted,
		});
	}

	// Advance the events PK sequence so subsequent warren-on-pg appends
	// land on `MAX(id) + 1` instead of colliding with seeded rows. Skip
	// when no events were copied — `setval(seq, NULL)` from an empty
	// `MAX(id)` would error, and there's nothing to bump anyway.
	if (eventsRowCount > 0) {
		await target.raw.query(
			"SELECT setval(pg_get_serial_sequence('events', 'id'), (SELECT MAX(id) FROM events))",
		);
	}
	// agents.id is now serial too (R-03 step 1, pl-fef5, warren-094a); same
	// post-copy sequence-advance is required so warren-on-pg appends don't
	// collide with copied rows.
	if (agentsRowCount > 0) {
		await target.raw.query(
			"SELECT setval(pg_get_serial_sequence('agents', 'id'), (SELECT MAX(id) FROM agents))",
		);
	}

	writeJsonLine(context.stdio.stdout, { ok: true, tables });
	return { exitCode: 0, tables };
}
