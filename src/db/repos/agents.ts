/**
 * Repository for the `agents` table.
 *
 * Agents are cached agent definitions, identified by `name` alone: the
 * global registry seeded from `src/registry/builtins/`. A library agent
 * loaded from a configured source overrides a built-in of the same name
 * via `upsert`.
 *
 * `upsert` is the seeding path: re-seeding an existing agent overwrites
 * its rendered_json and bumps last_refreshed without losing the original
 * registered_at timestamp.
 */

import { asc, eq } from "drizzle-orm";
import { NotFoundError } from "../../core/errors.ts";
import type { SqliteDrizzleDb } from "../client.ts";
import type { AgentDbRow } from "../schema.ts";
import type { DrizzleAdapter, WarrenSchema } from "./drizzle-adapter.ts";

export interface UpsertAgentInput {
	name: string;
	renderedJson: unknown;
	now?: Date;
}

type AgentsTable = WarrenSchema["agents"];

export class AgentsRepo {
	constructor(private readonly adapter: DrizzleAdapter) {}

	/**
	 * The repo casts `adapter.drizzle` to `SqliteDrizzleDb` to satisfy
	 * TypeScript — drizzle's per-dialect query builders share method names
	 * (`.select()`, `.insert()`, `.update()`, `.delete()`) but their return
	 * types are mutually incompatible at the union level. At runtime the
	 * handle is the dialect-correct drizzle handle paired with the
	 * dialect-correct schema (see `DrizzleAdapter.schema`), so the queries
	 * built here generate the correct dialect SQL.
	 */
	private get db(): SqliteDrizzleDb {
		return this.adapter.drizzle as SqliteDrizzleDb;
	}

	private get agents(): AgentsTable {
		return this.adapter.schema.agents;
	}

	async upsert(input: UpsertAgentInput): Promise<AgentDbRow> {
		const ts = (input.now ?? new Date()).toISOString();
		return this.adapter.runInTransaction(async (tx) => {
			const txDb = tx.drizzle as SqliteDrizzleDb;
			const agents = tx.schema.agents;
			const where = eq(agents.name, input.name);
			const existing = await tx.pickOne(txDb.select().from(agents).where(where));
			if (existing) {
				const patch = {
					renderedJson: input.renderedJson,
					lastRefreshed: ts,
				};
				await tx.runWrite(txDb.update(agents).set(patch).where(where));
				return { ...existing, ...patch };
			}
			await tx.runWrite(
				txDb.insert(agents).values({
					name: input.name,
					renderedJson: input.renderedJson,
					registeredAt: ts,
					lastRefreshed: ts,
				}),
			);
			const inserted = await tx.pickOne(txDb.select().from(agents).where(where));
			if (!inserted) {
				throw new Error("agents.upsert: insert returned no row");
			}
			return inserted;
		});
	}

	/** Exact-match lookup by name. Returns null when no row exists. */
	async get(name: string): Promise<AgentDbRow | null> {
		const row = await this.adapter.pickOne(
			this.db.select().from(this.agents).where(eq(this.agents.name, name)),
		);
		return row ?? null;
	}

	async require(name: string): Promise<AgentDbRow> {
		const row = await this.get(name);
		if (!row) {
			throw new NotFoundError(`agent not found: ${name}`);
		}
		return row;
	}

	/** List all rows, ordered by name. */
	async listAll(): Promise<AgentDbRow[]> {
		return this.adapter.pickAll(this.db.select().from(this.agents).orderBy(asc(this.agents.name)));
	}

	async delete(name: string): Promise<void> {
		await this.adapter.runWrite(this.db.delete(this.agents).where(eq(this.agents.name, name)));
	}
}
