/**
 * Unit test for the PlanRun spawn wrapper (warren-b290 / pl-7937 step 5).
 * Asserts `createPlanRunSpawn` wires trigger / dispatcherHandle / runtime
 * provider through to `spawnRun`'s input bag. The plan-run ↔ plot bridge
 * was removed in warren-b968 and the plot DB surface in warren-0b13.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Burrow, Run as BurrowRun } from "@os-eco/burrow-cli";
import { openDatabase, type WarrenDb } from "../db/client.ts";
import { createRepos, type Repos } from "../db/repos/index.ts";
import { agents } from "../db/schema.ts";
import type { SpawnFn } from "../projects/clone.ts";
import type { SpawnRunInput, SpawnRunResult } from "../runs/index.ts";
import type { BridgeRegistry } from "../runs/stream/types.ts";
import type { RuntimeProvider } from "../runtime/contract.ts";
import { createWarrenConfigCache } from "../warren-config/index.ts";
import { createPlanRunSpawn } from "./dispatch.ts";

const NOW = new Date("2026-05-18T00:00:00.000Z");

// Identity-only runtime provider (warren-c42c). `createPlanRunSpawn` threads it
// straight into `spawnRun`; these tests use a stub `spawnRunFn`, so the provider
// is never invoked — only its identity is asserted.
const RUNTIME_PROVIDER = { kind: "stub" } as unknown as RuntimeProvider;

function makeBridges(): BridgeRegistry {
	return {
		start() {},
		async stopAll() {},
		size: () => 0,
	};
}

describe("createPlanRunSpawn", () => {
	let db: WarrenDb;
	let repos: Repos;
	let projectId: string;

	beforeEach(async () => {
		db = await openDatabase({ path: ":memory:" });
		db.drizzle
			.insert(agents)
			.values({
				name: "claude-code",
				renderedJson: { sections: {} },
				registeredAt: NOW.toISOString(),
				lastRefreshed: NOW.toISOString(),
			})
			.run();
		repos = createRepos(db);
		const project = await repos.projects.create({
			gitUrl: "https://github.com/x/y.git",
			localPath: "/data/projects/x/y",
			defaultBranch: "main",
		});
		projectId = project.id;
	});

	afterEach(async () => {
		await db.close();
	});

	test("forwards trigger / dispatcherHandle / runtimeProvider into spawnRun's input bag", async () => {
		const { planRun } = await repos.planRuns.create({
			planId: "pl-plot",
			projectId,
			agentName: "claude-code",
			children: [{ seq: 1, seedId: "warren-a" }],
			maxCostUsd: 3,
			now: NOW,
		});
		const child = (await repos.planRuns.listChildren(planRun.id))[0];
		if (child === undefined) throw new Error("child seq=1 missing");

		const captured: SpawnRunInput[] = [];
		const spawnRunFn = async (input: SpawnRunInput): Promise<SpawnRunResult> => {
			captured.push(input);
			const run = await repos.runs.create({
				agentName: input.agentName,
				projectId: input.projectId,
				prompt: input.prompt,
				renderedAgentJson: { sections: {} },
				trigger: input.trigger ?? "manual",
				now: NOW,
			});
			return {
				run,
				burrow: { id: "bur_a", workspacePath: "/ws" } as Burrow,
				burrowRun: { id: "rb_a" } as BurrowRun,
				agent: { name: input.agentName, sections: {} } as never,
			};
		};

		// Identity-only stub — asserts the SAME provider instance reaches
		// spawnRun (warren-c531 follow-up: a dropped provider falls back to
		// the burrow-backed LocalProvider, unusable under WARREN_RUNTIME=k8s).
		const runtimeProvider = { kind: "stub" } as unknown as RuntimeProvider;
		const spawn = createPlanRunSpawn({
			repos,
			runtimeProvider,
			bridges: makeBridges(),
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
			projectsConfig: { root: "/data/projects", gitBinary: "git" },
			projectSpawn: (async () => ({ stdout: "", stderr: "", exitCode: 0 })) as SpawnFn,
			seedsCli: {
				sdBinary: "sd",
				spawn: (async () => ({ stdout: "", stderr: "", exitCode: 0 })) as SpawnFn,
			},
			spawnRunFn,
			now: () => NOW,
		});

		await spawn({ planRun, child, prompt: "work on sd warren-a" });

		expect(captured).toHaveLength(1);
		expect(captured[0]?.trigger).toBe("plan-run");
		expect(captured[0]?.dispatcherHandle).toBe(planRun.dispatcherHandle);
		expect(captured[0]?.runtimeProvider).toBe(runtimeProvider);
		// warren-a63d: the plan-run's per-child spend cap rides the override slot.
		expect(captured[0]?.maxCostUsdOverride).toBe(3);
	});

	test("spawns a single child run for a PlanRun with no bindings", async () => {
		const { planRun } = await repos.planRuns.create({
			planId: "pl-noplot",
			projectId,
			agentName: "claude-code",
			children: [{ seq: 1, seedId: "warren-a" }],
			now: NOW,
		});
		const child = (await repos.planRuns.listChildren(planRun.id))[0];
		if (child === undefined) throw new Error("child seq=1 missing");

		const captured: SpawnRunInput[] = [];
		const spawnRunFn = async (input: SpawnRunInput): Promise<SpawnRunResult> => {
			captured.push(input);
			const run = await repos.runs.create({
				agentName: input.agentName,
				projectId: input.projectId,
				prompt: input.prompt,
				renderedAgentJson: { sections: {} },
				trigger: input.trigger ?? "manual",
				now: NOW,
			});
			return {
				run,
				burrow: { id: "bur_b", workspacePath: "/ws" } as Burrow,
				burrowRun: { id: "rb_b" } as BurrowRun,
				agent: { name: input.agentName, sections: {} } as never,
			};
		};

		const spawn = createPlanRunSpawn({
			repos,
			runtimeProvider: RUNTIME_PROVIDER,
			bridges: makeBridges(),
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
			projectsConfig: { root: "/data/projects", gitBinary: "git" },
			projectSpawn: (async () => ({ stdout: "", stderr: "", exitCode: 0 })) as SpawnFn,
			seedsCli: {
				sdBinary: "sd",
				spawn: (async () => ({ stdout: "", stderr: "", exitCode: 0 })) as SpawnFn,
			},
			spawnRunFn,
			now: () => NOW,
		});

		await spawn({ planRun, child, prompt: "work on sd warren-a" });

		expect(captured).toHaveLength(1);
	});
});
