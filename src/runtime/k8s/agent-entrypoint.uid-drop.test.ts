import { describe, expect, test } from "bun:test";
import type { RuntimeId } from "../../core/wire.ts";
import type { AdapterRuntimeEvent, AgentRuntimeAdapter, SpawnCommand } from "../adapters/index.ts";
import { type AgentEnvSource, parseAgentEntrypointEnv, runAgent } from "./agent-entrypoint.ts";
import type { AgentSpawn } from "./agent-io.ts";
import { ENV_AGENT_RUN_AS_GID, ENV_AGENT_RUN_AS_UID } from "./agent-uid-drop.ts";

/**
 * warren-cb93: the entrypoint/agent uid split at the `runAgent` seam — the
 * adapter-rendered argv is wrapped in the setpriv drop (after a preflight
 * probe) when the pod env carries the split contract, and passes through
 * untouched when it does not.
 */

function streamOf(text: string): ReadableStream<Uint8Array> {
	return new ReadableStream({
		start(controller) {
			if (text.length > 0) controller.enqueue(new TextEncoder().encode(text));
			controller.close();
		},
	});
}

const echoRuntime: AgentRuntimeAdapter = {
	runtimeId: "test-runtime" as RuntimeId,
	harnessStatePrefixes: [],
	terminalErrorEnvelopeTypes: [],
	buildSpawnCommand: (ctx): SpawnCommand => ({
		argv: ["test-agent", "--flag"],
		stdin: ctx.prompt,
	}),
	parseEvents: (line): AdapterRuntimeEvent[] => [
		{ kind: "text", stream: "stdout", payload: { line } },
	],
};

const registry = { get: (id: string) => (id === echoRuntime.runtimeId ? echoRuntime : undefined) };

function baseEnv(overrides: Record<string, string> = {}): AgentEnvSource {
	return {
		WARREN_RUN_ID: "run_01tdf3a0wg5e",
		WARREN_AGENT_RUNTIME: "test-runtime",
		WARREN_PROMPT: "do the thing",
		...overrides,
	};
}

function recordingSpawn(calls: { argv: readonly string[] }[], exitCode = 0): AgentSpawn {
	return (command) => {
		calls.push({ argv: command.argv });
		return {
			stdout: streamOf(""),
			stderr: streamOf(""),
			exited: Promise.resolve(exitCode),
		};
	};
}

describe("runAgent uid drop (warren-cb93)", () => {
	test("wraps the agent argv in the setpriv drop after a preflight probe", async () => {
		const calls: { argv: readonly string[] }[] = [];
		const result = await runAgent(
			parseAgentEntrypointEnv(
				baseEnv({ [ENV_AGENT_RUN_AS_UID]: "1001", [ENV_AGENT_RUN_AS_GID]: "1000" }),
			),
			{ registry, spawn: recordingSpawn(calls), skipFinalize: true },
		);
		expect(result.phase).toBe("succeeded");
		expect(calls.length).toBe(2);
		// Probe: same drop flags exec'ing `true`.
		expect(calls[0]?.argv).toEqual([
			"setpriv",
			"--reuid=1001",
			"--regid=1000",
			"--clear-groups",
			"--no-new-privs",
			"--inh-caps=-all",
			"--ambient-caps=-all",
			"--bounding-set=-all",
			"--",
			"true",
		]);
		// The real spawn: the adapter argv rides after the `--` separator.
		expect(calls[1]?.argv.slice(0, -2)).toEqual(calls[0]?.argv.slice(0, -1));
		expect(calls[1]?.argv.slice(-2)).toEqual(["test-agent", "--flag"]);
	});

	test("a failed preflight refuses to spawn the agent at the entrypoint's uid", async () => {
		const calls: { argv: readonly string[] }[] = [];
		const lines: string[] = [];
		const result = await runAgent(
			parseAgentEntrypointEnv(baseEnv({ [ENV_AGENT_RUN_AS_UID]: "1001" })),
			{
				registry,
				spawn: recordingSpawn(calls, 1),
				out: (line) => lines.push(line),
				skipFinalize: true,
			},
		);
		expect(result.phase).toBe("failed");
		// Only the probe ran — the agent was never spawned.
		expect(calls.length).toBe(1);
		expect(calls[0]?.argv.at(-1)).toBe("true");
		const errorLine = lines.find((l) => l.includes("uid-drop preflight failed"));
		expect(errorLine).toBeDefined();
	});

	test("no drop env ⇒ the agent argv passes through unwrapped (no probe)", async () => {
		const calls: { argv: readonly string[] }[] = [];
		const result = await runAgent(parseAgentEntrypointEnv(baseEnv()), {
			registry,
			spawn: recordingSpawn(calls),
			skipFinalize: true,
		});
		expect(result.phase).toBe("succeeded");
		expect(calls).toEqual([{ argv: ["test-agent", "--flag"] }]);
	});

	test("a malformed drop env throws (fail closed) rather than running unwrapped", () => {
		expect(() => parseAgentEntrypointEnv(baseEnv({ [ENV_AGENT_RUN_AS_UID]: "root" }))).toThrow(
			ENV_AGENT_RUN_AS_UID,
		);
	});
});
