/**
 * Boot-time backfill for the `tool_calls` rollup (warren-7746 / pl-103e
 * step 9). Runs written before the rollup existed have `tool_use` /
 * `tool_result` rows in `events` but no structured rows; this pass
 * re-extracts them through the same shape registries the live bridge
 * uses (`src/runs/analytics/tool-call-extract.ts`).
 *
 * The plan's risk note constrains the shape of this job: it must NOT
 * block boot and must NOT re-scan the whole events history. So:
 *
 *   - Boot wires it fire-and-forget (`void …catch`) in
 *     `src/server/main/index.ts` — the server accepts traffic while it runs.
 *   - The candidate set is WINDOWED (`sinceTs`, default 30 days) and
 *     CAPPED (`maxRuns`, default 100) per pass. Because a backfilled run
 *     leaves the candidate set (it now has rollup rows), each subsequent
 *     boot picks up the next window's worth — incremental by
 *     construction, no checkpoint table.
 *   - Idempotent: `ToolCallsRepo.recordUse` is INSERT ON CONFLICT DO
 *     NOTHING on (run_id, seq), so a backfill that races a live bridge
 *     or re-runs after a crash lands no duplicate rows.
 */

import type { Repos } from "../db/repos/index.ts";
import {
	extractToolResult,
	extractToolUse,
	runtimeFromRenderedAgent,
} from "./analytics/tool-call-extract.ts";

/** Default lookback window for backfill candidates, in days. */
export const DEFAULT_TOOL_CALLS_BACKFILL_WINDOW_DAYS = 30;

/** Default cap on runs re-extracted per pass. */
export const DEFAULT_TOOL_CALLS_BACKFILL_MAX_RUNS = 100;

export interface ToolCallsBackfillLogger {
	info(obj: Record<string, unknown>, msg: string): void;
	warn(obj: Record<string, unknown>, msg: string): void;
}

export interface ToolCallsBackfillOptions {
	/** Lookback window in days; default {@link DEFAULT_TOOL_CALLS_BACKFILL_WINDOW_DAYS}. */
	readonly windowDays?: number;
	/** Max runs per pass; default {@link DEFAULT_TOOL_CALLS_BACKFILL_MAX_RUNS}. */
	readonly maxRuns?: number;
	readonly logger?: ToolCallsBackfillLogger;
	/** Clock override (tests). */
	readonly now?: () => Date;
}

export interface ToolCallsBackfillResult {
	/** Runs considered (candidates whose run row still exists). */
	readonly runs: number;
	/** tool_use rows written (conflicts skipped count as written no-ops). */
	readonly uses: number;
	/** tool_result joins applied. */
	readonly results: number;
}

/** Fold one historical tool event into the rollup. Mirrors the bridge writer. */
async function recordEvent(
	repos: Repos,
	runId: string,
	runtime: ReturnType<typeof runtimeFromRenderedAgent>,
	row: {
		kind: string;
		sandboxEventSeq: number;
		ts: string;
		origin: string | null;
		payloadJson: unknown;
	},
): Promise<{ uses: number; results: number }> {
	if (row.kind === "tool_use") {
		const extraction = extractToolUse(runtime, row.payloadJson);
		await repos.toolCalls.recordUse({
			runId,
			seq: row.sandboxEventSeq,
			ts: row.ts,
			toolName: extraction.toolName,
			command: extraction.command,
			filePaths: extraction.filePaths,
			toolUseId: extraction.toolUseId,
			origin: row.origin,
		});
		return { uses: 1, results: 0 };
	}
	if (row.kind !== "tool_result") return { uses: 0, results: 0 };
	const extraction = extractToolResult(runtime, row.payloadJson);
	if (extraction === null) return { uses: 0, results: 0 };
	await repos.toolCalls.recordResult({
		runId,
		toolUseId: extraction.toolUseId,
		isError: extraction.isError,
		resultBytes: extraction.resultBytes,
	});
	return { uses: 0, results: 1 };
}

/**
 * Re-extract one run's tool history. Returns null when the run row is
 * gone (its events will cascade away with it soon enough; nothing to
 * backfill against).
 */
async function backfillOneRun(
	repos: Repos,
	runId: string,
): Promise<{ uses: number; results: number } | null> {
	const run = await repos.runs.get(runId);
	if (run === null) return null;
	const runtime = runtimeFromRenderedAgent(run.renderedAgentJson);
	const rows = await repos.events.listToolEventsForRun(runId);
	let uses = 0;
	let results = 0;
	for (const row of rows) {
		const counted = await recordEvent(repos, runId, runtime, row);
		uses += counted.uses;
		results += counted.results;
	}
	return { uses, results };
}

/**
 * Re-extract one pass of rollup rows. Per-candidate failures are logged
 * and skipped — a poisoned run history must not stop the pass, and the
 * next boot retries it.
 */
export async function backfillToolCallRollup(
	repos: Repos,
	opts: ToolCallsBackfillOptions = {},
): Promise<ToolCallsBackfillResult> {
	const windowDays = opts.windowDays ?? DEFAULT_TOOL_CALLS_BACKFILL_WINDOW_DAYS;
	const maxRuns = opts.maxRuns ?? DEFAULT_TOOL_CALLS_BACKFILL_MAX_RUNS;
	const now = (opts.now ?? (() => new Date()))();
	const sinceTs = new Date(now.getTime() - windowDays * 24 * 60 * 60 * 1000).toISOString();

	const candidates = await repos.toolCalls.listRunsMissingRollup({ sinceTs, limit: maxRuns });
	let runs = 0;
	let uses = 0;
	let results = 0;
	for (const runId of candidates) {
		try {
			const counted = await backfillOneRun(repos, runId);
			if (counted === null) continue;
			runs += 1;
			uses += counted.uses;
			results += counted.results;
		} catch (err) {
			opts.logger?.warn(
				{ runId, err: err instanceof Error ? err.message : String(err) },
				"tool-calls backfill: skipping run after error",
			);
		}
	}
	if (candidates.length > 0) {
		opts.logger?.info(
			{ candidates: candidates.length, runs, uses, results, sinceTs },
			"tool-calls rollup backfill pass complete",
		);
	}
	return { runs, uses, results };
}

/** Default page size for the repair walk over runs with rollup rows. */
export const DEFAULT_TOOL_CALLS_REPAIR_PAGE_SIZE = 100;

export interface ToolCallsRepairOptions {
	/** Runs re-extracted per keyset page; default {@link DEFAULT_TOOL_CALLS_REPAIR_PAGE_SIZE}. */
	readonly pageSize?: number;
	readonly logger?: ToolCallsBackfillLogger;
}

export interface ToolCallsRepairResult {
	/** Runs whose rollup rows were dropped and re-extracted. */
	readonly runs: number;
	/** Runs left untouched (run row gone, events pruned, or extraction error). */
	readonly skipped: number;
	/** tool_use rows re-written. */
	readonly uses: number;
	/** tool_result joins re-applied. */
	readonly results: number;
}

/**
 * Re-extract EXISTING rollup rows through the (fixed) shape registries
 * (warren-677c). The boot backfill only targets runs with NO rollup
 * rows, so rows a since-fixed shape mis-read (pi's `arguments` wrapper
 * left every command NULL and every file_paths empty) never re-enter
 * its candidate set. This pass walks every run that has rollup rows,
 * drops them, and replays the run's retained tool events through the
 * same extraction seam the bridge and backfill use.
 *
 * A run whose tool events are no longer retained is SKIPPED, never
 * deleted — the rollup is only derived state while its source survives.
 * Re-extracting an already-correct run rewrites identical rows, so
 * over-selection is harmless; the pass is idempotent end to end.
 */
export async function repairToolCallRollup(
	repos: Repos,
	opts: ToolCallsRepairOptions = {},
): Promise<ToolCallsRepairResult> {
	const pageSize = opts.pageSize ?? DEFAULT_TOOL_CALLS_REPAIR_PAGE_SIZE;
	let afterRunId: string | undefined;
	let runs = 0;
	let skipped = 0;
	let uses = 0;
	let results = 0;
	for (;;) {
		const page = await repos.toolCalls.listRunsWithRollup({
			limit: pageSize,
			...(afterRunId === undefined ? {} : { afterRunId }),
		});
		if (page.length === 0) break;
		for (const runId of page) {
			const counted = await repairOneRun(repos, runId, opts.logger).catch((err: unknown) => {
				opts.logger?.warn(
					{ runId, err: err instanceof Error ? err.message : String(err) },
					"tool-calls repair: skipping run after error",
				);
				return null;
			});
			if (counted === null) {
				skipped += 1;
				continue;
			}
			runs += 1;
			uses += counted.uses;
			results += counted.results;
		}
		afterRunId = page[page.length - 1];
	}
	opts.logger?.info({ runs, skipped, uses, results }, "tool-calls rollup repair pass complete");
	return { runs, skipped, uses, results };
}

/**
 * Drop-and-replay one run's rollup rows from its retained tool events.
 * Returns null (repairing nothing) when the run row is gone or its
 * events were pruned — the rollup is only derived state while its
 * source survives, so a sourceless run keeps its stale rows.
 */
async function repairOneRun(
	repos: Repos,
	runId: string,
	logger: ToolCallsBackfillLogger | undefined,
): Promise<{ uses: number; results: number } | null> {
	const run = await repos.runs.get(runId);
	if (run === null) return null;
	const rows = await repos.events.listToolEventsForRun(runId);
	if (rows.length === 0) {
		logger?.warn({ runId }, "tool-calls repair: events pruned, keeping stale rollup");
		return null;
	}
	const runtime = runtimeFromRenderedAgent(run.renderedAgentJson);
	await repos.toolCalls.deleteForRun(runId);
	let uses = 0;
	let results = 0;
	for (const row of rows) {
		const counted = await recordEvent(repos, runId, runtime, row);
		uses += counted.uses;
		results += counted.results;
	}
	return { uses, results };
}
