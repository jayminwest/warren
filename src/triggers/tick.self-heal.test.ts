/**
 * Tick self-heal + notice rate-limiting integration (warren-1ec7). The
 * healer/tracker units live in `project-heal.test.ts`; these cover how
 * `runTick` consumes the `ensureProjectClone` and `noticeGate` seams.
 */

import { beforeEach, describe, expect, test } from "bun:test";
import { openDatabase, type WarrenDb } from "../db/client.ts";
import { createRepos, type Repos } from "../db/repos/index.ts";
import type { LoadedWarrenConfig } from "../warren-config/index.ts";
import { ProjectHealTracker } from "./project-heal.ts";
import { runTick } from "./tick.ts";

const NOW = new Date("2026-07-21T00:05:00.000Z");

function emptyConfig(): LoadedWarrenConfig {
	return {
		triggers: null,
		defaults: null,
		prTemplate: null,
		sourceFile: null,
		errors: [],
		warnings: [],
	};
}

interface CapturedLog {
	level: "info" | "warn" | "error";
	obj: Record<string, unknown>;
	msg?: string;
}

function makeLogger(): { logs: CapturedLog[] } & {
	info: (obj: Record<string, unknown>, msg?: string) => void;
	warn: (obj: Record<string, unknown>, msg?: string) => void;
	error: (obj: Record<string, unknown>, msg?: string) => void;
} {
	const logs: CapturedLog[] = [];
	return {
		logs,
		info: (obj, msg) => logs.push({ level: "info", obj, msg }),
		warn: (obj, msg) => logs.push({ level: "warn", obj, msg }),
		error: (obj, msg) => logs.push({ level: "error", obj, msg }),
	};
}

describe("runTick self-heal (warren-1ec7)", () => {
	let db: WarrenDb;
	let repos: Repos;

	beforeEach(async () => {
		db = await openDatabase({ path: ":memory:" });
		repos = createRepos(db);
		await repos.projects.create({
			gitUrl: "https://github.com/x/y.git",
			localPath: "/data/projects/x/y",
			defaultBranch: "main",
		});
	});

	test("ensureProjectClone self-heals a missing clone and the tick proceeds", async () => {
		let loadCalls = 0;
		const result = await runTick({
			repos,
			now: () => NOW,
			// Re-clone succeeded, so loadWarrenConfig sees a live clone.
			ensureProjectClone: async () => "recloned",
			loadWarrenConfig: async () => {
				loadCalls += 1;
				return emptyConfig();
			},
			spawn: async () => ({ runId: "n/a" }),
		});
		expect(loadCalls).toBe(1);
		expect(result.projectErrors).toEqual([]);
	});

	test("ensureProjectClone 'skip' short-circuits the project (no config load)", async () => {
		let loadCalls = 0;
		const result = await runTick({
			repos,
			now: () => NOW,
			ensureProjectClone: async () => "skip",
			loadWarrenConfig: async () => {
				loadCalls += 1;
				return emptyConfig();
			},
			spawn: async () => ({ runId: "n/a" }),
		});
		expect(loadCalls).toBe(0);
		expect(result.projectErrors).toEqual([]);
	});

	test("noticeGate rate-limits project_failed across ticks", async () => {
		const gate = new ProjectHealTracker(60 * 60 * 1000);
		const logger = makeLogger();
		const deps = {
			repos,
			now: () => NOW,
			noticeGate: gate,
			loadWarrenConfig: async () => {
				throw new Error("clone missing on disk");
			},
			spawn: async () => ({ runId: "n/a" }),
			logger,
		} as const;

		await runTick(deps);
		await runTick(deps);

		// Both ticks captured the per-project error, but only the first logged.
		const failLogs = logger.logs.filter((l) => l.msg === "scheduler.project_failed");
		expect(failLogs).toHaveLength(1);
	});

	test("noticeGate rate-limits sd_list_failed across ticks", async () => {
		const gate = new ProjectHealTracker(60 * 60 * 1000);
		const logger = makeLogger();
		const deps = {
			repos,
			now: () => NOW,
			noticeGate: gate,
			loadWarrenConfig: async () => emptyConfig(),
			issueTracker: {
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
				listScheduledIssues: async () => {
					throw new Error("Not in a seeds project");
				},
			},
			spawn: async () => ({ runId: "n/a" }),
			logger,
		} as const;

		await runTick(deps);
		await runTick(deps);

		const listLogs = logger.logs.filter((l) => l.msg === "scheduler.sd_list_failed");
		expect(listLogs).toHaveLength(1);
	});
});
