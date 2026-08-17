/**
 * Tests for the warren-owned preview sidecar registry (warren-4bf3), ported
 * from burrow's sidecar registry tests. The spawn + forward seams are
 * injected so we exercise the lifecycle state machine, cap enforcement,
 * profile inheritance, and cascade-on-teardown invariant without launching
 * real bwrap children.
 */

import { describe, expect, test } from "bun:test";
import { NotFoundError, ValidationError } from "../../../core/errors.ts";
import type { ForwardHandle } from "../../../sandbox/inbound-forward.ts";
import type { SandboxProfile, SpawnResult } from "../../../sandbox/types.ts";
import {
	LocalSidecarRegistry,
	SidecarCapExceededError,
	type SidecarCreateInput,
	WarrenSidecarSpawnError,
} from "./registry.ts";

interface FakeProc {
	result: SpawnResult;
	exit: (code: number) => void;
	pushStdout: (chunk: Uint8Array) => void;
	pushStderr: (chunk: Uint8Array) => void;
	cancelled: () => boolean;
}

function makeFakeProc(pid: number): FakeProc {
	let exitResolve!: (code: number) => void;
	const exited = new Promise<number>((res) => {
		exitResolve = res;
	});
	let pushStdout: (c: Uint8Array | null) => void = () => {};
	let pushStderr: (c: Uint8Array | null) => void = () => {};
	const stdout = new ReadableStream<Uint8Array>({
		start(controller) {
			pushStdout = (chunk) => {
				if (chunk === null) controller.close();
				else controller.enqueue(chunk);
			};
		},
	});
	const stderr = new ReadableStream<Uint8Array>({
		start(controller) {
			pushStderr = (chunk) => {
				if (chunk === null) controller.close();
				else controller.enqueue(chunk);
			};
		},
	});
	let cancelled = false;
	const result: SpawnResult = {
		pid,
		stdout,
		stderr,
		exited,
		cancel: () => {
			cancelled = true;
			pushStdout(null);
			pushStderr(null);
			exitResolve(143);
		},
	};
	return {
		result,
		exit: (code) => {
			pushStdout(null);
			pushStderr(null);
			exitResolve(code);
		},
		pushStdout: (chunk) => pushStdout(chunk),
		pushStderr: (chunk) => pushStderr(chunk),
		cancelled: () => cancelled,
	};
}

function makeFakeForward(): { handle: ForwardHandle; stopped: () => boolean } {
	let stopped = false;
	const handle: ForwardHandle = {
		hostPort: 32100,
		sandboxPort: 3000,
		hostPortBound: true,
		stop: async () => {
			stopped = true;
		},
	};
	return { handle, stopped: () => stopped };
}

function makeProfile(): SandboxProfile {
	return {
		workspace: "/tmp/ws",
		home: "/tmp/home",
		readOnlyMounts: [],
		network: "open",
		allowedDomains: [],
		envPassthrough: [],
		setEnv: { FOO: "bar" },
		toolchainPaths: [],
	};
}

interface Harness {
	registry: LocalSidecarRegistry;
	procs: FakeProc[];
	forwards: ReturnType<typeof makeFakeForward>[];
	spawnedWith: { profile: SandboxProfile; argv: readonly string[] }[];
}

function makeRegistry(opts: { cap?: number; profile?: SandboxProfile | null } = {}): Harness {
	const procs: FakeProc[] = [];
	const forwards: ReturnType<typeof makeFakeForward>[] = [];
	const spawnedWith: { profile: SandboxProfile; argv: readonly string[] }[] = [];
	let nextPid = 1000;
	const registry = new LocalSidecarRegistry({
		profileFor: () => (opts.profile === null ? null : (opts.profile ?? makeProfile())),
		...(opts.cap !== undefined ? { cap: opts.cap } : {}),
		spawn: async (profile, command) => {
			spawnedWith.push({ profile, argv: command.argv });
			const proc = makeFakeProc(nextPid++);
			procs.push(proc);
			return proc.result;
		},
		startForward: async () => {
			const forward = makeFakeForward();
			forwards.push(forward);
			return forward.handle;
		},
	});
	return { registry, procs, forwards, spawnedWith };
}

function createInput(overrides: Partial<SidecarCreateInput> = {}): SidecarCreateInput {
	return { sandboxId: "local-run_1", command: ["sh", "-c", "bun run dev"], ...overrides };
}

/** Flush the microtask queue so stream pumps + exit handlers settle. */
async function settle(): Promise<void> {
	await new Promise((resolve) => setTimeout(resolve, 0));
}

describe("LocalSidecarRegistry", () => {
	test("spawns the sidecar against the sandbox's stored profile", async () => {
		const h = makeRegistry();
		const record = await h.registry.create(createInput());
		expect(record.state).toBe("live");
		expect(record.id).toMatch(/^sc_/);
		expect(h.spawnedWith.length).toBe(1);
		expect(h.spawnedWith[0]?.profile.setEnv).toEqual({ FOO: "bar" });
		expect(h.spawnedWith[0]?.argv).toEqual(["sh", "-c", "bun run dev"]);
	});

	test("rejects create when the sandbox profile is unresolvable", async () => {
		const h = makeRegistry({ profile: null });
		expect(h.registry.has("local-run_1")).toBe(false);
		await expect(h.registry.create(createInput())).rejects.toBeInstanceOf(NotFoundError);
		expect(h.procs.length).toBe(0);
	});

	test("rejects an empty command with ValidationError", async () => {
		const h = makeRegistry();
		await expect(h.registry.create(createInput({ command: [] }))).rejects.toBeInstanceOf(
			ValidationError,
		);
	});

	test("enforces the per-sandbox live-sidecar cap", async () => {
		const h = makeRegistry({ cap: 1 });
		await h.registry.create(createInput());
		await expect(h.registry.create(createInput())).rejects.toBeInstanceOf(SidecarCapExceededError);
	});

	test("starts the inbound forward against the sidecar pid", async () => {
		const h = makeRegistry();
		const record = await h.registry.create(
			createInput({ inboundPortForward: { hostPort: 32100, sandboxPort: 3000 } }),
		);
		expect(record.hostPortBound).toBe(true);
		expect(h.forwards.length).toBe(1);
	});

	test("throws and tears down the sidecar when the forward fails to bind", async () => {
		const procs: FakeProc[] = [];
		const registry = new LocalSidecarRegistry({
			profileFor: () => makeProfile(),
			spawn: async () => {
				const proc = makeFakeProc(1000);
				procs.push(proc);
				return proc.result;
			},
			startForward: async () => {
				throw new Error("EADDRINUSE");
			},
		});
		await expect(
			registry.create(createInput({ inboundPortForward: { hostPort: 32100, sandboxPort: 3000 } })),
		).rejects.toBeInstanceOf(WarrenSidecarSpawnError);
		expect(procs[0]?.cancelled()).toBe(true);
	});

	test("throws when the spawn itself fails", async () => {
		const registry = new LocalSidecarRegistry({
			profileFor: () => makeProfile(),
			spawn: async () => {
				throw new Error("bwrap missing");
			},
		});
		await expect(registry.create(createInput())).rejects.toBeInstanceOf(WarrenSidecarSpawnError);
	});

	test("transitions to exited and stops the forward when the child exits", async () => {
		const h = makeRegistry();
		const record = await h.registry.create(
			createInput({ inboundPortForward: { hostPort: 32100, sandboxPort: 3000 } }),
		);
		h.procs[0]?.exit(0);
		await settle();
		const after = h.registry.get("local-run_1", record.id);
		expect(after.state).toBe("exited");
		expect(after.exitCode).toBe(0);
		expect(h.forwards[0]?.stopped()).toBe(true);
	});

	test("captures stdout/stderr tails for the logs surface", async () => {
		const h = makeRegistry();
		const record = await h.registry.create(createInput());
		h.procs[0]?.pushStdout(new TextEncoder().encode("ready on 3000"));
		h.procs[0]?.pushStderr(new TextEncoder().encode("warn: slow"));
		await settle();
		const logs = h.registry.logs("local-run_1", record.id);
		expect(logs.stdout).toBe("ready on 3000");
		expect(logs.stderr).toBe("warn: slow");
	});

	test("trims logs to the requested tail bytes", async () => {
		const h = makeRegistry();
		const record = await h.registry.create(createInput());
		h.procs[0]?.pushStdout(new TextEncoder().encode("0123456789"));
		await settle();
		expect(h.registry.logs("local-run_1", record.id, 4).stdout).toBe("6789");
	});

	test("delete terminates the child and stops the forward", async () => {
		const h = makeRegistry();
		const record = await h.registry.create(
			createInput({ inboundPortForward: { hostPort: 32100, sandboxPort: 3000 } }),
		);
		await h.registry.delete("local-run_1", record.id);
		expect(h.procs[0]?.cancelled()).toBe(true);
		expect(h.forwards[0]?.stopped()).toBe(true);
		expect(h.registry.get("local-run_1", record.id).state).toBe("torn-down");
	});

	test("get/logs/delete throw NotFoundError for an unknown sidecar", async () => {
		const h = makeRegistry();
		expect(() => h.registry.get("local-run_1", "sc_nope")).toThrow(NotFoundError);
		expect(() => h.registry.logs("local-run_1", "sc_nope")).toThrow(NotFoundError);
		await expect(h.registry.delete("local-run_1", "sc_nope")).rejects.toBeInstanceOf(NotFoundError);
	});

	test("cascadeDelete terminates every sidecar on the sandbox", async () => {
		const h = makeRegistry();
		await h.registry.create(createInput());
		await h.registry.create(createInput());
		expect(h.registry.list("local-run_1").length).toBe(2);
		await h.registry.cascadeDelete("local-run_1");
		for (const proc of h.procs) expect(proc.cancelled()).toBe(true);
		expect(h.registry.list("local-run_1").length).toBe(0);
	});

	test("shutdownAll terminates sidecars across sandboxes", async () => {
		const h = makeRegistry();
		await h.registry.create(createInput());
		await h.registry.create(createInput({ sandboxId: "local-run_2" }));
		await h.registry.shutdownAll();
		for (const proc of h.procs) expect(proc.cancelled()).toBe(true);
		expect(h.registry.list("local-run_1").length).toBe(0);
		expect(h.registry.list("local-run_2").length).toBe(0);
	});
});
