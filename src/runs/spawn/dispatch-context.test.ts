/**
 * Dispatch-context writer (warren-d6ca). Exercises the REAL spawnRun across
 * representative dispatch paths and asserts exactly one context row each.
 * One test proves a throwing context write still dispatches.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { WarrenDb } from "../../db/client.ts";
import type { Repos } from "../../db/repos/index.ts";
import { createWarrenConfigCache } from "../../warren-config/cache.ts";
import {
	deriveRetryKind,
	resolveCapSource,
	resolveFieldSource,
	writeDispatchContext,
} from "./dispatch-context.ts";
import { spawnRun } from "./index.ts";
import { makeAgentJson, makeProvider, makeSandboxClient, setupRepos } from "./test-helpers.ts";

const FIXED_NOW = new Date("2026-08-19T12:00:00.000Z");

describe("dispatch-context pure helpers (warren-d6ca)", () => {
	test("resolveFieldSource ranks override > project_default > frontmatter", () => {
		expect(resolveFieldSource("op", "pd", "v")).toBe("override");
		expect(resolveFieldSource(undefined, "pd", "v")).toBe("project_default");
		expect(resolveFieldSource("  ", undefined, "v")).toBe("frontmatter");
		expect(resolveFieldSource(undefined, undefined, undefined)).toBeNull();
	});

	test("resolveCapSource ranks override > frontmatter > project_default", () => {
		expect(
			resolveCapSource({
				maxCostUsdOverride: 3,
				baseFrontmatter: { maxCostUsd: 1 },
				frontmatter: { maxCostUsd: 3 },
				projectDefaultMaxCostUsd: 2,
			}),
		).toEqual({ source: "override", value: 3 });
		expect(
			resolveCapSource({
				baseFrontmatter: { maxCostUsd: 1 },
				frontmatter: { maxCostUsd: 1 },
				projectDefaultMaxCostUsd: 2,
			}),
		).toEqual({ source: "frontmatter", value: 1 });
		// Project default folded onto post-fold frontmatter must still attribute
		// the tier to project_default (baseFrontmatter had no declaration).
		expect(
			resolveCapSource({
				baseFrontmatter: {},
				frontmatter: { maxCostUsd: 2.5 },
				projectDefaultMaxCostUsd: 2.5,
			}),
		).toEqual({ source: "project_default", value: 2.5 });
		expect(resolveCapSource({ baseFrontmatter: {}, frontmatter: {} })).toEqual({
			source: null,
			value: null,
		});
	});

	test("deriveRetryKind prefers dispatchOrigin, falls back to row shape", () => {
		expect(
			deriveRetryKind({ retryOf: null, parentRunId: null, cloneKind: null }, "retry_infra_lost"),
		).toBe("infra_lost");
		expect(
			deriveRetryKind({ retryOf: null, parentRunId: null, cloneKind: null }, "retry_provider"),
		).toBe("provider_error");
		expect(
			deriveRetryKind({ retryOf: "run_a", parentRunId: null, cloneKind: null }, undefined),
		).toBe("infra_lost");
		expect(
			deriveRetryKind(
				{ retryOf: "run_a", parentRunId: "run_a", cloneKind: "replicate" },
				undefined,
			),
		).toBe("provider_error");
		expect(
			deriveRetryKind({ retryOf: null, parentRunId: "run_a", cloneKind: "continue" }, "plan_run"),
		).toBe("none");
	});
});

describe("spawnRun: dispatch-context writer (warren-d6ca)", () => {
	let db: WarrenDb;
	let repos: Repos;

	beforeEach(async () => {
		({ db, repos } = await setupRepos());
	});
	afterEach(async () => {
		await db.close();
	});

	test("plain api dispatch writes exactly one context row with chosen action + queue", async () => {
		await repos.agents.upsert({
			name: "pi",
			renderedJson: makeAgentJson({
				name: "pi",
				frontmatter: { provider: "anthropic", model: "claude-sonnet-4", maxCostUsd: 1 },
				sections: {
					system: "sys",
					burrow_config: `[sandbox]\nnetwork = "restricted"`,
				},
			}),
		});
		const { client } = makeSandboxClient();
		const result = await spawnRun({
			repos,
			runtimeProvider: makeProvider(client),
			agentName: "pi",
			projectId: "prj_xxxxxxxxxxxx",
			prompt: "fix the flaky test",
			trigger: "manual",
			dispatchOrigin: "api",
			dispatcherHandle: "operator",
			seedId: "warren-d6ca",
			// Compatible anthropic model id — override only the provider tier.
			providerOverride: "anthropic",
			maxCostUsdOverride: 5,
			now: () => FIXED_NOW,
		});

		const ctx = await repos.dispatchContext.getByRunId(result.run.id);
		expect(ctx).toMatchObject({
			runId: result.run.id,
			agentName: "pi",
			provider: "anthropic",
			model: "claude-sonnet-4",
			providerSource: "override",
			modelSource: "frontmatter",
			capSource: "override",
			maxCostUsd: 5,
			runtimeBackend: "local",
			promptBytes: new TextEncoder().encode("fix the flaky test").byteLength,
			mode: "batch",
			network: "restricted",
			queueQueuedRuns: 1, // the just-created run
			queueRunningRuns: 0,
			queueProjectNonTerminal: 1,
			queueSnapshotSource: "runs_table",
			trigger: "manual",
			dispatchOrigin: "api",
			dispatcherHandle: "operator",
			retryKind: "none",
			attemptNo: 1,
			rootRunId: result.run.id,
			seedId: "warren-d6ca",
		});
		// Exactly one row for this run (idempotent insert).
		expect(await repos.dispatchContext.getByRunId(result.run.id)).toEqual(ctx);
	});

	test("never-started failure still gets a context row (written before runtime contact)", async () => {
		const provider = makeProvider(makeSandboxClient().client);
		provider.create = () => Promise.reject(new Error("provision boom"));
		await expect(
			spawnRun({
				repos,
				runtimeProvider: provider,
				agentName: "refactor-bot",
				projectId: "prj_xxxxxxxxxxxx",
				prompt: "never starts",
				dispatchOrigin: "api",
				now: () => FIXED_NOW,
			}),
		).rejects.toThrow("provision boom");

		const runs = await repos.runs.listAll();
		expect(runs).toHaveLength(1);
		const run = runs[0];
		if (run === undefined) throw new Error("expected a run row");
		const ctx = await repos.dispatchContext.getByRunId(run.id);
		expect(ctx).toMatchObject({
			runId: run.id,
			retryKind: "none",
			dispatchOrigin: "api",
			queueSnapshotSource: "runs_table",
		});
	});

	test("infra-lost retry normalizes lineage: kind=infra_lost, attempt_no=2, root=original", async () => {
		const { client } = makeSandboxClient();
		const original = await spawnRun({
			repos,
			runtimeProvider: makeProvider(client),
			agentName: "refactor-bot",
			projectId: "prj_xxxxxxxxxxxx",
			prompt: "original",
			dispatchOrigin: "api",
			now: () => FIXED_NOW,
		});
		const retry = await spawnRun({
			repos,
			runtimeProvider: makeProvider(client),
			agentName: "refactor-bot",
			projectId: "prj_xxxxxxxxxxxx",
			prompt: "original",
			dispatchOrigin: "retry_infra_lost",
			retryOf: original.run.id,
			now: () => FIXED_NOW,
		});

		const ctx = await repos.dispatchContext.getByRunId(retry.run.id);
		expect(ctx).toMatchObject({
			runId: retry.run.id,
			retryKind: "infra_lost",
			retryOfRunId: original.run.id,
			parentRunId: null,
			attemptNo: 2,
			rootRunId: original.run.id,
			dispatchOrigin: "retry_infra_lost",
		});
	});

	test("provider-retry normalizes lineage: kind=provider_error, attempt_no=2", async () => {
		const { client } = makeSandboxClient();
		const original = await spawnRun({
			repos,
			runtimeProvider: makeProvider(client),
			agentName: "refactor-bot",
			projectId: "prj_xxxxxxxxxxxx",
			prompt: "original",
			dispatchOrigin: "api",
			now: () => FIXED_NOW,
		});
		const retry = await spawnRun({
			repos,
			runtimeProvider: makeProvider(client),
			agentName: "refactor-bot",
			projectId: "prj_xxxxxxxxxxxx",
			prompt: "original",
			dispatchOrigin: "retry_provider",
			parentRunId: original.run.id,
			cloneKind: "replicate",
			retryOf: original.run.id,
			now: () => FIXED_NOW,
		});

		const ctx = await repos.dispatchContext.getByRunId(retry.run.id);
		expect(ctx).toMatchObject({
			runId: retry.run.id,
			retryKind: "provider_error",
			retryOfRunId: original.run.id,
			parentRunId: original.run.id,
			attemptNo: 2,
			rootRunId: original.run.id,
			dispatchOrigin: "retry_provider",
		});
	});

	test("plan_run dispatch captures planRunId from metadata; retry_kind stays none", async () => {
		const { client } = makeSandboxClient();
		const result = await spawnRun({
			repos,
			runtimeProvider: makeProvider(client),
			agentName: "refactor-bot",
			projectId: "prj_xxxxxxxxxxxx",
			prompt: "do the child",
			trigger: "plan-run",
			dispatchOrigin: "plan_run",
			seedId: "warren-child",
			dispatcherHandle: "planner",
			metadata: { planRunId: "plr_aaaaaaaaaaaa", planId: "pl-a37b", childSeq: 0 },
			now: () => FIXED_NOW,
		});

		const ctx = await repos.dispatchContext.getByRunId(result.run.id);
		expect(ctx).toMatchObject({
			runId: result.run.id,
			dispatchOrigin: "plan_run",
			planRunId: "plr_aaaaaaaaaaaa",
			seedId: "warren-child",
			dispatcherHandle: "planner",
			// Plan-child retries carry no run-row marker — kind stays none.
			retryKind: "none",
			attemptNo: 1,
			rootRunId: result.run.id,
		});
	});

	test("cron dispatch captures triggerId from metadata", async () => {
		const { client } = makeSandboxClient();
		const result = await spawnRun({
			repos,
			runtimeProvider: makeProvider(client),
			agentName: "refactor-bot",
			projectId: "prj_xxxxxxxxxxxx",
			prompt: "nightly sweep",
			trigger: "cron",
			dispatchOrigin: "cron",
			seedId: "warren-seed",
			metadata: { triggerId: "nightly", cron: "0 0 * * *", seed: "warren-seed" },
			now: () => FIXED_NOW,
		});

		const ctx = await repos.dispatchContext.getByRunId(result.run.id);
		expect(ctx).toMatchObject({
			dispatchOrigin: "cron",
			triggerId: "nightly",
			seedId: "warren-seed",
			trigger: "cron",
		});
	});

	test("project-default provider/model/cap sources stamp project_default", async () => {
		await repos.agents.upsert({
			name: "pi",
			renderedJson: makeAgentJson({ name: "pi", frontmatter: {} }),
		});
		const warrenConfigs = createWarrenConfigCache({
			load: async () => ({
				triggers: null,
				defaults: {
					defaultProvider: "anthropic",
					defaultModel: "claude-opus-4-7",
					maxCostUsd: 2.5,
				},
				prTemplate: null,
				sourceFile: null,
				errors: [],
				warnings: [],
			}),
		});
		const { client } = makeSandboxClient();
		const result = await spawnRun({
			repos,
			runtimeProvider: makeProvider(client),
			agentName: "pi",
			projectId: "prj_xxxxxxxxxxxx",
			prompt: "p",
			warrenConfigs,
			now: () => FIXED_NOW,
		});

		const ctx = await repos.dispatchContext.getByRunId(result.run.id);
		expect(ctx).toMatchObject({
			provider: "anthropic",
			model: "claude-opus-4-7",
			providerSource: "project_default",
			modelSource: "project_default",
			capSource: "project_default",
			maxCostUsd: 2.5,
		});
	});

	test("a throwing context write still dispatches (fire-and-log)", async () => {
		const { client, calls } = makeSandboxClient();
		const warnings: Array<{ obj: object; msg?: string }> = [];
		const logger = {
			info() {},
			warn(obj: object, msg?: string) {
				warnings.push({ obj, msg });
			},
			error() {},
		};

		// Force the insert path to throw by replacing the repo method.
		const original = repos.dispatchContext.insert.bind(repos.dispatchContext);
		repos.dispatchContext.insert = async () => {
			throw new Error("disk full");
		};

		const result = await spawnRun({
			repos,
			runtimeProvider: makeProvider(client),
			agentName: "refactor-bot",
			projectId: "prj_xxxxxxxxxxxx",
			prompt: "still works",
			dispatchOrigin: "api",
			logger,
			now: () => FIXED_NOW,
		});

		// Dispatch completed — provider was contacted, run attached.
		expect(result.run.sandboxId).toBe("bur_aaaaaaaaaaaa");
		expect(result.run.sandboxRunId).toBe("run_zzzzzzzzzzzz");
		expect(calls.some((c) => c.method === "POST" && c.path === "/sandboxes")).toBe(true);

		// Warn + system event landed.
		expect(warnings.some((w) => w.msg?.includes("dispatch-context"))).toBe(true);
		const events = await repos.events.listByRun(result.run.id);
		expect(events.some((e) => e.kind === "dispatch_context_write_failed")).toBe(true);

		// No context row (insert never landed).
		expect(await repos.dispatchContext.getByRunId(result.run.id)).toBeUndefined();

		// Restore for afterEach cleanliness.
		repos.dispatchContext.insert = original;
	});

	test("queue snapshot counts sibling non-terminal runs in the same project", async () => {
		const { client } = makeSandboxClient();
		// Seed a running sibling so the snapshot sees more than just self.
		const sibling = await repos.runs.create({
			agentName: "refactor-bot",
			projectId: "prj_xxxxxxxxxxxx",
			renderedAgentJson: {},
			prompt: "sibling",
			trigger: "manual",
		});
		await repos.runs.markRunning(sibling.id, FIXED_NOW);

		const result = await spawnRun({
			repos,
			runtimeProvider: makeProvider(client),
			agentName: "refactor-bot",
			projectId: "prj_xxxxxxxxxxxx",
			prompt: "me",
			now: () => FIXED_NOW,
		});

		const ctx = await repos.dispatchContext.getByRunId(result.run.id);
		expect(ctx).toMatchObject({
			// self (queued) + sibling (running)
			queueQueuedRuns: 1,
			queueRunningRuns: 1,
			queueProjectNonTerminal: 2,
			queueSnapshotSource: "runs_table",
		});
	});
});

describe("writeDispatchContext fire-and-log (unit)", () => {
	let db: WarrenDb;
	let repos: Repos;

	beforeEach(async () => {
		({ db, repos } = await setupRepos());
	});
	afterEach(async () => {
		await db.close();
	});

	test("swallows builder/insert failures without throwing", async () => {
		const run = await repos.runs.create({
			agentName: "refactor-bot",
			projectId: "prj_xxxxxxxxxxxx",
			renderedAgentJson: makeAgentJson(),
			prompt: "x",
			trigger: "manual",
		});
		repos.dispatchContext.insert = async () => {
			throw new Error("boom");
		};
		const { client } = makeSandboxClient();
		await expect(
			writeDispatchContext({
				spawn: {
					repos,
					runtimeProvider: makeProvider(client),
					agentName: "refactor-bot",
					projectId: "prj_xxxxxxxxxxxx",
					prompt: "x",
					now: () => FIXED_NOW,
				},
				run,
				agent: makeAgentJson(),
				baseAgent: makeAgentJson(),
				declaredProvider: undefined,
				declaredModel: undefined,
				projectDefaults: null,
				network: "none",
			}),
		).resolves.toBeUndefined();
	});
});
