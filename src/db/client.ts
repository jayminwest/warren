/**
 * Dialect-aware drizzle database client (R-13, pl-f17e step 3).
 *
 * `openDatabase` opens warren's durable state against either SQLite (today's
 * default, zero-config fresh-install path) or Postgres (operator opt-in via
 * `WARREN_DB_URL=postgres://...`). The pg migration set lives under
 * `src/db/migrations/postgres/` (warren-373e); production boot still passes
 * `{ path }` so the sqlite branch is the only path exercised at runtime until
 * step 5 (warren-e2ea) widens server/main/index.ts onto WARREN_DB_URL.
 *
 * Two shapes share one entry point. The `{ path }` overload preserves the
 * pre-R-13 sqlite signature exactly — tests and the existing server boot path
 * continue to receive a `WarrenDb` (== sqlite) without narrowing. The `{ url }`
 * overload accepts the dialect-agnostic WARREN_DB_URL contract and returns
 * `AnyWarrenDb`; callers narrow on `dialect`. Step 5 (warren-e2ea) wires the
 * server boot path onto `{ url }`.
 *
 * SQLite branch behavior is unchanged: WAL on file-backed dbs, FK off during
 * `migrate()` so the 12-step ALTER pattern in 0003 survives, FK back on after.
 * Postgres branch: pg.Pool with `max` from options or env-default; migrations
 * apply via `drizzle-orm/node-postgres/migrator` against the per-dialect
 * folder. `pg.Pool.end()` is async — the close hook awaits it, which is why
 * `WarrenDb.close()` was always typed as `Promise<void>`.
 */

import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { drizzle as drizzleSqlite } from "drizzle-orm/bun-sqlite";
import { migrate as migrateSqlite } from "drizzle-orm/bun-sqlite/migrator";
import { drizzle as drizzlePg } from "drizzle-orm/node-postgres";
import { migrate as migratePg } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";
import { ValidationError } from "../core/errors.ts";
import * as pgSchema from "./schema/postgres.ts";
import * as schema from "./schema.ts";
import { parseDatabaseUrl } from "./url.ts";

/** WARREN_DB_URL — dialect-aware database URL. */
export const WARREN_DB_URL_ENV = "WARREN_DB_URL" as const;
/** WARREN_DB_PATH — legacy sqlite-only path; back-compat alias. */
export const WARREN_DB_PATH_ENV = "WARREN_DB_PATH" as const;
/** WARREN_DB_POOL_MAX — pg Pool size (sqlite ignores). Default 10. */
export const WARREN_DB_POOL_MAX_ENV = "WARREN_DB_POOL_MAX" as const;
export const DEFAULT_PG_POOL_MAX = 10;

const DEFAULT_SQLITE_MIGRATIONS_FOLDER = join(import.meta.dir, "migrations");
const DEFAULT_PG_MIGRATIONS_FOLDER = join(import.meta.dir, "migrations", "postgres");

export type WarrenDialect = "sqlite" | "postgres";

export type SqliteDrizzleDb = ReturnType<typeof drizzleSqlite<typeof schema>>;
export type PostgresDrizzleDb = ReturnType<typeof drizzlePg<typeof pgSchema>>;

/**
 * Back-compat alias. Repos and consumers that imported `DrizzleDb` pre-R-13
 * expect the sqlite handle — keep that meaning so step 3 doesn't churn the
 * repo layer. Step 5+ widens repos to accept either dialect.
 */
export type DrizzleDb = SqliteDrizzleDb;

export interface SqliteWarrenDb {
	dialect: "sqlite";
	drizzle: SqliteDrizzleDb;
	raw: Database;
	close(): Promise<void>;
}

export interface PostgresWarrenDb {
	dialect: "postgres";
	drizzle: PostgresDrizzleDb;
	raw: Pool;
	close(): Promise<void>;
}

/**
 * Back-compat alias for today's runtime: SQLite. Production code paths that
 * still pass `{ path }` get this exact type back (no narrowing); the wider
 * union below is what step 5 will adopt as the boot path picks up the URL
 * contract.
 */
export type WarrenDb = SqliteWarrenDb;

/** Dialect-aware union returned by the `{ url }` overload of openDatabase. */
export type AnyWarrenDb = SqliteWarrenDb | PostgresWarrenDb;

export interface OpenDatabaseOptions {
	/**
	 * WARREN_DB_URL contract: `sqlite:///path`, `file:///path`, `:memory:`,
	 * `postgres://...`, `postgresql://...`, or a bare sqlite path. Wins over
	 * `path` when both are set.
	 */
	url?: string;
	/**
	 * Legacy sqlite path (`WARREN_DB_PATH` shape). Equivalent to passing the
	 * same string as `url` — both flow through `parseDatabaseUrl`, so callers
	 * can keep the pre-R-13 `{ path }` call shape unchanged.
	 */
	path?: string;
	/** SQLite migrations folder. Defaults to `src/db/migrations/`. */
	migrationsFolder?: string;
	/**
	 * Postgres migrations folder. Defaults to `src/db/migrations/postgres/`
	 * (populated by step 4). If the folder does not exist yet (pre-step-4
	 * checkout), the migrator is skipped so the pg branch is still callable
	 * for integration scaffolding.
	 */
	pgMigrationsFolder?: string;
	skipMigrations?: boolean;
	/**
	 * Postgres pool max connections. Operators tune via WARREN_DB_POOL_MAX
	 * (read by step 5 server config). Defaults to `DEFAULT_PG_POOL_MAX`.
	 */
	pgPoolMax?: number;
}

export async function openDatabase(options: {
	path: string;
	migrationsFolder?: string;
	skipMigrations?: boolean;
}): Promise<SqliteWarrenDb>;
export async function openDatabase(options: OpenDatabaseOptions): Promise<AnyWarrenDb>;
export async function openDatabase(options: OpenDatabaseOptions): Promise<AnyWarrenDb> {
	const raw = resolveUrl(options);
	const parsed = parseDatabaseUrl(raw);
	if (parsed.dialect === "sqlite") {
		return openSqlite(parsed.path, options);
	}
	return openPostgres(parsed.connectionString, options);
}

function resolveUrl(options: OpenDatabaseOptions): string {
	if (options.url !== undefined && options.url !== "") return options.url;
	if (options.path !== undefined && options.path !== "") return options.path;
	throw new ValidationError("openDatabase requires `url` or `path`", {
		recoveryHint: "pass { url: 'sqlite:///data/warren.db' } or { path: '/data/warren.db' }",
	});
}

async function openSqlite(path: string, options: OpenDatabaseOptions): Promise<SqliteWarrenDb> {
	if (path !== ":memory:") {
		await mkdir(dirname(path), { recursive: true });
	}

	const raw = new Database(path, { create: true });
	configureSqlitePragmas(raw, path === ":memory:");

	const db = drizzleSqlite(raw, { schema });

	if (!options.skipMigrations) {
		// FK must be OFF when migrations run so the canonical SQLite "12-step ALTER"
		// pattern (CREATE __new / INSERT SELECT / DROP / RENAME) succeeds against
		// tables referenced by other tables. Drizzle wraps each migration body in
		// BEGIN/COMMIT, and SQLite silently ignores `PRAGMA foreign_keys` toggled
		// inside a transaction — so the toggle has to happen on the connection
		// before migrate() opens its transaction.
		raw.exec("PRAGMA foreign_keys = OFF");
		migrateSqlite(db, {
			migrationsFolder: options.migrationsFolder ?? DEFAULT_SQLITE_MIGRATIONS_FOLDER,
		});
	}
	raw.exec("PRAGMA foreign_keys = ON");

	return {
		dialect: "sqlite",
		drizzle: db,
		raw,
		close: async () => raw.close(),
	};
}

async function openPostgres(
	connectionString: string,
	options: OpenDatabaseOptions,
): Promise<PostgresWarrenDb> {
	const max = options.pgPoolMax ?? DEFAULT_PG_POOL_MAX;
	if (!Number.isInteger(max) || max <= 0) {
		throw new ValidationError(`pgPoolMax must be a positive integer (got ${JSON.stringify(max)})`, {
			recoveryHint: `set WARREN_DB_POOL_MAX to a positive integer; default is ${DEFAULT_PG_POOL_MAX}`,
		});
	}

	const pool = new Pool({ connectionString, max });
	const db = drizzlePg(pool, { schema: pgSchema });

	if (!options.skipMigrations) {
		const folder = options.pgMigrationsFolder ?? DEFAULT_PG_MIGRATIONS_FOLDER;
		// Skip-on-missing is here for test scaffolding that points at a temp
		// folder it hasn't populated yet (step 6 test substrate; step 7
		// acceptance scenarios). The default folder is populated under
		// `src/db/migrations/postgres/` (step 4, warren-373e).
		if (existsSync(folder)) {
			await migratePg(db, { migrationsFolder: folder });
		}
	}

	return {
		dialect: "postgres",
		drizzle: db,
		raw: pool,
		close: async () => {
			await pool.end();
		},
	};
}

function configureSqlitePragmas(raw: Database, inMemory: boolean): void {
	if (!inMemory) {
		raw.exec("PRAGMA journal_mode = WAL");
		raw.exec("PRAGMA synchronous = NORMAL");
	}
	raw.exec("PRAGMA busy_timeout = 5000");
}

/**
 * Dialect-aware reachability probe. Runs `SELECT 1` against the live
 * handle so `warren doctor` / `/readyz` can report `db_reachable` per
 * acceptance #2 of pl-f17e. SQLite uses the synchronous bun-sqlite query
 * surface; Postgres awaits the pool query. Returns void on success;
 * throws (caller maps to the diagnostic envelope).
 */
export async function pingDatabase(db: AnyWarrenDb): Promise<void> {
	if (db.dialect === "sqlite") {
		db.raw.query<{ one: number }, []>("SELECT 1 AS one").get();
		return;
	}
	await db.raw.query("SELECT 1");
}

export { schema };
