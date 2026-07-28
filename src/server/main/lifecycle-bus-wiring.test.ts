import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { openDatabase, type WarrenDb } from "../../db/client.ts";
import { createRepos, type Repos } from "../../db/repos/index.ts";
import { HEALER_TRIGGER } from "../../healer/index.ts";
import { clearLifecycleBus, lifecycleBus } from "../../runs/index.ts";
import type { SeedsCliDeps } from "../../seeds-cli/index.ts";
import type { Logger } from "../types.ts";
import { bootLifecycleBus, type LifecycleBusWiringInput } from "./lifecycle-bus-wiring.ts";

interface LoggedLine {
	readonly level: "info" | "warn" | "error";
	readonly obj: object;
	readonly msg?: string;
}

function recordingLogger(): { lines: LoggedLine[]; logger: Logger } {
	const lines: LoggedLine[] = [];
	const push = (level: LoggedLine["level"]) => (obj: object, msg?: string) =>
		void lines.push({ level, obj, msg });
	return { lines, logger: { info: push("info"), warn: push("warn"), error: push("error") } };
}

const seedsCli: SeedsCliDeps = {
	sdBinary: "sd",
	spawn: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
};

describe("bootLifecycleBus", () => {
	let db: WarrenDb;
	let repos: Repos;

	beforeEach(async () => {
		db = await openDatabase({ path: ":memory:" });
		repos = createRepos(db);
	});
	afterEach(() => {
		clearLifecycleBus();
		db.close();
	});

	function wiringInput(logger: Logger): LifecycleBusWiringInput {
		return { logger, repos, seedsCli };
	}

	test("registers the healer + seed-close consumers and installs the process singleton", () => {
		const { logger } = recordingLogger();
		const handle = bootLifecycleBus(wiringInput(logger));
		expect(handle.bus.extensionNames()).toEqual(["healer", "seed-close"]);
		expect(lifecycleBus()).toBe(handle.bus);
	});

	test("stop() detaches consumers and uninstalls the singleton", () => {
		const { logger } = recordingLogger();
		const handle = bootLifecycleBus(wiringInput(logger));
		handle.stop();
		expect(handle.bus.extensionNames()).toEqual([]);
		expect(lifecycleBus()).toBeUndefined();
	});

	test("the wired healer observes a healer-triggered dispatch", () => {
		const { lines, logger } = recordingLogger();
		const handle = bootLifecycleBus(wiringInput(logger));
		lifecycleBus()?.emitRunDispatched({
			runId: "run_x",
			projectId: "proj_x",
			agentName: "healer",
			branch: "burrow/run_x",
			trigger: HEALER_TRIGGER,
			sandboxId: "sbx_x",
			providerRunId: "brun_x",
		});
		expect(lines.some((l) => l.msg === "healer.dispatched")).toBe(true);
		handle.stop();
	});

	test("routes a subscriber error to the boot logger, never rethrown", async () => {
		const { lines, logger } = recordingLogger();
		const handle = bootLifecycleBus(wiringInput(logger));
		// A synchronous throw from a subscriber must land on onError, not the emit.
		handle.bus.register({
			name: "boom",
			protocol: "warren-ext/v1",
			hooks: {
				run_dispatched: () => {
					throw new Error("kaboom");
				},
			},
		});
		expect(() =>
			lifecycleBus()?.emitRunDispatched({
				runId: "run_e",
				projectId: "proj_e",
				agentName: "healer",
				branch: "burrow/run_e",
				trigger: HEALER_TRIGGER,
				sandboxId: "sbx_e",
				providerRunId: "brun_e",
			}),
		).not.toThrow();
		await Promise.resolve();
		expect(lines.some((l) => l.level === "error" && l.msg === "lifecycle.subscriber_error")).toBe(
			true,
		);
		handle.stop();
	});
});
