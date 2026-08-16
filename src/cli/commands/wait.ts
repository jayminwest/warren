/**
 * `warren wait <run-id> [--timeout <seconds>]` — block until a run reaches a
 * terminal state (warren-b048, pl-882c step 11).
 *
 * The poll loop is the SDK's `waitForRun` — never a hand-rolled loop (the
 * plan exists partly to delete those). Exit codes follow the warren-b61e
 * table: `succeeded` → 0, any other terminal state → 1 (run-failed), a
 * wait timeout surfaces as the SDK's 408 `wait_timeout` error → 1, an
 * unreachable server → 3. Machine modes emit the terminal run document
 * (ndjson one line / json indented); pretty renders the glyph summary.
 */

import type { WarrenClient } from "../../client/index.ts";
import type { RunRow } from "../../client/types.ts";
import type { CliContext } from "../output.ts";
import { commandFailure, EXIT_RUN_FAILED, EXIT_SUCCESS, writeResult } from "../output.ts";
import { renderRunPretty, runSummary } from "../run-renderer.ts";
import { guardRemoteRun } from "./probe.ts";

export interface WaitArgs {
	readonly runId: string;
	/** Overall budget in ms; forwarded to the SDK's `waitForRun` when set. */
	readonly timeoutMs?: number;
	/** Emit the compact RunSummary projection instead of the full document. */
	readonly summary?: boolean;
}

export interface WaitDeps {
	readonly client: WarrenClient;
	readonly probeTimeoutMs?: number;
}

export interface WaitResult {
	readonly exitCode: number;
	readonly runId?: string;
	readonly state?: RunRow["state"];
}

export async function runWait(
	context: CliContext,
	deps: WaitDeps,
	args: WaitArgs,
): Promise<WaitResult> {
	const guard = await guardRemoteRun(context, deps.client, args.runId, deps.probeTimeoutMs);
	if (guard !== null) return guard;
	try {
		const run = await deps.client.waitForRun(
			args.runId,
			args.timeoutMs !== undefined ? { timeoutMs: args.timeoutMs } : {},
		);
		writeResult(context, args.summary === true ? runSummary(run) : run, renderRunPretty(run));
		return {
			exitCode: run.state === "succeeded" ? EXIT_SUCCESS : EXIT_RUN_FAILED,
			runId: run.id,
			state: run.state,
		};
	} catch (err) {
		return { ...commandFailure(context, err), runId: args.runId };
	}
}
