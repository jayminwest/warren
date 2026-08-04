/**
 * `warren tail <run-id> [--follow] [--from-seq <n>]` — stream a run's event
 * log (warren-b048, pl-882c step 11).
 *
 * Consumes `GET /runs/:id/events` through the SDK's `streamRunEvents` — the
 * same NDJSON surface the UI and `warren run` already read, not a second
 * protocol. `--follow` (default) keeps the connection open until the server
 * closes the stream at the terminal state; `--no-follow` drains the current
 * backlog and exits. `--from-seq` replays only events after that seq.
 *
 * Output contract (warren-b61e): ndjson (default) and json both emit the raw
 * RunEvent wire document per line — a stream has no single final document —
 * while pretty reuses the shared `renderEventLine` seam (no third event
 * summarizer). SIGINT during `--follow` detaches the LOCAL tail only (the
 * remote run keeps going; exit 130) via the shared tailWithDetach wiring.
 */

import type { CliContext } from "../output.ts";
import { outputMode, writeJsonLine } from "../output.ts";
import { renderEventLine } from "../plan-run-renderer.ts";
import { guardRemoteRun } from "./probe.ts";
import { type RemoteTailDeps, tailOutcomeExit, tailWithDetach } from "./remote-tail.ts";

export interface TailArgs {
	readonly runId: string;
	/** Keep the stream open until the server closes it (default true). */
	readonly follow?: boolean;
	/** Replay only events with `seq > fromSeq`. */
	readonly fromSeq?: number;
}

export interface TailDeps extends RemoteTailDeps {}

export interface TailResult {
	readonly exitCode: number;
	readonly runId?: string;
}

export async function runTail(
	context: CliContext,
	deps: TailDeps,
	args: TailArgs,
): Promise<TailResult> {
	const guard = await guardRemoteRun(context, deps.client, args.runId, deps.probeTimeoutMs);
	if (guard !== null) return guard;

	const follow = args.follow ?? true;
	const outcome = await tailWithDetach({
		context,
		detachHint:
			`warren: detaching from run ${args.runId} (the remote run keeps going; ` +
			`cancel it with warren cancel ${args.runId}). Ctrl-C again to exit.\n`,
		stream: (signal) =>
			deps.client.streamRunEvents(args.runId, {
				follow,
				signal,
				...(args.fromSeq !== undefined ? { sinceSeq: args.fromSeq } : {}),
			}),
		onEvent: (event) => {
			if (outputMode(context) === "pretty") {
				context.stdio.stdout.write(`${renderEventLine(event)}\n`);
				return;
			}
			writeJsonLine(context.stdio.stdout, event);
		},
		...(deps.onSigint !== undefined ? { onSigint: deps.onSigint } : {}),
		...(deps.exit !== undefined ? { exit: deps.exit } : {}),
	});

	if (outcome.kind !== "completed") {
		return { exitCode: tailOutcomeExit(context, outcome), runId: args.runId };
	}
	return { exitCode: 0, runId: args.runId };
}
