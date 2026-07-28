/**
 * Repository for the `agents` table.
 *
 * Agents are canopy prompts cached locally. R-03 (pl-fef5) split identity
 * from a single `name` PK into `(name, project_id)`: a NULL `project_id`
 * is the global tier (built-in + library); a non-null `project_id` is the
 * project tier (rendered from `<projectPath>/.canopy/`). Every read/write
 * method takes an optional `projectId` to address the right tier.
 *
 * Scope semantics:
 *   - Methods with no `projectId` (or `projectId: null`) target the global
 *     tier — exact lookup against `(name, NULL)`. This is the default so
 *     pre-R-03 callers (50+ sites) keep working unchanged.
 *   - `projectId: string` targets the project tier exactly — no fallback
 *     to global. Use `resolve()` for the project-first-with-fallback shape
 *     that spawn (warren-0a7e) needs.
 *
 * `upsert` is the registry-refresh path: re-rendering an existing agent
 * overwrites its rendered_json and bumps last_refreshed without losing the
 * original registered_at timestamp.
 */

import { and, asc, eq, isNull, or, type SQL } from "drizzle-orm";
import { NotFoundError } from "../../core/errors.ts";
import type { SqliteDrizzleDb } from "../client.ts";
import type { AgentRow } from "../schema.ts";
import type { DrizzleAdapter, WarrenSchema } from "./drizzle-adapter.ts";

export interface AgentScope {
	/**
	 * `null` / omitted = global tier (built-in + library rows where
	 * `project_id IS NULL`). A string targets that project's tier exactly.
	 */
	projectId?: string | null;
}

export interface UpsertAgentInput extends AgentScope {
	name: string;
	renderedJson: unknown;
	now?: Date;
}

type AgentsTable = WarrenSchema["agents"];

function scopeWhere(agents: AgentsTable, name: string, projectId: string | null): SQL {
	if (projectId === null) {
		return and(eq(agents.name, name), isNull(agents.projectId)) as SQL;
	}
	return and(eq(agents.name, name), eq(agents.projectId, projectId)) as SQL;
}

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

	async upsert(input: UpsertAgentInput): Promise<AgentRow> {
		const ts = (input.now ?? new Date()).toISOString();
		const projectId = input.projectId ?? null;
		return this.adapter.runInTransaction(async (tx) => {
			const txDb = tx.drizzle as SqliteDrizzleDb;
			const agents = tx.schema.agents;
			const where = scopeWhere(agents, input.name, projectId);
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
					projectId,
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

	/**
	 * Exact-match lookup at the requested scope. No fallback — a project-tier
	 * lookup returns null when only a global row exists. Use `resolve()` for
	 * project-first-with-global-fallback semantics.
	 */
	async get(name: string, scope: AgentScope = {}): Promise<AgentRow | null> {
		const projectId = scope.projectId ?? null;
		const row = await this.adapter.pickOne(
			this.db
				.select()
				.from(this.agents)
				.where(scopeWhere(this.agents, name, projectId)),
		);
		return row ?? null;
	}

	async require(name: string, scope: AgentScope = {}): Promise<AgentRow> {
		const row = await this.get(name, scope);
		if (!row) {
			throw new NotFoundError(`agent not found: ${name}`, {
				recoveryHint:
					"POST /projects/:id/agents/refresh to re-discover from a project .canopy/ tier",
			});
		}
		return row;
	}

	/**
	 * Project-first lookup with global fallback (R-03 step 7 / warren-0a7e):
	 * when `scope.projectId` is set, try `(name, projectId)` first and return
	 * the global row only if no project-tier row exists. Without a projectId,
	 * resolves to the global row (equivalent to `get(name)`).
	 *
	 * Returns null when neither tier has a matching row. `runs.spawn` wraps
	 * this with its own NotFoundError so the existing error envelope (incl.
	 * `recoveryHint: POST /agents/refresh`) stays intact.
	 */
	async resolve(name: string, scope: AgentScope = {}): Promise<AgentRow | null> {
		const projectId = scope.projectId ?? null;
		if (projectId !== null) {
			const projectRow = await this.adapter.pickOne(
				this.db
					.select()
					.from(this.agents)
					.where(scopeWhere(this.agents, name, projectId)),
			);
			if (projectRow) return projectRow;
		}
		return this.get(name);
	}

	/**
	 * List rows at the requested scope, ordered by name.
	 *
	 *   - No `projectId` (or `null`) → global tier only (project_id IS NULL).
	 *     Matches today's `GET /agents` no-filter shape.
	 *   - `projectId: string`       → global ∪ that project's tier. When a
	 *     name exists in both tiers, both rows are returned; dedupe (with
	 *     project-tier preference) belongs at the HTTP/UI layer.
	 */
	async listAll(scope: AgentScope = {}): Promise<AgentRow[]> {
		const projectId = scope.projectId ?? null;
		if (projectId === null) {
			return this.adapter.pickAll(
				this.db
					.select()
					.from(this.agents)
					.where(isNull(this.agents.projectId))
					.orderBy(asc(this.agents.name)),
			);
		}
		return this.adapter.pickAll(
			this.db
				.select()
				.from(this.agents)
				.where(or(isNull(this.agents.projectId), eq(this.agents.projectId, projectId)))
				.orderBy(asc(this.agents.name)),
		);
	}

	/**
	 * Return all project-tier rows for `projectId` (i.e. excluding the global
	 * tier). `refreshProjectAgents` (pl-fef5 step 5) uses this to diff
	 * registered names against what's still on disk so removed prompts are
	 * pruned without touching global rows.
	 */
	async listForProject(projectId: string): Promise<AgentRow[]> {
		return this.adapter.pickAll(
			this.db
				.select()
				.from(this.agents)
				.where(eq(this.agents.projectId, projectId))
				.orderBy(asc(this.agents.name)),
		);
	}

	async delete(name: string, scope: AgentScope = {}): Promise<void> {
		const projectId = scope.projectId ?? null;
		await this.adapter.runWrite(
			this.db.delete(this.agents).where(scopeWhere(this.agents, name, projectId)),
		);
	}
}
