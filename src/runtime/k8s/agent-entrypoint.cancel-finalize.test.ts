/**
 * warren-01d5 — a cost-cap (or operator) cancel under K8sProvider deletes the
 * pod, so the kubelet delivers SIGTERM to THIS entrypoint. The old behavior
 * died there: no finalize result, no salvage bundle, and the emptyDir (with
 * every commit) died with the container. The fix latches the signal, stops
 * the agent child, and falls through into `runFinalizeEntrypoint` — so a
 * signal-cancelled pod runs the SAME finalize/salvage path a naturally
 * completing pod does, inside the pod's cancel-grace window.
 *
 * These tests fire the injected `registerCancelSignal` handler to simulate
 * the kubelet SIGTERM and prove the finalize/salvage outcome end to end:
 *
 *   - intent parked in time ⇒ the branch is pushed from the pod and the
 *     `FinalizeResult` is POSTed (identical to natural completion);
 *   - intent never parked (warren mid-reap / unreachable) ⇒ the bounded
 *     `WARREN_CANCEL_FINALIZE_MAX_WAIT_MS` poll gives up and the entrypoint
 *     banks the no-intent salvage bundle before exiting.
 */
import { describe, expect, test } from "bun:test";
import type { RuntimeId } from "../../core/wire.ts";
import type { AgentRuntimeAdapter, SpawnCommand } from "../adapters/index.ts";
import { type AgentEnvSource, runAgentEntrypoint } from "./agent-entrypoint.ts";
import type { AgentSpawn } from "./agent-io.ts";
import type { FinalizeFs, FinalizeGitRunner } from "./finalize-collect.ts";
import type { FinalizeEntrypointDeps, FinalizeHttp } from "./finalize-entrypoint.ts";
import { IN_POD_FINALIZE_WIRE_VERSION, type InPodFinalizeIntent } from "./finalize-wire.ts";

function streamOf(text: string): ReadableStream<Uint8Array> {
	return new ReadableStream({
		start(controller) {
			if (text.length > 0) controller.enqueue(new TextEncoder().encode(text));
			controller.close();
		},
	});
}

/**
 * A spawn seam whose agent never exits on its own; `kill()` resolves `exited`
 * with the kubelet-style kill code (137), mirroring a SIGTERMed agent child.
 */
function hangUntilKilledSpawn(): { spawn: AgentSpawn; killed: () => boolean } {
	let wasKilled = false;
	const spawn: AgentSpawn = () => {
		let resolveExited!: (code: number) => void;
		return {
			stdout: streamOf(""),
			stderr: streamOf(""),
			exited: new Promise<number>((resolve) => {
				resolveExited = resolve;
			}),
			kill: () => {
				wasKilled = true;
				resolveExited(137);
			},
		};
	};
	return { spawn, killed: () => wasKilled };
}

const testRuntime: AgentRuntimeAdapter = {
	runtimeId: "test-runtime" as RuntimeId,
	harnessStatePrefixes: [],
	terminalErrorEnvelopeTypes: [],
	buildSpawnCommand: (ctx): SpawnCommand => ({
		argv: ["test-agent"],
		stdin: ctx.prompt,
	}),
};

const registry = { get: (id: string) => (id === "test-runtime" ? testRuntime : undefined) };

function baseEnv(overrides: Partial<Record<string, string>> = {}): AgentEnvSource {
	return {
		WARREN_RUN_ID: "run_cancelf1ll",
		WARREN_AGENT_RUNTIME: "test-runtime",
		WARREN_PROMPT: "do the thing",
		WARREN_WORKSPACE_PATH: "/workspace",
		WARREN_API_URL: "http://warren.warren.svc.cluster.local:8080",
		WARREN_API_TOKEN: "tok",
		WARREN_BASE_BRANCH: "main",
		WARREN_BRANCH: "warren/run_cancelf1ll",
		...overrides,
	};
}

function intent(over: Partial<InPodFinalizeIntent> = {}): InPodFinalizeIntent {
	return {
		version: IN_POD_FINALIZE_WIRE_VERSION,
		attemptId: "fin_cancel1test",
		branch: "warren/run_cancelf1ll",
		push: true,
		artifacts: [],
		commit: [],
		baseBranch: "main",
		gitToken: "push-tok",
		...over,
	};
}

function fakeGit(): { git: FinalizeGitRunner; calls: string[][] } {
	const calls: string[][] = [];
	const git: FinalizeGitRunner = async (args) => {
		calls.push(args);
		return { exitCode: 0, stdout: "", stderr: "" };
	};
	return { git, calls };
}

const fakeFs: FinalizeFs = {
	readFile: async () => "",
	readdir: async () => [],
};

const silent = (): void => {};

describe("runAgentEntrypoint — signal-driven cancel runs the finalize/salvage path (warren-01d5)", () => {
	test("SIGTERM stops the agent and still pushes the branch + POSTs the finalize result", async () => {
		const { spawn, killed } = hangUntilKilledSpawn();
		let fireCancel: (signal: string) => void = () => {};
		const lines: string[] = [];
		const gets: string[] = [];
		const posts: { url: string; body: unknown }[] = [];
		const { git, calls: gitCalls } = fakeGit();
		const finalize: FinalizeEntrypointDeps = {
			git,
			fs: fakeFs,
			http: {
				get: async (url) => {
					gets.push(url);
					return { status: 200, body: { intent: intent() } };
				},
				post: async (url, _token, body) => {
					posts.push({ url, body });
					return { status: 200 };
				},
			} satisfies FinalizeHttp,
			sleep: async () => {},
			log: silent,
		};

		const running = runAgentEntrypoint(baseEnv(), {
			registry,
			spawn,
			// The inbox drain hits the control plane before the spawn; answer
			// 404 (no inbox) so the entrypoint reaches the spawn immediately.
			http: { get: async () => ({ status: 404, body: null }) },
			out: (line) => lines.push(line),
			log: silent,
			registerCancelSignal: (handler) => {
				fireCancel = handler;
			},
			finalize,
		});
		// Let the spawn land, then simulate the kubelet delivering SIGTERM.
		await new Promise((r) => setTimeout(r, 10));
		fireCancel("SIGTERM");
		const code = await running;

		// The agent child was stopped (the entrypoint did not wait for it).
		expect(killed()).toBe(true);
		expect(code).toBe(137);
		// The cancel is witnessed on the event stream.
		expect(lines.some((l) => l.includes("cancel_requested"))).toBe(true);
		// The finalize step ran: intent polled and the result POSTed — the same
		// outcome a naturally completing pod produces.
		expect(gets.some((u) => u.includes("/runs/run_cancelf1ll/finalize-intent"))).toBe(true);
		expect(posts.some((p) => p.url.includes("/runs/run_cancelf1ll/finalize-result"))).toBe(true);
		// The intent's branch push actually ran against the live workspace.
		expect(gitCalls.some((args) => args[0] === "push")).toBe(true);
	});

	test("no intent in the bounded cancel window ⇒ the salvage bundle is banked before exit", async () => {
		const { spawn } = hangUntilKilledSpawn();
		let fireCancel: (signal: string) => void = () => {};
		const posts: { url: string; body: unknown }[] = [];
		const { git } = fakeGit();
		let clock = 0;
		const finalize: FinalizeEntrypointDeps = {
			git,
			fs: fakeFs,
			http: {
				// Never an intent: warren is mid-reap / restarting.
				get: async () => ({ status: 200, body: { intent: null } }),
				post: async (url, _token, body) => {
					posts.push({ url, body });
					return { status: 200 };
				},
			} satisfies FinalizeHttp,
			// Drive the virtual clock so the bounded maxWait expires instantly.
			sleep: async (ms) => {
				clock += ms;
			},
			now: () => clock,
			readFileBytes: async () => new TextEncoder().encode("bundle-bytes"),
			rm: async () => {},
			log: silent,
		};

		const running = runAgentEntrypoint(baseEnv(), {
			registry,
			spawn,
			// The inbox drain hits the control plane before the spawn; answer
			// 404 (no inbox) so the entrypoint reaches the spawn immediately.
			http: { get: async () => ({ status: 404, body: null }) },
			out: silent,
			log: silent,
			registerCancelSignal: (handler) => {
				fireCancel = handler;
			},
			finalize,
		});
		await new Promise((r) => setTimeout(r, 10));
		fireCancel("SIGTERM");
		await running;

		// The no-intent salvage window captured the work instead of letting the
		// pod (and its emptyDir) die with it.
		expect(posts.some((p) => p.url.includes("/runs/run_cancelf1ll/salvage"))).toBe(true);
	});
});
