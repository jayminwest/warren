/**
 * The in-pod agent entrypoint (pl-829f step 25 / warren-186c, design
 * k8s-migration.md §1.4/§4.2/§5.1). Runs INSIDE the run pod's agent container —
 * after the `workspace-init` init container has materialized `/workspace` and
 * before the finalize step — and is the K8s counterpart to what `burrow serve`
 * does host-side in the LocalProvider path.
 *
 * With pod-per-run there is no `burrow serve` driving the agent, so this thin
 * Bun entrypoint REUSES burrow's agent-launch machinery rather than inventing a
 * parallel one: it resolves the selected runtime off burrow's `AgentRegistry`
 * (`@os-eco/burrow-cli`), calls the runtime's own `buildSpawnCommand` (argv +
 * stdin) and `parseEvents` (stdout line → structured event), and drives them
 * with a minimal spawn loop. The only thing it replaces is the sandbox: the pod
 * IS the sandbox (design §2.2), so the agent argv is spawned directly instead of
 * through bwrap/`runSandboxed`.
 *
 * Lifecycle (the contract the agent image wires around, design §5.1):
 *
 *   1. DRAIN the steering inbox once over `GET /runs/:id/inbox`. A batch runtime
 *      (claude-code/sapling) closes stdin at spawn, so pending steering rides as
 *      the turn's `pendingMessages`, folded into the prompt by the runtime's own
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
 *   4. On agent exit, run the finalize entrypoint in-process (`./finalize-
 *      entrypoint.ts`): it polls warren's parked reap intent, collects the
 *      workspace-dependent artifacts, and POSTs the `FinalizeResult`.
 *   5. Exit with the agent's own exit code so the pod's terminal PHASE
 *      (`restartPolicy: Never`: 0 → Succeeded, ≠0 → Failed) reflects the run
 *      outcome — the pod-watcher/status-map's backstop signal (design §1.3).
 *
 * The workspace-touching + network seams (`registry`, `spawn`, `http`, `out`)
 * are injectable so the whole orchestration is unit-testable without a cluster,
 * a real agent binary, or a real network.
 */

import { AgentRegistry, type AgentRuntime, type SpawnCommand } from "@os-eco/burrow-cli";
import {
	type AgentInboxHttp,
	type AgentSpawn,
	buildSpawnContext,
	defaultHttp,
	defaultSpawn,
	drainInbox,
	emitSystem,
	formatEventLine,
	readLines,
} from "./agent-io.ts";
import { createStdinHoldController } from "./agent-stdin-hold.ts";
import { type FinalizeEntrypointDeps, runFinalizeEntrypoint } from "./finalize-entrypoint.ts";

/* -------------------------------------------------------------------------- */
/* Env                                                                        */
/* -------------------------------------------------------------------------- */

export interface AgentEntrypointEnv {
	runId: string;
	runtimeId: string;
	prompt: string;
	workspacePath: string;
	/** Callback base URL (Service DNS) — inbox drain + finalize; absent ⇒ both skipped. */
	apiUrl: string | undefined;
	/** Bearer for the callback; absent ⇒ inbox drain + finalize skipped. */
	apiToken: string | undefined;
	/** Agent frontmatter (provider/model overrides the runtime honors), if any. */
	frontmatter: Record<string, unknown> | undefined;
	/** Poll interval for the steering-inbox drain (ms). */
	inboxPollIntervalMs: number;
	/**
	 * Watchdog for stdin-held runtimes (pi): if the child produces no stdout for
	 * this many ms while stdin is still held open, warren closes stdin (nudging
	 * the runtime to exit on EOF) and force-kills as a backstop — so a hung
	 * inference can't pin the pod forever waiting on a close-trigger event that
	 * never arrives. `0` disables the watchdog. Runtimes that close stdin at
	 * spawn (claude-code, sapling) never arm it. (warren-7a43)
	 */
	stdinHoldIdleTimeoutMs: number;
}

export type AgentEnvSource = Readonly<Record<string, string | undefined>>;

function required(env: AgentEnvSource, key: string): string {
	const raw = env[key]?.trim();
	if (raw === undefined || raw === "") {
		throw new Error(`agent-entrypoint: missing required env ${key}`);
	}
	return raw;
}

function optional(env: AgentEnvSource, key: string): string | undefined {
	const raw = env[key]?.trim();
	return raw === undefined || raw === "" ? undefined : raw;
}

function positiveIntEnv(env: AgentEnvSource, key: string, fallback: number): number {
	const raw = env[key]?.trim();
	if (raw === undefined || raw === "") return fallback;
	const n = Number(raw);
	return Number.isInteger(n) && n > 0 ? n : fallback;
}

/** Like `positiveIntEnv` but allows `0` (a knob's disable sentinel). */
function nonNegativeIntEnv(env: AgentEnvSource, key: string, fallback: number): number {
	const raw = env[key]?.trim();
	if (raw === undefined || raw === "") return fallback;
	const n = Number(raw);
	return Number.isInteger(n) && n >= 0 ? n : fallback;
}

/**
 * Parse the agent frontmatter carried on `WARREN_AGENT_METADATA` (the domain's
 * `composeBurrowMetadata` folds `{ frontmatter }` into the run metadata). A
 * malformed / non-object value yields `undefined` (the runtime falls back to its
 * pinned provider/model defaults) rather than failing the run.
 */
export function parseAgentFrontmatter(
	raw: string | undefined,
): Record<string, unknown> | undefined {
	if (raw === undefined || raw === "") return undefined;
	try {
		const value: unknown = JSON.parse(raw);
		if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
		const frontmatter = (value as { frontmatter?: unknown }).frontmatter;
		if (frontmatter !== null && typeof frontmatter === "object" && !Array.isArray(frontmatter)) {
			return frontmatter as Record<string, unknown>;
		}
		return undefined;
	} catch {
		return undefined;
	}
}

/** Default stdin-hold idle watchdog: 30 min, matching `agent.pauseTimeoutMs`. */
export const DEFAULT_STDIN_HOLD_IDLE_TIMEOUT_MS = 1_800_000;

/** Parse + validate the agent entrypoint env. Pure. */
export function parseAgentEntrypointEnv(env: AgentEnvSource): AgentEntrypointEnv {
	const apiUrlRaw = optional(env, "WARREN_API_URL");
	return {
		runId: required(env, "WARREN_RUN_ID"),
		runtimeId: required(env, "WARREN_AGENT_RUNTIME"),
		prompt: env.WARREN_PROMPT ?? "",
		workspacePath: optional(env, "WARREN_WORKSPACE_PATH") ?? "/workspace",
		apiUrl: apiUrlRaw?.replace(/\/+$/, ""),
		apiToken: optional(env, "WARREN_API_TOKEN"),
		frontmatter: parseAgentFrontmatter(env.WARREN_AGENT_METADATA),
		inboxPollIntervalMs: positiveIntEnv(env, "WARREN_INBOX_POLL_INTERVAL_MS", 5_000),
		stdinHoldIdleTimeoutMs: nonNegativeIntEnv(
			env,
			"WARREN_AGENT_STDIN_HOLD_IDLE_MS",
			DEFAULT_STDIN_HOLD_IDLE_TIMEOUT_MS,
		),
	};
}

/* -------------------------------------------------------------------------- */
/* Injectable deps                                                            */
/* -------------------------------------------------------------------------- */

export interface AgentEntrypointDeps {
	/** Runtime registry — defaults to burrow's built-ins (`new AgentRegistry()`). */
	registry?: { get(id: string): AgentRuntime | undefined };
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
}

/* -------------------------------------------------------------------------- */
/* Orchestration                                                              */
/* -------------------------------------------------------------------------- */

export interface AgentRunResult {
	exitCode: number;
	phase: "succeeded" | "failed";
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
	const registry = deps.registry ?? new AgentRegistry();
	const spawn = deps.spawn ?? defaultSpawn;
	const http = deps.http ?? defaultHttp;
	const out = deps.out ?? ((line: string) => process.stdout.write(`${line}\n`));
	const log = deps.log ?? ((m: string) => console.error(m));

	const runtime = registry.get(env.runtimeId);
	if (runtime === undefined) {
		emitSystem(out, "error", { message: `runtime '${env.runtimeId}' is not registered` });
		return { exitCode: 1, phase: "failed" };
	}

	const pendingMessages = await drainInbox(env, http, log);
	const ctx = buildSpawnContext(env, pendingMessages);

	if (runtime.prepareWorkspace !== undefined) {
		await runtime.prepareWorkspace({
			burrow: ctx.burrow,
			run: ctx.run,
			workspacePath: env.workspacePath,
		});
	}

	// A runtime that declares `shouldCloseStdinOnEvent` (pi/leveret/healer) exits
	// the instant stdin closes mid-inference — so it MUST keep stdin open until
	// its terminal event lands (mirrors burrow `dispatch.ts` `useStdinHold`).
	// Batch runtimes (claude-code `--print`, sapling) leave the seam undefined and
	// keep the write-and-close-at-spawn behavior. (warren-7a43)
	const useStdinHold = typeof runtime.shouldCloseStdinOnEvent === "function";
	const baseCommand = runtime.buildSpawnCommand(ctx);
	const command: SpawnCommand = useStdinHold ? { ...baseCommand, holdStdin: true } : baseCommand;
	log(`agent-entrypoint: launching '${runtime.id}' in ${env.workspacePath}`);
	const proc = await spawn(command, { cwd: env.workspacePath });

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
			const events = [...runtime.parseEvents(line, { burrow: ctx.burrow, run: ctx.run })];
			for (const ev of events) out(formatEventLine(ev));
			await hold.onEvents(events);
		}
	};
	const pumpStderr = async (): Promise<void> => {
		for await (const line of readLines(proc.stderr)) {
			if (line.length === 0) continue;
			out(formatEventLine({ kind: "stderr", stream: "stderr", payload: { line } }));
		}
	};

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
	const phase = exitCode === 0 ? "succeeded" : "failed";
	log(`agent-entrypoint: '${runtime.id}' exited ${exitCode} (${phase})`);
	return { exitCode, phase };
}

/**
 * Full entrypoint: run the agent, then run the in-pod finalize step, and return
 * the agent's exit code (so the pod PHASE reflects the run outcome). Finalize is
 * best-effort and independent of the agent's success — warren only parks a reap
 * intent when it decides to reap (which happens for failed runs too), and the
 * finalize entrypoint self-bounds with its own poll timeout when no intent
 * arrives. Skipped when no callback credential is present or `deps.skipFinalize`.
 */
export async function runAgentEntrypoint(
	envSource: AgentEnvSource,
	deps: AgentEntrypointDeps = {},
): Promise<number> {
	const log = deps.log ?? ((m: string) => console.error(m));
	const env = parseAgentEntrypointEnv(envSource);
	const result = await runAgent(env, deps);

	const canFinalize = env.apiUrl !== undefined && env.apiToken !== undefined;
	if (deps.skipFinalize !== true && canFinalize) {
		try {
			await runFinalizeEntrypoint(envSource, deps.finalize);
		} catch (err) {
			// Finalize is best-effort in-pod; warren's own finalize timeout produces
			// a failed FinalizeResult if the pod never posts. Never let a finalize
			// error mask the agent's real exit code.
			log(`agent-entrypoint: finalize step failed (${err instanceof Error ? err.message : err})`);
		}
	} else if (!canFinalize) {
		log("agent-entrypoint: no callback credential; skipping in-pod finalize");
	}
	return result.exitCode;
}

if (import.meta.main) {
	runAgentEntrypoint(process.env)
		.then((code) => process.exit(code))
		.catch((err: unknown) => {
			console.error(err instanceof Error ? err.message : String(err));
			process.exit(1);
		});
}
