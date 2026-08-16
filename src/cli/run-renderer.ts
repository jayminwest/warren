/**
 * Pretty rendering for run rows, shared by the `warren show` / `warren wait`
 * commands (warren-b048, pl-882c step 11) and the `plan status` child table
 * (warren-00df dedup). Machine modes (ndjson/json) emit
 * the raw wire document; this module owns only the human view, so the D6
 * duration dialect (`4.2s` / `3.1m` / `1.4h`) and the cost formatting live
 * in exactly one place.
 */

import type { RunRow } from "../client/types.ts";
import { formatDurationMs } from "./output.ts";
import { terminalGlyph } from "./plan-run-renderer.ts";

/**
 * Compact run projection for `warren show|wait --summary` (warren-8447) —
 * the fields a shepherding loop greps for, without the multi-KB
 * renderedAgentJson / prompt noise of the full document.
 */
export interface RunSummary {
	readonly id: string;
	readonly state: RunRow["state"];
	readonly failureReason: RunRow["failureReason"];
	readonly prUrl: RunRow["prUrl"];
	readonly costUsd: RunRow["costUsd"];
	readonly endedAt: RunRow["endedAt"];
}

/** Project a run row to its `--summary` shape. */
export function runSummary(run: RunRow): RunSummary {
	return {
		id: run.id,
		state: run.state,
		failureReason: run.failureReason,
		prUrl: run.prUrl,
		costUsd: run.costUsd,
		endedAt: run.endedAt,
	};
}

/** A run's wall-clock duration (D6), or an em-dash when unknown. */
export function runDuration(run: RunRow | null): string {
	if (run === null || run.startedAt === null || run.endedAt === null) return "—";
	const started = Date.parse(run.startedAt);
	const ended = Date.parse(run.endedAt);
	if (Number.isNaN(started) || Number.isNaN(ended) || ended < started) return "—";
	return formatDurationMs(ended - started);
}

/** A cost in USD, or an em-dash when unknown. */
export function runCost(costUsd: number | null): string {
	return costUsd === null ? "—" : `$${costUsd.toFixed(4)}`;
}

/** Render a run row as a multi-line human summary (`warren show --output pretty`). */
export function renderRunPretty(run: RunRow): string {
	const lines = [
		`${terminalGlyph(run.state)} run ${run.id} [${run.state}] — agent ${run.agentName}, ` +
			`project ${run.projectId ?? "—"}, trigger ${run.trigger}`,
		`  duration: ${runDuration(run)}  cost: ${runCost(run.costUsd)}`,
	];
	if (run.failureReason !== null) lines.push(`  failure: ${run.failureReason}`);
	if (run.prUrl !== null && run.prUrl !== "") lines.push(`  pr: ${run.prUrl}`);
	if (run.seedId !== null) lines.push(`  seed: ${run.seedId}`);
	return lines.join("\n");
}
