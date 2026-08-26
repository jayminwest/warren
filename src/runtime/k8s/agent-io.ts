/**
 * Low-level I/O seams and helpers shared by the in-pod agent entrypoint
 * (`./agent-entrypoint.ts`) and its stdin-hold subsystem
 * (`./agent-stdin-hold.ts`). Everything here is injectable / pure so the
 * orchestration is unit-testable without a cluster, a real agent binary, or a
 * real network: the spawn seam (`AgentSpawn`/`AgentProc`), the NDJSON event
 * serializer (`formatEventLine`/`emitSystem`), the steering-inbox drain
 * (`drainInbox`), the byte-stream line reader (`readLines`), and the default
 * `Bun.spawn` / `fetch` implementations.
 */

import type {
	AdapterRuntimeEvent,
	AdapterSpawnContext,
	AgentFrontmatter,
	SpawnCommand,
	SteeringMessage,
} from "../adapters/index.ts";
import type { Message } from "../contract.ts";
import type { AgentEntrypointEnv } from "./agent-entrypoint.ts";
import { WARREN_ORIGIN_MARKER } from "./log-parse.ts";

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
 *
 * Every line also carries `origin: "warren"` (warren-6646): THIS emitter is
 * warren's in-pod event pipeline, so what it writes — its own system diagnostics
 * AND the transcript events the runtime's structured parser classified — is
 * warren-authored. A line that lands in the pod log without going through here
 * (an agent writing NDJSON at the entrypoint's stdout fd) lacks the marker and
 * `toNormalizedEvent` strips its system-stream authority.
 */

/**
 * The structural event shape this pipeline serializes. A parser-emitted
 * {@link AdapterRuntimeEvent} satisfies it; so do the entrypoint's own
 * system diagnostics (`oom_killed`, `stdin_hold_timeout`, …), whose kinds
 * sit outside the adapters' closed event-kind union.
 */
export interface PodLogEvent {
	readonly kind: string;
	readonly stream: string;
	readonly payload: unknown;
	readonly ts?: Date;
}

export function formatEventLine(ev: PodLogEvent): string {
	return JSON.stringify({
		kind: ev.kind,
		stream: ev.stream,
		payload: ev.payload,
		ts: (ev.ts ?? new Date()).toISOString(),
		origin: WARREN_ORIGIN_MARKER,
	});
}

/** Emit a `state`/system diagnostic event onto the NDJSON stream. */
export function emitSystem(out: (line: string) => void, kind: string, payload: unknown): void {
	out(formatEventLine({ kind, stream: "system", payload }));
}

/* -------------------------------------------------------------------------- */
/* Injectable seams (testable without a cluster / real agent / real network)   */
/* -------------------------------------------------------------------------- */

/** A spawned agent process — the subset of `Bun.spawn`'s result the loop drives. */
export interface AgentProc {
	stdout: ReadableStream<Uint8Array>;
	stderr: ReadableStream<Uint8Array>;
	exited: Promise<number>;
	/**
	 * Close the child's stdin write side. Idempotent. Only meaningful when the
	 * command carried `holdStdin: true` — otherwise stdin was already ended at
	 * spawn time and this is a no-op. Mirrors burrow `SpawnResult.closeStdin`.
	 */
	closeStdin?: () => Promise<void>;
	/**
	 * Write more bytes to the still-open stdin without closing it. Only meaningful
	 * under `holdStdin: true`; used by the mid-run steering loop to inject inbox
	 * messages a stdin-RPC runtime (pi) consumes live. Mirrors burrow
	 * `SpawnResult.writeStdin`.
	 */
	writeStdin?: (chunk: string) => Promise<void>;
	/** Force-kill the child (the stdin-hold watchdog's backstop). */
	kill?: () => void;
	/**
	 * The child's OS pid. Under the uid split the entrypoint routes `kill`
	 * through a setpriv cross-uid helper that needs it (warren-950d,
	 * `./agent-uid-drop.ts` `withCrossUidKill`); absent (a test double) the
	 * direct `kill` stays in place.
	 */
	pid?: number;
}

/**
 * The spawn command the entrypoint hands the spawn seam: the adapter-rendered
 * argv/stdin plus the k8s-side `holdStdin` directive (the entrypoint sets it
 * for a runtime that declares `shouldCloseStdinOnEvent`, warren-7a43).
 */
export interface AgentSpawnCommand extends SpawnCommand {
	readonly holdStdin?: boolean;
}

export type AgentSpawn = (
	command: AgentSpawnCommand,
	opts: { cwd: string },
) => AgentProc | Promise<AgentProc>;

export interface AgentInboxHttp {
	get: (url: string, token: string) => Promise<{ status: number; body: unknown }>;
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
 * Narrow a warren seam `Message` to the {@link SteeringMessage} shape the
 * adapters' steering encoders read (`body` + `priority` only). The seam row
 * already satisfies it structurally; the explicit pick documents exactly
 * which columns cross into the harness layer.
 */
function toSteeringMessage(msg: Message): SteeringMessage {
	return { body: msg.body, priority: msg.priority };
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
): Promise<SteeringMessage[]> {
	if (env.apiUrl === undefined || env.apiToken === undefined) return [];
	try {
		const res = await http.get(`${env.apiUrl}/runs/${env.runId}/inbox`, env.apiToken);
		if (res.status !== 200) return [];
		const messages = extractInboxMessages(res.body);
		if (messages.length > 0)
			log(`agent-entrypoint: drained ${messages.length} steering message(s)`);
		return messages.map(toSteeringMessage);
	} catch (err) {
		log(`agent-entrypoint: inbox drain failed (${err instanceof Error ? err.message : err})`);
		return [];
	}
}

/* -------------------------------------------------------------------------- */
/* Adapter spawn context                                                       */
/* -------------------------------------------------------------------------- */

/**
 * Build the {@link AdapterSpawnContext} the adapter's `buildSpawnCommand`
 * consumes: run id, prompt, the drained steering batch, the workspace path,
 * and the optional frontmatter override (parsed off `WARREN_AGENT_METADATA`;
 * a malformed value already failed open to `undefined` in
 * `parseAgentFrontmatter`, so the assertion only re-labels the shape).
 */
export function buildSpawnContext(
	env: AgentEntrypointEnv,
	pendingMessages: readonly SteeringMessage[],
): AdapterSpawnContext {
	return {
		runId: env.runId,
		prompt: env.prompt,
		pendingMessages,
		workspacePath: env.workspacePath,
		...(env.frontmatter !== undefined
			? { frontmatter: env.frontmatter as unknown as AgentFrontmatter }
			: {}),
	};
}

/* -------------------------------------------------------------------------- */
/* Line reader over a byte stream                                              */
/* -------------------------------------------------------------------------- */

export async function* readLines(
	stream: ReadableStream<Uint8Array>,
): AsyncGenerator<string, void, void> {
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

/** Abortable sleep — resolves after `ms` or immediately when `signal` aborts. */
export function sleepUntil(ms: number, signal: AbortSignal): Promise<void> {
	if (signal.aborted) return Promise.resolve();
	return new Promise((resolve) => {
		const onAbort = (): void => {
			clearTimeout(timer);
			resolve();
		};
		const timer = setTimeout(() => {
			signal.removeEventListener("abort", onAbort);
			resolve();
		}, ms);
		signal.addEventListener("abort", onAbort, { once: true });
	});
}

/* -------------------------------------------------------------------------- */
/* Default spawn (Bun) + default HTTP (fetch)                                  */
/* -------------------------------------------------------------------------- */

/**
 * Harness-only env keys the AGENT child must never inherit (warren-6016). The
 * push credential rides the agent CONTAINER env (from the `warren-git-token`
 * Secret) so the finalize/salvage window can authenticate a rescue push even
 * when no reap intent ever parked one — but the blast-radius rule "a
 * compromised agent never holds the push token" still holds for the agent
 * process itself, so the entrypoint spawns the agent with these scrubbed. A
 * runtime's own `command.env` may still set them explicitly (warren-controlled).
 */
const AGENT_SCRUBBED_ENV_KEYS: readonly string[] = ["WARREN_GIT_TOKEN", "GITHUB_TOKEN"];

/**
 * The env the agent child spawns with: the inherited (container) env minus the
 * harness-only credentials, plus the runtime's own `command.env` overrides.
 * Pure so the scrub is unit-testable without spawning a process.
 */
export function agentChildEnv(
	inherited: Record<string, string | undefined>,
	commandEnv?: Record<string, string>,
): Record<string, string> {
	const env: Record<string, string> = {};
	for (const [key, value] of Object.entries(inherited)) {
		if (value === undefined || AGENT_SCRUBBED_ENV_KEYS.includes(key)) continue;
		env[key] = value;
	}
	for (const [key, value] of Object.entries(commandEnv ?? {})) env[key] = value;
	return env;
}

export const defaultSpawn: AgentSpawn = async (command, opts) => {
	const proc = Bun.spawn(command.argv, {
		cwd: opts.cwd,
		env: agentChildEnv(process.env, command.env),
		stdin: "pipe",
		stdout: "pipe",
		stderr: "pipe",
	});
	const holdStdin = command.holdStdin ?? false;
	// Two stdin regimes (design mirrors burrow `provider/local/sandbox.ts`):
	//   • batch (claude-code): write the encoded prompt, then END —
	//     they read stdin to EOF to flush their final output.
	//   • stdin-hold (pi): write the prompt then FLUSH but leave the write side
	//     open. `sink.write()` alone only buffers in bun's userland (burrow-029d),
	//     so an explicit flush is required or pi blocks forever on its first read.
	//     The write side stays open until `closeStdin()` fires on the runtime's
	//     terminal event (or the watchdog trips).
	if (typeof command.stdin === "string") {
		proc.stdin.write(command.stdin);
		if (holdStdin) await proc.stdin.flush();
		else await proc.stdin.end();
	} else if (!holdStdin) {
		proc.stdin.end();
	}

	let stdinClosed = false;
	const closeStdin = async (): Promise<void> => {
		if (stdinClosed) return;
		stdinClosed = true;
		await proc.stdin.end();
	};
	const writeStdin = async (chunk: string): Promise<void> => {
		if (stdinClosed) throw new Error("agent-entrypoint: child stdin already closed");
		proc.stdin.write(chunk);
		await proc.stdin.flush();
	};
	return {
		stdout: proc.stdout,
		stderr: proc.stderr,
		exited: proc.exited,
		closeStdin,
		writeStdin,
		kill: () => proc.kill(),
		pid: proc.pid,
	};
};

export const defaultHttp: AgentInboxHttp = {
	get: async (url, token) => {
		const res = await fetch(url, { headers: { authorization: `Bearer ${token}` } });
		const body = res.status === 200 ? await res.json() : null;
		return { status: res.status, body };
	},
};
