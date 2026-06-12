import { describe, expect, test } from "bun:test";
import {
	type InstallSignalHandler,
	resolveCommandFromEnv,
	runSupervisor,
	type SignalName,
	type SpawnFn,
	type SupervisedChild,
	type SupervisorDeps,
	type SupervisorLogger,
} from "./main.ts";

interface FakeChild extends SupervisedChild {
	signalsReceived: ("SIGTERM" | "SIGKILL")[];
	resolveExit(code: number): void;
}

function makeChild(name: "burrow" | "warren", pid = 1234): FakeChild {
	let resolver: ((code: number) => void) | undefined;
	const exited = new Promise<number>((resolve) => {
		resolver = resolve;
	});
	const signals: ("SIGTERM" | "SIGKILL")[] = [];
	return {
		name,
		pid,
		signalsReceived: signals,
		exited,
		kill: (signal) => {
			signals.push(signal);
		},
		resolveExit: (code) => resolver?.(code),
	};
}

interface Harness {
	deps: SupervisorDeps;
	logs: { level: "info" | "warn" | "error"; obj: object; msg?: string }[];
	signalHandlers: Map<SignalName, () => void>;
	socketReady: boolean;
	socketCalls: number;
	spawned: { name: "burrow" | "warren"; cmd: readonly string[] }[];
	queueChild(name: "burrow" | "warren", child: FakeChild): void;
	now: number;
	advance(ms: number): void;
}

function makeHarness(
	opts: { socketReady?: boolean; burrowChildren?: FakeChild[]; warrenChildren?: FakeChild[] } = {},
): Harness {
	const burrowQueue: FakeChild[] = [...(opts.burrowChildren ?? [])];
	const warrenQueue: FakeChild[] = [...(opts.warrenChildren ?? [])];
	const spawned: Harness["spawned"] = [];
	const logs: Harness["logs"] = [];
	const signalHandlers = new Map<SignalName, () => void>();
	let socketReady = opts.socketReady ?? true;
	let socketCalls = 0;
	let now = 0;

	const spawn: SpawnFn = (cmd, name) => {
		spawned.push({ name, cmd });
		const queue = name === "burrow" ? burrowQueue : warrenQueue;
		const next = queue.shift();
		if (next === undefined) {
			throw new Error(`harness ran out of queued children for ${name}`);
		}
		return next;
	};

	const installSignalHandler: InstallSignalHandler = (signal, handler) => {
		signalHandlers.set(signal, handler);
		return () => {
			if (signalHandlers.get(signal) === handler) signalHandlers.delete(signal);
		};
	};

	const logger: SupervisorLogger = {
		info: (obj, msg) => logs.push({ level: "info", obj, msg }),
		warn: (obj, msg) => logs.push({ level: "warn", obj, msg }),
		error: (obj, msg) => logs.push({ level: "error", obj, msg }),
	};

	const deps: SupervisorDeps = {
		spawn,
		waitForSocket: async () => {
			socketCalls += 1;
			return socketReady;
		},
		installSignalHandler,
		sleep: async () => undefined,
		now: () => now,
		logger,
	};

	const harness: Harness = {
		deps,
		logs,
		signalHandlers,
		spawned,
		get socketReady() {
			return socketReady;
		},
		set socketReady(v: boolean) {
			socketReady = v;
		},
		get socketCalls() {
			return socketCalls;
		},
		queueChild: (name, child) => {
			(name === "burrow" ? burrowQueue : warrenQueue).push(child);
		},
		get now() {
			return now;
		},
		set now(v: number) {
			now = v;
		},
		advance: (ms: number) => {
			now += ms;
		},
	};
	return harness;
}

const cmd = {
	socketPath: "/tmp/burrow.sock",
	burrowCmd: ["burrow", "serve", "--socket", "/tmp/burrow.sock"],
	warrenCmd: ["bun", "run", "src/server/main/index.ts"],
};

describe("runSupervisor", () => {
	test("happy path: spawns burrow, waits for socket, spawns warren, exits with warren's code", async () => {
		const burrow = makeChild("burrow");
		const warren = makeChild("warren");
		const h = makeHarness({ burrowChildren: [burrow], warrenChildren: [warren] });

		const supervisorP = runSupervisor(h.deps, cmd);
		// Let microtasks drain.
		await Promise.resolve();
		expect(h.spawned[0]).toEqual({ name: "burrow", cmd: cmd.burrowCmd });
		// Wait one tick so the socket-poll resolves and warren spawns.
		await Promise.resolve();
		await Promise.resolve();
		await Promise.resolve();

		// Warren exits cleanly.
		warren.resolveExit(0);
		// Burrow gets SIGTERM and then exits.
		await Promise.resolve();
		await Promise.resolve();
		burrow.resolveExit(0);

		const result = await supervisorP;
		expect(result.exitCode).toBe(0);
		expect(result.reason).toBe("warren_exited");
		expect(burrow.signalsReceived).toContain("SIGTERM");
		expect(h.spawned.map((s) => s.name)).toEqual(["burrow", "warren"]);
	});

	test("warren non-zero exit propagates to supervisor exit code", async () => {
		const burrow = makeChild("burrow");
		const warren = makeChild("warren");
		const h = makeHarness({ burrowChildren: [burrow], warrenChildren: [warren] });

		const supervisorP = runSupervisor(h.deps, cmd);
		await flushMicrotasks();

		warren.resolveExit(2);
		await flushMicrotasks();
		burrow.resolveExit(0);

		const result = await supervisorP;
		expect(result.exitCode).toBe(2);
		expect(result.reason).toBe("warren_exited");
	});

	test("socket timeout: kills burrow and exits 1 without spawning warren", async () => {
		const burrow = makeChild("burrow");
		const h = makeHarness({
			socketReady: false,
			burrowChildren: [burrow],
		});

		const supervisorP = runSupervisor(h.deps, cmd);
		await flushMicrotasks();
		burrow.resolveExit(143); // SIGTERM exit code

		const result = await supervisorP;
		expect(result.exitCode).toBe(1);
		expect(result.reason).toBe("socket_timeout");
		expect(h.spawned.map((s) => s.name)).toEqual(["burrow"]);
		expect(burrow.signalsReceived).toContain("SIGTERM");
	});

	test("burrow non-zero exit triggers a restart inside the budget", async () => {
		const burrow1 = makeChild("burrow", 1);
		const burrow2 = makeChild("burrow", 2);
		const warren = makeChild("warren");
		const h = makeHarness({
			burrowChildren: [burrow1, burrow2],
			warrenChildren: [warren],
		});

		const supervisorP = runSupervisor(h.deps, cmd);
		await flushMicrotasks();

		// First burrow crashes.
		burrow1.resolveExit(1);
		await flushMicrotasks();
		// Second burrow has been spawned.
		expect(h.spawned.filter((s) => s.name === "burrow")).toHaveLength(2);

		// Now warren exits, supervisor tears down.
		warren.resolveExit(0);
		await flushMicrotasks();
		burrow2.resolveExit(0);

		const result = await supervisorP;
		expect(result.exitCode).toBe(0);
		expect(result.reason).toBe("warren_exited");
	});

	test("burrow exhausts its restart budget; supervisor exits 1 and kills warren", async () => {
		const burrowChildren = [
			makeChild("burrow", 1),
			makeChild("burrow", 2),
			makeChild("burrow", 3),
			makeChild("burrow", 4),
			makeChild("burrow", 5),
		];
		const warren = makeChild("warren");
		const h = makeHarness({
			burrowChildren,
			warrenChildren: [warren],
		});

		const supervisorP = runSupervisor(h.deps, {
			...cmd,
			burrowRestartBudget: 4,
			burrowRestartWindowMs: 60_000,
			signalGraceMs: 100,
		});
		await flushMicrotasks();

		// 4 restarts allowed, 5th attempt blows the budget.
		for (let i = 0; i < burrowChildren.length; i++) {
			const child = burrowChildren[i];
			if (child === undefined) throw new Error(`missing child ${i}`);
			child.resolveExit(1);
			await flushMicrotasks();
		}

		// Supervisor should now be tearing down warren.
		warren.resolveExit(143);

		const result = await supervisorP;
		expect(result.exitCode).toBe(1);
		expect(result.reason).toBe("burrow_budget_exhausted");
		expect(warren.signalsReceived).toContain("SIGTERM");
	});

	test("SIGTERM forwards to both children and resolves with warren's exit code", async () => {
		const burrow = makeChild("burrow");
		const warren = makeChild("warren");
		const h = makeHarness({ burrowChildren: [burrow], warrenChildren: [warren] });

		const supervisorP = runSupervisor(h.deps, cmd);
		await flushMicrotasks();

		const term = h.signalHandlers.get("SIGTERM");
		expect(term).toBeDefined();
		term?.();
		expect(warren.signalsReceived).toContain("SIGTERM");
		expect(burrow.signalsReceived).toContain("SIGTERM");

		// Children exit in response.
		warren.resolveExit(0);
		await flushMicrotasks();
		burrow.resolveExit(0);

		const result = await supervisorP;
		expect(result.exitCode).toBe(0);
		expect(result.reason).toBe("warren_exited");
	});

	test("SIGINT triggers the same shutdown path as SIGTERM", async () => {
		const burrow = makeChild("burrow");
		const warren = makeChild("warren");
		const h = makeHarness({ burrowChildren: [burrow], warrenChildren: [warren] });

		const supervisorP = runSupervisor(h.deps, cmd);
		await flushMicrotasks();

		h.signalHandlers.get("SIGINT")?.();
		warren.resolveExit(0);
		await flushMicrotasks();
		burrow.resolveExit(0);

		const result = await supervisorP;
		expect(result.exitCode).toBe(0);
		expect(warren.signalsReceived).toContain("SIGTERM");
	});

	test("during shutdown, a burrow exit does not trigger a restart", async () => {
		const burrow = makeChild("burrow");
		const warren = makeChild("warren");
		const h = makeHarness({ burrowChildren: [burrow], warrenChildren: [warren] });

		const supervisorP = runSupervisor(h.deps, cmd);
		await flushMicrotasks();

		// SIGTERM, then both children exit. Burrow exits with non-zero — but
		// shutdown is in progress, so no restart should be attempted.
		h.signalHandlers.get("SIGTERM")?.();
		burrow.resolveExit(143);
		warren.resolveExit(0);

		const result = await supervisorP;
		expect(result.reason).toBe("warren_exited");
		// Only the original burrow was spawned.
		expect(h.spawned.filter((s) => s.name === "burrow")).toHaveLength(1);
	});

	test("clean (zero) exit from burrow without shutdown is treated as fatal", async () => {
		const burrow = makeChild("burrow");
		const warren = makeChild("warren");
		const h = makeHarness({ burrowChildren: [burrow], warrenChildren: [warren] });

		const supervisorP = runSupervisor(h.deps, cmd);
		await flushMicrotasks();

		burrow.resolveExit(0);
		// Supervisor should now tear down warren.
		await flushMicrotasks();
		warren.resolveExit(143);

		const result = await supervisorP;
		expect(result.exitCode).toBe(1);
		expect(result.reason).toBe("burrow_clean_exit");
	});

	test("uninstalls signal handlers on exit", async () => {
		const burrow = makeChild("burrow");
		const warren = makeChild("warren");
		const h = makeHarness({ burrowChildren: [burrow], warrenChildren: [warren] });

		const supervisorP = runSupervisor(h.deps, cmd);
		await flushMicrotasks();
		expect(h.signalHandlers.size).toBe(2);

		warren.resolveExit(0);
		await flushMicrotasks();
		burrow.resolveExit(0);
		await supervisorP;

		expect(h.signalHandlers.size).toBe(0);
	});
});

describe("resolveCommandFromEnv", () => {
	test("falls back to the canonical defaults when env is empty", () => {
		const cmd = resolveCommandFromEnv({ env: {} });
		expect(cmd.socketPath).toBe("/var/run/burrow.sock");
		expect(cmd.burrowCmd).toEqual(["burrow", "serve", "--socket", "/var/run/burrow.sock"]);
		expect(cmd.warrenCmd).toEqual(["bun", "run", "src/server/main/index.ts"]);
	});

	test("env overrides flow through to both commands", () => {
		const cmd = resolveCommandFromEnv({
			env: {
				WARREN_BURROW_SOCKET: "/run/burrow/test.sock",
				WARREN_BURROW_BIN: "/usr/local/bin/burrow",
				WARREN_SUPERVISOR_BUN: "/opt/bun/bin/bun",
				WARREN_SERVER_ENTRY: "dist/server.js",
			},
		});
		expect(cmd.socketPath).toBe("/run/burrow/test.sock");
		expect(cmd.burrowCmd).toEqual([
			"/usr/local/bin/burrow",
			"serve",
			"--socket",
			"/run/burrow/test.sock",
		]);
		expect(cmd.warrenCmd).toEqual(["/opt/bun/bin/bun", "run", "dist/server.js"]);
	});

	test("WARREN_BURROW_NO_AUTH=1 appends --no-auth", () => {
		const cmd = resolveCommandFromEnv({ env: { WARREN_BURROW_NO_AUTH: "1" } });
		expect(cmd.burrowCmd).toEqual([
			"burrow",
			"serve",
			"--socket",
			"/var/run/burrow.sock",
			"--no-auth",
		]);
	});

	test("WARREN_BURROW_NO_AUTH accepts 'true' (case-insensitive)", () => {
		const cmd = resolveCommandFromEnv({ env: { WARREN_BURROW_NO_AUTH: "TRUE" } });
		expect(cmd.burrowCmd).toContain("--no-auth");
	});

	test("WARREN_BURROW_NO_AUTH accepts 'yes'/'on' (case-insensitive, trimmed)", () => {
		for (const raw of ["yes", "ON", " on ", "Yes"]) {
			const cmd = resolveCommandFromEnv({ env: { WARREN_BURROW_NO_AUTH: raw } });
			expect(cmd.burrowCmd).toContain("--no-auth");
		}
	});

	test("WARREN_BURROW_NO_AUTH=0 leaves the command unchanged", () => {
		const cmd = resolveCommandFromEnv({ env: { WARREN_BURROW_NO_AUTH: "0" } });
		expect(cmd.burrowCmd).not.toContain("--no-auth");
	});

	test("WARREN_BURROW_ARGS splits on whitespace and appends", () => {
		const cmd = resolveCommandFromEnv({
			env: { WARREN_BURROW_ARGS: "--log-level debug --max-runs 4" },
		});
		expect(cmd.burrowCmd).toEqual([
			"burrow",
			"serve",
			"--socket",
			"/var/run/burrow.sock",
			"--log-level",
			"debug",
			"--max-runs",
			"4",
		]);
	});

	test("empty WARREN_BURROW_ARGS is treated as absent", () => {
		const cmd = resolveCommandFromEnv({ env: { WARREN_BURROW_ARGS: "   " } });
		expect(cmd.burrowCmd).toEqual(["burrow", "serve", "--socket", "/var/run/burrow.sock"]);
	});

	test("WARREN_BURROW_NO_AUTH and WARREN_BURROW_ARGS compose, with --no-auth first", () => {
		const cmd = resolveCommandFromEnv({
			env: { WARREN_BURROW_NO_AUTH: "1", WARREN_BURROW_ARGS: "--verbose" },
		});
		expect(cmd.burrowCmd).toEqual([
			"burrow",
			"serve",
			"--socket",
			"/var/run/burrow.sock",
			"--no-auth",
			"--verbose",
		]);
	});
});

/** Drain the microtask queue several turns. Several awaits in the supervisor
 * compound (spawn, await waitForSocket, spawn again, install handlers, race),
 * so we flush a few times to let each one resolve. */
async function flushMicrotasks(): Promise<void> {
	for (let i = 0; i < 20; i++) {
		await Promise.resolve();
	}
}
