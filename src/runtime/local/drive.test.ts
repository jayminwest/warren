import { describe, expect, test } from "bun:test";
import type { ProxyHandle, StartProxyOptions } from "../../sandbox/proxy-server.ts";
import type { SandboxProfile, SpawnCommand, SpawnResult } from "../../sandbox/types.ts";
import type { AgentRuntimeAdapter } from "../adapters/index.ts";
import type { RunSpec } from "../contract.ts";
import { driveLocalRun, readSpecFrontmatter } from "./drive.ts";
import { LocalRunStore } from "./run-store.ts";

const PROFILE: SandboxProfile = {
	workspace: "/tmp/ws",
	home: "/tmp/home",
	readOnlyMounts: [],
	network: "open",
	allowedDomains: [],
	envPassthrough: [],
	setEnv: {},
	toolchainPaths: [],
};

interface FakeProcOptions {
	readonly stdoutLines?: readonly string[];
	readonly stderrLines?: readonly string[];
	readonly exitCode?: number;
	readonly oom?: boolean;
	/** Hold stdout open until closeStdin/cancel (stdin-hold runtimes). */
	readonly holdUntilClose?: boolean;
}

interface FakeProc {
	readonly proc: SpawnResult;
	readonly stdinWrites: string[];
	readonly stdinClosed: () => boolean;
	readonly cancelled: () => boolean;
}

function makeFakeProc(opts: FakeProcOptions = {}): FakeProc {
	let stdoutCtrl!: ReadableStreamDefaultController<Uint8Array>;
	let stderrCtrl!: ReadableStreamDefaultController<Uint8Array>;
	const encoder = new TextEncoder();
	const stdout = new ReadableStream<Uint8Array>({
		start(ctrl) {
			stdoutCtrl = ctrl;
		},
	});
	const stderr = new ReadableStream<Uint8Array>({
		start(ctrl) {
			stderrCtrl = ctrl;
		},
	});
	let resolveExit!: (code: number) => void;
	const exited = new Promise<number>((resolve) => {
		resolveExit = resolve;
	});
	const state = { stdinClosed: false, cancelled: false };
	const stdinWrites: string[] = [];

	const finish = (): void => {
		stdoutCtrl.close();
		stderrCtrl.close();
		resolveExit(opts.exitCode ?? 0);
	};

	for (const line of opts.stdoutLines ?? []) stdoutCtrl.enqueue(encoder.encode(`${line}\n`));
	for (const line of opts.stderrLines ?? []) stderrCtrl.enqueue(encoder.encode(`${line}\n`));

	const proc: SpawnResult = {
		pid: 4242,
		stdout,
		stderr,
		exited,
		cancel: () => {
			state.cancelled = true;
			finish();
		},
		closeStdin: () => {
			state.stdinClosed = true;
			if (opts.holdUntilClose === true) finish();
			return Promise.resolve();
		},
		writeStdin: (chunk: string) => {
			stdinWrites.push(chunk);
			return Promise.resolve();
		},
		...(opts.oom !== undefined ? { oomKilled: () => opts.oom === true } : {}),
	};
	if (opts.holdUntilClose !== true) finish();
	return {
		proc,
		stdinWrites,
		stdinClosed: () => state.stdinClosed,
		cancelled: () => state.cancelled,
	};
}

function makeAdapter(overrides: Partial<AgentRuntimeAdapter> = {}): AgentRuntimeAdapter {
	return {
		runtimeId: "fake",
		harnessStatePrefixes: [],
		terminalErrorEnvelopeTypes: [],
		buildSpawnCommand: () => ({ argv: ["fake"], stdin: "do it" }),
		parseEvents: (line: string) => [
			JSON.parse(line) as { kind: "text"; stream: "stdout"; payload: unknown },
		],
		...overrides,
	} as AgentRuntimeAdapter;
}

function makeSpec(overrides: Partial<RunSpec> = {}): RunSpec {
	return {
		runId: "run_drive1",
		originUrl: "https://github.com/o/r.git",
		branch: "warren/run_drive1",
		baseBranch: "main",
		hostClonePathHint: "/data/projects/x/y",
		runtimeId: "fake",
		prompt: "do it",
		mode: "batch",
		network: "open",
		seedFiles: [],
		env: {},
		...overrides,
	};
}

function makeRecord(store: LocalRunStore, runId = "run_drive1") {
	return store.create({
		runId,
		sandboxId: `local-${runId}`,
		workspacePath: "/tmp/ws",
		homePath: "/tmp/home",
		branch: `warren/${runId}`,
	});
}

function driveWith(
	store: LocalRunStore,
	record: ReturnType<typeof makeRecord>,
	spec: RunSpec,
	fake: FakeProc,
	adapter: AgentRuntimeAdapter,
	extra: {
		midRunInboxPollMs?: number;
		profile?: SandboxProfile;
		spawn?: (profile: SandboxProfile, command: SpawnCommand) => Promise<SpawnResult>;
		startProxy?: (opts: StartProxyOptions) => Promise<ProxyHandle>;
		onWorkspaceReady?: (runId: string, at: Date) => void;
	} = {},
): Promise<void> {
	const { profile = PROFILE, spawn, startProxy, midRunInboxPollMs, onWorkspaceReady } = extra;
	return driveLocalRun(store, record, spec, profile, {
		spawn: spawn ?? (() => Promise.resolve(fake.proc)),
		registry: { get: (id) => (id === adapter.runtimeId ? adapter : undefined) },
		...(startProxy !== undefined ? { startProxy } : {}),
		...(midRunInboxPollMs !== undefined ? { midRunInboxPollMs } : {}),
		...(onWorkspaceReady !== undefined ? { onWorkspaceReady } : {}),
	});
}

function makeFakeProxy(
	port = 51234,
): ProxyHandle & { stopped: () => boolean; stopCalls: () => number } {
	let stopped = false;
	let stopCalls = 0;
	return {
		port,
		url: `http://127.0.0.1:${port}`,
		deniedCount: 0,
		allowedCount: 0,
		stop: async () => {
			stopCalls += 1;
			stopped = true;
		},
		stopped: () => stopped,
		stopCalls: () => stopCalls,
	};
}

describe("driveLocalRun", () => {
	test("fires the workspace-ready signal once after prepareSpawn (warren-7116)", async () => {
		const store = new LocalRunStore();
		const record = makeRecord(store);
		const fake = makeFakeProc({ stdoutLines: [], exitCode: 0 });
		const signals: Array<{ runId: string; at: Date }> = [];
		await driveWith(store, record, makeSpec(), fake, makeAdapter(), {
			onWorkspaceReady: (runId, at) => void signals.push({ runId, at }),
		});
		expect(signals).toHaveLength(1);
		expect(signals[0]?.runId).toBe("run_drive1");
		expect(signals[0]?.at).toBeInstanceOf(Date);
	});

	test("persists parsed stdout events and terminalizes succeeded on exit 0", async () => {
		const store = new LocalRunStore();
		const record = makeRecord(store);
		const fake = makeFakeProc({
			stdoutLines: [
				JSON.stringify({ kind: "text", stream: "stdout", payload: { text: "hi" } }),
				JSON.stringify({ kind: "state_change", stream: "system", payload: { type: "result" } }),
			],
			exitCode: 0,
		});
		await driveWith(store, record, makeSpec(), fake, makeAdapter());
		expect(record.phase).toBe("succeeded");
		expect(record.terminalReason).toBe("completed");
		expect(record.exitCode).toBe(0);
		expect(record.events.map((e) => [e.seq, e.kind])).toEqual([
			[1, "text"],
			[2, "state_change"],
		]);
	});

	test("synthesizes agent_end when the agent exits without a terminal envelope", async () => {
		const store = new LocalRunStore();
		const record = makeRecord(store);
		const fake = makeFakeProc({
			stdoutLines: [JSON.stringify({ kind: "text", stream: "stdout", payload: {} })],
			exitCode: 2,
		});
		await driveWith(store, record, makeSpec(), fake, makeAdapter());
		expect(record.phase).toBe("failed");
		expect(record.terminalReason).toBe("error");
		const synthesized = record.events.at(-1);
		expect(synthesized?.kind).toBe("state_change");
		const payload = synthesized?.payload as Record<string, unknown>;
		expect(payload.type).toBe("agent_end");
		expect(payload.synthesized).toBe(true);
		expect(payload.stopReason).toBe("error");
	});

	test("terminalizes cancelled when cancel won the race", async () => {
		const store = new LocalRunStore();
		const record = makeRecord(store);
		const fake = makeFakeProc({ holdUntilClose: true });
		record.cancelRequested = true;
		fake.proc.cancel();
		await driveWith(store, record, makeSpec(), fake, makeAdapter());
		expect(record.phase).toBe("cancelled");
		expect(record.terminalReason).toBe("cancelled");
	});

	test("surfaces the cgroup OOM kill as an oom_killed terminal", async () => {
		const store = new LocalRunStore();
		const record = makeRecord(store);
		const fake = makeFakeProc({ exitCode: 137, oom: true });
		await driveWith(store, record, makeSpec(), fake, makeAdapter());
		expect(record.phase).toBe("failed");
		expect(record.terminalReason).toBe("oom_killed");
		expect(record.events.some((e) => e.kind === "oom_killed")).toBe(true);
		expect(record.errorMessage).toContain("oom-killed");
	});

	test("persists stderr lines as stderr events", async () => {
		const store = new LocalRunStore();
		const record = makeRecord(store);
		const fake = makeFakeProc({
			stdoutLines: [
				JSON.stringify({ kind: "state_change", stream: "system", payload: { type: "result" } }),
			],
			stderrLines: ["warn: something"],
			exitCode: 0,
		});
		await driveWith(store, record, makeSpec(), fake, makeAdapter());
		const stderr = record.events.find((e) => e.kind === "stderr");
		expect(stderr?.stream).toBe("stderr");
		expect((stderr?.payload as { line: string }).line).toBe("warn: something");
	});

	test("an unregistered runtime terminalizes failed with a witness event", async () => {
		const store = new LocalRunStore();
		const record = makeRecord(store);
		await driveLocalRun(store, record, makeSpec({ runtimeId: "ghost" }), PROFILE, {
			registry: { get: () => undefined },
		});
		expect(record.phase).toBe("failed");
		expect(record.events[0]?.kind).toBe("error");
		expect(record.errorMessage).toContain("ghost");
	});

	test("a spawn rejection terminalizes failed rather than rejecting", async () => {
		const store = new LocalRunStore();
		const record = makeRecord(store);
		await driveLocalRun(store, record, makeSpec(), PROFILE, {
			spawn: () => Promise.reject(new Error("bwrap missing")),
			registry: { get: () => makeAdapter() },
		});
		expect(record.phase).toBe("failed");
		expect(record.errorMessage).toContain("bwrap missing");
		expect(record.events.at(-1)?.kind).toBe("error");
	});

	test("stdin-hold closes stdin on the adapter's trigger event", async () => {
		const store = new LocalRunStore();
		const record = makeRecord(store);
		const adapter = makeAdapter({
			shouldCloseStdinOnEvent: (ev) => (ev.payload as { type?: string }).type === "agent_end",
		});
		const fake = makeFakeProc({
			holdUntilClose: true,
			stdoutLines: [
				JSON.stringify({ kind: "state_change", stream: "system", payload: { type: "agent_end" } }),
			],
			exitCode: 0,
		});
		await driveWith(store, record, makeSpec(), fake, adapter);
		expect(fake.stdinClosed()).toBe(true);
		expect(record.phase).toBe("succeeded");
	});

	test("mid-run steering writes encoded messages to the live stdin", async () => {
		const store = new LocalRunStore();
		const record = makeRecord(store);
		const adapter = makeAdapter({
			shouldCloseStdinOnEvent: () => false,
			encodeSteeringMessage: (msg) => ({ stdin: `steer:${msg.body}\n` }),
		});
		const fake = makeFakeProc({ holdUntilClose: true });
		const done = driveWith(store, record, makeSpec(), fake, adapter, {
			midRunInboxPollMs: 10,
		});
		// Wait for the drive loop to spawn + start the steering poll.
		await new Promise((resolve) => setTimeout(resolve, 50));
		store.sendMessage(record, { body: "hello", priority: "high" });
		await new Promise((resolve) => setTimeout(resolve, 100));
		expect(fake.stdinWrites).toContain("steer:hello\n");
		expect(
			record.events.some(
				(e) => e.kind === "inbox_delivered" && (e.payload as { mode: string }).mode === "mid_run",
			),
		).toBe(true);
		expect(store.listPending(record)).toHaveLength(0);
		fake.proc.cancel();
		await done;
	});

	test("the auto-reply hook writes its response for each parsed event", async () => {
		const store = new LocalRunStore();
		const record = makeRecord(store);
		const adapter = makeAdapter({
			shouldCloseStdinOnEvent: (ev) => (ev.payload as { type?: string }).type === "agent_end",
			autoRespondToEvent: (ev) => (ev.kind === "tool_use" ? { stdin: `decline\n` } : undefined),
		});
		const fake = makeFakeProc({
			holdUntilClose: true,
			stdoutLines: [
				JSON.stringify({ kind: "tool_use", stream: "stdout", payload: {} }),
				JSON.stringify({ kind: "state_change", stream: "system", payload: { type: "agent_end" } }),
			],
		});
		await driveWith(store, record, makeSpec(), fake, adapter);
		expect(fake.stdinWrites).toContain("decline\n");
	});

	test("claims pending inbox rows before spawn so they fold into the turn", async () => {
		const store = new LocalRunStore();
		const record = makeRecord(store);
		store.sendMessage(record, { body: "queued-note" });
		let seenPending: readonly unknown[] = [];
		const adapter = makeAdapter({
			buildSpawnCommand: (ctx) => {
				seenPending = ctx.pendingMessages;
				return { argv: ["fake"] };
			},
		});
		const fake = makeFakeProc({
			stdoutLines: [
				JSON.stringify({ kind: "state_change", stream: "system", payload: { type: "result" } }),
			],
		});
		await driveWith(store, record, makeSpec(), fake, adapter);
		expect(seenPending.map((m) => (m as { body: string }).body)).toEqual(["queued-note"]);
	});

	test("network=restricted arms proxyAddress + HTTP(S)_PROXY and stops the proxy with the run", async () => {
		const store = new LocalRunStore();
		const record = makeRecord(store);
		const fake = makeFakeProc({
			stdoutLines: [
				JSON.stringify({ kind: "state_change", stream: "system", payload: { type: "result" } }),
			],
		});
		const proxy = makeFakeProxy(51999);
		let seenProfile: SandboxProfile | undefined;
		let seenCommand: SpawnCommand | undefined;
		let startOpts: StartProxyOptions | undefined;
		const restricted: SandboxProfile = {
			...PROFILE,
			network: "restricted",
			allowedDomains: ["api.anthropic.com", "github.com"],
		};
		await driveWith(store, record, makeSpec({ network: "restricted" }), fake, makeAdapter(), {
			profile: restricted,
			startProxy: async (opts) => {
				startOpts = opts;
				return proxy;
			},
			spawn: async (profile, command) => {
				seenProfile = profile;
				seenCommand = command;
				return fake.proc;
			},
		});
		expect(startOpts?.allowedDomains).toEqual(["api.anthropic.com", "github.com"]);
		expect(seenProfile?.proxyAddress).toEqual({ host: "127.0.0.1", port: 51999 });
		expect(seenCommand?.env?.HTTP_PROXY).toBe(proxy.url);
		expect(seenCommand?.env?.HTTPS_PROXY).toBe(proxy.url);
		expect(seenCommand?.env?.http_proxy).toBe(proxy.url);
		expect(seenCommand?.env?.https_proxy).toBe(proxy.url);
		expect(seenCommand?.env?.NO_PROXY).toBe("");
		expect(proxy.stopped()).toBe(true);
		expect(proxy.stopCalls()).toBe(1);
		expect(record.phase).toBe("succeeded");
	});

	test("network=open does not start a proxy and leaves the profile untouched", async () => {
		const store = new LocalRunStore();
		const record = makeRecord(store);
		const fake = makeFakeProc({
			stdoutLines: [
				JSON.stringify({ kind: "state_change", stream: "system", payload: { type: "result" } }),
			],
		});
		let startProxyCalls = 0;
		let seenProfile: SandboxProfile | undefined;
		let seenCommand: SpawnCommand | undefined;
		await driveWith(store, record, makeSpec(), fake, makeAdapter(), {
			startProxy: async () => {
				startProxyCalls += 1;
				return makeFakeProxy();
			},
			spawn: async (profile, command) => {
				seenProfile = profile;
				seenCommand = command;
				return fake.proc;
			},
		});
		expect(startProxyCalls).toBe(0);
		expect(seenProfile?.proxyAddress).toBeUndefined();
		expect(seenCommand?.env?.HTTP_PROXY).toBeUndefined();
	});

	test("a proxy start failure terminalizes failed without spawning", async () => {
		const store = new LocalRunStore();
		const record = makeRecord(store);
		let spawnCalls = 0;
		await driveLocalRun(
			store,
			record,
			makeSpec({ network: "restricted" }),
			{ ...PROFILE, network: "restricted", allowedDomains: ["github.com"] },
			{
				startProxy: () => Promise.reject(new Error("EADDRINUSE")),
				spawn: async () => {
					spawnCalls += 1;
					throw new Error("should not spawn");
				},
				registry: { get: () => makeAdapter() },
			},
		);
		expect(spawnCalls).toBe(0);
		expect(record.phase).toBe("failed");
		expect(record.errorMessage).toContain("failed to start network proxy");
		expect(record.errorMessage).toContain("EADDRINUSE");
	});

	test("spawn rejection still stops a live restricted proxy", async () => {
		const store = new LocalRunStore();
		const record = makeRecord(store);
		const proxy = makeFakeProxy();
		await driveLocalRun(
			store,
			record,
			makeSpec({ network: "restricted" }),
			{ ...PROFILE, network: "restricted", allowedDomains: ["github.com"] },
			{
				startProxy: async () => proxy,
				spawn: () => Promise.reject(new Error("bwrap missing")),
				registry: { get: () => makeAdapter() },
			},
		);
		expect(proxy.stopped()).toBe(true);
		expect(record.phase).toBe("failed");
		expect(record.errorMessage).toContain("bwrap missing");
	});
});

describe("readSpecFrontmatter", () => {
	test("returns the frontmatter object when metadata carries one", () => {
		expect(readSpecFrontmatter({ frontmatter: { model: "claude" } })).toEqual({
			model: "claude",
		});
	});

	test("yields undefined for missing or malformed metadata", () => {
		expect(readSpecFrontmatter(undefined)).toBeUndefined();
		expect(readSpecFrontmatter({})).toBeUndefined();
		expect(readSpecFrontmatter({ frontmatter: "nope" })).toBeUndefined();
		expect(readSpecFrontmatter({ frontmatter: [1] })).toBeUndefined();
	});
});
