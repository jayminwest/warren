/**
 * PR- and branch-fact write methods for the `runs` table (warren-f6af's
 * `setPrUrl`, warren-3bc6's `setPrState`, warren-5255's `setBranch`),
 * extracted from `RunsRepo` to keep `runs.ts`
 * under the file-size budget. Mirrors the `runs-queries.ts` /
 * `runs-ci-fixer.ts` precedent: each method is a free function taking the
 * `DrizzleAdapter` as its first argument, and `RunsRepo` delegates to it
 * so the call surface is unchanged.
 */

import { eq } from "drizzle-orm";
import { NotFoundError } from "../../core/errors.ts";
import type { SqliteDrizzleDb } from "../client.ts";
import type { PullRequestLifecycle, RunRow } from "../schema.ts";
import type { DrizzleAdapter } from "./drizzle-adapter.ts";

/** Load the row or throw NotFoundError (mirrors RunsRepo.require). */
async function requireRun(adapter: DrizzleAdapter, id: string): Promise<RunRow> {
	const db = adapter.drizzle as SqliteDrizzleDb;
	const runs = adapter.schema.runs;
	const row = await adapter.pickOne<RunRow>(db.select().from(runs).where(eq(runs.id, id)));
	if (!row) throw new NotFoundError(`run not found: ${id}`);
	return row;
}

/**
 * Persist the PR URL reap's `pr_open` sub-step opened (warren-f6af).
 * Last write wins; passing `null` clears the field. Separate from
 * `finalize` because reap fires this *before* the terminal transition
 * (so the URL lands on the `reap.completed` event payload too).
 */
/**
 * Persist the composed workspace branch spawnRun dispatched to
 * (warren-5255). Written once, right after branch composition — the run id
 * is generated inside `create`, so the branch cannot ride the insert.
 */
export async function setBranch(
	adapter: DrizzleAdapter,
	id: string,
	branch: string,
): Promise<RunRow> {
	const db = adapter.drizzle as SqliteDrizzleDb;
	const runs = adapter.schema.runs;
	const current = await requireRun(adapter, id);
	await adapter.runWrite(db.update(runs).set({ branch }).where(eq(runs.id, id)));
	return { ...current, branch };
}

export async function setPrUrl(
	adapter: DrizzleAdapter,
	id: string,
	prUrl: string | null,
): Promise<RunRow> {
	const db = adapter.drizzle as SqliteDrizzleDb;
	const runs = adapter.schema.runs;
	const current = await requireRun(adapter, id);
	await adapter.runWrite(db.update(runs).set({ prUrl }).where(eq(runs.id, id)));
	return { ...current, prUrl };
}

/**
 * Persist the merge-watcher's PR facts (warren-3bc6 / pl-103e step 6).
 * `prState` is the forge-reported lifecycle (`open` while polling,
 * `merged` / `closed_unmerged` at terminal); `prMergedAt` is the
 * forge-reported merge instant, null for every non-merged state. Last
 * write wins — the watcher's terminal write is the one that sticks.
 */
export async function setPrState(
	adapter: DrizzleAdapter,
	id: string,
	prState: PullRequestLifecycle,
	prMergedAt: string | null,
): Promise<RunRow> {
	const db = adapter.drizzle as SqliteDrizzleDb;
	const runs = adapter.schema.runs;
	const current = await requireRun(adapter, id);
	await adapter.runWrite(db.update(runs).set({ prState, prMergedAt }).where(eq(runs.id, id)));
	return { ...current, prState, prMergedAt };
}
