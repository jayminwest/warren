/**
 * `warren run <agent> <project> -p "..."` — one-shot, no UI.
 *
 * Post-warren-97a2 (owner decision D3) this command is a REMOTE client of
 * the warren HTTP API: a local user is a remote user pointed at
 * localhost. The serverless local-SQLite path (spawn via `withCliDb` +
 * an in-process stream bridge + CLI-side reap) is killed — the server
 * owns spawn, bridge, reap, and the mulch/seeds round-trip. The CLI:
 *
 *   1. probes the server (down warren → friendly stderr, not a fetch
 *      stack),
 *   2. dispatches via `POST /runs`,
 *   3. tails `GET /runs/:id/events?follow=1` as NDJSON until the server
 *      closes the stream at the terminal state (warren-7bff),
 *   4. reads the terminal state back and maps it to the exit code
 *      (`succeeded` → 0, anything else → 1), so the command slots into
 *      CI pipelines.
 *
 * SIGINT during a live tail aborts the local stream but does **not**
 * cancel the remote run — cancellation is `POST /runs/:id/cancel` (the
 * SDK's `cancelRun`). The first SIGINT prints a hint and detaches
 * (exit 130); a second force-exits.
 */

import { isTerminalRunState, type RunTerminalState } from "../../core/wire.ts";
import type { CliContext } from "../output.ts";
import { formatError, writeJsonLine } from "../output.ts";
import { probeOrReport } from "./probe.ts";
import { type RemoteTailDeps, tailOutcomeExit, tailWithDetach } from "./remote-tail.ts";

export interface RunArgs {
	readonly agent: string;
	readonly project: string;
	readonly prompt: string;
	/** Run trigger label (default `cli`), forwarded to `POST /runs`. */
	readonly trigger?: string;
	/** Per-run override of the agent's `frontmatter.provider`. */
	readonly providerOverride?: string;
	/** Per-run override of the agent's `frontmatter.model`. */
	readonly modelOverride?: string;
}

export interface RunDeps extends RemoteTailDeps {}

export interface RunResult {
	readonly exitCode: number;
	readonly runId?: string;
	readonly state?: RunTerminalState;
}

export async function runRun(
	context: CliContext,
	deps: RunDeps,
	args: RunArgs,
): Promise<RunResult> {
	if (args.agent === "" || args.project === "" || args.prompt === "") {
		context.stdio.stderr.write("warren: agent, project, and --prompt are all required\n");
		return { exitCode: 2 };
	}

	if (!(await probeOrReport(context, deps.client, deps.probeTimeoutMs))) {
		return { exitCode: 1 };
	}

	let runId: string;
	try {
		const spawned = await deps.client.createRun({
			agent: args.agent,
			project: args.project,
			prompt: args.prompt,
			trigger: args.trigger ?? "cli",
			...(args.providerOverride !== undefined ? { providerOverride: args.providerOverride } : {}),
			...(args.modelOverride !== undefined ? { modelOverride: args.modelOverride } : {}),
		});
		runId = spawned.run.id;
		writeJsonLine(context.stdio.stdout, {
			event: "run.spawned",
			runId,
			agent: spawned.run.agentName,
			project: spawned.run.projectId,
			burrowId: spawned.burrow.id,
		});
	} catch (err) {
		context.stdio.stderr.write(`warren: ${formatError(err)}\n`);
		return { exitCode: 1 };
	}

	return tailUntilTerminal(context, deps, runId);
}

/**
 * Tail `/runs/:id/events` as NDJSON until the server closes the stream at
 * the terminal state or the operator detaches with SIGINT, then resolve
 * the terminal state and map it to an exit code.
 */
async function tailUntilTerminal(
	context: CliContext,
	deps: RunDeps,
	runId: string,
): Promise<RunResult> {
	const outcome = await tailWithDetach({
		context,
		detachHint:
			`warren: detaching from run ${runId} (the remote run keeps going; ` +
			`cancel it with POST /runs/${runId}/cancel). Ctrl-C again to exit.\n`,
		stream: (signal) => deps.client.streamRunEvents(runId, { follow: true, signal }),
		onEvent: (event) =>
			writeJsonLine(context.stdio.stdout, {
				event: "run.event",
				runId,
				seq: event.seq,
				ts: event.ts,
				kind: event.kind,
				stream: event.stream,
				payload: event.payload,
			}),
		onSigint: deps.onSigint,
		exit: deps.exit,
	});

	if (outcome.kind !== "completed") {
		return { exitCode: tailOutcomeExit(context, outcome), runId };
	}

	return resolveTerminal(context, deps, runId);
}

/** Fetch the terminal run state and map it to an exit code. */
async function resolveTerminal(
	context: CliContext,
	deps: RunDeps,
	runId: string,
): Promise<RunResult> {
	try {
		const run = await deps.client.getRun(runId);
		const state = run.state;
		writeJsonLine(context.stdio.stdout, {
			event: "run.terminal",
			runId,
			state,
			failureReason: run.failureReason,
			prUrl: run.prUrl,
		});
		// The server closes the follow stream at terminal, so a non-terminal
		// read-back here means the stream died early — count it as failed.
		const terminal = isTerminalRunState(state) ? state : "failed";
		return { exitCode: terminal === "succeeded" ? 0 : 1, runId, state: terminal };
	} catch (err) {
		context.stdio.stderr.write(`warren: failed to read run state: ${formatError(err)}\n`);
		return { exitCode: 1, runId };
	}
}
