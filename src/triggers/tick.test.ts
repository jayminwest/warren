import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { ScheduledIssue } from "../core/wire.ts";
import { openDatabase, type WarrenDb } from "../db/client.ts";
import { createRepos, type Repos } from "../db/repos/index.ts";
import { agents } from "../db/schema.ts";
import type { LoadedWarrenConfig } from "../warren-config/index.ts";
import { CronRetryTracker, MAX_CRON_TRANSIENT_RETRIES } from "./cron-retry.ts";
import type { DispatchSpawnFn } from "./dispatch.ts";
import type { TickIssueTracker } from "./tick.ts";
import { runTick, startScheduler } from "./tick.ts";

/** warren-6234: fake tracker for the scheduled-issues pass. */
function makeTracker(
	opts: { scheduled?: readonly ScheduledIssue[]; listThrows?: boolean; mergeThrows?: boolean } = {},
): {
	issueTracker: TickIssueTracker;
	merges: Array<{ projectId: string; localPath?: string; seedId: string; metadata: unknown }>;
	seenContexts: Array<{ projectId: string; localPath?: string }>;
} {
	const merges: Array<{
		projectId: string;
		localPath?: string;
		seedId: string;
		metadata: unknown;
	}> = [];
	const seenContexts: Array<{ projectId: string; localPath?: string }> = [];
	const issueTracker: TickIssueTracker = {
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
		listScheduledIssues: async (ctx) => {
			seenContexts.push({ projectId: ctx.projectId, localPath: ctx.localPath });
			if (opts.listThrows) throw new Error("sd boom");
			return opts.scheduled ?? [];
		},
		mergeIssueMetadata: async (ctx, seedId, metadata) => {
			merges.push({ projectId: ctx.projectId, localPath: ctx.localPath, seedId, metadata });
			if (opts.mergeThrows) throw new Error("sd update exit 1");
		},
	};
	return { issueTracker, merges, seenContexts };
}

const NOW = new Date("2026-05-11T00:05:00.000Z");

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

interface SilentLogger {
	logs: { level: "info" | "warn" | "error"; obj: Record<string, unknown>; msg?: string }[];
	info: (obj: Record<string, unknown>, msg?: string) => void;
	warn: (obj: Record<string, unknown>, msg?: string) => void;
	error: (obj: Record<string, unknown>, msg?: string) => void;
}

function makeLogger(): SilentLogger {
	const logs: SilentLogger["logs"] = [];
	return {
		logs,
		info: (obj, msg) => logs.push({ level: "info", obj, msg }),
		warn: (obj, msg) => logs.push({ level: "warn", obj, msg }),
		error: (obj, msg) => logs.push({ level: "error", obj, msg }),
	};
}

describe("runTick", () => {
	let db: WarrenDb;
	let repos: Repos;
	let projectId: string;
	let localPath: string;

	beforeEach(async () => {
		db = await openDatabase({ path: ":memory:" });
		db.drizzle
			.insert(agents)
			.values({
				name: "claude-code",
				renderedJson: { sections: {} },
				registeredAt: "2026-05-10T00:00:00.000Z",
				lastRefreshed: "2026-05-10T00:00:00.000Z",
			})
			.run();
		repos = createRepos(db);
		const project = await repos.projects.create({
			gitUrl: "https://github.com/x/y.git",
			localPath: "/data/projects/x/y",
			defaultBranch: "main",
		});
		projectId = project.id;
		localPath = project.localPath;
	});

	afterEach(async () => {
		await db.close();
	});

	test("returns an empty result for projects with no .warren/", async () => {
		const result = await runTick({
			repos,
			now: () => NOW,
			loadWarrenConfig: async () => emptyConfig(),
			spawn: async () => ({ runId: "run_unused" }),
		});
		expect(result.cron).toEqual([]);
		expect(result.scheduled).toEqual([]);
		expect(result.projectErrors).toEqual([]);
	});

	test("dispatches cron triggers and persists last-fired state", async () => {
		await repos.triggers.upsert({
			projectId,
			triggerId: "nightly",
			lastFiredAt: "2026-05-10T12:00:00.000Z",
		});
		const calls: { agentName: string; trigger: string }[] = [];
		let createdRunId: string | null = null;
		const spawn: DispatchSpawnFn = async (input) => {
			calls.push({ agentName: input.agentName, trigger: input.trigger });
			const run = await repos.runs.create({
				agentName: input.agentName,
				projectId,
				prompt: input.prompt,
				renderedAgentJson: { sections: {} },
				trigger: input.trigger,
			});
			createdRunId = run.id;
			return { runId: run.id };
		};

		const result = await runTick({
			repos,
			now: () => NOW,
			loadWarrenConfig: async () => ({
				triggers: [
					{
						id: "nightly",
						kind: "cron",
						cron: "0 0 * * *",
						seed: "warren-abc",
						role: "claude-code",
					},
				],
				defaults: null,
				prTemplate: null,
				sourceFile: null,
				errors: [],
				warnings: [],
			}),
			spawn,
		});

		expect(result.cron).toHaveLength(1);
		expect(result.cron[0]?.kind).toBe("fired");
		expect(calls).toEqual([{ agentName: "claude-code", trigger: "cron" }]);
		expect(createdRunId).not.toBeNull();

		const row = await repos.triggers.require({ projectId, triggerId: "nightly" });
		expect(row.lastRunId).toBe(createdRunId);
	});

	test("logs scheduler.cron_gave_up and GCs never_started rows after N transient failures (warren-a0a2)", async () => {
		await repos.triggers.upsert({
			projectId,
			triggerId: "nightly",
			lastFiredAt: "2026-05-10T12:00:00.000Z",
		});
		const cronRetryTracker = new CronRetryTracker();
		const deleteNeverStartedRun = async (runId: string): Promise<void> => {
			await repos.runs.deleteNeverStarted(runId);
		};
		// Spawn always fails transiently, minting a never_started row each time.
		const spawn: DispatchSpawnFn = async (input) => {
			const run = await repos.runs.create({
				agentName: input.agentName,
				projectId,
				prompt: input.prompt,
				renderedAgentJson: { sections: {} },
				trigger: input.trigger,
			});
			input.onRowCreated?.(run.id);
			await repos.runs.markRunning(run.id);
			await repos.runs.finalize(run.id, "failed", NOW, "never_started");
			throw new Error("burrow unreachable");
		};
		const config = {
			triggers: [{ id: "nightly", kind: "cron" as const, cron: "0 0 * * *", role: "claude-code" }],
			defaults: null,
			prTemplate: null,
			sourceFile: null,
			errors: [],
			warnings: [],
		};

		const logger = makeLogger();
		for (let i = 0; i < MAX_CRON_TRANSIENT_RETRIES; i += 1) {
			await runTick({
				repos,
				now: () => new Date(`2026-05-11T00:0${5 + i}:00.000Z`),
				loadWarrenConfig: async () => config,
				spawn,
				cronRetryTracker,
				deleteNeverStartedRun,
				logger,
			});
		}

		expect(logger.logs.some((l) => l.msg === "scheduler.cron_gave_up")).toBe(true);
		const gaveUp = logger.logs.find((l) => l.msg === "scheduler.cron_gave_up");
		expect(gaveUp?.obj.attempts).toBe(MAX_CRON_TRANSIENT_RETRIES);
		// Flood mitigation: at most one never_started row survives the slot.
		const survivors = (await repos.runs.listAll({})).filter(
			(r) => r.failureReason === "never_started",
		);
		expect(survivors).toHaveLength(1);
	});

	test("fires past-due scheduled issues and merges all warren metadata keys in one write", async () => {
		const { issueTracker, merges, seenContexts } = makeTracker({
			scheduled: [
				{
					id: "warren-sched",
					status: "open",
					scheduledFor: new Date("2026-05-10T10:00:00.000Z"),
				},
			],
		});
		const result = await runTick({
			repos,
			now: () => NOW,
			issueTracker,
			loadWarrenConfig: async () => ({
				triggers: null,
				defaults: { defaultRole: "claude-code" },
				prTemplate: null,
				sourceFile: null,
				errors: [],
				warnings: [],
			}),
			spawn: async () => ({ runId: "run_sched" }),
		});

		expect(result.scheduled).toHaveLength(1);
		expect(result.scheduled[0]?.kind).toBe("fired");
		expect(seenContexts).toEqual([{ projectId, localPath }]);
		// pl-bb70 step 5: scheduledFor clear + lastScheduledRun + the common
		// warren-namespaced keys (role, trigger, lastRunId, lastRunAt) land in
		// a single tracker metadata merge.
		expect(merges).toEqual([
			{
				projectId,
				localPath,
				seedId: "warren-sched",
				metadata: {
					role: "claude-code",
					trigger: "scheduled",
					lastRunId: "run_sched",
					lastRunAt: NOW.toISOString(),
					scheduledFor: null,
					lastScheduledRun: "run_sched",
				},
			},
		]);
	});

	test("skips the scheduled pass when the tracker lacks supportsScheduledIssues (warren-6234)", async () => {
		const { issueTracker, seenContexts } = makeTracker({
			scheduled: [
				{
					id: "warren-sched",
					status: "open",
					scheduledFor: new Date("2026-05-10T10:00:00.000Z"),
				},
			],
		});
		const unsupported: TickIssueTracker = {
			...issueTracker,
			capabilities: {
				...issueTracker.capabilities,
				supportsScheduledIssues: false,
			},
		};
		const result = await runTick({
			repos,
			now: () => NOW,
			issueTracker: unsupported,
			loadWarrenConfig: async () => emptyConfig(),
			spawn: async () => ({ runId: "run_unused" }),
		});
		expect(seenContexts).toHaveLength(0);
		expect(result.scheduled).toEqual([]);
	});

	test("extension-write failure stamps a system event on the dispatched run (risk #4)", async () => {
		// The system event is appended against the *warren-side* run row,
		// so we need a real run row to satisfy the FK. Spawn returns an id
		// the runs repo created.
		const project = await repos.projects.require(projectId);
		const realRun = await repos.runs.create({
			agentName: "claude-code",
			projectId: project.id,
			prompt: "scheduled",
			renderedAgentJson: { sections: {} },
			trigger: "scheduled",
		});

		const logger = makeLogger();
		await runTick({
			repos,
			now: () => NOW,
			loadWarrenConfig: async () => ({
				triggers: null,
				defaults: { defaultRole: "claude-code" },
				prTemplate: null,
				sourceFile: null,
				errors: [],
				warnings: [],
			}),
			issueTracker: makeTracker({
				scheduled: [
					{
						id: "warren-sched",
						status: "open",
						scheduledFor: new Date("2026-05-10T10:00:00.000Z"),
					},
				],
				mergeThrows: true,
			}).issueTracker,
			spawn: async () => ({ runId: realRun.id }),
			logger,
		});

		const events = await repos.events.listByRun(realRun.id);
		expect(events).toHaveLength(1);
		expect(events[0]?.kind).toBe("trigger.cleared_extension_failed");
		expect(events[0]?.stream).toBe("system");
		const payload = events[0]?.payloadJson as { seedId: string; reason: string };
		expect(payload.seedId).toBe("warren-sched");
		expect(payload.reason).toContain("sd update exit 1");
	});

	test("sd list failure on one project does not stop the tick", async () => {
		const other = await repos.projects.create({
			gitUrl: "https://github.com/x/z.git",
			localPath: "/data/projects/x/z",
			defaultBranch: "main",
		});

		const logger = makeLogger();
		const { issueTracker, seenContexts } = makeTracker({ listThrows: true });
		const result = await runTick({
			repos,
			now: () => NOW,
			loadWarrenConfig: async () => emptyConfig(),
			issueTracker,
			spawn: async () => ({ runId: "n/a" }),
			logger,
		});

		// Both projects were visited, even though one threw.
		expect(seenContexts).toEqual([
			{ projectId, localPath },
			{ projectId: other.id, localPath: other.localPath },
		]);
		expect(result.projectErrors).toEqual([]);
		expect(logger.logs.some((l) => l.msg === "scheduler.sd_list_failed")).toBe(true);
	});

	test("project loadWarrenConfig failure is captured per-project, not fatal", async () => {
		await repos.projects.create({
			gitUrl: "https://github.com/x/z.git",
			localPath: "/data/projects/x/z",
			defaultBranch: "main",
		});

		let calls = 0;
		const result = await runTick({
			repos,
			now: () => NOW,
			loadWarrenConfig: async () => {
				calls += 1;
				if (calls === 1) throw new Error("clone missing");
				return emptyConfig();
			},
			spawn: async () => ({ runId: "n/a" }),
		});

		expect(result.projectErrors).toHaveLength(1);
		expect(result.projectErrors[0]?.reason).toContain("clone missing");
		expect(calls).toBe(2);
	});
});

describe("startScheduler", () => {
	test("disabled handle is a no-op (never ticks)", async () => {
		const handle = startScheduler({
			tickMs: 1,
			disabled: true,
			repos: {
				projects: { listAll: () => [] } as never,
				triggers: {} as never,
				runs: {} as never,
				events: {} as never,
			},
			loadWarrenConfig: async () => emptyConfig(),
			spawn: async () => ({ runId: "n/a" }),
		});

		await handle.stop();
		expect(handle.tickCount()).toBe(0);
	});

	test("single-flight: an in-flight tick blocks the next fire", async () => {
		let resolveInflight: () => void = () => {};
		const projectRow = {
			id: "prj_sf",
			gitUrl: "g",
			localPath: "/p",
			defaultBranch: "main",
			addedAt: "x",
			lastFetchedAt: null,
			lastHeadSha: null,
		};
		const logger = makeLogger();

		const handle = startScheduler({
			tickMs: 100_000, // long — we drive ticks manually via runOnce
			repos: {
				projects: { listAll: () => [projectRow] } as never,
				triggers: {} as never,
				runs: {} as never,
				events: {} as never,
			},
			loadWarrenConfig: async () =>
				new Promise<LoadedWarrenConfig>((resolve) => {
					resolveInflight = () => resolve(emptyConfig());
				}),
			spawn: async () => ({ runId: "n/a" }),
			logger,
		});

		const first = handle.runOnce();
		const second = handle.runOnce();
		expect(await second).toBeNull(); // single-flight blocked the overlap
		expect(logger.logs.some((l) => l.msg === "scheduler.tick_skipped")).toBe(true);
		resolveInflight();
		await first;
		await handle.stop();
	});

	test("stop() prevents further fires and drains the in-flight one", async () => {
		const handle = startScheduler({
			tickMs: 1,
			repos: {
				projects: { listAll: () => [] } as never,
				triggers: {} as never,
				runs: {} as never,
				events: {} as never,
			},
			loadWarrenConfig: async () => emptyConfig(),
			spawn: async () => ({ runId: "n/a" }),
		});

		await handle.runOnce();
		await handle.stop();
		const after = await handle.runOnce();
		expect(after).toBeNull();
	});
});
