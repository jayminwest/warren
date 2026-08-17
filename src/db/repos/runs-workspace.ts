/**
 * Workspace-destruction bookkeeping for the `runs` table (warren-9b77),
 * extracted from `runs.ts` to hold that file under its 500-line budget —
 * the same pattern as `runs-delete.ts` / `runs-queries.ts`: a free
 * function taking the `DrizzleAdapter`, with a thin `RunsRepo` delegate.
 *
 * The fallback workspace GC (`src/runs/reap/gc.ts`) and the per-reap
 * destroy (`src/runs/reap/destroy.ts`) both derive their candidate set
 * from `runs.sandbox_id`. Before warren-9b77 neither path recorded the
 * destruction outcome warren-side, so every reclaimed workspace
 * re-stranded on the next sweep and the `/readyz`
 * `stale_sandbox_workspaces` diagnostic stayed permanently red. Nulling
 * `sandboxId` on every run row that referenced the destroyed workspace is
 * the persisted marker: the `findStrandedBurrows` predicate (and the
 * diagnostic that reuses it) never sees the burrow again.
 */

import { eq } from "drizzle-orm";
import type { SqliteDrizzleDb } from "../client.ts";
import type { DrizzleAdapter } from "./drizzle-adapter.ts";

/**
 * Null out `sandboxId` on every run row that referenced a workspace whose
 * destruction is confirmed (per-reap destroy success, GC-tick destroy
 * success, or GC-tick already-gone). Multiple runs can share one burrow,
 * so the clear is keyed by the burrow id, not the run id. Idempotent —
 * rows already cleared simply don't match the WHERE clause.
 */
export async function clearBurrowIdForWorkspace(
	adapter: DrizzleAdapter,
	sandboxId: string,
): Promise<void> {
	const db = adapter.drizzle as SqliteDrizzleDb;
	const runs = adapter.schema.runs;
	await adapter.runWrite(
		db.update(runs).set({ sandboxId: null }).where(eq(runs.sandboxId, sandboxId)),
	);
}
