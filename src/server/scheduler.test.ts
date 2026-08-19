import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, type WarrenDb } from "../db/client.ts";
import { createRepos, type Repos } from "../db/repos/index.ts";
import { agents } from "../db/schema.ts";
import { FakeForge } from "../forge/fake/fake-forge.ts";
import type { SpawnFn } from "../projects/clone.ts";
import type { ProjectsConfig } from "../projects/config.ts";
import type { SpawnRunInput, SpawnRunResult } from "../runs/index.ts";
import type { RuntimeProvider } from "../runtime/contract.ts";
import { SeedsTracker } from "../tracker/seeds-tracker.ts";
import type { TriggerSchedulerConfig } from "../triggers/index.ts";
import { createWarrenConfigCache } from "../warren-config/index.ts";
import { bootScheduler } from "./scheduler.ts";
import type { BridgeRegistry } from "./types.ts";

interface BridgeCall {
	readonly runId: string;
	readonly sandboxRunId: string;
}

function makeBridges(calls: BridgeCall[]): BridgeRegistry {
	return {
		start(runId, sandboxRunId) {
			calls.push({ runId, sandboxRunId });
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

// Identity-only stub — the tests assert the SAME instance reaches spawnRun
// (warren-c531 follow-up: a dropped provider silently falls back to the
// burrow-backed LocalProvider, which cannot spawn under WARREN_RUNTIME=k8s).
const RUNTIME_PROVIDER = { kind: "stub" } as unknown as RuntimeProvider;

// FakeForge owns only `fake://` urls, so the github.com fixtures mint no
// credential (undefined → anonymous git) — the old empty-token passthrough.
const FORGE = new FakeForge();

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
				sandbox: { id: "bur_a", workspacePath: "/ws" },
				sandboxRun: { id: "rb_a" },
				agent: { name: input.agentName, sections: {} } as never,
			};
		};

		const handle = bootScheduler({
			repos,
			forge: FORGE,
			runtimeProvider: RUNTIME_PROVIDER,
			bridges: makeBridges(bridgeCalls),
			warrenConfigs,
			projectsConfig: PROJECTS_CONFIG,
			projectSpawn: (async () => ({ stdout: "", stderr: "", exitCode: 0 })) as SpawnFn,
			config: { ...SCHEDULER_CONFIG, disabled: true },
			now: () => NOW,
			spawnRunFn,
			// Self-heal probe (warren-1ec7): treat the clone as present so the
			// tick reaches dispatch without touching disk.
			cloneExists: () => true,
		});

		const result = await handle.runOnce();
		await handle.stop();

		expect(result?.cron).toHaveLength(1);
		expect(result?.cron[0]?.kind).toBe("fired");
		expect(spawnRunCalls).toHaveLength(1);
		expect(spawnRunCalls[0]?.agentName).toBe("claude-code");
		expect(spawnRunCalls[0]?.projectId).toBe(projectId);
		expect(spawnRunCalls[0]?.trigger).toBe("cron");
		// warren-9ce3: explicit provenance + seedId forward from the cron entry.
		expect(spawnRunCalls[0]?.dispatchOrigin).toBe("cron");
		expect(spawnRunCalls[0]?.seedId).toBe("warren-abc");
		// spawnRun threaded the prod plumbing through (refresh hook + cache).
		expect(spawnRunCalls[0]?.projectsConfig).toBe(PROJECTS_CONFIG);
		expect(spawnRunCalls[0]?.warrenConfigs).toBe(warrenConfigs);
		expect(spawnRunCalls[0]?.runtimeProvider).toBe(RUNTIME_PROVIDER);
		expect(bridgeCalls).toHaveLength(1);
		expect(bridgeCalls[0]?.sandboxRunId).toBe("rb_a");
	});

	test("scheduled pass routes through the tracker seam using the configured sdBinary and projectSpawn (warren-6234)", async () => {
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

		const scheduledSpawnCalls: SpawnRunInput[] = [];
		const spawnRunFn = async (input: SpawnRunInput): Promise<SpawnRunResult> => {
			scheduledSpawnCalls.push(input);
			const run = await repos.runs.create({
				agentName: input.agentName,
				projectId: input.projectId,
				prompt: input.prompt,
				renderedAgentJson: { sections: {} },
				trigger: input.trigger ?? "manual",
				...(input.seedId !== undefined ? { seedId: input.seedId } : {}),
			});
			return {
				run,
				sandbox: { id: "bur_b", workspacePath: "/ws" },
				sandboxRun: { id: "rb_b" },
				agent: { name: input.agentName, sections: {} } as never,
			};
		};

		const handle = bootScheduler({
			repos,
			forge: FORGE,
			runtimeProvider: RUNTIME_PROVIDER,
			bridges: makeBridges(bridgeCalls),
			warrenConfigs,
			projectsConfig: PROJECTS_CONFIG,
			projectSpawn,
			config: { ...SCHEDULER_CONFIG, sdBinary: "sd-test", disabled: true },
			// warren-6234: the scheduled pass routes through the tracker
			// seam; a SeedsTracker over the same sdBinary + projectSpawn
			// pair keeps the shell-out assertions meaningful.
			issueTracker: new SeedsTracker({ sdBinary: "sd-test", spawn: projectSpawn }),
			now: () => NOW,
			spawnRunFn,
			cloneExists: () => true,
		});

		const result = await handle.runOnce();
		await handle.stop();

		expect(result?.scheduled).toHaveLength(1);
		const fired = result?.scheduled[0];
		expect(fired?.kind).toBe("fired");
		// warren-9ce3: scheduled origin + seedId land on the spawn input
		// (and therefore on runs.seed_id) rather than only in metadata.
		expect(scheduledSpawnCalls).toHaveLength(1);
		expect(scheduledSpawnCalls[0]?.dispatchOrigin).toBe("scheduled");
		expect(scheduledSpawnCalls[0]?.seedId).toBe("warren-zzzz");
		expect(scheduledSpawnCalls[0]?.trigger).toBe("scheduled");
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

	test("warren-1ec7: a missing clone is re-cloned via projectSpawn and the tick proceeds", async () => {
		const warrenConfigs = createWarrenConfigCache({
			load: async () => ({
				triggers: null,
				defaults: null,
				prTemplate: null,
				sourceFile: null,
				errors: [],
				warnings: [],
			}),
		});

		// Point the projects root at a tmp dir so `cloneProjectRepo`'s real
		// parent-dir mkdir succeeds; the git spawn itself is stubbed.
		const tmpRoot = await mkdtemp(join(tmpdir(), "warren-heal-"));
		let missing = true;
		const gitCommands: string[][] = [];
		const projectSpawn: SpawnFn = async (cmd) => {
			gitCommands.push([...cmd]);
			if (cmd[1] === "clone") missing = false; // clone materialized the dir
			return { stdout: "", stderr: "", exitCode: 0 };
		};

		try {
			const handle = bootScheduler({
				repos,
				forge: FORGE,
				runtimeProvider: RUNTIME_PROVIDER,
				bridges: makeBridges([]),
				warrenConfigs,
				projectsConfig: { root: tmpRoot, gitBinary: "git" },
				projectSpawn,
				config: { ...SCHEDULER_CONFIG, disabled: true },
				now: () => NOW,
				// The clone is absent until the re-clone spawn runs.
				cloneExists: () => !missing,
			});

			const result = await handle.runOnce();
			await handle.stop();

			// The tick self-healed rather than surfacing a project error.
			expect(result?.projectErrors).toEqual([]);
			const cloneCall = gitCommands.find((c) => c[1] === "clone");
			expect(cloneCall).toBeDefined();
			expect(cloneCall).toContain("https://github.com/x/y.git");
		} finally {
			await rm(tmpRoot, { recursive: true, force: true });
		}
	});

	test("ci-fixer dispatch stamps dispatchOrigin=ci_fixer (warren-9ce3)", async () => {
		// Seed an opener run with a failing PR so the ci-fixer pass fires.
		const opener = await repos.runs.create({
			agentName: "claude-code",
			projectId,
			prompt: "open the PR",
			renderedAgentJson: { sections: {} },
			trigger: "manual",
		});
		await repos.runs.markRunning(opener.id, NOW);
		await repos.runs.setPrUrl(opener.id, "fake://x/y/pulls/9");

		const { DEFAULT_RUN_BRANCH_PREFIX } = await import("../runs/branch.ts");
		const forge = new FakeForge();
		const ref = forge.parseRepoRef("fake://x/y/pulls/9");
		if (ref === null) throw new Error("fake forge must own fake:// urls");
		forge.setChecks(ref, `${DEFAULT_RUN_BRANCH_PREFIX}/${opener.id}`, [
			{
				name: "test",
				status: "completed",
				conclusion: "failure",
				jobId: "1",
				detailsUrl: null,
			},
		]);

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
				sandbox: { id: "bur_fix", workspacePath: "/ws" },
				sandboxRun: { id: "rb_fix" },
				agent: { name: input.agentName, sections: {} } as never,
			};
		};

		const handle = bootScheduler({
			repos,
			forge,
			runtimeProvider: RUNTIME_PROVIDER,
			bridges: makeBridges([]),
			warrenConfigs: createWarrenConfigCache({
				load: async () => ({
					triggers: null,
					defaults: {
						ciFixer: {
							enabled: true,
							maxRetries: 2,
							cooldownMinutes: 10,
							logTailLines: 200,
							role: "claude-code",
						},
					},
					prTemplate: null,
					sourceFile: null,
					errors: [],
					warnings: [],
				}),
			}),
			projectsConfig: PROJECTS_CONFIG,
			projectSpawn: (async () => ({ stdout: "", stderr: "", exitCode: 0 })) as SpawnFn,
			config: { ...SCHEDULER_CONFIG, disabled: true },
			now: () => NOW,
			spawnRunFn,
			cloneExists: () => true,
		});

		await handle.runOnce();
		await handle.stop();

		const fixerCall = spawnRunCalls.find((c) => c.trigger === "ci-fixer");
		expect(fixerCall).toBeDefined();
		expect(fixerCall?.dispatchOrigin).toBe("ci_fixer");
	});

	test("disabled config does not schedule an interval", async () => {
		const setIntervalCalls: { ms: number }[] = [];
		const handle = bootScheduler({
			repos,
			forge: FORGE,
			runtimeProvider: RUNTIME_PROVIDER,
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
			forge: FORGE,
			runtimeProvider: RUNTIME_PROVIDER,
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
