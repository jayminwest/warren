import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { openDatabase, type WarrenDb } from "../../db/client.ts";
import { createRepos, type Repos } from "../../db/repos/index.ts";
import { FakeForge } from "../../forge/fake/fake-forge.ts";
import { HEALER_TRIGGER } from "../../healer/index.ts";
import { clearLifecycleBus, lifecycleBus } from "../../runs/index.ts";
import type { IssueTracker } from "../../tracker/contract.ts";
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

const issueTracker: IssueTracker = {
	capabilities: {
		supportsPlans: true,
		supportsMetadata: true,
		supportsScheduledIssues: true,
		isGitNative: true,
	},
	getIssue: async () => {
		throw new Error("unused");
	},
	listIssueStatuses: async () => new Map(),
	closeIssue: async () => {},
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
		return { logger, repos, issueTracker };
	}

	test("registers the healer + seed-close consumers and installs the process singleton", () => {
		const { logger } = recordingLogger();
		const handle = bootLifecycleBus(wiringInput(logger));
		expect(handle.bus.extensionNames()).toEqual(["healer", "seed-close", "lifecycle-stream"]);
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

	test("with a forge, registers the merge watcher and re-adopts unresolved PRs", async () => {
		const { logger } = recordingLogger();
		const forge = new FakeForge();
		const project = await repos.projects.create({
			gitUrl: "https://github.com/x/y.git",
			localPath: "/data/projects/x/y",
			defaultBranch: "main",
		});
		const run = await repos.runs.create({
			agentName: "a",
			projectId: project.id,
			prompt: "p",
			renderedAgentJson: {},
			trigger: "manual",
		});
		// A PR the forge already knows as merged — the re-adopted watch
		// settles on its first poll (real timers, but the merged arm never
		// reaches a backoff sleep).
		const ref = forge.parseRepoRef("fake://x/y");
		if (ref === null) throw new Error("fake forge refused its own URL");
		const opened = await forge.openPullRequest(ref, {
			title: "t",
			body: "b",
			headBranch: "warren/run-1",
			baseBranch: "main",
		});
		if (!opened.ok) throw new Error("fake forge failed to open a PR");
		if (!forge.markMerged(ref, opened.value)) throw new Error("fake forge failed to merge");
		await repos.runs.setPrUrl(run.id, opened.value.webUrl);

		const handle = bootLifecycleBus({ ...wiringInput(logger), forge });
		expect(handle.bus.extensionNames()).toEqual([
			"healer",
			"seed-close",
			"pr-merge-watcher",
			"lifecycle-stream",
		]);
		// Boot re-adoption is fire-and-forget; wait for the row to settle.
		const deadline = Date.now() + 2_000;
		let row = await repos.runs.get(run.id);
		while (row?.prState !== "merged" && Date.now() < deadline) {
			await new Promise((resolve) => setTimeout(resolve, 5));
			row = await repos.runs.get(run.id);
		}
		expect(row?.prState).toBe("merged");
		expect(row?.prMergedAt).not.toBeNull();
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
