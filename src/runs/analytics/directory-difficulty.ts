/**
 * Per-directory difficulty aggregator (warren-8f1b / pl-103e step 10).
 *
 * Pure, dialect-agnostic sibling to `command-mining.ts`. Where command
 * mining ranks the shell commands agents run, this module ranks the
 * directories agents struggle in — the flagship "agents struggle with
 * this section of the codebase" insight (design record §4 row 1). It
 * joins three evidence streams to the file paths the `tool_calls`
 * rollup extracted through the `fileShape` registry (warren-7746):
 *
 *   - run outcomes — a run that touched the directory and ended
 *     `failed` counts against it;
 *   - retry clusters — a file-class call re-touching a path that
 *     already errored earlier in the SAME run (the path-level analogue
 *     of the stuck-command loop);
 *   - steering events — mid-run human interventions in runs that
 *     touched the directory.
 *
 * Aggregation is by normalized directory, ranked top-N by evidence
 * volume (file touches). Every bucket ships its denominators
 * (`runsTouching`, `fileTouches`) and a {@link InsightConfidence}
 * qualifier derived from the denominator size, per the plan's insight
 * discipline (design record §9, measurement validity).
 *
 * Validity rules:
 *
 *   - Minimum-N guard ({@link MIN_DIRECTORY_RUNS}): a directory with
 *     fewer runs touching it than the guard never ranks — a two-run
 *     directory can hit a 100% failure share on noise alone. Guarded
 *     directories are still counted in `totals.directoriesBelowMinN` so
 *     the consumer can see what was withheld.
 *   - Runs predating the rollup are UNKNOWN, not clean: they have no
 *     `tool_calls` rows, so they appear in `totals.runsInWindow` but
 *     never in `totals.runsWithFilePaths`, and never in any directory
 *     denominator.
 *
 * Determinism: the ranked list sorts by evidence volume descending,
 * then directory ascending, so tests are stable regardless of row
 * order.
 */

import { INSIGHT_CONFIDENCES, type InsightConfidence } from "../../core/wire.ts";

/**
 * Minimum runs touching a directory before it may rank. Below this a
 * failure share is anecdote, not signal (design record §9).
 */
export const MIN_DIRECTORY_RUNS = 3;
/** Denominator thresholds for the confidence qualifier. */
const CONFIDENCE_MEDIUM_RUNS = 5;
const CONFIDENCE_HIGH_RUNS = 10;
/** Default cap on the ranked directory list (top-N by evidence volume). */
export const DEFAULT_DIRECTORY_LIMIT = 10;

/**
 * Tools whose extracted path IS a directory (a search scope), not a
 * file inside one. For these the path itself aggregates; for
 * file-class tools (Read/Edit/Write/…) the parent directory does.
 */
const DIRECTORY_SCOPED_TOOLS: ReadonlySet<string> = new Set(["Glob", "Grep", "LS"]);

/**
 * One `tool_calls` rollup row reduced to what the directory join needs.
 * The handler narrows the `file_paths` JSON column to `string[]` before
 * constructing this shape.
 */
export interface DirectoryToolCallRow {
	readonly runId: string;
	/** sandbox_event_seq of the tool_use event — orders calls within a run. */
	readonly seq: number;
	readonly toolName: string | null;
	readonly isError: boolean;
	/** fileShape-extracted paths the call touches; empty for non-file tools. */
	readonly filePaths: readonly string[];
}

/** The per-run outcome facts the difficulty join reads. */
export interface DirectoryRunOutcome {
	readonly runId: string;
	readonly state: string;
}

/** One ranked directory bucket, with denominators and confidence. */
export interface DirectoryStat {
	readonly directory: string;
	/** Denominator: distinct runs with at least one file touch in the directory. */
	readonly runsTouching: number;
	/** Of `runsTouching`, how many ended `failed`. */
	readonly runsFailed: number;
	/** `runsFailed / runsTouching`, or null when the denominator is zero. */
	readonly failureShare: number | null;
	/** Evidence volume: file-class calls touching the directory. */
	readonly fileTouches: number;
	/** Of `fileTouches`, how many errored. */
	readonly errorTouches: number;
	/**
	 * Calls that re-touched a path already errored earlier in the same
	 * run — the path-level "stuck in a loop" signal.
	 */
	readonly retries: number;
	/** Steering messages sent to runs touching the directory. */
	readonly steeringMessages: number;
	/**
	 * Difficulty score: `failureShare + retries / fileTouches`. Both
	 * terms are rate-normalized, so a busy-but-clean directory does not
	 * outrank a small struggling one on volume alone.
	 */
	readonly difficultyScore: number;
	/** Confidence qualifier from the `runsTouching` denominator size. */
	readonly confidence: InsightConfidence;
}

/** Window-level denominators for the difficulty rollup. */
export interface DirectoryDifficultyTotals {
	/** All runs in the analytics window (the outer denominator). */
	readonly runsInWindow: number;
	/**
	 * Runs with at least one fileShape-extracted path — the KNOWN subset.
	 * Runs predating the rollup are unknown and excluded from every
	 * directory denominator (validity rule 2).
	 */
	readonly runsWithFilePaths: number;
	/** File-class calls carrying at least one path, across all runs. */
	readonly fileTouches: number;
	/** Directories that cleared the minimum-N guard and ranked. */
	readonly directoriesRanked: number;
	/** Directories withheld by the minimum-N guard. */
	readonly directoriesBelowMinN: number;
}

export interface DirectoryDifficulty {
	readonly directories: readonly DirectoryStat[];
	readonly totals: DirectoryDifficultyTotals;
}

/**
 * Normalize an extracted path to its aggregation directory. Strips
 * leading `./` segments; a bare filename (no `/`) aggregates under
 * `"."` (the workspace root); directory-scoped tools (Glob/Grep/LS)
 * aggregate the path itself. Returns null for paths that carry no
 * directory signal (empty, or the filesystem root).
 */
export function normalizeDirectory(path: string, toolName: string | null): string | null {
	let p = path;
	while (p.startsWith("./")) p = p.slice(2);
	if (p === "" || p === "/") return null;
	if (DIRECTORY_SCOPED_TOOLS.has(toolName ?? "")) {
		return p.endsWith("/") ? p.slice(0, -1) || null : p;
	}
	const idx = p.lastIndexOf("/");
	if (idx === -1) return ".";
	if (idx === 0) return "/";
	return p.slice(0, idx);
}

function confidenceFor(runsTouching: number): InsightConfidence {
	if (runsTouching >= CONFIDENCE_HIGH_RUNS) return INSIGHT_CONFIDENCES[2];
	if (runsTouching >= CONFIDENCE_MEDIUM_RUNS) return INSIGHT_CONFIDENCES[1];
	return INSIGHT_CONFIDENCES[0];
}

interface DirAccum {
	runs: Set<string>;
	failedRuns: Set<string>;
	fileTouches: number;
	errorTouches: number;
	retries: number;
	steeringMessages: number;
}

function newAccum(): DirAccum {
	return {
		runs: new Set(),
		failedRuns: new Set(),
		fileTouches: 0,
		errorTouches: 0,
		retries: 0,
		steeringMessages: 0,
	};
}

interface ScanResult {
	dirs: Map<string, DirAccum>;
	runsWithFilePaths: Set<string>;
	fileTouches: number;
}

/** Fold one extracted path into its directory accumulator. */
function foldPath(accum: DirAccum, row: DirectoryToolCallRow, alreadyErrored: boolean): void {
	accum.runs.add(row.runId);
	accum.fileTouches++;
	if (alreadyErrored) accum.retries++;
	if (row.isError) accum.errorTouches++;
}

/** Fold one rollup row's extracted paths into their directory accumulators. */
function scanRowPaths(
	row: DirectoryToolCallRow,
	dirs: Map<string, DirAccum>,
	erroredPaths: ReadonlySet<string>,
): number {
	let touches = 0;
	for (const path of row.filePaths) {
		const dir = normalizeDirectory(path, row.toolName);
		if (dir === null) continue;
		let accum = dirs.get(dir);
		if (accum === undefined) {
			accum = newAccum();
			dirs.set(dir, accum);
		}
		foldPath(accum, row, erroredPaths.has(path));
		touches++;
	}
	return touches;
}

/**
 * First pass: walk the rollup rows in per-run seq order, accumulating
 * per-directory touch/error/retry counters. `erroredPathsByRun` is the
 * retry memory — a path that errored earlier in the same run.
 */
function scanRows(
	rows: readonly DirectoryToolCallRow[],
	stateByRunId: ReadonlyMap<string, string>,
): ScanResult {
	const dirs = new Map<string, DirAccum>();
	const runsWithFilePaths = new Set<string>();
	const erroredPathsByRun = new Map<string, Set<string>>();
	const sorted = [...rows].sort((a, b) =>
		a.runId === b.runId ? a.seq - b.seq : a.runId < b.runId ? -1 : 1,
	);
	let fileTouches = 0;
	for (const row of sorted) {
		if (!stateByRunId.has(row.runId)) continue;
		let erroredPaths = erroredPathsByRun.get(row.runId);
		if (erroredPaths === undefined) {
			erroredPaths = new Set();
			erroredPathsByRun.set(row.runId, erroredPaths);
		}
		const touches = scanRowPaths(row, dirs, erroredPaths);
		if (touches > 0) {
			fileTouches += touches;
			runsWithFilePaths.add(row.runId);
			if (row.isError) for (const path of row.filePaths) erroredPaths.add(path);
		}
	}
	return { dirs, runsWithFilePaths, fileTouches };
}

/** Materialize one ranked bucket from its accumulator (post-guard). */
function toStat(directory: string, a: DirAccum): DirectoryStat {
	const failureShare = a.runs.size === 0 ? null : a.failedRuns.size / a.runs.size;
	const retryRate = a.fileTouches === 0 ? 0 : a.retries / a.fileTouches;
	return {
		directory,
		runsTouching: a.runs.size,
		runsFailed: a.failedRuns.size,
		failureShare,
		fileTouches: a.fileTouches,
		errorTouches: a.errorTouches,
		retries: a.retries,
		steeringMessages: a.steeringMessages,
		difficultyScore: (failureShare ?? 0) + retryRate,
		confidence: confidenceFor(a.runs.size),
	};
}

function compareStats(a: DirectoryStat, b: DirectoryStat): number {
	if (b.fileTouches !== a.fileTouches) return b.fileTouches - a.fileTouches;
	return a.directory < b.directory ? -1 : 1;
}

/**
 * Build the per-directory difficulty rollup.
 *
 * @param rows - `tool_calls` rollup rows across the window, in any
 *   order (the retry scan re-sorts per run by seq).
 * @param outcomes - Run outcomes for the window; runs absent from this
 *   list are ignored entirely.
 * @param steeringByRunId - Steering-message count per run id.
 */
export function buildDirectoryDifficulty(
	rows: readonly DirectoryToolCallRow[],
	outcomes: readonly DirectoryRunOutcome[],
	steeringByRunId: ReadonlyMap<string, number>,
	opts: { limit?: number } = {},
): DirectoryDifficulty {
	const stateByRunId = new Map(outcomes.map((o) => [o.runId, o.state]));
	const { dirs, runsWithFilePaths, fileTouches } = scanRows(rows, stateByRunId);

	// Fold outcomes + steering into the per-directory accumulators.
	for (const accum of dirs.values()) {
		for (const runId of accum.runs) {
			if (stateByRunId.get(runId) === "failed") accum.failedRuns.add(runId);
			accum.steeringMessages += steeringByRunId.get(runId) ?? 0;
		}
	}

	const stats: DirectoryStat[] = [];
	let belowMinN = 0;
	for (const [directory, a] of dirs) {
		if (a.runs.size < MIN_DIRECTORY_RUNS) {
			belowMinN++;
			continue;
		}
		stats.push(toStat(directory, a));
	}
	stats.sort(compareStats);
	const limit = opts.limit ?? DEFAULT_DIRECTORY_LIMIT;
	return {
		directories: stats.slice(0, limit),
		totals: {
			runsInWindow: outcomes.length,
			runsWithFilePaths: runsWithFilePaths.size,
			fileTouches,
			directoriesRanked: Math.min(stats.length, limit),
			directoriesBelowMinN: belowMinN,
		},
	};
}
