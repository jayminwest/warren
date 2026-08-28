/**
 * warren-9a4a — the synthesized terminal envelope. When the agent exits without
 * ever emitting a terminal envelope (`result` / `agent_end` on the
 * `state_change`/`system` carrier) — the systematic shape of a stdin-held pi
 * run killed by the idle watchdog — the entrypoint synthesizes the missing
 * `agent_end` post-exit so the reap pipeline terminalizes the run instead of
 * hanging `running` while the pod polls finalize-intent forever. Sibling of
 * `agent-entrypoint.test.ts` (which sits near the 500-line check:size budget).
 */

import { describe, expect, test } from "bun:test";
import type { RuntimeId } from "../../core/wire.ts";
import { detectRuntimeTerminal } from "../../runs/stream/terminal-detect.ts";
import type { AdapterRuntimeEvent, AgentRuntimeAdapter, SpawnCommand } from "../adapters/index.ts";
import {
	type AgentEnvSource,
	DEFAULT_STDIN_HOLD_KILL_GRACE_MS,
	parseAgentEntrypointEnv,
	runAgent,
} from "./agent-entrypoint.ts";
import type { AgentInboxHttp, AgentProc, AgentSpawn } from "./agent-io.ts";
import { splitTimestamp, toNormalizedEvent, tryParse } from "./log-parse.ts";

/* -------------------------------------------------------------------------- */
/* Fixtures                                                                    */
/* -------------------------------------------------------------------------- */

function streamOf(text: string): ReadableStream<Uint8Array> {
	return new ReadableStream({
		start(controller) {
			if (text.length > 0) controller.enqueue(new TextEncoder().encode(text));
			controller.close();
		},
	});
}

function baseEnv(overrides: Partial<Record<string, string>> = {}): AgentEnvSource {
	return {
		WARREN_RUN_ID: "run_01tdf3a0wg5e",
		WARREN_AGENT_RUNTIME: "test-runtime",
		WARREN_PROMPT: "do the thing",
		WARREN_WORKSPACE_PATH: "/workspace",
		...overrides,
	};
}

function collector(): { out: (line: string) => void; lines: string[] } {
	const lines: string[] = [];
	return { out: (line) => lines.push(line), lines };
}

const silent = (): void => {};

const emptyInbox: AgentInboxHttp = { get: async () => ({ status: 200, body: { messages: [] } }) };

/** A batch adapter: one stdout line → one `text` event, never a terminal. */
const textOnlyRuntime: AgentRuntimeAdapter = {
	runtimeId: "test-runtime" as RuntimeId,
	harnessStatePrefixes: [],
	terminalErrorEnvelopeTypes: [],
	buildSpawnCommand: (ctx): SpawnCommand => ({ argv: ["test-agent"], stdin: ctx.prompt }),
	parseEvents: (line): AdapterRuntimeEvent[] => [
		{ kind: "text", stream: "stdout", payload: { line } },
	],
};

/** An adapter whose parser maps a `{type}` JSON line to the matching envelope. */
const envelopeRuntime: AgentRuntimeAdapter = {
	...textOnlyRuntime,
	parseEvents: (line): AdapterRuntimeEvent[] => {
		const type = (JSON.parse(line) as { type: string }).type;
		return type === "agent_end"
			? [{ kind: "state_change", stream: "system", payload: { type } }]
			: [{ kind: "text", stream: "stdout", payload: { type } }];
	},
	shouldCloseStdinOnEvent: (ev): boolean => {
		if (ev.kind !== "state_change") return false;
		const payload = ev.payload as { type?: unknown } | null | undefined;
		return !!payload && payload.type === "agent_end";
	},
};

function stubRegistry(rt: AgentRuntimeAdapter): {
	get(id: string): AgentRuntimeAdapter | undefined;
} {
	return { get: (id) => (id === rt.runtimeId ? rt : undefined) };
}

function stubSpawn(opts: { stdout?: string; exitCode?: number }): AgentSpawn {
	return () => ({
		stdout: streamOf(opts.stdout ?? ""),
		stderr: streamOf(""),
		exited: Promise.resolve(opts.exitCode ?? 0),
	});
}

interface ParsedLine {
	kind: string;
	stream: string;
	origin: string;
	payload: Record<string, unknown>;
}

function parseLines(lines: string[]): ParsedLine[] {
	return lines.map((l) => JSON.parse(l) as ParsedLine);
}

function agentEndEnvelopes(lines: string[]): ParsedLine[] {
	return parseLines(lines).filter(
		(l) =>
			l.kind === "state_change" &&
			l.stream === "system" &&
			(l.payload as { type?: unknown }).type === "agent_end",
	);
}

/**
 * Re-parse an emitted NDJSON line through the pod-log parser and run the
 * control plane's own terminal detector over it — the full provenance +
 * carrier path the synthesized envelope must pass (warren-9a4a).
 */
function terminalStateOf(line: string): ReturnType<typeof detectRuntimeTerminal> {
	const { kubeletTs, content } = splitTimestamp(line);
	const parsed = tryParse(content);
	expect(parsed).not.toBeNull();
	const normalized = toNormalizedEvent(parsed as Record<string, unknown>, 1, kubeletTs);
	return detectRuntimeTerminal(normalized);
}

/* -------------------------------------------------------------------------- */
/* Env knob (fix sketch #4)                                                    */
/* -------------------------------------------------------------------------- */

describe("parseAgentEntrypointEnv · WARREN_AGENT_STDIN_KILL_GRACE_MS", () => {
	test("defaults to the 15s grace when unset", () => {
		const env = parseAgentEntrypointEnv(baseEnv());
		expect(env.stdinHoldKillGraceMs).toBe(DEFAULT_STDIN_HOLD_KILL_GRACE_MS);
		expect(env.stdinHoldKillGraceMs).toBe(15_000);
	});

	test("parses an override, including the 0 kill-immediately sentinel", () => {
		expect(
			parseAgentEntrypointEnv(baseEnv({ WARREN_AGENT_STDIN_KILL_GRACE_MS: "25" }))
				.stdinHoldKillGraceMs,
		).toBe(25);
		expect(
			parseAgentEntrypointEnv(baseEnv({ WARREN_AGENT_STDIN_KILL_GRACE_MS: "0" }))
				.stdinHoldKillGraceMs,
		).toBe(0);
	});

	test("falls back on a malformed value", () => {
		expect(
			parseAgentEntrypointEnv(baseEnv({ WARREN_AGENT_STDIN_KILL_GRACE_MS: "soon" }))
				.stdinHoldKillGraceMs,
		).toBe(DEFAULT_STDIN_HOLD_KILL_GRACE_MS);
	});
});

/* -------------------------------------------------------------------------- */
/* Synthesized terminal envelope (fix sketch #1)                               */
/* -------------------------------------------------------------------------- */

describe("runAgent · synthesized terminal envelope", () => {
	test("a non-zero exit with no terminal envelope synthesizes a FAILED agent_end", async () => {
		const { out, lines } = collector();
		const result = await runAgent(parseAgentEntrypointEnv(baseEnv()), {
			registry: stubRegistry(textOnlyRuntime),
			spawn: stubSpawn({ stdout: "alpha\n", exitCode: 3 }),
			http: emptyInbox,
			out,
			log: silent,
			skipFinalize: true,
		});
		expect(result).toEqual({ exitCode: 3, phase: "failed", cancelledViaSignal: false });
		const ends = agentEndEnvelopes(lines);
		expect(ends).toHaveLength(1);
		expect(ends[0]?.payload).toMatchObject({
			type: "agent_end",
			synthesized: true,
			reason: "agent_exit_without_terminal_envelope",
			exitCode: 3,
			stopReason: "error",
		});
		expect(typeof ends[0]?.payload.errorMessage).toBe("string");
		// The synthesized envelope rides the warren origin marker and passes the
		// control plane's own terminal detector as a failure.
		const raw = lines.find((l) => (JSON.parse(l) as ParsedLine).payload.type === "agent_end");
		expect(raw).toBeDefined();
		expect(terminalStateOf(raw as string)).toBe("failed");
	});

	test("a clean exit with no terminal envelope synthesizes a SUCCEEDED agent_end", async () => {
		const { out, lines } = collector();
		const result = await runAgent(parseAgentEntrypointEnv(baseEnv()), {
			registry: stubRegistry(textOnlyRuntime),
			spawn: stubSpawn({ stdout: "alpha\n", exitCode: 0 }),
			http: emptyInbox,
			out,
			log: silent,
			skipFinalize: true,
		});
		expect(result).toEqual({ exitCode: 0, phase: "succeeded", cancelledViaSignal: false });
		const ends = agentEndEnvelopes(lines);
		expect(ends).toHaveLength(1);
		expect(ends[0]?.payload).toMatchObject({
			type: "agent_end",
			synthesized: true,
			reason: "agent_exit_without_terminal_envelope",
			exitCode: 0,
		});
		expect(ends[0]?.payload.stopReason).toBeUndefined();
		expect(ends[0]?.payload.errorMessage).toBeUndefined();
		const raw = lines.find((l) => (JSON.parse(l) as ParsedLine).payload.type === "agent_end");
		expect(terminalStateOf(raw as string)).toBe("succeeded");
	});

	test("no synthesis when the agent emitted its own terminal envelope", async () => {
		const { out, lines } = collector();
		const result = await runAgent(
			parseAgentEntrypointEnv(baseEnv({ WARREN_AGENT_RUNTIME: "test-runtime" })),
			{
				registry: stubRegistry(envelopeRuntime),
				spawn: stubSpawn({
					stdout: `${JSON.stringify({ type: "agent_end" })}\n`,
					exitCode: 0,
				}),
				http: emptyInbox,
				out,
				log: silent,
				skipFinalize: true,
			},
		);
		expect(result).toEqual({ exitCode: 0, phase: "succeeded", cancelledViaSignal: false });
		const ends = agentEndEnvelopes(lines);
		expect(ends).toHaveLength(1);
		expect(ends[0]?.payload.synthesized).toBeUndefined();
	});

	test("the synthesized envelope lands after the oom witness on a 137 kill", async () => {
		const { out, lines } = collector();
		const result = await runAgent(parseAgentEntrypointEnv(baseEnv()), {
			registry: stubRegistry(textOnlyRuntime),
			spawn: stubSpawn({ exitCode: 137 }),
			http: emptyInbox,
			out,
			log: silent,
			skipFinalize: true,
		});
		expect(result.exitCode).toBe(137);
		const kinds = parseLines(lines).map((l) => l.kind);
		expect(kinds).toContain("oom_killed");
		// Every witness precedes the terminal envelope so the bridge sees it all
		// before terminalizing.
		expect(kinds.indexOf("oom_killed")).toBeLessThan(kinds.lastIndexOf("state_change"));
		const ends = agentEndEnvelopes(lines);
		expect(ends).toHaveLength(1);
		expect(ends[0]?.payload.stopReason).toBe("error");
	});
});

/* -------------------------------------------------------------------------- */
/* Watchdog kill path (fix sketches #1 + #2 + #4 together)                     */
/* -------------------------------------------------------------------------- */

describe("runAgent · watchdog kill synthesizes the terminal envelope", () => {
	/**
	 * The exact warren-9a4a live shape: a stdin-held runtime emits one line then
	 * goes silent; the idle watchdog trips, closes stdin (which REJECTS with
	 * EPIPE — the child is already dead, fix sketch #2's fatal unhandled
	 * rejection), and hard-kills after the env-knobbed grace. The run must
	 * resolve AND stream a synthesized terminal envelope.
	 */
	test("stdin-hold timeout + EPIPE close + kill still terminalizes the stream", async () => {
		const { out, lines } = collector();
		let killed = false;
		let closeCalls = 0;
		const enc = new TextEncoder();
		const spawn: AgentSpawn = (): AgentProc => {
			let resolveExit!: (n: number) => void;
			let controller!: ReadableStreamDefaultController<Uint8Array>;
			const exited = new Promise<number>((r) => {
				resolveExit = r;
			});
			const stdout = new ReadableStream<Uint8Array>({
				start(c) {
					controller = c;
					c.enqueue(enc.encode(`${JSON.stringify({ type: "turn_start" })}\n`));
					// Never closes on its own — only the watchdog kill ends the run.
				},
			});
			return {
				stdout,
				stderr: streamOf(""),
				exited,
				closeStdin: async (): Promise<void> => {
					closeCalls += 1;
					throw new Error("write EPIPE");
				},
				kill: (): void => {
					killed = true;
					try {
						controller.close();
					} catch {
						/* already closed */
					}
					resolveExit(137);
				},
			};
		};
		const result = await runAgent(
			parseAgentEntrypointEnv(
				baseEnv({
					WARREN_AGENT_RUNTIME: "test-runtime",
					WARREN_AGENT_STDIN_HOLD_IDLE_MS: "25",
					WARREN_AGENT_STDIN_KILL_GRACE_MS: "25",
				}),
			),
			{
				registry: stubRegistry(envelopeRuntime),
				spawn,
				http: emptyInbox,
				out,
				log: silent,
				skipFinalize: true,
			},
		);
		expect(killed).toBe(true);
		expect(closeCalls).toBeGreaterThan(0);
		expect(result.exitCode).toBe(137);
		const parsed = parseLines(lines);
		expect(parsed.some((l) => l.kind === "stdin_hold_timeout")).toBe(true);
		const ends = agentEndEnvelopes(lines);
		expect(ends).toHaveLength(1);
		expect(ends[0]?.payload).toMatchObject({
			synthesized: true,
			reason: "agent_exit_without_terminal_envelope",
			exitCode: 137,
			stopReason: "error",
		});
	});
});
