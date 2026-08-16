/**
 * `warren show <run-id>` — one-shot run detail (warren-b048, pl-882c step 11).
 *
 * A thin read over the SDK's `getRun` (`GET /runs/:id`), rendered per the
 * warren-b61e output contract: `json` is the raw run document, `ndjson`
 * (default) the same document as one compact line, `pretty` the human
 * summary from `run-renderer.ts`. Like every remote command it probes first
 * so a down warren is a friendly stderr line (exit 3), not a fetch stack.
 */

import type { WarrenClient } from "../../client/index.ts";
import type { RunRow } from "../../client/types.ts";
import type { CliContext } from "../output.ts";
import { commandFailure, writeResult } from "../output.ts";
import { renderRunPretty, runSummary } from "../run-renderer.ts";
import { guardRemoteRun } from "./probe.ts";

export interface ShowArgs {
	readonly runId: string;
	/** Emit the compact RunSummary projection instead of the full document. */
	readonly summary?: boolean;
}

export interface ShowDeps {
	readonly client: WarrenClient;
	readonly probeTimeoutMs?: number;
}

export interface ShowResult {
	readonly exitCode: number;
	readonly runId?: string;
	readonly state?: RunRow["state"];
}

export async function runShow(
	context: CliContext,
	deps: ShowDeps,
	args: ShowArgs,
): Promise<ShowResult> {
	const guard = await guardRemoteRun(context, deps.client, args.runId, deps.probeTimeoutMs);
	if (guard !== null) return guard;
	try {
		const run = await deps.client.getRun(args.runId);
		writeResult(context, args.summary === true ? runSummary(run) : run, renderRunPretty(run));
		return { exitCode: 0, runId: run.id, state: run.state };
	} catch (err) {
		return { ...commandFailure(context, err), runId: args.runId };
	}
}
