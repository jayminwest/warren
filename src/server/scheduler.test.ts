import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Burrow, Run as BurrowRun } from "@os-eco/burrow-cli";
import { BurrowClient, BurrowClientPool } from "../burrow-client/index.ts";
import { openDatabase, type WarrenDb } from "../db/client.ts";
import { createRepos, type Repos } from "../db/repos/index.ts";
import { agents } from "../db/schema.ts";
import type { SpawnFn } from "../projects/clone.ts";
import type { ProjectsConfig } from "../projects/config.ts";
import type { SpawnRunInput, SpawnRunResult } from "../runs/index.ts";
import type { TriggerSchedulerConfig } from "../triggers/index.ts";
import { createWarrenConfigCache } from "../warren-config/index.ts";
import { bootScheduler } from "./scheduler.ts";
import type { BridgeRegistry } from "./types.ts";

function stubFetch(): typeof fetch {
	return (async () =>
		new Response(JSON.stringify({ error: { code: "x", message: "stub" } }), {
			status: 404,
		})) as unknown as typeof fetch;
}

function makeBurrowClient(): BurrowClient {
	return new BurrowClient({
		config: { transport: { kind: "unix", path: "/tmp/x.sock" } },
		fetch: stubFetch(),
	});
}

async function makePool(repos: Repos): Promise<BurrowClientPool> {
	await repos.workers.upsert({ name: "local", url: "unix:///tmp/x.sock" });
	const pool = new BurrowClientPool({ repos });
	pool.register("local", makeBurrowClient());
	return pool;
}

interface BridgeCall {
	readonly runId: string;
	readonly burrowRunId: string;
}

function makeBridges(calls: BridgeCall[]): BridgeRegistry {
	return {
		start(runId, burrowRunId) {
			calls.push({ runId, burrowRunId });
		},
		async stopAll() {},
		size: () => 0,
	};
}

const PROJECTS_CONFIG: ProjectsConfig = {
	root: "/data/projects",
	gitBinary: "git",
};

const SCHEDULER_CONFIG: TriggerSchedulerConfig = {
	tickMs: 60_000,
	disabled: false,
	sdBinary: "sd-test",
};

const NOW = new Date("2026-05-11T00:05:00.000Z");

describe("bootScheduler", () => {
	let db: WarrenDb;
	let repos: Repos;
	let projectId: string;
	let projectPath: string;

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
		projectPath = project.localPath;
	});

	afterEach(async () => {
		await db.close();
	});

	test("dispatch wraps spawnRun and hands the run off to bridges", async () => {
		const bridgeCalls: BridgeCall[] = [];
		const warrenConfigs = createWarrenConfigCache({
			load: async () => ({
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
		});
		await repos.triggers.upsert({
			projectId,
			triggerId: "nightly",
			lastFiredAt: "2026-05-10T12:00:00.000Z",
		});

		const spawnRunCalls: SpawnRunInput[] = [];
		const spawnRunFn = async (input: SpawnRunInput): Promise<SpawnRunResult> => {
			spawnRunCalls.push(input);
			const run = await repos.runs.create({
				agentName: input.agentName,
				projectId: input.projectId,
				prompt: input.prompt,
				renderedAgentJson: { sections: {} },
				trigger: input.trigger ?? "manual",
			});
			return {
				run,
				burrow: { id: "bur_a", workspacePath: "/ws" } as Burrow,
				burrowRun: { id: "rb_a" } as BurrowRun,
				agent: { name: input.agentName, sections: {} } as never,
			};
		};

		const handle = bootScheduler({
			repos,
			burrowClientPool: await makePool(repos),
			bridges: makeBridges(bridgeCalls),
			warrenConfigs,
			projectsConfig: PROJECTS_CONFIG,
			projectSpawn: (async () => ({ stdout: "", stderr: "", exitCode: 0 })) as SpawnFn,
			config: { ...SCHEDULER_CONFIG, disabled: true },
			now: () => NOW,
			spawnRunFn,
		});

		const result = await handle.runOnce();
		await handle.stop();

		expect(result?.cron).toHaveLength(1);
		expect(result?.cron[0]?.kind).toBe("fired");
		expect(spawnRunCalls).toHaveLength(1);
		expect(spawnRunCalls[0]?.agentName).toBe("claude-code");
		expect(spawnRunCalls[0]?.projectId).toBe(projectId);
		expect(spawnRunCalls[0]?.trigger).toBe("cron");
		// spawnRun threaded the prod plumbing through (refresh hook + cache).
		expect(spawnRunCalls[0]?.projectsConfig).toBe(PROJECTS_CONFIG);
		expect(spawnRunCalls[0]?.warrenConfigs).toBe(warrenConfigs);
		expect(bridgeCalls).toHaveLength(1);
		expect(bridgeCalls[0]?.burrowRunId).toBe("rb_a");
	});

	test("listScheduledSeeds + updateExtensions use the configured sdBinary and projectSpawn", async () => {
		const bridgeCalls: BridgeCall[] = [];
		const warrenConfigs = createWarrenConfigCache({
			load: async () => ({
				triggers: null,
				defaults: { defaultRole: "claude-code" },
				prTemplate: null,
				sourceFile: null,
				errors: [],
				warnings: [],
			}),
		});

		type CapturedSpawn = { cmd: readonly string[]; cwd: string };
		const spawnCalls: CapturedSpawn[] = [];
		const projectSpawn: SpawnFn = async (cmd, opts) => {
			spawnCalls.push({ cmd, cwd: opts.cwd });
			if (cmd[1] === "list") {
				return {
					stdout: JSON.stringify({
						issues: [
							{
								id: "warren-zzzz",
								status: "open",
								title: "Run me",
								extensions: { scheduledFor: "2026-05-10T00:00:00.000Z" },
							},
						],
					}),
					stderr: "",
					exitCode: 0,
				};
			}
			return { stdout: "", stderr: "", exitCode: 0 };
		};

		const spawnRunFn = async (input: SpawnRunInput): Promise<SpawnRunResult> => {
			const run = await repos.runs.create({
				agentName: input.agentName,
				projectId: input.projectId,
				prompt: input.prompt,
				renderedAgentJson: { sections: {} },
				trigger: input.trigger ?? "manual",
			});
			return {
				run,
				burrow: { id: "bur_b", workspacePath: "/ws" } as Burrow,
				burrowRun: { id: "rb_b" } as BurrowRun,
				agent: { name: input.agentName, sections: {} } as never,
			};
		};

		const handle = bootScheduler({
			repos,
			burrowClientPool: await makePool(repos),
			bridges: makeBridges(bridgeCalls),
			warrenConfigs,
			projectsConfig: PROJECTS_CONFIG,
			projectSpawn,
			config: { ...SCHEDULER_CONFIG, sdBinary: "sd-test", disabled: true },
			now: () => NOW,
			spawnRunFn,
		});

		const result = await handle.runOnce();
		await handle.stop();

		expect(result?.scheduled).toHaveLength(1);
		const fired = result?.scheduled[0];
		expect(fired?.kind).toBe("fired");
		const runId = fired?.kind === "fired" ? fired.runId : "";
		const listCall = spawnCalls.find((c) => c.cmd[1] === "list");
		const updateCall = spawnCalls.find((c) => c.cmd[1] === "update");
		expect(listCall?.cmd).toEqual(["sd-test", "list", "--format", "json"]);
		expect(listCall?.cwd).toBe(projectPath);
		expect(updateCall?.cmd[0]).toBe("sd-test");
		expect(updateCall?.cmd[1]).toBe("update");
		expect(updateCall?.cmd[2]).toBe("warren-zzzz");
		expect(updateCall?.cmd[3]).toBe("--extensions");
		// pl-bb70 step 5: cron tick's post-fire write is a single sd update
		// that merges scheduledFor clear + lastScheduledRun + the warren
		// common keys (role/trigger/lastRunId/lastRunAt).
		expect(JSON.parse(updateCall?.cmd[4] ?? "{}")).toEqual({
			role: "claude-code",
			trigger: "scheduled",
			lastRunId: runId,
			lastRunAt: NOW.toISOString(),
			scheduledFor: null,
			lastScheduledRun: runId,
		});
		expect(updateCall?.cwd).toBe(projectPath);
		// Only one sd update (single merged write — not two as the old
		// clearScheduledFor + spawn-side writeSeedExtensions pair would
		// have produced).
		expect(spawnCalls.filter((c) => c.cmd[1] === "update")).toHaveLength(1);
		expect(bridgeCalls).toHaveLength(1);
	});

	test("disabled config does not schedule an interval", async () => {
		const setIntervalCalls: { ms: number }[] = [];
		const handle = bootScheduler({
			repos,
			burrowClientPool: await makePool(repos),
			bridges: makeBridges([]),
			warrenConfigs: createWarrenConfigCache({
				load: async () => ({
					triggers: null,
					defaults: null,
					prTemplate: null,
					sourceFile: null,
					errors: [],
					warnings: [],
				}),
			}),
			projectsConfig: PROJECTS_CONFIG,
			projectSpawn: (async () => ({ stdout: "", stderr: "", exitCode: 0 })) as SpawnFn,
			config: { ...SCHEDULER_CONFIG, disabled: true },
			setInterval: (_cb, ms) => {
				setIntervalCalls.push({ ms });
				return {};
			},
			clearInterval: () => {},
		});

		expect(setIntervalCalls).toEqual([]);
		await handle.stop();
	});

	test("enabled config schedules the interval at the configured tickMs", async () => {
		const setIntervalCalls: { ms: number }[] = [];
		const clearCalls: number[] = [];
		const handle = bootScheduler({
			repos,
			burrowClientPool: await makePool(repos),
			bridges: makeBridges([]),
			warrenConfigs: createWarrenConfigCache({
				load: async () => ({
					triggers: null,
					defaults: null,
					prTemplate: null,
					sourceFile: null,
					errors: [],
					warnings: [],
				}),
			}),
			projectsConfig: PROJECTS_CONFIG,
			projectSpawn: (async () => ({ stdout: "", stderr: "", exitCode: 0 })) as SpawnFn,
			config: { ...SCHEDULER_CONFIG, tickMs: 250, disabled: false },
			setInterval: (_cb, ms) => {
				setIntervalCalls.push({ ms });
				return { token: "interval-1" };
			},
			clearInterval: () => {
				clearCalls.push(1);
			},
		});

		expect(setIntervalCalls).toEqual([{ ms: 250 }]);
		await handle.stop();
		expect(clearCalls).toEqual([1]);
	});
});
