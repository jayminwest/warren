/**
 * Repository for the `plots` projection table (warren-9022 / LEVERET §0.0.A /
 * §0.0.F).
 *
 * The plots table is a read-CACHE that mirrors full git-backed Plot state
 * (`.plot/<id>.json` + `<id>.events.jsonl`) — NOT an authoritative store. The
 * source of truth stays git; this repo only ever writes what an upstream
 * projection hook (warren-7b60, the plot-client read/write paths) hands it,
 * derived from the freshly-read git state. A row is fully rebuildable from
 * git, so `upsert` is idempotent and last-writer-wins — there is no state
 * machine to guard (unlike RunsRepo / PlanRunsRepo per mx-a5432a).
 *
 * `id` is the plot's own `plot-...` id (PLOT_ID_REGEX, mx-28a262), supplied by
 * the caller — warren never mints it. `state_json` carries the entire plot
 * state blob; the promoted scalar columns (project_id / status / title /
 * updated_at) are denormalized out of that blob purely to back list / index
 * queries (`listByProject`, status filters).
 */

import { and, asc, desc, eq } from "drizzle-orm";
import { NotFoundError } from "../../core/errors.ts";
import type { SqliteDrizzleDb } from "../client.ts";
import type { PlotProjectionState, PlotRow } from "../schema.ts";
import type { DrizzleAdapter } from "./drizzle-adapter.ts";

export interface UpsertPlotInput {
	/** Plot id (`plot-...`); caller-supplied, never warren-generated. */
	id: string;
	projectId: string;
	status: string;
	/** Plot title; null/omitted for a plot whose intent has no title yet. */
	title?: string | null;
	/** Full git-backed plot state blob mirrored verbatim into `state_json`. */
	state: PlotProjectionState;
	/**
	 * The plot's last-updated timestamp (ISO8601), mirrored from git state.
	 * Falls back to `now` (or wall-clock) when the caller can't derive it.
	 */
	updatedAt?: string;
	now?: Date;
}

export class PlotsRepo {
	constructor(private readonly adapter: DrizzleAdapter) {}

	private get db(): SqliteDrizzleDb {
		return this.adapter.drizzle as SqliteDrizzleDb;
	}

	private get plots() {
		return this.adapter.schema.plots;
	}

	/**
	 * Insert-or-replace the projection row for `input.id`. Idempotent and
	 * last-writer-wins: the projection mirrors git, so a re-sync of the same
	 * plot simply overwrites the prior denormalized scalars + blob. Runs in
	 * a transaction (read-then-insert/update) to stay cross-dialect without
	 * relying on dialect-specific `ON CONFLICT` shapes.
	 */
	async upsert(input: UpsertPlotInput): Promise<PlotRow> {
		const updatedAt = input.updatedAt ?? (input.now ?? new Date()).toISOString();
		const row: PlotRow = {
			id: input.id,
			projectId: input.projectId,
			status: input.status,
			title: input.title ?? null,
			updatedAt,
			stateJson: input.state,
		};
		return this.adapter.runInTransaction(async (tx) => {
			const txDb = tx.drizzle as SqliteDrizzleDb;
			const plots = tx.schema.plots;
			const existing = await tx.pickOne(txDb.select().from(plots).where(eq(plots.id, input.id)));
			if (existing) {
				await tx.runWrite(
					txDb
						.update(plots)
						.set({
							projectId: row.projectId,
							status: row.status,
							title: row.title,
							updatedAt: row.updatedAt,
							stateJson: row.stateJson,
						})
						.where(eq(plots.id, input.id)),
				);
				return row;
			}
			await tx.runWrite(txDb.insert(plots).values(row));
			return row;
		});
	}

	async get(id: string): Promise<PlotRow | null> {
		const row = await this.adapter.pickOne(
			this.db.select().from(this.plots).where(eq(this.plots.id, id)),
		);
		return row ?? null;
	}

	async require(id: string): Promise<PlotRow> {
		const row = await this.get(id);
		if (!row) {
			throw new NotFoundError(`plot not found: ${id}`, {
				recoveryHint: "the plots table is a projection — re-sync from git to repopulate",
			});
		}
		return row;
	}

	/**
	 * Plots for a project, most-recently-updated first. Optional `status`
	 * narrows to a single status value (the `plots_status` index backs the
	 * filter). Order is `updated_at DESC` so the UI list shows freshest work
	 * at the top; the `(project_id, updated_at)` composite serves the scan.
	 */
	async listByProject(projectId: string, status?: string): Promise<PlotRow[]> {
		const where = status
			? and(eq(this.plots.projectId, projectId), eq(this.plots.status, status))
			: eq(this.plots.projectId, projectId);
		return this.adapter.pickAll(
			this.db.select().from(this.plots).where(where).orderBy(desc(this.plots.updatedAt)),
		);
	}

	async listAll(): Promise<PlotRow[]> {
		return this.adapter.pickAll(this.db.select().from(this.plots).orderBy(asc(this.plots.id)));
	}

	async delete(id: string): Promise<void> {
		await this.adapter.runWrite(this.db.delete(this.plots).where(eq(this.plots.id, id)));
	}
}
