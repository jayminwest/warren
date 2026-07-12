/**
 * Dialect-polymorphic drizzle adapter (R-13, pl-f1be step 1).
 *
 * Maps sqlite's sync `.get()` / `.all()` / `.run()` query terminators and sync
 * `db.transaction()` callback to dialect-agnostic async equivalents — so the
 * 7 warren repos can compile against either dialect once steps 2-5 migrate
 * them onto this surface. Concentrates the dispatch in one ~150-LOC file
 * (auditable in isolation, unit-tested against both backends via `withDb()`)
 * instead of fanning the dialect handling across 56 call sites.
 *
 * Public surface:
 *
 *   - `DrizzleAdapter.for(db)` — wrap an `AnyWarrenDb` handle.
 *   - `.pickOne<T>(qb)` — single-row SELECT.
 *   - `.pickAll<T>(qb)` — multi-row SELECT.
 *   - `.runWrite(qb)` — INSERT / UPDATE / DELETE without consuming output.
 *   - `.runReturningOne<T>(qb)` — write + `.returning()`, first row required.
 *   - `.runReturningAll<T>(qb)` — write + `.returning()`, all rows.
 *   - `.runInTransaction(fn)` — atomic block; rolls back on throw.
 *   - `.dialect`, `.drizzle` — accessors repos use to build typed queries.
 *
 * ## Transactions
 *
 * drizzle-orm/bun-sqlite's `db.transaction(fn)` is **synchronous** — if `fn`
 * returns a Promise, drizzle commits before the Promise resolves, so the
 * dialect-agnostic `(tx) => Promise<T>` signature is incompatible with the
 * native sqlite call shape. The sqlite branch therefore issues
 * `BEGIN` / `COMMIT` / `ROLLBACK` directly on the underlying `bun:sqlite`
 * connection via `raw.exec(...)`. This is safe because warren runs as a
 * single Node-style event loop with a single sqlite connection: no other
 * SQL can interleave between the BEGIN and the COMMIT/ROLLBACK on that
 * connection. The pg branch delegates to drizzle's native async
 * `db.transaction(fn)`, which acquires a dedicated pool connection for the
 * transaction lifetime; the inner adapter is rebuilt with the tx-scoped
 * drizzle handle so query builders constructed from `tx.drizzle` execute
 * inside the transaction.
 */

import type { Database } from "bun:sqlite";
import type { Pool } from "pg";
import type { AnyWarrenDb, PostgresDrizzleDb, SqliteDrizzleDb, WarrenDialect } from "../client.ts";
import * as pgSchema from "../schema/postgres.ts";
import * as sqliteSchema from "../schema/sqlite.ts";

/**
 * Canonical schema type repos build queries against. Typed as the sqlite
 * shape because the existing repos pre-R-13 imported sqlite tables; both
 * dialect modules export the same identifiers (agents, projects, runs,
 * events, triggers, planRuns, ...) with structurally identical column
 * shapes. The runtime object returned by `DrizzleAdapter.schema` is the
 * dialect-correct module (sqliteTable for sqlite, pgTable for pg) — drizzle
 * dispatches `db.insert(table)` against the table class's `entityKind`, so
 * the actual runtime table MUST match the handle's dialect.
 */
export type WarrenSchema = typeof sqliteSchema;

/**
 * Drizzle handle accepted by the adapter at each scope. Outside a transaction
 * this is the dialect-specific top-level db handle returned by `openDatabase`;
 * inside a pg transaction this is the tx-scoped handle drizzle hands to the
 * transaction callback. SQLite reuses the top-level handle inside transactions
 * (see runInTransaction above).
 */
export type AnyDrizzleHandle = SqliteDrizzleDb | PostgresDrizzleDb;

/**
 * Sqlite-side read surface — drizzle-orm/bun-sqlite SELECT and
 * INSERT/UPDATE/DELETE+`.returning()` query builders expose synchronous
 * `.get()` / `.all()` terminators returning the projected rows.
 */
export interface SqliteReadable<T> {
	get(): T | undefined;
	all(): T[];
}

/**
 * Sqlite-side write surface — INSERT/UPDATE/DELETE builders without
 * `.returning()` expose `.run()` returning a Changes object the adapter
 * discards.
 */
export interface SqliteWritable {
	run(): unknown;
}

/**
 * Postgres-side read surface — drizzle SELECT and `.returning()` query
 * builders are thenable and resolve to the row array on `await`. We type
 * the input as a bare `PromiseLike<T[]>` so the adapter doesn't pin a
 * specific drizzle internal class.
 */
export type PgReadable<T> = PromiseLike<T[]>;

/**
 * Postgres-side write surface — drizzle INSERT/UPDATE/DELETE builders
 * without `.returning()` are thenable and resolve to a `pg.QueryResult`
 * (NOT a row array — that's only for `.returning()`). The adapter discards
 * the value either way; typed as `PromiseLike<unknown>` to admit both
 * shapes.
 */
export type PgWritable = PromiseLike<unknown>;

/** Accepted by `pickOne` / `pickAll` / `runReturning*` — produces rows. */
export type Readable<T> = SqliteReadable<T> | PgReadable<T>;
/** Accepted by `runWrite` — fire-and-forget INSERT/UPDATE/DELETE. */
export type Writable = SqliteWritable | PgWritable;

interface AdapterHandle {
	dialect: WarrenDialect;
	drizzle: AnyDrizzleHandle;
	raw: Database | Pool;
}

export class DrizzleAdapter {
	private constructor(private readonly handle: AdapterHandle) {}

	/** Wrap a freshly-opened `AnyWarrenDb` handle. */
	static for(db: AnyWarrenDb): DrizzleAdapter {
		return new DrizzleAdapter({
			dialect: db.dialect,
			drizzle: db.drizzle,
			raw: db.raw,
		});
	}

	get dialect(): WarrenDialect {
		return this.handle.dialect;
	}

	/**
	 * The drizzle handle for the current scope (top-level db OR a pg
	 * transaction). Repos use this to build query objects which they then
	 * pass to `.pickOne` / `.pickAll` / `.runWrite` / etc. Typed as the
	 * dialect union so the same repo body compiles on either branch.
	 */
	get drizzle(): AnyDrizzleHandle {
		return this.handle.drizzle;
	}

	/**
	 * Dialect-correct schema module. The runtime object is `sqliteSchema`
	 * when dialect=sqlite (SQLiteTable instances) and `pgSchema` when
	 * dialect=postgres (PgTable instances) — drizzle's `db.insert(table)` /
	 * `db.select().from(table)` dispatch on the table's `entityKind` at
	 * runtime, so the table class MUST match the handle's dialect. Typed as
	 * `WarrenSchema` (the sqlite shape) because both modules export the
	 * same identifiers with structurally identical column shapes; this cast
	 * is the only place in the codebase where the dialect-incorrect type is
	 * tolerated, and it's safe because every consumer treats the schema as
	 * a bag of opaque table references that flow back through `drizzle.*`
	 * calls.
	 */
	get schema(): WarrenSchema {
		const mod = this.handle.dialect === "sqlite" ? sqliteSchema : pgSchema;
		return mod as unknown as WarrenSchema;
	}

	/**
	 * Execute a single-row SELECT. SQLite calls `.get()` synchronously and
	 * resolves; postgres awaits the thenable and returns the first row, or
	 * `undefined` when the result set is empty.
	 */
	async pickOne<T>(query: Readable<T>): Promise<T | undefined> {
		if (this.handle.dialect === "sqlite") {
			return (query as SqliteReadable<T>).get();
		}
		const rows = await (query as PgReadable<T>);
		return rows[0];
	}

	/** Execute a multi-row SELECT. */
	async pickAll<T>(query: Readable<T>): Promise<T[]> {
		if (this.handle.dialect === "sqlite") {
			return (query as SqliteReadable<T>).all();
		}
		return await (query as PgReadable<T>);
	}

	/**
	 * Execute an INSERT/UPDATE/DELETE without consuming the affected-row
	 * info. SQLite calls `.run()` (the returned `Changes` object is
	 * discarded); postgres awaits the thenable (the resolved
	 * `pg.QueryResult` is discarded).
	 */
	async runWrite(query: Writable): Promise<void> {
		if (this.handle.dialect === "sqlite") {
			(query as SqliteWritable).run();
			return;
		}
		await (query as PgWritable);
	}

	/**
	 * Execute an INSERT/UPDATE/DELETE with `.returning()` and pick the first
	 * returned row. EventsRepo.append uses this to round-trip the
	 * autoincrement `id` and other server defaults. Throws when zero rows
	 * came back — the only callers issue single-row writes where this is an
	 * invariant violation.
	 */
	async runReturningOne<T>(query: Readable<T>): Promise<T> {
		const row = await this.pickOne<T>(query);
		if (row === undefined) {
			throw new Error("runReturningOne: query returned no rows");
		}
		return row;
	}

	/** Execute an INSERT/UPDATE/DELETE with `.returning()` and return all rows. */
	async runReturningAll<T>(query: Readable<T>): Promise<T[]> {
		return this.pickAll<T>(query);
	}

	/**
	 * Run `fn` inside a transaction. The `tx` adapter passed to `fn` scopes
	 * all subsequent reads/writes inside the same transaction; rollback
	 * fires on any uncaught throw from `fn`. See the module header for the
	 * dialect-specific implementation notes.
	 */
	async runInTransaction<T>(fn: (tx: DrizzleAdapter) => Promise<T>): Promise<T> {
		if (this.handle.dialect === "sqlite") {
			const raw = this.handle.raw as Database;
			raw.exec("BEGIN");
			try {
				const result = await fn(this);
				raw.exec("COMMIT");
				return result;
			} catch (err) {
				try {
					raw.exec("ROLLBACK");
				} catch {
					// Best-effort: if the connection is already wedged the
					// original throw will surface; nothing useful we can do
					// here.
				}
				throw err;
			}
		}
		const pgDb = this.handle.drizzle as PostgresDrizzleDb;
		return pgDb.transaction(async (tx) => {
			const txAdapter = new DrizzleAdapter({
				dialect: "postgres",
				// tx exposes the same .select / .insert / .update / .delete
				// surface as the top-level handle; the types diverge
				// (NodePgTransaction vs NodePgDatabase) but the runtime
				// methods the adapter touches are byte-identical.
				drizzle: tx as unknown as PostgresDrizzleDb,
				raw: this.handle.raw,
			});
			return fn(txAdapter);
		});
	}
}
