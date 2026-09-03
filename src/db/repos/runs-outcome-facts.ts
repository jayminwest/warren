/**
 * Reap-time outcome facts (warren-ab2b / pl-103e), extracted from
 * `RunsRepo` to keep `runs.ts` under the file-size budget — same posture
 * as `runs-ci-fixer.ts`. `RunsRepo.setOutcomeFacts` delegates here so the
 * call surface is unchanged.
 */

import { eq } from "drizzle-orm";
import { NotFoundError } from "../../core/errors.ts";
import type { SqliteDrizzleDb } from "../client.ts";
import type { RunRow } from "../schema.ts";
import type { DrizzleAdapter } from "./drizzle-adapter.ts";

/**
 * The facts the reap pipeline measured at finalize. Every numeric field is
 * `number | null`: NULL means unknown (skipped/failed finalize,
 * unmeasurable diff, pre-column row), never zero. `baseSha` is the resolved
 * workspace base SHA (warren-b19e) — the merge-base of the diff base and the
 * workspace HEAD, read where commits_ahead is measured; null = unmeasurable.
 */
export interface RunOutcomeFacts {
	readonly commitsAhead: number | null;
	readonly baseSha: string | null;
	readonly filesChanged: number | null;
	readonly insertions: number | null;
	readonly deletions: number | null;
}

/**
 * Persist the reap-time outcome facts onto the run row. Last write wins —
 * a re-reap overwrites with its own measurement. Facts are recorded, not
 * interpreted: the caller passes what it measured and NULL for what it
 * could not.
 */
export async function setOutcomeFacts(
	adapter: DrizzleAdapter,
	id: string,
	facts: RunOutcomeFacts,
): Promise<RunRow> {
	const db = adapter.drizzle as SqliteDrizzleDb;
	const runs = adapter.schema.runs;
	const current = await adapter.pickOne<RunRow>(db.select().from(runs).where(eq(runs.id, id)));
	if (!current) throw new NotFoundError(`run not found: ${id}`);
	const patch = {
		commitsAhead: facts.commitsAhead,
		baseSha: facts.baseSha,
		filesChanged: facts.filesChanged,
		insertions: facts.insertions,
		deletions: facts.deletions,
	};
	await adapter.runWrite(db.update(runs).set(patch).where(eq(runs.id, id)));
	return { ...current, ...patch };
}
