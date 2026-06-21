/**
 * CI-fixer run queries (warren-0b75), extracted from `RunsRepo` to keep
 * `runs.ts` under the file-size budget. `RunsRepo` delegates its
 * `listPrCandidatesByProject` / `fixAttemptHistoryByPrUrl` methods here so
 * the call surface is unchanged.
 */

import { and, asc, eq, isNotNull, ne, sql } from "drizzle-orm";
import type { SqliteDrizzleDb } from "../client.ts";
import type { DrizzleAdapter } from "./drizzle-adapter.ts";

/**
 * CI-fixer PR candidates for a project. One entry per distinct `pr_url`,
 * represented by the *oldest* run that carries it — the run that opened the
 * PR, whose `${prefix}/${runId}` branch is the PR head ref the poller
 * fetches check-runs against. Subsequent fixer runs push to that same branch
 * (targetBranch override) and inherit the same `pr_url`, so de-duping to the
 * oldest keeps the head ref stable. Ordered most-recent-PR-first and capped
 * so a project with a long PR history doesn't fan out into an unbounded
 * number of GitHub calls per tick. `conversation`-mode runs are excluded
 * (they never open PRs).
 */
export async function listPrCandidatesByProject(
	adapter: DrizzleAdapter,
	projectId: string,
	limit = 25,
): Promise<{ runId: string; prUrl: string }[]> {
	const db = adapter.drizzle as SqliteDrizzleDb;
	const runs = adapter.schema.runs;
	const rows = await adapter.pickAll<{
		id: string;
		prUrl: string | null;
		startedAt: string | null;
	}>(
		db
			.select({ id: runs.id, prUrl: runs.prUrl, startedAt: runs.startedAt })
			.from(runs)
			.where(
				and(eq(runs.projectId, projectId), isNotNull(runs.prUrl), ne(runs.mode, "conversation")),
			)
			.orderBy(asc(runs.startedAt), asc(runs.id)),
	);
	const openerByUrl = new Map<string, string>();
	for (const r of rows) {
		if (r.prUrl !== null && !openerByUrl.has(r.prUrl)) {
			openerByUrl.set(r.prUrl, r.id);
		}
	}
	const candidates = [...openerByUrl].map(([prUrl, runId]) => ({ runId, prUrl }));
	// Most-recent PR first: the opener map preserves oldest-opener insertion
	// order (asc startedAt), so reverse to surface the freshest PRs, then cap.
	candidates.reverse();
	return candidates.slice(0, limit);
}

/**
 * Prior CI-fixer attempt history for a PR. Counts the runs already
 * dispatched by the poller against `prUrl` (trigger `ci-fixer`) and the most
 * recent one's completion timestamp, feeding `decideDispatch`'s `max_retries`
 * + `cooldown` gates. The opener run (trigger `manual` / `cron` /
 * `scheduled`) is excluded by the trigger filter, so a PR with no fixer yet
 * reports `{attempts: 0, lastAttemptAt: null}`. Covered by `runs_pr_url_idx`.
 */
export async function fixAttemptHistoryByPrUrl(
	adapter: DrizzleAdapter,
	prUrl: string,
): Promise<{ attempts: number; lastAttemptAt: string | null }> {
	const db = adapter.drizzle as SqliteDrizzleDb;
	const runs = adapter.schema.runs;
	const rows = await adapter.pickAll<{
		attempts: number | string;
		lastAttemptAt: string | null;
	}>(
		db
			.select({
				attempts: sql<number>`count(*)`,
				lastAttemptAt: sql<string | null>`max(${runs.endedAt})`,
			})
			.from(runs)
			.where(and(eq(runs.prUrl, prUrl), eq(runs.trigger, "ci-fixer"))),
	);
	const row = rows[0];
	return {
		attempts: Number(row?.attempts ?? 0),
		lastAttemptAt: row?.lastAttemptAt ?? null,
	};
}
