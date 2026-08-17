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

function makeChild(name: "warren", pid = 1234): FakeChild {
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
	spawned: { name: "warren"; cmd: readonly string[] }[];
	warren: FakeChild;
	/** Resolve every pending sleep immediately (the grace timer fires). */
	sleepImmediately: boolean;
}

function makeHarness(opts: { warren?: FakeChild } = {}): Harness {
	const warren = opts.warren ?? makeChild("warren");
	const spawned: Harness["spawned"] = [];
	const logs: Harness["logs"] = [];
	const signalHandlers = new Map<SignalName, () => void>();
	const harness: Harness = {
		logs,
		signalHandlers,
		spawned,
		warren,
		sleepImmediately: false,
		deps: undefined as unknown as SupervisorDeps,
	};

	const spawn: SpawnFn = (cmd, name) => {
		spawned.push({ name, cmd });
		return warren;
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

	harness.deps = {
		spawn,
		installSignalHandler,
		sleep: async () => {
			if (harness.sleepImmediately) return;
			// Park forever: the grace timer is not under test unless the
			// harness opts in.
			await new Promise<never>(() => undefined);
		},
		logger,
	};
	return harness;
}

const WARREN_CMD = ["bun", "run", "src/server/main/index.ts"] as const;

describe("runSupervisor", () => {
	test("spawns warren as the only supervised child", async () => {
		const h = makeHarness();
		const done = runSupervisor(h.deps, { warrenCmd: WARREN_CMD });
		expect(h.spawned).toEqual([{ name: "warren", cmd: WARREN_CMD }]);
		h.warren.resolveExit(0);
		await done;
	});

	test("passes warren's exit code through when warren exits on its own", async () => {
		const h = makeHarness();
		const done = runSupervisor(h.deps, { warrenCmd: WARREN_CMD });
		h.warren.resolveExit(3);
		const result = await done;
		expect(result).toEqual({ exitCode: 3, reason: "warren_exited" });
		expect(h.warren.signalsReceived).toEqual([]);
	});

	test("forwards SIGTERM to warren and exits with warren's code", async () => {
		const h = makeHarness();
		const done = runSupervisor(h.deps, { warrenCmd: WARREN_CMD });
		h.signalHandlers.get("SIGTERM")?.();
		expect(h.warren.signalsReceived).toEqual(["SIGTERM"]);
		h.warren.resolveExit(0);
		const result = await done;
		expect(result.exitCode).toBe(0);
	});

	test("forwards SIGINT to warren", async () => {
		const h = makeHarness();
		const done = runSupervisor(h.deps, { warrenCmd: WARREN_CMD });
		h.signalHandlers.get("SIGINT")?.();
		expect(h.warren.signalsReceived).toEqual(["SIGTERM"]);
		h.warren.resolveExit(0);
		await done;
	});

	test("forwards a shutdown signal only once", async () => {
		const h = makeHarness();
		const done = runSupervisor(h.deps, { warrenCmd: WARREN_CMD });
		h.signalHandlers.get("SIGTERM")?.();
		h.signalHandlers.get("SIGINT")?.();
		expect(h.warren.signalsReceived).toEqual(["SIGTERM"]);
		h.warren.resolveExit(0);
		await done;
	});

	test("escalates to SIGKILL when warren outlives the shutdown grace", async () => {
		const h = makeHarness();
		h.sleepImmediately = true;
		const done = runSupervisor(h.deps, { warrenCmd: WARREN_CMD });
		h.signalHandlers.get("SIGTERM")?.();
		// Let the fire-and-forget grace timer run.
		await Promise.resolve();
		await Promise.resolve();
		expect(h.warren.signalsReceived).toEqual(["SIGTERM", "SIGKILL"]);
		h.warren.resolveExit(137);
		const result = await done;
		expect(result.exitCode).toBe(137);
	});

	test("does not SIGKILL a warren that exited inside the grace window", async () => {
		const h = makeHarness();
		const done = runSupervisor(h.deps, { warrenCmd: WARREN_CMD });
		h.signalHandlers.get("SIGTERM")?.();
		h.warren.resolveExit(0);
		await done;
		// Even if the grace timer fires late, the exited flag suppresses it.
		h.sleepImmediately = true;
		await Promise.resolve();
		expect(h.warren.signalsReceived).toEqual(["SIGTERM"]);
	});

	test("uninstalls both signal handlers when warren exits", async () => {
		const h = makeHarness();
		const done = runSupervisor(h.deps, { warrenCmd: WARREN_CMD });
		expect(h.signalHandlers.size).toBe(2);
		h.warren.resolveExit(0);
		await done;
		expect(h.signalHandlers.size).toBe(0);
	});
});

describe("resolveCommandFromEnv", () => {
	test("defaults to bun running the canonical server entry", () => {
		const cmd = resolveCommandFromEnv({ env: {} });
		expect(cmd.warrenCmd).toEqual(["bun", "run", "src/server/main/index.ts"]);
	});

	test("honors WARREN_SUPERVISOR_BUN and WARREN_SERVER_ENTRY overrides", () => {
		const cmd = resolveCommandFromEnv({
			env: {
				WARREN_SUPERVISOR_BUN: "/usr/local/bin/bun",
				WARREN_SERVER_ENTRY: "dist/server.js",
			},
		});
		expect(cmd.warrenCmd).toEqual(["/usr/local/bin/bun", "run", "dist/server.js"]);
	});

	test("ignores the retired burrow env knobs", () => {
		const cmd = resolveCommandFromEnv({
			env: {
				WARREN_BURROW_SOCKET: "/run/burrow/test.sock",
				WARREN_BURROW_BIN: "/usr/local/bin/burrow",
				WARREN_BURROW_NO_AUTH: "1",
				WARREN_BURROW_ARGS: "--log-level debug",
			},
		});
		expect(cmd.warrenCmd).toEqual(["bun", "run", "src/server/main/index.ts"]);
		expect("socketPath" in cmd).toBe(false);
		expect("burrowCmd" in cmd).toBe(false);
	});
});
