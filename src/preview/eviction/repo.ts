/**
 * Drizzle-backed previews repo for the eviction worker + manual
 * teardown route (warren-d0a9 split of src/preview/eviction.ts).
 * Polymorphic over sqlite and postgres (warren-adfb).
 *
 * Concurrency strategy:
 *
 *   - **`evict`** is a single CAS UPDATE...WHERE state IN ('starting','live')
 *     with `.returning({id})`. Atomic at the SQL layer on both dialects, so
 *     two concurrent evicters (or an evicter racing a manual teardown) can't
 *     both succeed: the second sees zero RETURNING rows and reports
 *     `claimed=false`. No transaction needed.
 *
 *   - **`claimTeardown`** must report the *previous* state (torn-down vs.
 *     already-torn-down vs. already-failed vs. never-launched), so it does
 *     SELECT-then-UPDATE inside a tx. The pg branch grabs `SELECT ... FOR
 *     UPDATE` on the candidate row to serialize against another claimer or
 *     the eviction worker; sqlite single-connection naturally serializes
 *     within one process, and warren only ever opens one writer connection.
 *     The UPDATE keeps a `state IN ('starting','live')` filter as a belt-
 *     and-suspenders CAS so even a concurrent evict that beats us to the
 *     row is correctly observed (the SELECT we did before still tells us
 *     `previousState`, but the UPDATE no-ops and we still return the right
 *     shape).
 */

import { and, asc, eq, inArray, sql } from "drizzle-orm";
import type { AnyWarrenDb, PostgresDrizzleDb, SqliteDrizzleDb } from "../../db/client.ts";
import { DrizzleAdapter } from "../../db/repos/drizzle-adapter.ts";
import type { PreviewState } from "../../db/schema.ts";
import type { ManualTeardownClaim, RunPreviewRow, RunPreviewsRepo } from "./types.ts";

interface PreviewTxState {
	readonly previewState: PreviewState | null;
	readonly previewPort: number | null;
	readonly burrowId: string | null;
}

async function lockRowForPostgres(tx: DrizzleAdapter, runId: string): Promise<void> {
	if (tx.dialect !== "postgres") return;
	// `SELECT ... FOR UPDATE` locks the candidate row for the duration of
	// the tx so a concurrent claimer or the eviction worker blocks until
	// we commit / rollback. Lock is released automatically on tx end.
	// Hand-rolled SQL because `.for("update")` is pg-only and the schema
	// reference would need a dialect-incorrect cast to type-check against
	// the pg drizzle handle.
	const pgDb = tx.drizzle as PostgresDrizzleDb;
	await pgDb.execute(sql`SELECT id FROM runs WHERE id = ${runId} FOR UPDATE`);
}

async function readCurrentPreview(
	tx: DrizzleAdapter,
	runId: string,
): Promise<PreviewTxState | undefined> {
	const txRuns = tx.schema.runs;
	const txDb = tx.drizzle as SqliteDrizzleDb;
	return tx.pickOne<PreviewTxState>(
		txDb
			.select({
				previewState: txRuns.previewState,
				previewPort: txRuns.previewPort,
				burrowId: txRuns.burrowId,
			})
			.from(txRuns)
			.where(eq(txRuns.id, runId)),
	);
}

async function writeTornDown(tx: DrizzleAdapter, runId: string): Promise<void> {
	const txRuns = tx.schema.runs;
	const txDb = tx.drizzle as SqliteDrizzleDb;
	await tx.runWrite(
		txDb
			.update(txRuns)
			.set({ previewState: "torn-down", previewPort: null })
			.where(and(eq(txRuns.id, runId), inArray(txRuns.previewState, ["starting", "live"]))),
	);
}

function shapeNonClaimable(
	previousState: PreviewState | null,
	current: PreviewTxState,
): ManualTeardownClaim {
	if (previousState === "torn-down") {
		return {
			status: "already-torn-down",
			previousState,
			port: current.previewPort,
			burrowId: current.burrowId,
		};
	}
	if (previousState === "failed") {
		return {
			status: "already-failed",
			previousState,
			port: current.previewPort,
			burrowId: current.burrowId,
		};
	}
	return {
		status: "never-launched",
		previousState: null,
		port: current.previewPort,
		burrowId: current.burrowId,
	};
}

export function createRunPreviewsRepo(db: AnyWarrenDb): RunPreviewsRepo {
	const adapter = DrizzleAdapter.for(db);
	const runs = adapter.schema.runs;
	const drizzleDb = adapter.drizzle as SqliteDrizzleDb;

	return {
		async listActivePreviews(): Promise<readonly RunPreviewRow[]> {
			const rows = await adapter.pickAll<{
				runId: string;
				projectId: string | null;
				burrowId: string | null;
				workerId: string | null;
				previewState: PreviewState | null;
				previewPort: number | null;
				previewStartedAt: string | null;
				previewLastHitAt: string | null;
			}>(
				drizzleDb
					.select({
						runId: runs.id,
						projectId: runs.projectId,
						burrowId: runs.burrowId,
						workerId: runs.workerId,
						previewState: runs.previewState,
						previewPort: runs.previewPort,
						previewStartedAt: runs.previewStartedAt,
						previewLastHitAt: runs.previewLastHitAt,
					})
					.from(runs)
					.where(inArray(runs.previewState, ["starting", "live"]))
					.orderBy(asc(runs.id)),
			);
			return rows.map((r) => ({
				runId: r.runId,
				projectId: r.projectId,
				burrowId: r.burrowId,
				workerId: r.workerId,
				previewState: r.previewState as "starting" | "live",
				previewPort: r.previewPort,
				previewStartedAt: r.previewStartedAt,
				previewLastHitAt: r.previewLastHitAt,
			}));
		},
		async countActivePreviews(): Promise<number> {
			const row = await adapter.pickOne<{ n: number | string }>(
				drizzleDb
					.select({ n: sql<number>`count(*)` })
					.from(runs)
					.where(inArray(runs.previewState, ["starting", "live"])),
			);
			return Number(row?.n ?? 0);
		},
		async evict(input): Promise<boolean> {
			const updated = await adapter.runReturningAll<{ id: string }>(
				drizzleDb
					.update(runs)
					.set({ previewState: "torn-down", previewPort: null })
					.where(and(eq(runs.id, input.runId), inArray(runs.previewState, ["starting", "live"])))
					.returning({ id: runs.id }),
			);
			return updated.length > 0;
		},
		async claimTeardown(input): Promise<ManualTeardownClaim> {
			return adapter.runInTransaction(async (tx) => {
				await lockRowForPostgres(tx, input.runId);
				const current = await readCurrentPreview(tx, input.runId);
				if (current === undefined) {
					// `teardownPreview` already calls `repos.runs.require` before us,
					// so a row vanishing between that check and this transaction is
					// a deletion race the route surfaces as `never-launched` rather
					// than re-raising 404 from inside a transaction.
					return {
						status: "never-launched",
						previousState: null,
						port: null,
						burrowId: null,
					};
				}
				const previousState = current.previewState;
				if (previousState === "starting" || previousState === "live") {
					await writeTornDown(tx, input.runId);
					return {
						status: "torn-down",
						previousState,
						port: current.previewPort,
						burrowId: current.burrowId,
					};
				}
				return shapeNonClaimable(previousState, current);
			});
		},
	};
}
