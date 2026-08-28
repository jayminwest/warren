/**
 * The in-pod agent entrypoint (pl-829f step 25 / warren-186c, design
 * k8s-migration.md §1.4/§4.2/§5.1). Runs INSIDE the run pod's agent container —
 * after the `workspace-init` init container has materialized `/workspace` and
 * before the finalize step — and is the K8s counterpart to what `burrow serve`
 * does host-side in the LocalProvider path.
 *
 * With pod-per-run there is no `burrow serve` driving the agent, so this thin
 * Bun entrypoint REUSES warren's agent-runtime adapters (`../adapters/`,
 * warren-7933) rather than inventing a parallel harness layer: it resolves the
 * selected runtime's adapter, calls its `buildSpawnCommand` (argv + stdin) and
 * `parseEvents` (stdout line → structured event), and drives them with a
 * minimal spawn loop. The only thing it replaces is the sandbox: the pod IS
 * the sandbox (design §2.2), so the agent argv is spawned directly instead of
 * through bwrap/`runSandboxed`.
 *
 * Lifecycle (the contract the agent image wires around, design §5.1):
 *
 *   1. DRAIN the steering inbox once over `GET /runs/:id/inbox`. A batch runtime
 *      (claude-code) closes stdin at spawn, so pending steering rides as the
 *      turn's `pendingMessages`, folded into the prompt by the adapter's own
 *      encoder. A stdin-held runtime (pi — one that declares
 *      `shouldCloseStdinOnEvent`) instead KEEPS stdin open past the prompt and,
 *      if it also declares `encodeSteeringMessage`, receives later inbox messages
 *      mid-run via a poll loop that writes them to the live stdin (warren-7a43,
 *      mirroring burrow's dispatcher).
 *   2. `prepareWorkspace` (the runtime's optional hook), then spawn the agent.
 *      For a stdin-held runtime the entrypoint holds stdin open after writing the
 *      prompt and closes it only when the runtime's terminal event (pi's
 *      `agent_end`) lands — pi exits the instant stdin closes mid-inference, so
 *      the old unconditional close-at-spawn made it exit with no work done
 *      (warren-7a43 / burrow-5db3). An idle watchdog drops stdin + kills if the
 *      close-trigger never arrives so a hung run can't pin the pod. All the
 *      stdin-hold machinery lives in `./agent-stdin-hold.ts`.
 *   3. Stream each stdout line through `runtime.parseEvents` and re-emit the
 *      structured events as NDJSON on THIS process's stdout — which becomes the
 *      pod log `K8sProvider.streamEvents` follows and `./log-parse.ts` parses
 *      (the envelope shape here round-trips through `toNormalizedEvent`). The
 *      agent's own terminal envelope (claude `state_change`/`result`) rides this
 *      stream, which is how warren detects logical completion and drives reap.
 *      An agent that exits WITHOUT one (a watchdog-killed pi, a crash) gets a
 *      synthesized `agent_end` emitted post-exit so the run still terminalizes
 *      instead of hanging `running` forever (warren-9a4a).
 *   4. On agent exit, run the finalize entrypoint in-process (`./finalize-
 *      entrypoint.ts`): it polls warren's parked reap intent, collects the
 *      workspace-dependent artifacts, and POSTs the `FinalizeResult`.
 *   5. Exit with the agent's own exit code so the pod's terminal PHASE
 *      (`restartPolicy: Never`: 0 → Succeeded, ≠0 → Failed) reflects the run
 *      outcome — the pod-watcher/status-map's backstop signal (design §1.3).
 *      warren-4d6a: one exception — when the agent exited 0 but the finalize
 *      step FAILED to deliver a result (and a callback credential was present),
 *      exit `EXIT_FINALIZE_NOT_DELIVERED` instead, so a pod whose committed
 *      work was never posted reads Failed (status-map: terminalReason 'error')
 *      rather than a lying Succeeded.
 *
 * The workspace-touching + network seams (`registry`, `spawn`, `http`, `out`)
 * are injectable so the whole orchestration is unit-testable without a cluster,
 * a real agent binary, or a real network.
 */

import { extractAgentEventEnvelope } from "../../core/event-envelope.ts";
import {
	type AdapterRuntimeEvent,
	type AgentRuntimeAdapter,
	allAdapters,
} from "../adapters/index.ts";
import {
	type AgentEntrypointEnv,
	type AgentEnvSource,
	parseAgentEntrypointEnv,
} from "./agent-entrypoint-env.ts";
import {
	type AgentInboxHttp,
	type AgentSpawn,
	type AgentSpawnCommand,
	buildSpawnContext,
	defaultHttp,
	defaultSpawn,
	drainInbox,
	emitSystem,
	formatEventLine,
	readLines,
} from "./agent-io.ts";
import { createStdinHoldController } from "./agent-stdin-hold.ts";
import {
	applyAgentUidDrop,
	uidDropPreflightErrorMessage,
	withCrossUidKill,
} from "./agent-uid-drop.ts";
import { type FinalizeEntrypointDeps, runFinalizeEntrypoint } from "./finalize-entrypoint.ts";

/* -------------------------------------------------------------------------- */
/* Env — lives in `./agent-entrypoint-env.ts` (file-size ratchet, warren-cb93)  */
/* -------------------------------------------------------------------------- */

export type { AgentEntrypointEnv, AgentEnvSource } from "./agent-entrypoint-env.ts";
export {
	DEFAULT_STDIN_HOLD_IDLE_TIMEOUT_MS,
	DEFAULT_STDIN_HOLD_KILL_GRACE_MS,
	parseAgentEntrypointEnv,
	parseAgentFrontmatter,
} from "./agent-entrypoint-env.ts";

/* -------------------------------------------------------------------------- */
/* Injectable deps                                                            */
/* -------------------------------------------------------------------------- */

/** The default adapter registry: warren's built-in runtime adapters. */
const DEFAULT_ADAPTER_REGISTRY: { get(id: string): AgentRuntimeAdapter | undefined } = {
	get: (id) => allAdapters().find((adapter) => adapter.runtimeId === id),
};

export interface AgentEntrypointDeps {
	/** Adapter registry — defaults to warren's built-ins (`allAdapters()`). */
	registry?: { get(id: string): AgentRuntimeAdapter | undefined };
	/** Spawn seam — defaults to `Bun.spawn`. */
	spawn?: AgentSpawn;
	/** Inbox-poll HTTP seam — defaults to `fetch`. */
	http?: AgentInboxHttp;
	/** Where NDJSON event lines are written — defaults to `process.stdout`. */
	out?: (line: string) => void;
	/** Structured diagnostic log (stderr) — defaults to `console.error`. */
	log?: (message: string) => void;
	/** Finalize seam overrides forwarded to `runFinalizeEntrypoint` (tests). */
	finalize?: FinalizeEntrypointDeps;
	/** Skip the in-pod finalize step entirely (tests that only exercise the agent). */
	skipFinalize?: boolean;
	/**
	 * Register a handler for the pod's termination signal (warren-01d5). The
	 * default `runAgentEntrypoint` main wiring installs `SIGTERM`/`SIGINT` on
	 * the process; tests inject a registrar they can fire directly. Absent
	 * (unit tests of `runAgent`) ⇒ no signal handling is installed.
	 */
	registerCancelSignal?: (handler: (signal: string) => void) => void;
}

/* -------------------------------------------------------------------------- */
/* Orchestration                                                              */
/* -------------------------------------------------------------------------- */

export interface AgentRunResult {
	exitCode: number;
	phase: "succeeded" | "failed";
	/**
	 * warren-01d5: a registered termination signal fired while the agent ran —
	 * the entrypoint killed the agent child so the caller's post-step (the
	 * finalize/salvage entrypoint) can still run inside the pod's cancel grace
	 * window instead of the kubelet SIGKILLing everything with the work unpushed.
	 */
	cancelledViaSignal: boolean;
}

/**
 * Resolve the final spawn command: wrap the agent argv in the setpriv uid
 * drop (warren-cb93, preflighted — see `./agent-uid-drop.ts`) so the agent
 * process runs at a DIFFERENT uid than this entrypoint and cannot forge the
 * provenance marker at `/proc/1/fd/1`, then arm the stdin hold. `null` when
 * the uid-drop preflight failed (a legible error event already emitted).
 */
async function resolveAgentCommand(
	baseCommand: AgentSpawnCommand,
	useStdinHold: boolean,
	env: AgentEntrypointEnv,
	io: { spawn: AgentSpawn; out: (line: string) => void; log: (m: string) => void },
): Promise<AgentSpawnCommand | null> {
	let command = baseCommand;
	if (env.agentRunAs !== undefined) {
		const dropped = await applyAgentUidDrop(baseCommand, env.agentRunAs, {
			spawn: io.spawn,
			cwd: env.workspacePath,
			log: io.log,
		});
		if (!dropped.ok) {
			emitSystem(io.out, "error", { message: uidDropPreflightErrorMessage(dropped.probeExit) });
			return null;
		}
		command = dropped.command;
	}
	return useStdinHold ? { ...command, holdStdin: true } : command;
}

/**
 * True when a parsed runtime event is a terminal envelope — claude's `result`
 * or pi's `agent_end` on the `state_change`/`system` carrier. This is the exact
 * predicate the control plane's `detectRuntimeTerminal`
 * (src/runs/stream/terminal-detect.ts) applies to the re-parsed stream, kept in
 * sync by going through the same shared extractor
 * (`src/core/event-envelope.ts`). (warren-9a4a)
 */
export function isTerminalEnvelope(ev: AdapterRuntimeEvent): boolean {
	const env = extractAgentEventEnvelope(ev);
	return env !== null && (env.type === "result" || env.type === "agent_end");
}

/**
 * warren-9a4a: the agent exited without ever emitting a terminal envelope —
 * synthesize the missing `agent_end` in-pod (called AFTER every other witness
 * event, so those reach the log before the terminal signal). Emitted through
 * `emitSystem`/`formatEventLine`, it carries the warren origin marker and
 * passes both the provenance gate and `detectRuntimeTerminal` with no
 * control-plane change; a non-zero exit marks the envelope failed so the run
 * terminalizes truthfully instead of reading succeeded.
 */
function emitSynthesizedTerminalEnvelope(
	out: (line: string) => void,
	sawTerminalEnvelope: boolean,
	exitCode: number,
): void {
	if (sawTerminalEnvelope) return;
	emitSystem(out, "state_change", {
		type: "agent_end",
		synthesized: true,
		reason: "agent_exit_without_terminal_envelope",
		exitCode,
		...(exitCode !== 0
			? {
					stopReason: "error",
					errorMessage: `agent exited ${exitCode} without emitting a terminal envelope`,
				}
			: {}),
	});
}

/**
 * Drive the agent to a terminal outcome: drain the inbox, prepare + spawn, pump
 * stdout→events / stderr→events, and map the exit code to a phase. Does NOT run
 * finalize (that is `runAgentEntrypoint`'s post-step) — split out so the agent
 * loop is testable in isolation.
 */
export async function runAgent(
	env: AgentEntrypointEnv,
	deps: AgentEntrypointDeps = {},
): Promise<AgentRunResult> {
	const registry = deps.registry ?? DEFAULT_ADAPTER_REGISTRY;
	const spawn = deps.spawn ?? defaultSpawn;
	const http = deps.http ?? defaultHttp;
	const out = deps.out ?? ((line: string) => process.stdout.write(`${line}\n`));
	const log = deps.log ?? ((m: string) => console.error(m));

	const runtime = registry.get(env.runtimeId);
	if (runtime === undefined) {
		emitSystem(out, "error", { message: `runtime '${env.runtimeId}' is not registered` });
		return { exitCode: 1, phase: "failed", cancelledViaSignal: false };
	}

	const pendingMessages = await drainInbox(env, http, log);
	const ctx = buildSpawnContext(env, pendingMessages);

	// warren-cb93: under the uid split the agent runs as a DIFFERENT uid than
	// this entrypoint, sharing the pod gid (fsGroup) — so everything the
	// entrypoint materializes into the workspace (prepareWorkspace dirs, the
	// claude TMPDIR, the pi session dir) must be GROUP-writable for the
	// split-off agent to write there. Unconditional (this entrypoint only ever
	// runs in the pod); the init container sets the same umask for the clone
	// itself (workspace-init.ts).
	process.umask(0o002);

	if (runtime.prepareWorkspace !== undefined) {
		await runtime.prepareWorkspace({
			runId: env.runId,
			workspacePath: env.workspacePath,
		});
	}
	if (runtime.buildSpawnCommand === undefined) {
		emitSystem(out, "error", {
			message: `runtime '${env.runtimeId}' declares no buildSpawnCommand`,
		});
		return { exitCode: 1, phase: "failed", cancelledViaSignal: false };
	}

	// A runtime that declares `shouldCloseStdinOnEvent` (pi) exits the instant
	// stdin closes mid-inference — so it MUST keep stdin open until its terminal
	// event lands (mirrors burrow `dispatch.ts` `useStdinHold`). Batch runtimes
	// (claude-code `--print`) leave the seam undefined and keep the
	// write-and-close-at-spawn behavior. (warren-7a43)
	const useStdinHold = typeof runtime.shouldCloseStdinOnEvent === "function";
	const baseCommand = runtime.buildSpawnCommand(ctx);

	const command = await resolveAgentCommand(baseCommand, useStdinHold, env, { spawn, out, log });
	if (command === null) return { exitCode: 1, phase: "failed", cancelledViaSignal: false };
	log(`agent-entrypoint: launching '${runtime.runtimeId}' in ${env.workspacePath}`);
	const spawned = await spawn(command, { cwd: env.workspacePath });
	// warren-950d: under the uid split the watchdog's kill is a cross-uid
	// signal the entrypoint's empty effective capability set cannot deliver on
	// containerd 2.x — route it through setpriv (assume the agent's uid, then
	// signal uid-matched). No drop env ⇒ pass-through.
	const proc = withCrossUidKill(spawned, env.agentRunAs, {
		spawn,
		cwd: env.workspacePath,
		log,
	});

	// warren-01d5: a graceful cancel (a cost-cap trip or an operator cancel
	// both land on `provider.cancel(handle)` → pod delete → kubelet SIGTERM)
	// must NOT hard-kill this entrypoint before the finalize/salvage step
	// runs — the pod is the only place the committed work exists. Latch the
	// first signal, witness it on the event stream, and stop the agent child
	// so the spawn loop below returns promptly; control then falls through
	// `runAgentEntrypoint` into `runFinalizeEntrypoint`, which pushes the
	// branch / posts the salvage bundle before the process exits.
	const cancelledViaSignal = { value: false };
	deps.registerCancelSignal?.((signal) => {
		if (cancelledViaSignal.value) return;
		cancelledViaSignal.value = true;
		log(`agent-entrypoint: ${signal} received; stopping the agent for graceful finalize`);
		emitSystem(out, "cancel_requested", { signal, stop: "graceful" });
		proc.kill?.();
	});

	// All the stdin-hold machinery (close-on-trigger, auto-reply, idle watchdog,
	// mid-run steering) lives behind this controller; for a batch runtime it is a
	// no-op and the pumps below behave exactly as before.
	const hold = createStdinHoldController({
		active: useStdinHold,
		env,
		runtime,
		proc,
		http,
		out,
		log,
	});
	hold.start();

	const pumpStdout = async (): Promise<void> => {
		for await (const line of readLines(proc.stdout)) {
			hold.onOutput(); // any output resets the idle watchdog
			if (line.length === 0) continue;
			const events = [...(runtime.parseEvents?.(line) ?? [])];
			for (const ev of events) {
				out(formatEventLine(ev));
				if (isTerminalEnvelope(ev)) sawTerminalEnvelope = true;
			}
			await hold.onEvents(events);
		}
	};
	const pumpStderr = async (): Promise<void> => {
		for await (const line of readLines(proc.stderr)) {
			if (line.length === 0) continue;
			out(formatEventLine({ kind: "stderr", stream: "stderr", payload: { line } }));
		}
	};

	// warren-9a4a: track whether the agent's OWN stream carried a terminal
	// envelope (`result` / `agent_end` on the state_change/system carrier — the
	// exact shape `detectRuntimeTerminal` reads). A stdin-held runtime killed by
	// the idle watchdog (or any crashed agent) exits without one, and the reap
	// pipeline terminalizes ONLY on that envelope — without a synthesized
	// fallback the run hangs in `running` while the pod polls finalize-intent
	// forever.
	let sawTerminalEnvelope = false;
	let streamError: unknown;
	let exitCode: number;
	try {
		[exitCode] = await Promise.all([
			proc.exited,
			pumpStdout().catch((err) => {
				streamError = err;
			}),
			pumpStderr().catch((err) => {
				streamError = streamError ?? err;
			}),
		]);
	} finally {
		await hold.stop();
	}

	// Exit 137 is the kubelet/kernel SIGKILL an OOM produces; surface it as a
	// distinct system event (parity with burrow's dispatch, design §3.2). The
	// pod-watcher/status-map also catches the real OOMKilled container reason —
	// this is the in-stream witness.
	if (exitCode === 137) {
		emitSystem(out, "oom_killed", { exitCode });
	}
	if (streamError !== undefined) {
		emitSystem(out, "error", {
			message: `event stream failed: ${streamError instanceof Error ? streamError.message : String(streamError)}`,
		});
	}
	emitSynthesizedTerminalEnvelope(out, sawTerminalEnvelope, exitCode);
	const phase = exitCode === 0 ? "succeeded" : "failed";
	log(`agent-entrypoint: '${runtime.runtimeId}' exited ${exitCode} (${phase})`);
	return { exitCode, phase, cancelledViaSignal: cancelledViaSignal.value };
}

/**
 * Container exit code (warren-4d6a) for "the agent succeeded but the finalize
 * entrypoint never delivered a result": 75 (sysexits EX_TEMPFAIL) — a distinct,
 * documented code so operators can tell a lost-delivery pod apart from an agent
 * failure (the agent's own non-zero code) and from an OOM (137). Any non-zero
 * code already reads pod-phase Failed → status-map terminalReason 'error'; this
 * value is the discriminator in the pod's exit code field.
 */
export const EXIT_FINALIZE_NOT_DELIVERED = 75;

/**
 * Full entrypoint: run the agent, then run the in-pod finalize step, and return
 * the agent's exit code (so the pod PHASE reflects the run outcome). Finalize is
 * best-effort and independent of the agent's success — warren only parks a reap
 * intent when it decides to reap (which happens for failed runs too), and the
 * finalize entrypoint self-bounds with its own poll timeout when no intent
 * arrives. Skipped when no callback credential is present or `deps.skipFinalize`.
 *
 * warren-4d6a: when a callback credential WAS present and finalize still failed
 * to deliver (no intent within maxWaitMs, exhausted POST retries, or a thrown
 * error), a SUCCESSFUL agent run exits `EXIT_FINALIZE_NOT_DELIVERED` instead of
 * 0 — the pod's terminal phase then truthfully reads Failed instead of
 * Succeeded for a run whose committed work was never posted. The agent's own
 * non-zero exit always wins unchanged.
 */
export async function runAgentEntrypoint(
	envSource: AgentEnvSource,
	deps: AgentEntrypointDeps = {},
): Promise<number> {
	const log = deps.log ?? ((m: string) => console.error(m));
	const env = parseAgentEntrypointEnv(envSource);
	const result = await runAgent(env, deps);

	const canFinalize = env.apiUrl !== undefined && env.apiToken !== undefined;
	let finalizeDelivered = true;
	if (deps.skipFinalize !== true && canFinalize) {
		try {
			finalizeDelivered = await runFinalizeEntrypoint(
				buildFinalizeEnvSource(envSource, result),
				deps.finalize,
			);
		} catch (err) {
			// A thrown finalize error means nothing was delivered — treat it as a
			// delivery failure for exit-code purposes (warren-4d6a).
			finalizeDelivered = false;
			log(`agent-entrypoint: finalize step failed (${err instanceof Error ? err.message : err})`);
		}
	} else if (!canFinalize) {
		log("agent-entrypoint: no callback credential; skipping in-pod finalize");
	}
	// The agent's own failure always wins; only a SUCCESSFUL agent run whose
	// finalize never delivered gets reclassified non-zero (warren-4d6a).
	if (result.exitCode !== 0) return result.exitCode;
	if (canFinalize && deps.skipFinalize !== true && !finalizeDelivered) {
		log(
			`agent-entrypoint: finalize never delivered a result; exiting ${EXIT_FINALIZE_NOT_DELIVERED} ` +
				"so the pod phase reads Failed instead of a lying Succeeded",
		);
		return EXIT_FINALIZE_NOT_DELIVERED;
	}
	return result.exitCode;
}

/**
 * Build the env the finalize entrypoint runs with: the pod env overlaid with
 * the agent's exit code (warren-5202 — reported on every intent poll so a
 * recovering control plane can classify the outcome from the pod's own
 * witness, not the (possibly log-rotated) terminal envelope), plus — warren-01d5
 * — a BOUNDED intent-poll budget under a signal-driven cancel. The pod then has
 * only the cancel grace window left, so the poll is bounded to a slice of it
 * (default 25s): if warren's intent arrives in time the branch is pushed from
 * the pod; if not, the entrypoint still banks the no-intent salvage bundle
 * before exiting — the same finalize/salvage outcome a natural completion gets.
 */
function buildFinalizeEnvSource(envSource: AgentEnvSource, result: AgentRunResult): AgentEnvSource {
	return {
		...envSource,
		WARREN_AGENT_EXIT_CODE: String(result.exitCode),
		...(result.cancelledViaSignal && envSource.WARREN_FINALIZE_MAX_WAIT_MS === undefined
			? { WARREN_FINALIZE_MAX_WAIT_MS: cancelFinalizeMaxWaitMs(envSource) }
			: {}),
	};
}

/**
 * warren-01d5: bounded finalize budget under a signal-driven cancel, as
 * `WARREN_CANCEL_FINALIZE_MAX_WAIT_MS` (ms). Must fit inside the pod's
 * cancel grace (`WARREN_K8S_CANCEL_GRACE_SECONDS`) so the entrypoint can
 * still bank the no-intent salvage bundle and exit before the SIGKILL.
 */
const DEFAULT_CANCEL_FINALIZE_MAX_WAIT_MS = "25000";

function cancelFinalizeMaxWaitMs(envSource: AgentEnvSource): string {
	const raw = envSource.WARREN_CANCEL_FINALIZE_MAX_WAIT_MS?.trim();
	return raw !== undefined && raw !== "" ? raw : DEFAULT_CANCEL_FINALIZE_MAX_WAIT_MS;
}

if (import.meta.main) {
	runAgentEntrypoint(process.env, {
		// warren-01d5: route the pod's termination signal into the graceful
		// stop path — K8sProvider.cancel deletes the pod, the kubelet delivers
		// SIGTERM, and this handler stops the agent so the in-pod
		// finalize/salvage step still runs inside the cancel grace window.
		registerCancelSignal: (handler) => {
			process.on("SIGTERM", () => handler("SIGTERM"));
			process.on("SIGINT", () => handler("SIGINT"));
		},
	})
		.then((code) => process.exit(code))
		.catch((err: unknown) => {
			console.error(err instanceof Error ? err.message : String(err));
			process.exit(1);
		});
}
