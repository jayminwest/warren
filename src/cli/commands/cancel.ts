/**
 * `warren cancel <run-id> [--reason <text>]` — cancel a non-terminal run
 * (warren-b048, pl-882c step 11).
 *
 * A thin control command over the SDK's `cancelRun` (`POST /runs/:id/cancel`,
 * warren-968c). The cancel is idempotent server-side: an already-terminal
 * run returns `alreadyTerminal: true` and still exits 0 — the operator's
 * intent ("this run should not be running") is satisfied either way. Output
 * follows the warren-b61e contract: ndjson/json emit the raw cancel
 * response, pretty a one-line glyph summary.
 */

import type { WarrenClient } from "../../client/index.ts";
import type { CancelRunResponse } from "../../client/types.ts";
import type { CliContext } from "../output.ts";
import { commandFailure, writeResult } from "../output.ts";
import { terminalGlyph } from "../plan-run-renderer.ts";
import { guardRemoteRun } from "./probe.ts";

export interface CancelArgs {
	readonly runId: string;
	/** Optional operator note recorded on the cancel. */
	readonly reason?: string;
}

export interface CancelDeps {
	readonly client: WarrenClient;
	readonly probeTimeoutMs?: number;
}

export interface CancelResult {
	readonly exitCode: number;
	readonly runId?: string;
	readonly alreadyTerminal?: boolean;
}

export async function runCancel(
	context: CliContext,
	deps: CancelDeps,
	args: CancelArgs,
): Promise<CancelResult> {
	const guard = await guardRemoteRun(context, deps.client, args.runId, deps.probeTimeoutMs);
	if (guard !== null) return guard;
	try {
		const response = await deps.client.cancelRun(
			args.runId,
			args.reason !== undefined ? { reason: args.reason } : {},
		);
		writeResult(context, response, renderCancelPretty(args.runId, response));
		return { exitCode: 0, runId: args.runId, alreadyTerminal: response.alreadyTerminal };
	} catch (err) {
		return { ...commandFailure(context, err), runId: args.runId };
	}
}

/** One-line human summary of a cancel response. */
function renderCancelPretty(runId: string, response: CancelRunResponse): string {
	if (response.alreadyTerminal) {
		return `${terminalGlyph(response.state)} run ${runId} already ${response.state} — nothing to cancel`;
	}
	return `${terminalGlyph(response.state)} run ${runId} cancelled`;
}
