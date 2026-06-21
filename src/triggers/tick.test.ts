import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { openDatabase, type WarrenDb } from "../db/client.ts";
import { createRepos, type Repos } from "../db/repos/index.ts";
import { agents } from "../db/schema.ts";
import type { WarrenExtensions } from "../seeds-cli/index.ts";
import type { LoadedWarrenConfig } from "../warren-config/index.ts";
import type { DispatchSpawnFn } from "./dispatch.ts";
import { runTick, startScheduler } from "./tick.ts";

const NOW = new Date("2026-05-11T00:05:00.000Z");

function emptyConfig(): LoadedWarrenConfig {
	return { triggers: null, defaults: null, prTemplate: null, errors: [], warnings: [] };
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
			listScheduledSeeds: async () => ({ scheduled: [], errors: [] }),
			updateExtensions: async () => {},
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
				errors: [],
				warnings: [],
			}),
			listScheduledSeeds: async () => ({ scheduled: [], errors: [] }),
			updateExtensions: async () => {},
			spawn,
		});

		expect(result.cron).toHaveLength(1);
		expect(result.cron[0]?.kind).toBe("fired");
		expect(calls).toEqual([{ agentName: "claude-code", trigger: "cron" }]);
		expect(createdRunId).not.toBeNull();

		const row = await repos.triggers.require({ projectId, triggerId: "nightly" });
		expect(row.lastRunId).toBe(createdRunId);
	});

	test("fires past-due scheduled seeds and merges all warren extension keys in one write", async () => {
		const writes: { path: string; seedId: string; extensions: WarrenExtensions }[] = [];
		const result = await runTick({
			repos,
			now: () => NOW,
			loadWarrenConfig: async () => ({
				triggers: null,
				defaults: { defaultRole: "claude-code" },
				prTemplate: null,
				errors: [],
				warnings: [],
			}),
			listScheduledSeeds: async (path) => {
				expect(path).toBe(localPath);
				return {
					scheduled: [
						{
							id: "warren-sched",
							status: "open",
							scheduledFor: new Date("2026-05-10T10:00:00.000Z"),
						},
					],
					errors: [],
				};
			},
			updateExtensions: async (path, seedId, extensions) => {
				writes.push({ path, seedId, extensions });
			},
			spawn: async () => ({ runId: "run_sched" }),
		});

		expect(result.scheduled).toHaveLength(1);
		expect(result.scheduled[0]?.kind).toBe("fired");
		// pl-bb70 step 5: scheduledFor clear + lastScheduledRun + the common
		// warren-namespaced keys (role, trigger, lastRunId, lastRunAt) land in
		// a single sd update.
		expect(writes).toEqual([
			{
				path: localPath,
				seedId: "warren-sched",
				extensions: {
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
				errors: [],
				warnings: [],
			}),
			listScheduledSeeds: async () => ({
				scheduled: [
					{
						id: "warren-sched",
						status: "open",
						scheduledFor: new Date("2026-05-10T10:00:00.000Z"),
					},
				],
				errors: [],
			}),
			updateExtensions: async () => {
				throw new Error("sd update exit 1");
			},
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

	test("ci-fixer pass dispatches a fixer for a failing PR and stamps a system event", async () => {
		const opener = await repos.runs.create({
			agentName: "claude-code",
			projectId,
			prompt: "open the PR",
			renderedAgentJson: { sections: {} },
			trigger: "manual",
		});
		await repos.runs.markRunning(opener.id, NOW);
		await repos.runs.setPrUrl(opener.id, "https://github.com/x/y/pull/9");

		const failingFetch = (async () =>
			new Response(
				JSON.stringify({
					check_runs: [{ id: 1, name: "test", status: "completed", conclusion: "failure" }],
				}),
				{ status: 200 },
			)) as unknown as typeof fetch;
		const spawnCalls: { projectId: string; agentName: string; parentRunId: string }[] = [];

		await runTick({
			repos,
			now: () => NOW,
			loadWarrenConfig: async () => ({
				triggers: null,
				defaults: {
					ciFixer: {
						enabled: true,
						maxRetries: 2,
						cooldownMinutes: 10,
						logTailLines: 200,
						role: "pr-fixer",
					},
				},
				prTemplate: null,
				errors: [],
				warnings: [],
			}),
			listScheduledSeeds: async () => ({ scheduled: [], errors: [] }),
			updateExtensions: async () => {},
			spawn: async () => ({ runId: "unused" }),
			ciFixer: {
				githubToken: "tok",
				fetch: failingFetch,
				spawn: async (i) => {
					spawnCalls.push({
						projectId: i.projectId,
						agentName: i.agentName,
						parentRunId: i.parentRunId,
					});
					return { runId: "run_fixer" };
				},
			},
		});

		expect(spawnCalls).toEqual([{ projectId, agentName: "pr-fixer", parentRunId: opener.id }]);
		const events = await repos.events.listByRun(opener.id);
		expect(events).toHaveLength(1);
		expect(events[0]?.kind).toBe("ci_fixer.dispatched");
		expect(events[0]?.stream).toBe("system");
		const payload = events[0]?.payloadJson as { prUrl: string; fixerRunId: string };
		expect(payload).toEqual({ prUrl: "https://github.com/x/y/pull/9", fixerRunId: "run_fixer" });
	});

	test("ci-fixer pass is a no-op when the project hasn't opted in", async () => {
		const opener = await repos.runs.create({
			agentName: "claude-code",
			projectId,
			prompt: "open the PR",
			renderedAgentJson: { sections: {} },
			trigger: "manual",
		});
		await repos.runs.markRunning(opener.id, NOW);
		await repos.runs.setPrUrl(opener.id, "https://github.com/x/y/pull/9");

		let spawned = 0;
		await runTick({
			repos,
			now: () => NOW,
			loadWarrenConfig: async () => emptyConfig(),
			listScheduledSeeds: async () => ({ scheduled: [], errors: [] }),
			updateExtensions: async () => {},
			spawn: async () => ({ runId: "unused" }),
			ciFixer: {
				githubToken: "tok",
				fetch: (async () => {
					throw new Error("fetch should not run");
				}) as unknown as typeof fetch,
				spawn: async () => {
					spawned += 1;
					return { runId: "run_fixer" };
				},
			},
		});

		expect(spawned).toBe(0);
		expect(await repos.events.listByRun(opener.id)).toHaveLength(0);
	});

	test("sd list failure on one project does not stop the tick", async () => {
		const other = await repos.projects.create({
			gitUrl: "https://github.com/x/z.git",
			localPath: "/data/projects/x/z",
			defaultBranch: "main",
		});

		const seenPaths: string[] = [];
		const logger = makeLogger();
		const result = await runTick({
			repos,
			now: () => NOW,
			loadWarrenConfig: async () => emptyConfig(),
			listScheduledSeeds: async (path) => {
				seenPaths.push(path);
				if (path === localPath) throw new Error("sd boom");
				return { scheduled: [], errors: [] };
			},
			updateExtensions: async () => {},
			spawn: async () => ({ runId: "n/a" }),
			logger,
		});

		// Both projects were visited, even though one threw.
		expect(seenPaths).toEqual([localPath, other.localPath]);
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
			listScheduledSeeds: async () => ({ scheduled: [], errors: [] }),
			updateExtensions: async () => {},
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
			listScheduledSeeds: async () => ({ scheduled: [], errors: [] }),
			updateExtensions: async () => {},
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
			listScheduledSeeds: async () => ({ scheduled: [], errors: [] }),
			updateExtensions: async () => {},
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
			listScheduledSeeds: async () => ({ scheduled: [], errors: [] }),
			updateExtensions: async () => {},
			spawn: async () => ({ runId: "n/a" }),
		});

		await handle.runOnce();
		await handle.stop();
		const after = await handle.runOnce();
		expect(after).toBeNull();
	});
});
