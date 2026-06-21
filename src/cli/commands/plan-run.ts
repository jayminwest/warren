/**
 * `warren plan run <plan-id>` / `warren plan cancel <id>` — thin HTTP-client
 * CLI for cloud plan-runs (warren-ec6a, pl-55df step 2).
 *
 * Unlike the DB-backed commands (`warren run`, `warren serve`, …), the `plan`
 * group talks to a remote warren over HTTP via {@link WarrenClient.fromEnv} —
 * it is the first command without `withCliDb`. The flow mirrors `warren run`:
 * probe the server first (turning a down warren into a friendly error rather
 * than a mid-stream transport throw), POST `/plan-runs`, print the
 * `{planRun, children}` dispatch summary, then tail the union event stream as
 * NDJSON until the plan-run reaches a terminal state. The terminal state maps
 * to the exit code (`succeeded` → 0, anything else → 1) so the command slots
 * into CI pipelines.
 *
 * SIGINT during a live tail aborts the local stream but does **not** cancel the
 * remote plan-run — that's what `warren plan cancel <id>` is for. The first
 * SIGINT prints a hint and detaches (exit 130); a second SIGINT force-exits.
 *
 * Output is NDJSON by design (pipeline parity); the human-readable `--output
 * pretty` renderer lands separately in warren-ae0a.
 */

import type { WarrenClient } from "../../client/index.ts";
import type { PlanRunState } from "../../client/types.ts";
import type { CliContext } from "../output.ts";
import { formatError } from "../output.ts";
import { createRenderer, type PlanRunOutput, type PlanRunRenderer } from "../plan-run-renderer.ts";

/** Exit code emitted when the operator detaches a live tail with SIGINT. */
const SIGINT_EXIT_CODE = 130;

export interface PlanRunArgs {
	readonly planId: string;
	readonly project: string;
	readonly agent: string;
	readonly promptTemplate?: string;
	readonly ref?: string;
	readonly provider?: string;
	readonly model?: string;
	readonly plot?: string;
	/** Tail events until terminal (default). `--no-follow` dispatches and exits. */
	readonly follow: boolean;
	/** Output mode for the dispatch summary + event stream. Default `ndjson`. */
	readonly output?: PlanRunOutput;
}

export interface PlanCancelArgs {
	readonly planRunId: string;
	/** Output mode for the cancellation summary. Default `ndjson`. */
	readonly output?: PlanRunOutput;
}

/** Disposer returned by {@link PlanRunDeps.onSigint}. */
export type SigintDisposer = () => void;

export interface PlanRunDeps {
	/** Remote warren client. Production wires `WarrenClient.fromEnv(context.env)`. */
	readonly client: WarrenClient;
	/**
	 * SIGINT seam (tests). Registers `handler` and returns a disposer that
	 * unregisters it. Production wires `process.on("SIGINT", …)`. When omitted
	 * the command falls back to the live `process` registration.
	 */
	readonly onSigint?: (handler: () => void) => SigintDisposer;
	/** Hard-exit seam (tests). Defaults to `process.exit`. */
	readonly exit?: (code: number) => never;
	/** Override the probe timeout (tests). */
	readonly probeTimeoutMs?: number;
}

export interface PlanCancelDeps {
	readonly client: WarrenClient;
	readonly probeTimeoutMs?: number;
}

export interface PlanRunResult {
	readonly exitCode: number;
	readonly planRunId?: string;
	readonly state?: PlanRunState;
}

export interface PlanCancelResult {
	readonly exitCode: number;
	readonly planRunId?: string;
}

/** Default SIGINT registration against the live process (production). */
function defaultOnSigint(handler: () => void): SigintDisposer {
	process.on("SIGINT", handler);
	return () => {
		process.off("SIGINT", handler);
	};
}

/** Probe the remote warren, mapping an unreachable server to a stderr line. */
async function probeOrReport(
	context: CliContext,
	client: WarrenClient,
	probeTimeoutMs?: number,
): Promise<boolean> {
	try {
		await (probeTimeoutMs !== undefined ? client.probe(probeTimeoutMs) : client.probe());
		return true;
	} catch (err) {
		context.stdio.stderr.write(`warren: ${formatError(err)}\n`);
		return false;
	}
}

export async function runPlanRun(
	context: CliContext,
	deps: PlanRunDeps,
	args: PlanRunArgs,
): Promise<PlanRunResult> {
	if (args.planId === "" || args.project === "" || args.agent === "") {
		context.stdio.stderr.write("warren: plan-id, --project, and --agent are all required\n");
		return { exitCode: 2 };
	}

	if (!(await probeOrReport(context, deps.client, deps.probeTimeoutMs))) {
		return { exitCode: 1 };
	}

	const renderer = createRenderer(args.output ?? "ndjson", context.stdio.stdout);

	let planRunId: string;
	try {
		const created = await deps.client.createPlanRun({
			planId: args.planId,
			project: args.project,
			agent: args.agent,
			...(args.promptTemplate !== undefined ? { promptTemplate: args.promptTemplate } : {}),
			...(args.ref !== undefined ? { ref: args.ref } : {}),
			...(args.provider !== undefined ? { providerOverride: args.provider } : {}),
			...(args.model !== undefined ? { modelOverride: args.model } : {}),
			...(args.plot !== undefined ? { plotId: args.plot } : {}),
		});
		planRunId = created.planRun.id;
		renderer.dispatched(created.planRun, created.children);
	} catch (err) {
		context.stdio.stderr.write(`warren: ${formatError(err)}\n`);
		return { exitCode: 1 };
	}

	if (!args.follow) {
		return { exitCode: 0, planRunId };
	}

	return tailUntilTerminal(context, deps, renderer, planRunId);
}

/**
 * Tail `/plan-runs/:id/events` as NDJSON until the plan-run terminates or the
 * operator detaches with SIGINT, then resolve the terminal state and map it to
 * an exit code.
 */
async function tailUntilTerminal(
	context: CliContext,
	deps: PlanRunDeps,
	renderer: PlanRunRenderer,
	planRunId: string,
): Promise<PlanRunResult> {
	const onSigint = deps.onSigint ?? defaultOnSigint;
	const exit = deps.exit ?? (process.exit as (code: number) => never);
	const tailAbort = new AbortController();
	let interrupted = false;

	const dispose = onSigint(() => {
		if (interrupted) {
			// Second SIGINT: stop waiting and hand control back to the shell.
			exit(SIGINT_EXIT_CODE);
			return;
		}
		interrupted = true;
		context.stdio.stderr.write(
			`warren: detaching from plan-run ${planRunId} (the remote run keeps going; ` +
				`'warren plan cancel ${planRunId}' to stop it). Ctrl-C again to exit.\n`,
		);
		tailAbort.abort();
	});

	try {
		for await (const event of deps.client.streamPlanRunEvents(planRunId, {
			follow: true,
			signal: tailAbort.signal,
		})) {
			renderer.event(event);
		}
	} catch (err) {
		if (!interrupted) {
			dispose();
			context.stdio.stderr.write(`warren: ${formatError(err)}\n`);
			return { exitCode: 1, planRunId };
		}
		// Interrupted tails surface an AbortError — swallow it.
	} finally {
		dispose();
	}

	if (interrupted) {
		return { exitCode: SIGINT_EXIT_CODE, planRunId };
	}

	return resolveTerminal(context, deps, renderer, planRunId);
}

/** Fetch the terminal plan-run state and map it to an exit code. */
async function resolveTerminal(
	context: CliContext,
	deps: PlanRunDeps,
	renderer: PlanRunRenderer,
	planRunId: string,
): Promise<PlanRunResult> {
	try {
		const detail = await deps.client.getPlanRun(planRunId);
		const state = detail.planRun.state;
		renderer.terminal(planRunId, state);
		return { exitCode: state === "succeeded" ? 0 : 1, planRunId, state };
	} catch (err) {
		context.stdio.stderr.write(`warren: failed to read plan-run state: ${formatError(err)}\n`);
		return { exitCode: 1, planRunId };
	}
}

export async function runPlanCancel(
	context: CliContext,
	deps: PlanCancelDeps,
	args: PlanCancelArgs,
): Promise<PlanCancelResult> {
	if (args.planRunId === "") {
		context.stdio.stderr.write("warren: plan-run id is required\n");
		return { exitCode: 2 };
	}

	if (!(await probeOrReport(context, deps.client, deps.probeTimeoutMs))) {
		return { exitCode: 1 };
	}

	try {
		const result = await deps.client.cancelPlanRun(args.planRunId);
		const renderer = createRenderer(args.output ?? "ndjson", context.stdio.stdout);
		renderer.cancelled(result);
		return { exitCode: 0, planRunId: args.planRunId };
	} catch (err) {
		context.stdio.stderr.write(`warren: ${formatError(err)}\n`);
		return { exitCode: 1, planRunId: args.planRunId };
	}
}
