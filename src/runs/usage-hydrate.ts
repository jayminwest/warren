/**
 * Read-time cost/token hydration for runs whose bridge died before its
 * next checkpoint (warren-ab18).
 *
 * The bridge (`stream.ts`) accumulates session usage in-memory and
 * checkpoints it onto `runs.cost_usd` / `runs.tokens_*` periodically
 * (pi: on every agent-end envelope; claude-code: on the terminal
 * `result` envelope). If warren stalls or the host reboots before the
 * next checkpoint lands, those columns stay null even though the
 * underlying usage envelopes were already persisted to `events`.
 *
 * `hydrateRunsUsage` patches that gap at read time: for any terminal
 * run whose `costUsd` is still null, it sums the run's usage events
 * via `aggregateUsageFromEvents` and overlays the derived totals onto
 * the row before the handler serializes it. Non-terminal rows are left
 * untouched — the bridge is the source of truth while it's alive.
 *
 * Write-through (warren-b33e): when a `UsagePersister` is supplied,
 * the derived totals are also persisted onto the run row so a terminal
 * run is hydrated at most once — the next read sees `costUsd` set and
 * skips the aggregation entirely. A terminal candidate with zero usage
 * envelopes persists `costUsd = 0` so it also stops being a candidate.
 * `cost_basis` is never touched. `backfillTerminalUsage` closes the
 * write side of the same gap at terminal reconciliation (reap/finalize)
 * so new runs never enter the null state when their envelopes exist.
 */

import type { EventsRepo } from "../db/repos/events.ts";
import type { RunRow, RunState } from "../db/schema.ts";
import { aggregateUsageFromEvents, eventRowToUsageInput } from "./usage-aggregate.ts";

const TERMINAL_RUN_STATES: ReadonlySet<RunState> = new Set(["succeeded", "failed", "cancelled"]);

/**
 * Subset of `EventsRepo` used for hydration. Declared structurally so
 * tests can stub the events fetch without instantiating a full repo.
 */
export interface UsageEventsFetcher {
	listUsageEvents(
		runIds: readonly string[],
	): Promise<
		readonly { runId: string; kind: string; stream: string | null; payloadJson: unknown }[]
	>;
}

/**
 * Narrow write seam for hydration. `RunsRepo` satisfies this
 * structurally via `updateUsage`; tests stub it.
 */
export interface UsagePersister {
	updateUsage(
		runId: string,
		stats: {
			costUsd: number;
			tokensInput: number;
			tokensOutput: number;
			tokensCacheRead: number;
			tokensCacheWrite: number;
		},
	): Promise<void>;
}

const ZERO_STATS = {
	costUsd: 0,
	tokensInput: 0,
	tokensOutput: 0,
	tokensCacheRead: 0,
	tokensCacheWrite: 0,
};

function zeroStatsFor(run: RunRow): typeof ZERO_STATS {
	// Preserve any bridge-stamped token columns; zero only the nulls.
	return {
		costUsd: 0,
		tokensInput: run.tokensInput ?? 0,
		tokensOutput: run.tokensOutput ?? 0,
		tokensCacheRead: run.tokensCacheRead ?? 0,
		tokensCacheWrite: run.tokensCacheWrite ?? 0,
	};
}

function persistUsage(runId: string, stats: typeof ZERO_STATS, persister: UsagePersister): void {
	persister.updateUsage(runId, stats).catch((err: unknown) => {
		console.error(`[usage-hydrate] failed to persist usage for run ${runId}:`, err);
	});
}

/**
 * Backfill at terminal reconciliation (warren-b33e): called from the
 * reap/finalize path right after the run flips to succeeded/failed/
 * cancelled, so a run whose bridge died before its last checkpoint is
 * hydrated once at write time instead of on every read. Zero-envelope
 * runs persist `costUsd = 0` and leave the columns otherwise untouched.
 * Best-effort: failures are logged, never thrown — the transition has
 * already landed and must not be rolled back by an accounting miss.
 */
export async function backfillTerminalUsage(
	run: RunRow,
	events: UsageEventsFetcher | EventsRepo,
	persister: UsagePersister,
): Promise<void> {
	if (!isHydrationCandidate(run)) return;
	try {
		const rows = await events.listUsageEvents([run.id]);
		const stats = aggregateUsageFromEvents(rows.map(eventRowToUsageInput)) ?? zeroStatsFor(run);
		await persister.updateUsage(run.id, stats);
	} catch (err) {
		console.error(`[usage-hydrate] failed to backfill usage for run ${run.id}:`, err);
	}
}

/**
 * For each run in `runs` that is terminal AND has `costUsd === null`,
 * compute usage from its persisted events and overlay the result onto
 * the row. Returns rows in the same order. Non-candidate rows are
 * passed through by reference (no spread).
 *
 * Batches all candidates into a single `listUsageEvents` call so the
 * list-endpoint case is one query, not N. Empty / no-candidate inputs
 * short-circuit without touching the DB.
 */
export async function hydrateRunsUsage<T extends RunRow>(
	runs: readonly T[],
	events: UsageEventsFetcher | EventsRepo,
	persister?: UsagePersister,
): Promise<T[]> {
	const candidates = runs.filter(isHydrationCandidate);
	if (candidates.length === 0) return runs.slice();
	const rows = await events.listUsageEvents(candidates.map((r) => r.id));
	const byRun = new Map<string, (typeof rows)[number][]>();
	for (const row of rows) {
		const bucket = byRun.get(row.runId);
		if (bucket === undefined) byRun.set(row.runId, [row]);
		else bucket.push(row);
	}
	return runs.map((run) => {
		if (!isHydrationCandidate(run)) return run;
		const stats = aggregateUsageFromEvents((byRun.get(run.id) ?? []).map(eventRowToUsageInput));
		if (stats === null) {
			// Zero usage envelopes: persist zeros so this terminal row stops
			// being a candidate on the next read (warren-b33e).
			if (persister) {
				const zeros = zeroStatsFor(run);
				persistUsage(run.id, zeros, persister);
				return { ...run, ...zeros };
			}
			return run;
		}
		if (persister) persistUsage(run.id, stats, persister);
		return {
			...run,
			costUsd: stats.costUsd,
			tokensInput: stats.tokensInput,
			tokensOutput: stats.tokensOutput,
			tokensCacheRead: stats.tokensCacheRead,
			tokensCacheWrite: stats.tokensCacheWrite,
		};
	});
}

/**
 * Single-row convenience wrapper around `hydrateRunsUsage`. Returns the
 * input row unchanged when it's not a hydration candidate.
 */
export async function hydrateRunUsage<T extends RunRow>(
	run: T,
	events: UsageEventsFetcher | EventsRepo,
): Promise<T> {
	const [hydrated] = await hydrateRunsUsage([run], events);
	// Length-1 input ⇒ length-1 output; non-null assertion is safe.
	return hydrated as T;
}

function isHydrationCandidate(run: RunRow): boolean {
	return run.costUsd === null && TERMINAL_RUN_STATES.has(run.state);
}
