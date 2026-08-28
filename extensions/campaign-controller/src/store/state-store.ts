/**
 * CampaignStateStore: the composition root for the controller's durable
 * state (plan pl-91b6 step 3, warren-2853).
 *
 * Owns the extension's SQLite database — WAL mode, explicit numbered
 * migrations applied inside transactions, and an injectable clock/id pair so
 * every timestamp and row id is deterministic under the fake-infrastructure
 * tests. Reopening the same file path replays no migrations and sees every
 * committed row: this class is the restart boundary.
 *
 * It intentionally persists no credential. No secret, token, password, or
 * credential column exists in the schema, and `inspectSchema` exists so a
 * test can prove that against the live database rather than the source.
 */
import { Database } from "bun:sqlite";
import type { Clock, IdGenerator } from "../clock.ts";
import { ActionStore } from "./actions.ts";
import { BudgetStore } from "./budget.ts";
import { CampaignStore } from "./campaigns.ts";
import { EventStore } from "./events.ts";
import { FollowUpStore } from "./follow-ups.ts";
import { LeaseStore } from "./leases.ts";
import { MIGRATIONS } from "./schema.ts";

/** One `table_name.column_name` pair from the live schema. */
export interface SchemaColumn {
	readonly table: string;
	readonly column: string;
}

export interface CampaignStateStoreDeps {
	readonly clock: Clock;
	readonly ids: IdGenerator;
}

export class CampaignStateStore {
	readonly #db: Database;
	readonly #clock: Clock;
	readonly #ids: IdGenerator;

	readonly campaigns: CampaignStore;
	readonly actions: ActionStore;
	readonly events: EventStore;
	readonly leases: LeaseStore;
	readonly budget: BudgetStore;
	readonly followUps: FollowUpStore;

	/**
	 * Open (and migrate) the store. `path` may be `":memory:"` for tests.
	 * Migrations run eagerly so a store is never observable half-migrated.
	 */
	constructor(path: string, deps: CampaignStateStoreDeps) {
		this.#db = new Database(path);
		this.#db.run("PRAGMA journal_mode = WAL;");
		this.#db.run("PRAGMA foreign_keys = ON;");
		this.#clock = deps.clock;
		this.#ids = deps.ids;
		const ctx = { db: this.#db, clock: this.#clock, ids: this.#ids };
		this.campaigns = new CampaignStore(ctx);
		this.actions = new ActionStore(ctx);
		this.events = new EventStore(ctx);
		this.leases = new LeaseStore(ctx);
		this.budget = new BudgetStore(ctx);
		this.followUps = new FollowUpStore(ctx);
		this.migrate();
	}

	/** Apply every pending migration, each inside its own transaction. */
	migrate(): void {
		this.#db.run(
			`CREATE TABLE IF NOT EXISTS schema_migrations (
				id INTEGER PRIMARY KEY,
				name TEXT NOT NULL,
				applied_at_ms INTEGER NOT NULL
			)`,
		);
		const applied = new Set(this.appliedMigrationIds());
		const pending = MIGRATIONS.filter((migration) => !applied.has(migration.id));
		for (const migration of pending) {
			const apply = this.#db.transaction(() => {
				this.#db.run(migration.sql);
				this.#db
					.query("INSERT INTO schema_migrations (id, name, applied_at_ms) VALUES (?, ?, ?)")
					.run(migration.id, migration.name, this.#clock.nowMs());
			});
			apply();
		}
	}

	/** Migration ids currently recorded in the database. */
	appliedMigrationIds(): number[] {
		const rows = this.#db.query("SELECT id FROM schema_migrations ORDER BY id").all() as Array<{
			id: number;
		}>;
		return rows.map((row) => row.id);
	}

	/**
	 * Run `fn` inside one SQLite transaction. If it throws, every write in
	 * the transaction rolls back — the durable state keeps its prior shape.
	 */
	transaction<T>(fn: () => T): T {
		const tx = this.#db.transaction(fn);
		return tx();
	}

	/** Every table/column pair in the live schema, for inspection tests. */
	inspectSchema(): SchemaColumn[] {
		const tables = this.#db
			.query(
				"SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
			)
			.all() as Array<{ name: string }>;
		const columns: SchemaColumn[] = [];
		for (const table of tables) {
			const rows = this.#db.query(`PRAGMA table_info(${table.name})`).all() as Array<{
				name: string;
			}>;
			for (const column of rows) {
				columns.push({ table: table.name, column: column.name });
			}
		}
		return columns;
	}

	/** The journal mode actually in effect (WAL except in-memory databases). */
	journalMode(): string {
		const row = this.#db.query("PRAGMA journal_mode").get() as { journal_mode: string };
		return row.journal_mode;
	}

	close(): void {
		this.#db.close();
	}
}
