import { describe, expect, test } from "bun:test";
import type { AgentRuntime, RuntimeEvent, SpawnCommand } from "@os-eco/burrow-cli";
import {
	type AgentEnvSource,
	parseAgentEntrypointEnv,
	parseAgentFrontmatter,
	runAgent,
	runAgentEntrypoint,
} from "./agent-entrypoint.ts";
import {
	type AgentInboxHttp,
	type AgentSpawn,
	drainInbox,
	extractInboxMessages,
	formatEventLine,
} from "./agent-io.ts";
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

function stubSpawn(opts: {
	stdout?: string;
	stderr?: string;
	exitCode?: number;
	onCommand?: (command: SpawnCommand, o: { cwd: string }) => void;
}): AgentSpawn {
	return (command, o) => {
		opts.onCommand?.(command, o);
		return {
			stdout: streamOf(opts.stdout ?? ""),
			stderr: streamOf(opts.stderr ?? ""),
			exited: Promise.resolve(opts.exitCode ?? 0),
		};
	};
}

/**
 * A minimal runtime that echoes the prompt + pending steering bodies into stdin
 * (so a test can assert inbox delivery reached the spawn command) and parses
 * each stdout line into one `text` event.
 */
const echoRuntime: AgentRuntime = {
	id: "test-runtime",
	displayName: "Test Runtime",
	supportsResume: false,
	installCheck: async () => ({ installed: true }),
	buildSpawnCommand: (ctx): SpawnCommand => ({
		argv: ["test-agent"],
		stdin: [ctx.prompt, ...ctx.pendingMessages.map((m) => m.body)].join("\n"),
	}),
	parseEvents: (line): RuntimeEvent[] => [{ kind: "text", stream: "stdout", payload: { line } }],
};

function stubRegistry(rt: AgentRuntime = echoRuntime): {
	get(id: string): AgentRuntime | undefined;
} {
	return { get: (id) => (id === rt.id ? rt : undefined) };
}

function baseEnv(overrides: Partial<Record<string, string>> = {}): AgentEnvSource {
	return {
		WARREN_RUN_ID: "run_01tdf3a0wg5e",
		WARREN_AGENT_RUNTIME: "test-runtime",
		WARREN_PROMPT: "do the thing",
		WARREN_WORKSPACE_PATH: "/workspace",
		WARREN_API_URL: "http://warren.warren.svc.cluster.local:8080",
		WARREN_API_TOKEN: "tok",
		...overrides,
	};
}

function collector(): { out: (line: string) => void; lines: string[] } {
	const lines: string[] = [];
	return { out: (line) => lines.push(line), lines };
}

const silent = (): void => {};

/* -------------------------------------------------------------------------- */
/* Env parsing                                                                 */
/* -------------------------------------------------------------------------- */

describe("parseAgentEntrypointEnv", () => {
	test("parses the full contract", () => {
		const env = parseAgentEntrypointEnv(
			baseEnv({ WARREN_AGENT_METADATA: JSON.stringify({ frontmatter: { model: "opus" } }) }),
		);
		expect(env.runId).toBe("run_01tdf3a0wg5e");
		expect(env.runtimeId).toBe("test-runtime");
		expect(env.prompt).toBe("do the thing");
		expect(env.workspacePath).toBe("/workspace");
		expect(env.apiUrl).toBe("http://warren.warren.svc.cluster.local:8080");
		expect(env.apiToken).toBe("tok");
		expect(env.frontmatter).toEqual({ model: "opus" });
		expect(env.inboxPollIntervalMs).toBe(5_000);
	});

	test("strips a trailing slash off the api url and defaults the workspace", () => {
		const env = parseAgentEntrypointEnv({
			WARREN_RUN_ID: "run_x",
			WARREN_AGENT_RUNTIME: "claude-code",
			WARREN_API_URL: "http://warren:8080/",
		});
		expect(env.apiUrl).toBe("http://warren:8080");
		expect(env.workspacePath).toBe("/workspace");
		expect(env.prompt).toBe("");
		expect(env.apiToken).toBeUndefined();
	});

	test("throws on a missing required var", () => {
		expect(() => parseAgentEntrypointEnv({ WARREN_AGENT_RUNTIME: "claude-code" })).toThrow(
			/WARREN_RUN_ID/,
		);
	});
});

describe("parseAgentFrontmatter", () => {
	test("extracts the frontmatter block", () => {
		expect(
			parseAgentFrontmatter(JSON.stringify({ frontmatter: { provider: "anthropic" } })),
		).toEqual({ provider: "anthropic" });
	});
	test("returns undefined for malformed / absent / non-object", () => {
		expect(parseAgentFrontmatter(undefined)).toBeUndefined();
		expect(parseAgentFrontmatter("not json")).toBeUndefined();
		expect(parseAgentFrontmatter(JSON.stringify({ frontmatter: 5 }))).toBeUndefined();
		expect(parseAgentFrontmatter(JSON.stringify({ other: 1 }))).toBeUndefined();
	});
});

/* -------------------------------------------------------------------------- */
/* Event emission — round-trip through the pod-log parser                       */
/* -------------------------------------------------------------------------- */

describe("formatEventLine ⇄ log-parse round-trip", () => {
	test("a bare NDJSON line re-parses to the same normalized event", () => {
		const ev: RuntimeEvent = {
			kind: "state_change",
			stream: "system",
			payload: { type: "result", is_error: false, result: "done" },
			ts: new Date("2026-07-13T00:00:00.000Z"),
		};
		const line = formatEventLine(ev);
		const { kubeletTs, content } = splitTimestamp(line);
		const parsed = tryParse(content);
		expect(parsed).not.toBeNull();
		const normalized = toNormalizedEvent(parsed as Record<string, unknown>, 7, kubeletTs);
		expect(normalized.kind).toBe("state_change");
		expect(normalized.stream).toBe("system");
		expect(normalized.payload).toEqual({ type: "result", is_error: false, result: "done" });
		expect(normalized.ts).toBe("2026-07-13T00:00:00.000Z");
		expect(normalized.seq).toBe(7);
	});

	test("survives a kubelet timestamp prefix (as the real pod log carries)", () => {
		const line = formatEventLine({
			kind: "text",
			stream: "stdout",
			payload: { text: "hello world" },
			ts: new Date("2026-07-13T00:00:01.000Z"),
		});
		const kubeletLine = `2026-07-13T00:00:01.500000000Z ${line}`;
		const { kubeletTs, content } = splitTimestamp(kubeletLine);
		expect(kubeletTs).toBe("2026-07-13T00:00:01.500000000Z");
		const parsed = tryParse(content);
		const normalized = toNormalizedEvent(parsed as Record<string, unknown>, 1, kubeletTs);
		expect(normalized.payload).toEqual({ text: "hello world" });
		// The agent's own ts wins over the kubelet stamp.
		expect(normalized.ts).toBe("2026-07-13T00:00:01.000Z");
	});
});

/* -------------------------------------------------------------------------- */
/* Inbox drain                                                                 */
/* -------------------------------------------------------------------------- */

describe("extractInboxMessages", () => {
	test("returns the messages array or [] on a malformed body", () => {
		expect(extractInboxMessages({ messages: [{ id: "m1" }] })).toEqual([{ id: "m1" }] as never);
		expect(extractInboxMessages({})).toEqual([]);
		expect(extractInboxMessages(null)).toEqual([]);
		expect(extractInboxMessages({ messages: "x" })).toEqual([]);
	});
});

describe("drainInbox", () => {
	test("maps claimed messages to burrow messages (body + priority)", async () => {
		const http: AgentInboxHttp = {
			get: async (url, token) => {
				expect(url).toBe("http://warren:8080/runs/run_x/inbox");
				expect(token).toBe("tok");
				return {
					status: 200,
					body: {
						messages: [
							{
								id: "msg_1",
								runId: "run_x",
								body: "steer me",
								priority: "urgent",
								fromActor: "op",
								state: "delivered",
								createdAt: "t",
								deliveredAt: "t",
							},
						],
					},
				};
			},
		};
		const env = parseAgentEntrypointEnv(
			baseEnv({ WARREN_RUN_ID: "run_x", WARREN_API_URL: "http://warren:8080" }),
		);
		const msgs = await drainInbox(env, http, silent);
		expect(msgs).toHaveLength(1);
		expect(msgs[0]?.body).toBe("steer me");
		expect(msgs[0]?.priority).toBe("urgent");
	});

	test("returns [] with no callback credential", async () => {
		const env = parseAgentEntrypointEnv({
			WARREN_RUN_ID: "run_x",
			WARREN_AGENT_RUNTIME: "test-runtime",
		});
		const http: AgentInboxHttp = {
			get: async () => {
				throw new Error("should not be called");
			},
		};
		expect(await drainInbox(env, http, silent)).toEqual([]);
	});

	test("returns [] on a non-200", async () => {
		const env = parseAgentEntrypointEnv(baseEnv());
		const http: AgentInboxHttp = { get: async () => ({ status: 404, body: null }) };
		expect(await drainInbox(env, http, silent)).toEqual([]);
	});
});

/* -------------------------------------------------------------------------- */
/* runAgent orchestration                                                      */
/* -------------------------------------------------------------------------- */

describe("runAgent", () => {
	test("streams parsed stdout lines as NDJSON and maps exit 0 → succeeded", async () => {
		const { out, lines } = collector();
		const result = await runAgent(parseAgentEntrypointEnv(baseEnv()), {
			registry: stubRegistry(),
			spawn: stubSpawn({ stdout: "alpha\nbeta\n", exitCode: 0 }),
			http: { get: async () => ({ status: 200, body: { messages: [] } }) },
			out,
			log: silent,
			skipFinalize: true,
		});
		expect(result).toEqual({ exitCode: 0, phase: "succeeded" });
		const payloads = lines.map(
			(l) => (JSON.parse(l) as { payload: { line: string } }).payload.line,
		);
		expect(payloads).toEqual(["alpha", "beta"]);
	});

	test("delivers drained inbox messages into the spawn command's stdin", async () => {
		let captured: SpawnCommand | undefined;
		const http: AgentInboxHttp = {
			get: async () => ({
				status: 200,
				body: {
					messages: [
						{
							id: "m1",
							runId: null,
							body: "PIVOT NOW",
							priority: "urgent",
							fromActor: "op",
							state: "delivered",
							createdAt: "t",
							deliveredAt: "t",
						},
					],
				},
			}),
		};
		await runAgent(parseAgentEntrypointEnv(baseEnv()), {
			registry: stubRegistry(),
			spawn: stubSpawn({ onCommand: (c) => (captured = c) }),
			http,
			out: silent,
			log: silent,
			skipFinalize: true,
		});
		expect(typeof captured?.stdin).toBe("string");
		expect(captured?.stdin).toContain("do the thing");
		expect(captured?.stdin).toContain("PIVOT NOW");
	});

	test("maps a non-zero exit to failed and emits an oom event on 137", async () => {
		const { out, lines } = collector();
		const result = await runAgent(parseAgentEntrypointEnv(baseEnv()), {
			registry: stubRegistry(),
			spawn: stubSpawn({ exitCode: 137 }),
			http: { get: async () => ({ status: 200, body: { messages: [] } }) },
			out,
			log: silent,
			skipFinalize: true,
		});
		expect(result).toEqual({ exitCode: 137, phase: "failed" });
		const kinds = lines.map((l) => (JSON.parse(l) as { kind: string }).kind);
		expect(kinds).toContain("oom_killed");
	});

	test("routes stderr lines to stderr-stream events", async () => {
		const { out, lines } = collector();
		await runAgent(parseAgentEntrypointEnv(baseEnv()), {
			registry: stubRegistry(),
			spawn: stubSpawn({ stderr: "boom\n", exitCode: 0 }),
			http: { get: async () => ({ status: 200, body: { messages: [] } }) },
			out,
			log: silent,
			skipFinalize: true,
		});
		const stderrEvents = lines
			.map((l) => JSON.parse(l) as { kind: string; stream: string; payload: { line?: string } })
			.filter((e) => e.stream === "stderr");
		expect(stderrEvents).toHaveLength(1);
		expect(stderrEvents[0]?.payload.line).toBe("boom");
	});

	test("fails cleanly when the runtime is not registered", async () => {
		const { out, lines } = collector();
		const result = await runAgent(
			parseAgentEntrypointEnv(baseEnv({ WARREN_AGENT_RUNTIME: "nope" })),
			{
				registry: stubRegistry(),
				spawn: stubSpawn({}),
				http: { get: async () => ({ status: 200, body: { messages: [] } }) },
				out,
				log: silent,
			},
		);
		expect(result).toEqual({ exitCode: 1, phase: "failed" });
		expect(lines.some((l) => l.includes("not registered"))).toBe(true);
	});
});

describe("runAgentEntrypoint", () => {
	test("returns the agent's exit code and skips finalize without a credential", async () => {
		const code = await runAgentEntrypoint(
			{ WARREN_RUN_ID: "run_x", WARREN_AGENT_RUNTIME: "test-runtime", WARREN_PROMPT: "p" },
			{
				registry: stubRegistry(),
				spawn: stubSpawn({ exitCode: 3 }),
				out: silent,
				log: silent,
			},
		);
		expect(code).toBe(3);
	});
});
