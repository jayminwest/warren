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
	Burrow,
	Message as BurrowMessage,
	Run,
	RuntimeEvent,
	SpawnCommand,
	SpawnContext,
} from "@os-eco/burrow-cli";
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
export function formatEventLine(ev: RuntimeEvent): string {
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
}

export type AgentSpawn = (
	command: SpawnCommand,
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
export function buildSpawnContext(
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

export const defaultSpawn: AgentSpawn = async (command, opts) => {
	const proc = Bun.spawn(command.argv, {
		cwd: opts.cwd,
		env: { ...process.env, ...(command.env ?? {}) },
		stdin: "pipe",
		stdout: "pipe",
		stderr: "pipe",
	});
	const holdStdin = command.holdStdin ?? false;
	// Two stdin regimes (design mirrors burrow `provider/local/sandbox.ts`):
	//   • batch (claude-code / sapling): write the encoded prompt, then END —
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
	};
};

export const defaultHttp: AgentInboxHttp = {
	get: async (url, token) => {
		const res = await fetch(url, { headers: { authorization: `Bearer ${token}` } });
		const body = res.status === 200 ? await res.json() : null;
		return { status: res.status, body };
	},
};
