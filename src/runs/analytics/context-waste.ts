/**
 * Context-waste proxy rollup (warren-6d41 / pl-103e step 11).
 *
 * Pure, dialect-agnostic companion to `run-metrics.ts` and
 * `command-mining.ts`, answering design-record §4 row 3's open question
 * (§10 q4, v0 answer): how much of a run's context did tool output
 * dominate? The cheap proxy correlates the `tool_calls` rollup's
 * `result_bytes` column against the runs table's context-token totals
 * (`tokensInput + tokensCacheRead`, via {@link contextTokensOf}).
 *
 * THE LIMITATION, named here because every payload this module emits
 * names it too: this is a BYTE-SIZE PROXY, not per-turn usage deltas.
 * Tokens are run-level totals, nullable, and only some harnesses report
 * them; bytes and tokens are different units compared as a rough
 * share. No per-turn attribution, no context-window accounting, no
 * compaction events. Treat the share as a ranking signal, never a
 * precise fraction of the window.
 *
 * Denominator discipline (the plan's invariant, as in
 * `outcome-analytics.ts`): a run predating the rollup has NO
 * `tool_calls` rows and is UNKNOWN — excluded from every denominator,
 * never counted as zero bytes. A run with rollup rows but null context
 * tokens is likewise unknown on the token side and drops out of the
 * share denominators. Only runs with BOTH rollup rows and known context
 * tokens (`runsMeasured`) ground a share, and every number ships with
 * its denominators and an {@link InsightConfidence} qualifier derived
 * from that measured cohort.
 */

import type { InsightConfidence } from "../../core/wire.ts";
import { generalizeCommand } from "./command-generalize.ts";
import type { ToolCallMiningRow } from "./command-mining.ts";
import { confidenceForSample } from "./outcome-analytics.ts";
import { contextTokensOf, NONE_KEY, type RunMetricsRow } from "./run-metrics.ts";

/**
 * Byte-share stats for one subject — a tool name (byTool) or a
 * generalized command signature (byCommand). Every field is a count or
 * total over the subject's own rollup rows; the share divides those
 * bytes by the context tokens of the MEASURED runs that invoked the
 * subject (rollup rows present AND context tokens known).
 */
export interface ContextWasteShare {
	/** tool name, or generalized command signature (e.g. `"bun test"`). */
	readonly key: string;
	/** rollup rows attributed to the subject. */
	readonly invocations: number;
	/** invocations whose tool_result byte size is known (joined + non-null). */
	readonly resultBytesKnown: number;
	/** summed `result_bytes` over the known invocations. */
	readonly resultBytesTotal: number;
	/** distinct runs that invoked the subject. */
	readonly runs: number;
	/** distinct invoking runs with known context tokens — the share's cohort. */
	readonly runsMeasured: number;
	/** context tokens summed over the subject's measured runs. */
	readonly contextTokensTotal: number;
	/**
	 * `resultBytesTotal / contextTokensTotal`, or null when the subject
	 * has no measured runs with tokens. A byte-vs-token PROXY share —
	 * see the module header's limitation.
	 */
	readonly share: number | null;
}

/**
 * The structured `contextWaste` section on `GET /analytics/behavior`
 * (warren-6d41). The overall share plus per-tool and per-command
 * breakdowns, all over explicit denominators.
 */
export interface ContextWasteProxy {
	/** runs in the analytics window. */
	readonly runsInWindow: number;
	/** runs with at least one rollup row — the rollup-era cohort. */
	readonly runsWithRollup: number;
	/**
	 * runs with rollup rows AND known context tokens — THE share
	 * denominator. Runs predating the rollup are unknown, never zero.
	 */
	readonly runsMeasured: number;
	/** context tokens summed over the measured cohort. */
	readonly contextTokensTotal: number;
	/** known `result_bytes` summed over the measured cohort's rows. */
	readonly resultBytesTotal: number;
	/** overall `resultBytesTotal / contextTokensTotal`, null when unmeasurable. */
	readonly share: number | null;
	/** per-tool breakdown, sorted by resultBytesTotal desc (key asc ties). */
	readonly byTool: readonly ContextWasteShare[];
	/**
	 * per-generalized-command breakdown (Bash-class rows only — a row
	 * whose command fails to generalize contributes none), same sort.
	 */
	readonly byCommand: readonly ContextWasteShare[];
	/** confidence qualifier derived from `runsMeasured`. */
	readonly confidence: InsightConfidence;
}

/** Accumulator for one subject key while scanning rollup rows. */
interface ShareAcc {
	invocations: number;
	resultBytesKnown: number;
	resultBytesTotal: number;
	runIds: Set<string>;
}

function accFor(acc: Map<string, ShareAcc>, key: string): ShareAcc {
	let entry = acc.get(key);
	if (entry === undefined) {
		entry = { invocations: 0, resultBytesKnown: 0, resultBytesTotal: 0, runIds: new Set() };
		acc.set(key, entry);
	}
	return entry;
}

/**
 * Finish one subject accumulator into a {@link ContextWasteShare}. The
 * share divides the subject's known result bytes by the context tokens
 * of its MEASURED runs — runs it was invoked in that carry known
 * context tokens. A subject invoked only in token-unknown runs has no
 * share (null), never a zero denominator.
 */
function finishShare(
	key: string,
	acc: ShareAcc,
	contextByRun: ReadonlyMap<string, number | null>,
): ContextWasteShare {
	let runsMeasured = 0;
	let contextTokensTotal = 0;
	for (const runId of acc.runIds) {
		const ctx = contextByRun.get(runId);
		if (ctx === null || ctx === undefined) continue;
		runsMeasured += 1;
		contextTokensTotal += ctx;
	}
	return {
		key,
		invocations: acc.invocations,
		resultBytesKnown: acc.resultBytesKnown,
		resultBytesTotal: acc.resultBytesTotal,
		runs: acc.runIds.size,
		runsMeasured,
		contextTokensTotal,
		share:
			runsMeasured > 0 && contextTokensTotal > 0 ? acc.resultBytesTotal / contextTokensTotal : null,
	};
}

/** Fold one rollup row into the per-tool and per-command accumulators. */
function accumulateRow(
	row: ToolCallMiningRow,
	byTool: Map<string, ShareAcc>,
	byCommand: Map<string, ShareAcc>,
): void {
	const tool = accFor(byTool, row.toolName ?? NONE_KEY);
	tool.invocations += 1;
	tool.runIds.add(row.runId);
	if (row.resultBytes !== null) {
		tool.resultBytesKnown += 1;
		tool.resultBytesTotal += row.resultBytes;
	}
	// A row whose command fails to generalize contributes no command entry.
	const generalized = row.command === null ? null : generalizeCommand(row.command);
	if (generalized === null) return;
	const command = accFor(byCommand, generalized);
	command.invocations += 1;
	command.runIds.add(row.runId);
	if (row.resultBytes !== null) {
		command.resultBytesKnown += 1;
		command.resultBytesTotal += row.resultBytes;
	}
}

function compareShares(a: ContextWasteShare, b: ContextWasteShare): number {
	if (a.resultBytesTotal !== b.resultBytesTotal) return b.resultBytesTotal - a.resultBytesTotal;
	return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
}

/**
 * Correlate the `tool_calls` rollup against run context tokens. O(rows
 * + runs). `rollupRows` are the same {@link ToolCallMiningRow}s the
 * behavior handler already reads for command mining; `metricsRows` are
 * the window's hydrated run rows (their `tokensInput`/`tokensCacheRead`
 * columns feed {@link contextTokensOf}).
 *
 * A run id present in `metricsRows` but absent from `rollupRows` counts
 * toward `runsInWindow` only — it is the pre-rollup (or no-tool-use)
 * unknown, excluded from `runsWithRollup` and `runsMeasured`, never
 * counted as zero bytes.
 */
export function buildContextWaste(
	rollupRows: readonly ToolCallMiningRow[],
	metricsRows: readonly RunMetricsRow[],
): ContextWasteProxy {
	const contextByRun = new Map<string, number | null>(
		metricsRows.map((r) => [r.runId, contextTokensOf(r)]),
	);
	const rollupRunIds = new Set<string>();
	const byTool = new Map<string, ShareAcc>();
	const byCommand = new Map<string, ShareAcc>();
	for (const row of rollupRows) {
		rollupRunIds.add(row.runId);
		accumulateRow(row, byTool, byCommand);
	}
	let runsMeasured = 0;
	let contextTokensTotal = 0;
	for (const runId of rollupRunIds) {
		const ctx = contextByRun.get(runId);
		if (ctx === null || ctx === undefined) continue;
		runsMeasured += 1;
		contextTokensTotal += ctx;
	}
	let resultBytesTotal = 0;
	for (const acc of byTool.values()) resultBytesTotal += acc.resultBytesTotal;
	return {
		runsInWindow: metricsRows.length,
		runsWithRollup: rollupRunIds.size,
		runsMeasured,
		contextTokensTotal,
		resultBytesTotal,
		share:
			runsMeasured > 0 && contextTokensTotal > 0 ? resultBytesTotal / contextTokensTotal : null,
		byTool: [...byTool.entries()]
			.map(([k, a]) => finishShare(k, a, contextByRun))
			.sort(compareShares),
		byCommand: [...byCommand.entries()]
			.map(([k, a]) => finishShare(k, a, contextByRun))
			.sort(compareShares),
		confidence: confidenceForSample(runsMeasured),
	};
}
