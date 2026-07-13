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
 *   1. DRAIN the steering inbox once over `GET /runs/:id/inbox` (contract §5
 *      `midRunSteering: false` — a batch runtime like claude-code/sapling closes
 *      stdin at spawn, so pending steering rides as the turn's `pendingMessages`,
 *      folded into the prompt by the runtime's own encoder; mid-run stdin
 *      injection is out of scope for v1's spawn-per-turn runtimes).
 *   2. `prepareWorkspace` (the runtime's optional hook), then spawn the agent.
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

import {
	AgentRegistry,
	type AgentRuntime,
	type Burrow,
	type Message as BurrowMessage,
	type Run,
	type RuntimeEvent,
	type SpawnCommand,
	type SpawnContext,
} from "@os-eco/burrow-cli";
import type { Message } from "../contract.ts";
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
	};
}

/* -------------------------------------------------------------------------- */
/* Event emission — the NDJSON envelope `./log-parse.ts` re-parses off the log */
/* -------------------------------------------------------------------------- */

/**
 * Serialize a runtime event into the one-line NDJSON envelope the pod-log stream
 * carries. The shape mirrors what `toNormalizedEvent` (`./log-parse.ts`) reads
 * back: a top-level `kind`/`stream`/`payload` plus the agent's own event time as
 * `ts` (the parser falls back to the kubelet line stamp when `ts` is absent, but
 * emitting it keeps the agent's timing authoritative). Pure + round-trippable —
 * see the co-located test.
 */
export function formatEventLine(ev: RuntimeEvent): string {
	return JSON.stringify({
		kind: ev.kind,
		stream: ev.stream,
		payload: ev.payload,
		ts: (ev.ts ?? new Date()).toISOString(),
	});
}

/* -------------------------------------------------------------------------- */
/* Injectable seams (testable without a cluster / real agent / real network)   */
/* -------------------------------------------------------------------------- */

/** A spawned agent process — the subset of `Bun.spawn`'s result the loop drives. */
export interface AgentProc {
	stdout: ReadableStream<Uint8Array>;
	stderr: ReadableStream<Uint8Array>;
	exited: Promise<number>;
}

export type AgentSpawn = (command: SpawnCommand, opts: { cwd: string }) => AgentProc;

export interface AgentInboxHttp {
	get: (url: string, token: string) => Promise<{ status: number; body: unknown }>;
}

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
/* Inbox drain — pending steering folded into the turn's pendingMessages        */
/* -------------------------------------------------------------------------- */

/** Extract `{ messages: Message[] }` from a `GET /runs/:id/inbox` body. Pure. */
export function extractInboxMessages(body: unknown): Message[] {
	if (body === null || typeof body !== "object") return [];
	const messages = (body as { messages?: unknown }).messages;
	if (!Array.isArray(messages)) return [];
	return messages.filter((m): m is Message => m !== null && typeof m === "object");
}

/**
 * Map a warren seam `Message` onto the burrow `Message` shape the runtime's
 * `buildSpawnCommand` reads (only `body` + `priority` are consulted by the
 * claude-code / sapling steering encoders). Cast through `unknown` at this trust
 * boundary — the burrow row type carries columns the encoders never touch.
 */
function toBurrowMessage(msg: Message): BurrowMessage {
	return {
		id: msg.id,
		body: msg.body,
		priority: msg.priority,
		fromActor: msg.fromActor,
		state: "delivered",
		createdAt: msg.createdAt,
		deliveredAt: msg.deliveredAt,
	} as unknown as BurrowMessage;
}

/**
 * Drain the run's steering inbox once (the poll-CONSUME endpoint claims + flips
 * each `unread` row to `delivered`). Returns the pending messages to fold into
 * the spawn's `pendingMessages`. A missing callback credential, a non-200, or a
 * malformed body all yield `[]` — steering is a best-effort nudge, never a
 * dispatch blocker.
 */
export async function drainInbox(
	env: AgentEntrypointEnv,
	http: AgentInboxHttp,
	log: (m: string) => void,
): Promise<BurrowMessage[]> {
	if (env.apiUrl === undefined || env.apiToken === undefined) return [];
	try {
		const res = await http.get(`${env.apiUrl}/runs/${env.runId}/inbox`, env.apiToken);
		if (res.status !== 200) return [];
		const messages = extractInboxMessages(res.body);
		if (messages.length > 0)
			log(`agent-entrypoint: drained ${messages.length} steering message(s)`);
		return messages.map(toBurrowMessage);
	} catch (err) {
		log(`agent-entrypoint: inbox drain failed (${err instanceof Error ? err.message : err})`);
		return [];
	}
}

/* -------------------------------------------------------------------------- */
/* Minimal burrow-shaped context (the runtimes only read a few fields)          */
/* -------------------------------------------------------------------------- */

/**
 * Build the `SpawnContext` the runtime's `buildSpawnCommand`/`parseEvents`
 * consume. The v1 runtimes (claude-code, sapling) read only `prompt`,
 * `pendingMessages`, and `workspacePath`; `burrow`/`run` are required by the
 * type but unused by those runtimes, so minimal stubs (cast through `unknown`)
 * satisfy the contract without reconstructing burrow's full DB rows.
 */
function buildSpawnContext(
	env: AgentEntrypointEnv,
	pendingMessages: BurrowMessage[],
): SpawnContext {
	const burrow = {
		id: `burrow_${env.runId}`,
		workspacePath: env.workspacePath,
	} as unknown as Burrow;
	const run = {
		id: env.runId,
		prompt: env.prompt,
		agentId: env.runtimeId,
		metadataJson: env.frontmatter !== undefined ? { frontmatter: env.frontmatter } : {},
	} as unknown as Run;
	return {
		burrow,
		run,
		prompt: env.prompt,
		pendingMessages,
		envResolved: {},
		workspacePath: env.workspacePath,
		...(env.frontmatter !== undefined ? { frontmatter: env.frontmatter } : {}),
	};
}

/* -------------------------------------------------------------------------- */
/* Line reader over a byte stream                                              */
/* -------------------------------------------------------------------------- */

async function* readLines(stream: ReadableStream<Uint8Array>): AsyncGenerator<string, void, void> {
	const reader = stream.getReader();
	const decoder = new TextDecoder();
	let buf = "";
	try {
		for (;;) {
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

/* -------------------------------------------------------------------------- */
/* Default spawn (Bun)                                                         */
/* -------------------------------------------------------------------------- */

const defaultSpawn: AgentSpawn = (command, opts) => {
	const proc = Bun.spawn(command.argv, {
		cwd: opts.cwd,
		env: { ...process.env, ...(command.env ?? {}) },
		stdin: "pipe",
		stdout: "pipe",
		stderr: "pipe",
	});
	// claude-code / sapling close stdin at spawn: write the encoded prompt, then
	// end. A ReadableStream stdin (unused by v1 runtimes) is drained best-effort.
	if (typeof command.stdin === "string") {
		proc.stdin.write(command.stdin);
	}
	proc.stdin.end();
	return {
		stdout: proc.stdout,
		stderr: proc.stderr,
		exited: proc.exited,
	};
};

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

	const command = runtime.buildSpawnCommand(ctx);
	log(`agent-entrypoint: launching '${runtime.id}' in ${env.workspacePath}`);
	const proc = spawn(command, { cwd: env.workspacePath });

	const pumpStdout = async (): Promise<void> => {
		for await (const line of readLines(proc.stdout)) {
			if (line.length === 0) continue;
			for (const ev of runtime.parseEvents(line, { burrow: ctx.burrow, run: ctx.run })) {
				out(formatEventLine(ev));
			}
		}
	};
	const pumpStderr = async (): Promise<void> => {
		for await (const line of readLines(proc.stderr)) {
			if (line.length === 0) continue;
			out(formatEventLine({ kind: "stderr", stream: "stderr", payload: { line } }));
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

/** Emit a `state`/system diagnostic event onto the NDJSON stream. */
function emitSystem(out: (line: string) => void, kind: string, payload: unknown): void {
	out(formatEventLine({ kind, stream: "system", payload }));
}

const defaultHttp: AgentInboxHttp = {
	get: async (url, token) => {
		const res = await fetch(url, { headers: { authorization: `Bearer ${token}` } });
		const body = res.status === 200 ? await res.json() : null;
		return { status: res.status, body };
	},
};

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
