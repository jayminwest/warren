/**
 * Registration for the agent-facing run read/control commands (warren-b048,
 * pl-882c step 11): `show`, `wait`, `tail`, `cancel`. Extracted from
 * `main.ts` to keep that file under the 500-line size budget; each action is
 * the same thin argv→command-function dispatch as the rest of the CLI.
 */

import type { Command } from "commander";
import { addClientFlags, clientFlags, type RemoteOpts, resolveWarrenClient } from "./client.ts";
import { runCancel } from "./commands/cancel.ts";
import { runShow } from "./commands/show.ts";
import { runTail } from "./commands/tail.ts";
import { runWait } from "./commands/wait.ts";
import { type CliContext, EXIT_USAGE } from "./output.ts";

/** Wire `warren show|wait|tail|cancel` onto the program. */
export function registerRunCommands(program: Command, context: CliContext): void {
	addClientFlags(
		program
			.command("show")
			.description("render a run's detail (GET /runs/:id; json mode is the raw run document)")
			.argument("<run-id>", "run id"),
	).action(async (runId: string, opts: RemoteOpts) => {
		const client = resolveWarrenClient(context.env, clientFlags(opts));
		const result = await runShow(context, { client }, { runId });
		process.exit(result.exitCode);
	});

	addClientFlags(
		program
			.command("wait")
			.description("poll a run to its terminal state (SDK waitForRun; exit 0 on succeeded)")
			.argument("<run-id>", "run id")
			.option("--timeout <seconds>", "overall wait budget in seconds (default 1800)"),
	).action(async (runId: string, opts: { timeout?: string } & RemoteOpts) => {
		const timeoutSeconds = opts.timeout !== undefined ? Number(opts.timeout) : undefined;
		if (timeoutSeconds !== undefined && !(Number.isFinite(timeoutSeconds) && timeoutSeconds > 0)) {
			context.stdio.stderr.write("warren: --timeout must be a positive number of seconds\n");
			process.exit(EXIT_USAGE);
		}
		const client = resolveWarrenClient(context.env, clientFlags(opts));
		const result = await runWait(
			context,
			{ client },
			{
				runId,
				...(timeoutSeconds !== undefined ? { timeoutMs: timeoutSeconds * 1_000 } : {}),
			},
		);
		process.exit(result.exitCode);
	});

	addClientFlags(
		program
			.command("tail")
			.description("stream a run's events (GET /runs/:id/events; SIGINT detaches, exit 130)")
			.argument("<run-id>", "run id")
			.option("--no-follow", "drain the current backlog and exit instead of following")
			.option("--from-seq <n>", "replay only events after this seq", (v) => Number(v)),
	).action(async (runId: string, opts: { follow: boolean; fromSeq?: number } & RemoteOpts) => {
		const client = resolveWarrenClient(context.env, clientFlags(opts));
		const result = await runTail(
			context,
			{ client },
			{
				runId,
				follow: opts.follow,
				...(opts.fromSeq !== undefined ? { fromSeq: opts.fromSeq } : {}),
			},
		);
		process.exit(result.exitCode);
	});

	addClientFlags(
		program
			.command("cancel")
			.description("cancel a non-terminal run (POST /runs/:id/cancel; idempotent)")
			.argument("<run-id>", "run id")
			.option("--reason <text>", "operator note recorded on the cancel"),
	).action(async (runId: string, opts: { reason?: string } & RemoteOpts) => {
		const client = resolveWarrenClient(context.env, clientFlags(opts));
		const result = await runCancel(
			context,
			{ client },
			{ runId, ...(opts.reason !== undefined ? { reason: opts.reason } : {}) },
		);
		process.exit(result.exitCode);
	});
}
