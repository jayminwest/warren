/**
 * The host-side drive loop (warren-413d, plan pl-3007 phase 3) — the
 * in-process replacement for `burrow serve`'s run dispatcher (burrow
 * `src/runner/dispatch.ts`), shaped on the k8s in-pod entrypoint
 * (`src/runtime/k8s/agent-entrypoint.ts`, warren-0efe): the same adapter
 * hooks (`buildSpawnCommand` / `parseEvents` / steering encoders), the same
 * stdin-hold contract, the same synthesized-terminal fallback — but spawned
 * through warren's own sandbox (`src/sandbox/`, warren-5af7) and persisted
 * directly into the in-process run store (`./run-store.ts`) instead of
 * riding a daemon's HTTP stream.
 *
 * Lifecycle per run:
 *
 *   1. Claim the steering inbox once (spawn-time drain, burrow SPEC §13.2)
 *      so pending messages fold into the adapter's stdin payload.
 *   2. `prepareWorkspace` (settings file, private TMPDIR, pi session dir),
 *      plus the warren-c865 home-credential forward: with $HOME now a real
 *      per-run directory, the host's claude OAuth blob is copied into it so
 *      auth resolves via $HOME lookup instead of the workspace.
 *   3. Under `network=restricted`, start a per-run loopback CONNECT proxy
 *      (warren-70bb / burrow `src/proxy/server.ts`), set `proxyAddress` on
 *      the profile, and overlay HTTP(S)_PROXY onto the agent env. open/none
 *      skip this path entirely so default behavior stays byte-identical.
 *   4. Spawn through `runSandboxed`. Batch runtimes (claude-code) close
 *      stdin at spawn; stdin-held runtimes (pi — declares
 *      `shouldCloseStdinOnEvent`) keep it open until the terminal event
 *      lands, with mid-run steering delivered over the live stdin
 *      (`encodeSteeringMessage`) and the auto-reply hook
 *      (`autoRespondToEvent`) declining interactive RPCs. The proxy stops
 *      in the drive loop's `finally` so a hung CONNECT tunnel cannot pin
 *      the run.
 *   5. Terminalize the record: cancelled (cancel() won the race), oom_killed
 *      (the cgroup probe, burrow-2083 parity), stream error, or the exit
 *      code. An agent that exits WITHOUT a terminal envelope gets a
 *      synthesized `agent_end` (warren-9a4a parity with the k8s entrypoint)
 *      so the domain's `detectRuntimeTerminal` always sees the run end.
 *
 * The loop never throws: every failure lands as events + a failed terminal
 * record, mirroring how burrow's dispatcher collapsed dispatch errors into a
 * structured failed outcome rather than rejecting `runs.create`.
 */

import { extractAgentEventEnvelope } from "../../core/event-envelope.ts";
import type { ProxyHandle, StartProxyOptions } from "../../sandbox/proxy-server.ts";
import { runSandboxed } from "../../sandbox/sandbox.ts";
import type { SandboxProfile, SpawnCommand, SpawnResult } from "../../sandbox/types.ts";
import type { AdapterRuntimeEvent, AgentRuntimeAdapter } from "../adapters/index.ts";
import type { AgentFrontmatter } from "../adapters/types.ts";
import type { RunSpec } from "../contract.ts";
import {
	abandonSpawnedChild,
	cancelWon,
	prepareSpawn,
	settleCancelledIfNeeded,
} from "./drive-prepare.ts";
import { createStdinController, type StdinController, startMidRunSteering } from "./drive-stdin.ts";
import type { LocalRunRecord, LocalRunStore } from "./run-store.ts";

/** Mid-run steering poll cadence — burrow's MID_RUN_INBOX_POLL_MS verbatim. */
export const MID_RUN_INBOX_POLL_MS = 200;

export type StartProxyFn = (opts: StartProxyOptions) => Promise<ProxyHandle>;

export interface DriveDeps {
	/** Spawn seam — defaults to `runSandboxed` (tests inject a fake child). */
	readonly spawn?: (profile: SandboxProfile, command: SpawnCommand) => Promise<SpawnResult>;
	/**
	 * Proxy starter seam (warren-70bb) — defaults to `startProxy`. Tests inject
	 * a fake so restricted-network runs never bind a real loopback port.
	 */
	readonly startProxy?: StartProxyFn;
	/** Adapter registry — defaults to warren's built-ins. */
	readonly registry?: { get(id: string): AgentRuntimeAdapter | undefined };
	/** Test seam: mid-run inbox poll cadence (ms). */
	readonly midRunInboxPollMs?: number;
	readonly now?: () => Date;
	readonly log?: (message: string) => void;
	/**
	 * Workspace-ready signal (warren-7116) — the runtime → domain edge for the
	 * `runs.workspace_ready_at` stamp. Fired once after `prepareSpawn` lands
	 * (workspace materialized, sandbox profile composed) so the prep span is
	 * measured without the drive loop touching the database directly. Optional;
	 * first-write-wins domain-side.
	 */
	readonly onWorkspaceReady?: (runId: string, at: Date) => void;
}

/**
 * Pull the agent frontmatter off `spec.metadata.frontmatter` (the domain's
 * `composeBurrowMetadata` folds it there). A non-object yields `undefined` —
 * the adapters fall back to their pinned provider/model defaults.
 */
export function readSpecFrontmatter(
	metadata: Record<string, unknown> | undefined,
): AgentFrontmatter | undefined {
	const raw = metadata?.frontmatter;
	if (raw === null || raw === undefined || typeof raw !== "object" || Array.isArray(raw)) {
		return undefined;
	}
	return raw as AgentFrontmatter;
}

/** True when a parsed event is the agent's terminal envelope (`result` / `agent_end`). */
function isTerminalEnvelope(ev: AdapterRuntimeEvent): boolean {
	const env = extractAgentEventEnvelope(ev);
	return env !== null && (env.type === "result" || env.type === "agent_end");
}

async function* readLines(stream: ReadableStream<Uint8Array>): AsyncGenerator<string, void, void> {
	const reader = stream.getReader();
	const decoder = new TextDecoder();
	let buf = "";
	try {
		while (true) {
			const { value, done } = await reader.read();
			if (done) break;
			buf += decoder.decode(value, { stream: true });
			let idx = buf.indexOf("\n");
			while (idx !== -1) {
				yield buf.slice(0, idx);
				buf = buf.slice(idx + 1);
				idx = buf.indexOf("\n");
			}
		}
		buf += decoder.decode();
		if (buf.length > 0) yield buf;
	} finally {
		reader.releaseLock();
	}
}

/**
 * Drive one run to a terminal record. Fire-and-forget from `create()` — the
 * returned promise resolves when the record terminalizes and never rejects:
 * a drive-loop fault lands as events + a failed terminal record, mirroring
 * burrow's dispatcher collapsing dispatch errors into a failed outcome.
 */
export async function driveLocalRun(
	store: LocalRunStore,
	record: LocalRunRecord,
	spec: RunSpec,
	profile: SandboxProfile,
	deps: DriveDeps = {},
): Promise<void> {
	try {
		await spawnAndPump(store, record, spec, profile, deps);
	} catch (err) {
		// A cancel that already settled the record must stay cancelled even if
		// teardown throws (double-cancel, closed stream, etc.).
		if (store.isTerminal(record)) return;
		const message = err instanceof Error ? err.message : String(err);
		store.appendEvent(record, { kind: "error", stream: "system", payload: { message } });
		store.terminalize(record, {
			phase: "failed",
			exitCode: null,
			terminalReason: "error",
			errorMessage: message,
		});
	}
}

async function spawnAndPump(
	store: LocalRunStore,
	record: LocalRunRecord,
	spec: RunSpec,
	profile: SandboxProfile,
	deps: DriveDeps,
): Promise<void> {
	const log = deps.log ?? (() => {});
	// Cancel can win before spawn (LocalEngine.cancel terminalizes immediately).
	if (cancelWon(store, record)) {
		settleCancelledIfNeeded(store, record);
		return;
	}
	const prepared = await prepareSpawn(store, record, spec, profile, deps);
	if (prepared === null) return;
	// warren-7116: the workspace is prepared — stamp the stage timestamp via
	// the injected domain signal (never a direct db write from the runtime).
	try {
		deps.onWorkspaceReady?.(record.runId, deps.now?.() ?? new Date());
	} catch {
		// Best-effort observability; a writer fault must not kill the drive loop.
	}
	const { runtime, runProfile, runCommand, proxy, useStdinHold } = prepared;

	// Re-check after async setup — cancel may have landed mid-prepare.
	if (cancelWon(store, record)) {
		await proxy?.stop();
		settleCancelledIfNeeded(store, record);
		return;
	}
	log(`local-drive: launching '${runtime.runtimeId}' in ${record.workspacePath}`);
	let proc: SpawnResult;
	try {
		proc = await (deps.spawn ?? runSandboxed)(runProfile, runCommand);
	} catch (err) {
		await proxy?.stop();
		throw err;
	}
	if (cancelWon(store, record)) {
		await abandonSpawnedChild(store, record, proc, proxy);
		return;
	}
	record.proc = proc;
	store.markRunning(record);

	const stdin = createStdinController(runtime, proc, useStdinHold);
	const midRun = startMidRunSteering(store, record, runtime, proc, stdin, deps);
	try {
		const outcome = await pumpToExit(store, record, runtime, proc, stdin, deps);
		terminalize(store, record, runProfile, proc, outcome, deps);
		log(`local-drive: '${runtime.runtimeId}' exited ${outcome.exitCode}`);
	} finally {
		// Stop the steering loop before tearing down stdin so its final
		// poll tick can't race the closeStdin path (burrow dispatch.ts).
		midRun.abort();
		await midRun.done;
		await stdin.closeIfDangling();
		// Bound proxy teardown to spawn lifetime — a hung CONNECT tunnel
		// can't pin the run (burrow dispatch.ts shape).
		await proxy?.stop();
	}
}

interface PumpOutcome {
	readonly exitCode: number;
	readonly sawTerminalEnvelope: boolean;
	readonly streamError: unknown;
}

/** Run the stdout/stderr pumps alongside the child's exit; collect the outcome. */
async function pumpToExit(
	store: LocalRunStore,
	record: LocalRunRecord,
	runtime: AgentRuntimeAdapter,
	proc: SpawnResult,
	stdin: StdinController,
	deps: DriveDeps,
): Promise<PumpOutcome> {
	const now = deps.now ?? (() => new Date());
	let sawTerminalEnvelope = false;
	const pumpStdout = async (): Promise<void> => {
		for await (const line of readLines(proc.stdout)) {
			if (line.length === 0) continue;
			const events = runtime.parseEvents?.(line) ?? [];
			for (const ev of events) {
				store.appendEvent(record, { kind: ev.kind, stream: ev.stream, payload: ev.payload }, now);
				if (isTerminalEnvelope(ev)) sawTerminalEnvelope = true;
			}
			await stdin.autoRespond(events);
			await stdin.closeOnTrigger(events);
		}
	};
	const pumpStderr = async (): Promise<void> => {
		for await (const line of readLines(proc.stderr)) {
			if (line.length === 0) continue;
			store.appendEvent(record, { kind: "stderr", stream: "stderr", payload: { line } }, now);
		}
	};
	let streamError: unknown;
	const [exitCode] = await Promise.all([
		proc.exited,
		pumpStdout().catch((err) => {
			streamError = err;
		}),
		pumpStderr().catch((err) => {
			streamError = streamError ?? err;
		}),
	]);
	return { exitCode, sawTerminalEnvelope, streamError };
}

/** Map the pump outcome onto the record's terminal phase + witness events. */
function terminalize(
	store: LocalRunStore,
	record: LocalRunRecord,
	profile: SandboxProfile,
	proc: SpawnResult,
	outcome: PumpOutcome,
	deps: DriveDeps,
): void {
	// LocalEngine.cancel terminalizes immediately (warren-8a6e); the drive
	// loop still drains the child but must not overwrite a settled phase
	// (e.g. cancelled → failed from a non-zero kill exit).
	if (store.isTerminal(record)) return;
	const now = deps.now ?? (() => new Date());
	const { exitCode } = outcome;
	if (record.cancelRequested) {
		store.terminalize(record, {
			phase: "cancelled",
			exitCode,
			terminalReason: "cancelled",
			errorMessage: "cancelled",
		});
		return;
	}
	if (proc.oomKilled?.() === true) {
		store.appendEvent(
			record,
			{
				kind: "oom_killed",
				stream: "system",
				payload: { exitCode, memoryLimitMb: profile.memoryLimitMb ?? null },
			},
			now,
		);
		store.terminalize(record, {
			phase: "failed",
			exitCode,
			terminalReason: "oom_killed",
			errorMessage: `sandbox memory limit exceeded (oom-killed, exit ${exitCode})`,
		});
		return;
	}
	const streamErrorMessage =
		outcome.streamError === undefined
			? null
			: outcome.streamError instanceof Error
				? outcome.streamError.message
				: String(outcome.streamError);
	if (streamErrorMessage !== null) {
		store.appendEvent(
			record,
			{
				kind: "error",
				stream: "system",
				payload: { message: `event stream failed: ${streamErrorMessage}` },
			},
			now,
		);
	}
	if (!outcome.sawTerminalEnvelope) emitSynthesizedTerminal(store, record, exitCode, now);
	if (streamErrorMessage !== null) {
		store.terminalize(record, {
			phase: "failed",
			exitCode,
			terminalReason: "error",
			errorMessage: `event stream failed: ${streamErrorMessage}`,
		});
		return;
	}
	store.terminalize(
		record,
		exitCode === 0
			? { phase: "succeeded", exitCode, terminalReason: "completed" }
			: {
					phase: "failed",
					exitCode,
					terminalReason: "error",
					errorMessage: `agent exited with code ${exitCode}`,
				},
	);
}

/**
 * warren-9a4a parity (k8s `agent-entrypoint.ts`): the agent exited without a
 * terminal envelope — synthesize `agent_end` so the domain's
 * `detectRuntimeTerminal` terminalizes the run instead of hanging `running`.
 */
function emitSynthesizedTerminal(
	store: LocalRunStore,
	record: LocalRunRecord,
	exitCode: number,
	now: () => Date,
): void {
	store.appendEvent(
		record,
		{
			kind: "state_change",
			stream: "system",
			payload: {
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
			},
		},
		now,
	);
}
