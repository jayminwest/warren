import { describe, expect, test } from "bun:test";
import type { RuntimeId } from "../../core/wire.ts";
import type { AdapterRuntimeEvent, AgentRuntimeAdapter, SpawnCommand } from "../adapters/index.ts";
import {
	type AgentEnvSource,
	EXIT_FINALIZE_NOT_DELIVERED,
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
import type { FinalizeEntrypointDeps } from "./finalize-entrypoint.ts";
import { IN_POD_FINALIZE_WIRE_VERSION } from "./finalize-wire.ts";
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
 * A minimal adapter that echoes the prompt + pending steering bodies into stdin
 * (so a test can assert inbox delivery reached the spawn command) and parses
 * each stdout line into one `text` event.
 */
const echoRuntime: AgentRuntimeAdapter = {
	runtimeId: "test-runtime" as RuntimeId,
	harnessStatePrefixes: [],
	terminalErrorEnvelopeTypes: [],
	buildSpawnCommand: (ctx): SpawnCommand => ({
		argv: ["test-agent"],
		stdin: [ctx.prompt, ...ctx.pendingMessages.map((m) => m.body)].join("\n"),
	}),
	parseEvents: (line): AdapterRuntimeEvent[] => [
		{ kind: "text", stream: "stdout", payload: { line } },
	],
};

function stubRegistry(rt: AgentRuntimeAdapter = echoRuntime): {
	get(id: string): AgentRuntimeAdapter | undefined;
} {
	return { get: (id) => (id === rt.runtimeId ? rt : undefined) };
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
		const ev: AdapterRuntimeEvent = {
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
	test("maps claimed messages to steering messages (body + priority)", async () => {
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
		expect(result).toEqual({ exitCode: 0, phase: "succeeded", cancelledViaSignal: false });
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
		expect(result).toEqual({ exitCode: 137, phase: "failed", cancelledViaSignal: false });
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
		expect(result).toEqual({ exitCode: 1, phase: "failed", cancelledViaSignal: false });
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

	/* warren-4d6a — finalize-not-delivered exit-code behavior ------------------ */

	/** Finalize seams where warren never parks an intent (polls hit the deadline). */
	function finalizeNeverDelivers(): {
		finalize: FinalizeEntrypointDeps;
		env: Record<string, string>;
	} {
		let clock = 0;
		return {
			env: { WARREN_FINALIZE_MAX_WAIT_MS: "10", WARREN_FINALIZE_EARLY_SALVAGE_MS: "0" },
			finalize: {
				http: {
					get: async () => ({ status: 200, body: { intent: null } }),
					post: async () => ({ status: 200 }),
				},
				git: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
				fs: {
					readFile: async () => {
						throw new Error("ENOENT");
					},
					readdir: async () => {
						throw new Error("ENOTDIR");
					},
				},
				sleep: async () => {
					clock += 100; // each poll sleep jumps past the 10ms maxWait
				},
				now: () => clock,
				readFileBytes: async () => new TextEncoder().encode("bundle"),
				rm: async () => {},
				log: silent,
			},
		};
	}

	function finalizeDelivers(): FinalizeEntrypointDeps {
		return {
			http: {
				get: async () => ({
					status: 200,
					body: {
						intent: {
							version: IN_POD_FINALIZE_WIRE_VERSION,
							attemptId: "fin_abcdefghjkmn",
							branch: "warren/run_x",
							push: false,
							artifacts: [],
							commit: [],
						},
					},
				}),
				post: async () => ({ status: 200 }),
			},
			git: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
			fs: {
				readFile: async () => {
					throw new Error("ENOENT");
				},
				readdir: async () => {
					throw new Error("ENOTDIR");
				},
			},
			sleep: async () => {},
			now: () => 0,
			log: silent,
		};
	}

	test("agent ok + finalize delivered returns the agent's exit code", async () => {
		const code = await runAgentEntrypoint(baseEnv(), {
			registry: stubRegistry(),
			spawn: stubSpawn({ exitCode: 0 }),
			http: { get: async () => ({ status: 200, body: { messages: [] } }) },
			out: silent,
			log: silent,
			finalize: finalizeDelivers(),
		});
		expect(code).toBe(0);
	});

	test("agent ok + finalize gave up with a credential present exits EXIT_FINALIZE_NOT_DELIVERED", async () => {
		const { finalize, env } = finalizeNeverDelivers();
		const code = await runAgentEntrypoint(baseEnv(env), {
			registry: stubRegistry(),
			spawn: stubSpawn({ exitCode: 0 }),
			http: { get: async () => ({ status: 200, body: { messages: [] } }) },
			out: silent,
			log: silent,
			finalize,
		});
		expect(code).toBe(EXIT_FINALIZE_NOT_DELIVERED);
		expect(code).not.toBe(0);
	});

	test("agent failed keeps its own exit code even when finalize never delivers", async () => {
		const { finalize, env } = finalizeNeverDelivers();
		const code = await runAgentEntrypoint(baseEnv(env), {
			registry: stubRegistry(),
			spawn: stubSpawn({ exitCode: 3 }),
			http: { get: async () => ({ status: 200, body: { messages: [] } }) },
			out: silent,
			log: silent,
			finalize,
		});
		expect(code).toBe(3);
	});

	test("no callback credential keeps the agent's exit code unchanged", async () => {
		const code = await runAgentEntrypoint(
			{ WARREN_RUN_ID: "run_x", WARREN_AGENT_RUNTIME: "test-runtime", WARREN_PROMPT: "p" },
			{
				registry: stubRegistry(),
				spawn: stubSpawn({ exitCode: 0 }),
				out: silent,
				log: silent,
			},
		);
		expect(code).toBe(0);
	});
});
