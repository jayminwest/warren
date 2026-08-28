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
 *      closes the stream (warren-7bff). Reap events can land after that
 *      close, so stream end is not terminal (warren-22cf),
 *   4. polls `GET /runs/:id` via the SDK's `waitForRun` until the run is
 *      actually terminal, then maps the state to the exit code
 *      (`succeeded` → 0, anything else → 1), so the command slots into
 *      CI pipelines. A bounded post-stream timeout surfaces as a
 *      distinct `run.stream_ended` line rather than a bogus terminal.
 *
 * SIGINT during a live tail aborts the local stream but does **not**
 * cancel the remote run — cancellation is `POST /runs/:id/cancel` (the
 * SDK's `cancelRun`). The first SIGINT prints a hint and detaches
 * (exit 130); a second force-exits.
 */

import { WarrenClientError } from "../../client/errors.ts";
import type { WaitForRunOptions } from "../../client/index.ts";
import type { RunRow } from "../../client/types.ts";
import { isTerminalRunState, type RunTerminalState } from "../../core/wire.ts";
import type { CliContext } from "../output.ts";
import {
	EXIT_RUN_FAILED,
	EXIT_SERVER_UNREACHABLE,
	EXIT_SUCCESS,
	EXIT_USAGE,
	exitCodeForError,
	formatError,
	outputMode,
	writeJsonLine,
} from "../output.ts";
import { renderEventLine, terminalGlyph } from "../plan-run-renderer.ts";
import { probeOrReport } from "./probe.ts";
import { type RemoteTailDeps, tailOutcomeExit, tailWithDetach } from "./remote-tail.ts";

/**
 * Bound on how long `warren run` waits for a true terminal state after the
 * event stream closes (warren-22cf). Reap is normally seconds; five minutes
 * covers a slow finalize without hanging a CI job forever. Overridable in
 * tests via {@link RunDeps.waitForRunOptions}.
 */
export const POST_STREAM_TERMINAL_TIMEOUT_MS = 5 * 60 * 1_000;

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
	/** Per-run USD spend cap (warren-a63d): wins over the agent's own and the project default. */
	readonly maxCostUsd?: number;
	/** Seeds issue to link the run to (warren-ca2f), forwarded to `POST /runs` seedId. */
	readonly seedId?: string;
	/** Base-commit pin (warren-aaf7): 40-hex SHA the workspace is cut at. */
	readonly baseCommit?: string;
	/** Opt-in existing-branch dispatch (warren-326f), forwarded to `POST /runs`. */
	readonly existingBranch?: string;
}

export interface RunDeps extends RemoteTailDeps {
	/**
	 * Options forwarded to `client.waitForRun` after the event stream closes
	 * (warren-22cf). Tests pass a short `timeoutMs` / `intervalMs`; production
	 * leaves this unset and uses {@link POST_STREAM_TERMINAL_TIMEOUT_MS}.
	 */
	readonly waitForRunOptions?: WaitForRunOptions;
}

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
		return { exitCode: EXIT_USAGE };
	}

	if (!(await probeOrReport(context, deps.client, deps.probeTimeoutMs))) {
		return { exitCode: EXIT_SERVER_UNREACHABLE };
	}

	const mode = outputMode(context);
	let runId: string;
	try {
		const spawned = await deps.client.createRun({
			agent: args.agent,
			project: args.project,
			prompt: args.prompt,
			trigger: args.trigger ?? "cli",
			...(args.providerOverride !== undefined ? { providerOverride: args.providerOverride } : {}),
			...(args.modelOverride !== undefined ? { modelOverride: args.modelOverride } : {}),
			...(args.maxCostUsd !== undefined ? { maxCostUsd: args.maxCostUsd } : {}),
			...(args.seedId !== undefined ? { seedId: args.seedId } : {}),
			...(args.baseCommit !== undefined ? { baseCommit: args.baseCommit } : {}),
			...(args.existingBranch !== undefined ? { existingBranch: args.existingBranch } : {}),
		});
		runId = spawned.run.id;
		if (mode === "ndjson") {
			writeJsonLine(context.stdio.stdout, {
				event: "run.spawned",
				runId,
				agent: spawned.run.agentName,
				project: spawned.run.projectId,
				sandboxId: spawned.sandbox.id,
			});
		} else if (mode === "pretty") {
			context.stdio.stdout.write(
				`▶ run ${runId} dispatched — agent ${spawned.run.agentName}, project ${spawned.run.projectId}\n`,
			);
		}
		// json mode stays silent until the single final document.
	} catch (err) {
		context.stdio.stderr.write(`warren: ${formatError(err)}\n`);
		return { exitCode: exitCodeForError(err) };
	}

	return tailUntilTerminal(context, deps, runId);
}

/**
 * Tail `/runs/:id/events` as NDJSON until the server closes the stream or
 * the operator detaches with SIGINT, then poll until a true terminal state
 * (warren-22cf) and map it to an exit code.
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
		onEvent: (event) => {
			const mode = outputMode(context);
			if (mode === "pretty") {
				context.stdio.stdout.write(`${renderEventLine(event)}\n`);
				return;
			}
			if (mode === "json") return; // stream suppressed; one final document
			writeJsonLine(context.stdio.stdout, {
				event: "run.event",
				runId,
				seq: event.seq,
				ts: event.ts,
				kind: event.kind,
				stream: event.stream,
				payload: event.payload,
			});
		},
		onSigint: deps.onSigint,
		exit: deps.exit,
	});

	if (outcome.kind !== "completed") {
		return { exitCode: tailOutcomeExit(context, outcome), runId };
	}

	return resolveTerminal(context, deps, runId);
}

/**
 * Poll until the run is actually terminal, then emit `run.terminal` and map
 * the state to an exit code (warren-22cf). Stream close alone is not enough:
 * reap.* can land after the follow stream ends (warren-7bff). On timeout the
 * CLI emits a distinct `run.stream_ended` line and exits 1 without pretending
 * the run finished.
 */
async function resolveTerminal(
	context: CliContext,
	deps: RunDeps,
	runId: string,
): Promise<RunResult> {
	const waitOpts: WaitForRunOptions = {
		timeoutMs: POST_STREAM_TERMINAL_TIMEOUT_MS,
		...deps.waitForRunOptions,
	};
	try {
		const run = await deps.client.waitForRun(runId, waitOpts);
		return emitTerminal(context, runId, run);
	} catch (err) {
		if (isWaitTimeout(err)) {
			return emitStreamEnded(context, deps, runId, err);
		}
		context.stdio.stderr.write(`warren: failed to read run state: ${formatError(err)}\n`);
		return { exitCode: exitCodeForError(err), runId };
	}
}

function isWaitTimeout(err: unknown): err is WarrenClientError {
	return err instanceof WarrenClientError && err.code === "wait_timeout";
}

function emitTerminal(context: CliContext, runId: string, run: RunRow): RunResult {
	const state = run.state;
	const final = {
		event: "run.terminal" as const,
		runId,
		state,
		failureReason: run.failureReason,
		prUrl: run.prUrl,
	};
	const mode = outputMode(context);
	if (mode === "pretty") {
		const pr = run.prUrl !== null && run.prUrl !== "" ? ` — ${run.prUrl}` : "";
		context.stdio.stdout.write(`${terminalGlyph(state)} run ${runId} ${state}${pr}\n`);
	} else if (mode === "json") {
		context.stdio.stdout.write(`${JSON.stringify(final, null, 2)}\n`);
	} else {
		writeJsonLine(context.stdio.stdout, final);
	}
	// waitForRun only resolves on a terminal state; defend in depth.
	const terminal: RunTerminalState = isTerminalRunState(state) ? state : "failed";
	return {
		exitCode: terminal === "succeeded" ? EXIT_SUCCESS : EXIT_RUN_FAILED,
		runId,
		state: terminal,
	};
}

async function emitStreamEnded(
	context: CliContext,
	deps: RunDeps,
	runId: string,
	err: WarrenClientError,
): Promise<RunResult> {
	let lastState: string | null = null;
	let failureReason: string | null = null;
	try {
		const snap = await deps.client.getRun(runId);
		lastState = snap.state;
		failureReason = snap.failureReason;
	} catch {
		// Best-effort snapshot; the timeout message still stands alone.
	}
	const payload = {
		event: "run.stream_ended" as const,
		runId,
		state: lastState,
		failureReason,
		reason: "await_terminal_timeout",
		message: err.message,
	};
	const mode = outputMode(context);
	if (mode === "pretty") {
		const stateBit = lastState !== null ? ` (last state: ${lastState})` : "";
		context.stdio.stdout.write(
			`⚠ run ${runId} stream ended but run is not terminal yet${stateBit}\n`,
		);
		context.stdio.stderr.write(`warren: ${err.message}\n`);
	} else if (mode === "json") {
		context.stdio.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
		context.stdio.stderr.write(`warren: ${err.message}\n`);
	} else {
		writeJsonLine(context.stdio.stdout, payload);
		context.stdio.stderr.write(`warren: ${err.message}\n`);
	}
	return { exitCode: EXIT_RUN_FAILED, runId };
}

/* -------------------------------------------------------------------------- */
/* Command registration (extracted from main.ts, warren-326f size budget)     */
/* -------------------------------------------------------------------------- */

import type { Command } from "commander";
import { addClientFlags, type RemoteOpts, resolveCommandClient } from "../client.ts";
import { parseMaxCostUsd } from "../flags.ts";

/** Register the `warren run` command on the built program. */
export function registerRunCommand(program: Command, context: CliContext): void {
	addClientFlags(
		program
			.command("run")
			.description(
				"dispatch a one-shot run against the warren server, tail events as NDJSON, and exit",
			)
			.argument("<agent>", "registered agent name")
			.argument("<project>", "project id (prj_xxx)")
			.requiredOption("-p, --prompt <text>", "prompt text the agent receives")
			.option("--trigger <label>", "run trigger label", "cli")
			.option("--provider <name>", "per-run override of agent frontmatter.provider")
			.option("--model <name>", "per-run override of agent frontmatter.model")
			.option(
				"--max-cost-usd <usd>",
				"per-run USD spend cap; wins over the agent's own and the project default",
				parseMaxCostUsd,
			)
			.option("--seed <id>", "link the run to a seeds issue (POST /runs seedId)")
			.option("--base-commit <sha>", "pin the workspace cut to a 40-hex commit SHA")
			.option(
				"--existing-branch <branch>",
				"run on an existing push-remote branch and push back to it; no PR",
			),
	).action(
		async (
			agent: string,
			project: string,
			opts: {
				prompt: string;
				trigger?: string;
				provider?: string;
				model?: string;
				maxCostUsd?: number;
				seed?: string;
				baseCommit?: string;
				existingBranch?: string;
			} & RemoteOpts,
		) => {
			const { client, context: ctx } = resolveCommandClient(context, opts);
			const result = await runRun(
				ctx,
				{ client },
				{
					agent,
					project,
					prompt: opts.prompt,
					...(opts.trigger !== undefined ? { trigger: opts.trigger } : {}),
					...(opts.provider !== undefined ? { providerOverride: opts.provider } : {}),
					...(opts.model !== undefined ? { modelOverride: opts.model } : {}),
					...(opts.maxCostUsd !== undefined ? { maxCostUsd: opts.maxCostUsd } : {}),
					...(opts.seed !== undefined ? { seedId: opts.seed } : {}),
					...(opts.baseCommit !== undefined ? { baseCommit: opts.baseCommit } : {}),
					...(opts.existingBranch !== undefined ? { existingBranch: opts.existingBranch } : {}),
				},
			);
			process.exit(result.exitCode);
		},
	);
}
