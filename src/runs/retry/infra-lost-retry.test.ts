import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { openDatabase, type WarrenDb } from "../../db/client.ts";
import { createRepos, type Repos } from "../../db/repos/index.ts";
import type { RunRow } from "../../db/schema.ts";
import { shouldRetryChild } from "../../plan-runs/retry.ts";
import type { RuntimeProvider } from "../../runtime/contract.ts";
import type { SpawnRunInput, SpawnRunResult } from "../spawn/types.ts";
import {
	createInfraLostRetryHook,
	decideInfraLostRetry,
	isInfraLostRunFailure,
	RUN_RETRY_DISPATCHED_KIND,
	RUN_RETRY_OF_KIND,
} from "./infra-lost-retry.ts";

/**
 * warren-4af7: a run that terminalizes `failed`/`sandbox_run_lost` earns ONE
 * automatic re-dispatch — a NEW run id linked via `runs.retry_of`, same
 * agent/project/prompt/seed, with the original cap MINUS the first attempt's
 * spend on the override slot. A retry that lands infra-lost stays terminal;
 * non-infra-lost failures never retry; plan-run children stand down (the
 * coordinator's warren-6de9 shape owns them).
 */

const NOW = new Date("2026-08-16T12:00:00.000Z");

/** Minimal provider stub — the retry hook never drives it (spawn is stubbed). */
const STUB_PROVIDER: RuntimeProvider = {
	capabilities: {
		previewPorts: false,
		networkPolicy: "none",
		longLived: false,
		midRunSteering: false,
		enforcedResourceLimits: false,
		workspaceArchive: false,
		workspaceGc: false,
	},
	kind: "local",
	create: () => Promise.reject(new Error("not used")),
	streamEvents: () => {
		throw new Error("not used");
	},
	status: () => Promise.reject(new Error("not used")),
	sendMessage: () => Promise.reject(new Error("not used")),
	cancel: () => Promise.reject(new Error("not used")),
	workspaceInfo: () => Promise.reject(new Error("not used")),
	finalize: () => Promise.reject(new Error("not used")),
	terminate: () => Promise.reject(new Error("not used")),
};

interface Harness {
	db: WarrenDb;
	repos: Repos;
	projectId: string;
	spawnCalls: SpawnRunInput[];
	bridgeStarts: string[];
	run: (over?: {
		prompt?: string;
		seedId?: string;
		retryOf?: string;
		costUsd?: number;
		maxCostUsd?: number;
		/** Extra frontmatter frozen onto the run, beside the cap. */
		frontmatter?: Record<string, unknown>;
		failureReason?: "sandbox_run_lost" | "crashed" | "provider_error" | "preempted";
	}) => Promise<RunRow>;
}

async function setup(): Promise<Harness> {
	const db = await openDatabase({ path: ":memory:" });
	const repos = createRepos(db);
	const project = await repos.projects.create({
		gitUrl: "https://github.com/x/y.git",
		localPath: "/data/projects/x/y",
		defaultBranch: "main",
	});
	const h: Harness = {
		db,
		repos,
		projectId: project.id,
		spawnCalls: [],
		bridgeStarts: [],
		run: async (over = {}) => {
			const run = await repos.runs.create({
				agentName: "claude-code",
				projectId: project.id,
				prompt: over.prompt ?? "fix the thing",
				renderedAgentJson: {
					frontmatter: {
						...(over.maxCostUsd !== undefined ? { maxCostUsd: over.maxCostUsd } : {}),
						...(over.frontmatter ?? {}),
					},
					sections: {},
				},
				trigger: "manual",
				...(over.seedId !== undefined ? { seedId: over.seedId } : {}),
				...(over.retryOf !== undefined ? { retryOf: over.retryOf } : {}),
				now: NOW,
			});
			await repos.runs.markRunning(run.id, NOW);
			if (over.costUsd !== undefined) {
				await repos.runs.attachStats(run.id, { costUsd: over.costUsd });
			}
			return repos.runs.finalize(run.id, "failed", NOW, over.failureReason ?? "sandbox_run_lost");
		},
	};
	return h;
}

function hookFor(h: Harness) {
	return createInfraLostRetryHook({
		repos: h.repos,
		runtimeProvider: STUB_PROVIDER,
		bridges: {
			start: (runId) => {
				h.bridgeStarts.push(runId);
			},
		},
		now: () => NOW,
		spawnRunFn: async (input: SpawnRunInput): Promise<SpawnRunResult> => {
			h.spawnCalls.push(input);
			// Persist the retry row the way the real spawnRun would, so the
			// retry_of link and the already_retried budget are real DB state.
			const run = await h.repos.runs.create({
				agentName: input.agentName,
				projectId: input.projectId,
				prompt: input.prompt,
				renderedAgentJson: { frontmatter: {}, sections: {} },
				trigger: input.trigger ?? "manual",
				...(input.retryOf !== undefined ? { retryOf: input.retryOf } : {}),
				now: NOW,
			});
			return {
				run,
				sandbox: { id: "bur_retry", workspacePath: "" },
				sandboxRun: { id: "brun_retry" },
				agent: { name: input.agentName } as SpawnRunResult["agent"],
			};
		},
	});
}

describe("infra-lost run auto-retry (warren-4af7)", () => {
	let h: Harness;

	beforeEach(async () => {
		h = await setup();
	});

	afterEach(async () => {
		await h.db.close();
	});

	test("infra-lost run → one retry with retryOf set and the remaining budget inherited", async () => {
		const original = await h.run({
			prompt: "work warren-xyz",
			seedId: "warren-xyz",
			maxCostUsd: 5,
			costUsd: 2,
		});

		await hookFor(h)(original.id);

		expect(h.spawnCalls).toHaveLength(1);
		const call = h.spawnCalls[0];
		expect(call?.retryOf).toBe(original.id);
		expect(call?.prompt).toBe("work warren-xyz");
		expect(call?.seedId).toBe("warren-xyz");
		expect(call?.projectId).toBe(h.projectId);
		// warren-9ce3: origin is the retry path, not the inherited trigger.
		expect(call?.dispatchOrigin).toBe("retry_infra_lost");
		// Cumulative spend: cap $5 minus the $2 the first attempt burned.
		expect(call?.maxCostUsdOverride).toBe(3);

		// The retry row carries the back-link; the original does not.
		const retry = await h.repos.runs.findByRetryOf(original.id);
		if (retry === null) throw new Error("expected a retry row");
		expect(h.bridgeStarts).toEqual([retry.id]);

		// Linkage events on BOTH runs so the chain is followable either way.
		const originalEvents = await h.repos.events.listByRun(original.id);
		const dispatched = originalEvents.find((e) => e.kind === RUN_RETRY_DISPATCHED_KIND);
		expect(dispatched?.payloadJson).toMatchObject({ retryRunId: retry.id });
		const retryEvents = await h.repos.events.listByRun(retry.id);
		const backlink = retryEvents.find((e) => e.kind === RUN_RETRY_OF_KIND);
		expect(backlink?.payloadJson).toMatchObject({ retryOf: original.id });
	});

	test("carries the provider and model the failed run resolved (warren-0d80)", async () => {
		const original = await h.run({
			frontmatter: { provider: "openrouter", model: "moonshotai/kimi-k3" },
		});
		await hookFor(h)(original.id);
		expect(h.spawnCalls[0]?.providerOverride).toBe("openrouter");
		expect(h.spawnCalls[0]?.modelOverride).toBe("moonshotai/kimi-k3");
	});

	test("keeps the remaining budget as the cap, not the original's full one (warren-0d80)", async () => {
		// The frozen frontmatter carries the FULL $5 cap. warren-4af7 says the
		// retry gets what is left, so the inherited cap must not win here.
		const original = await h.run({ maxCostUsd: 5, costUsd: 2 });
		await hookFor(h)(original.id);
		expect(h.spawnCalls[0]?.maxCostUsdOverride).toBe(3);
	});

	test("passes no provider or model for a run that declared none (warren-0d80)", async () => {
		const original = await h.run({});
		await hookFor(h)(original.id);
		expect(h.spawnCalls[0]?.providerOverride).toBeUndefined();
		expect(h.spawnCalls[0]?.modelOverride).toBeUndefined();
	});

	test("uncapped original → retry dispatches with no cap override", async () => {
		const original = await h.run({});
		await hookFor(h)(original.id);
		expect(h.spawnCalls).toHaveLength(1);
		expect(h.spawnCalls[0]?.maxCostUsdOverride).toBeUndefined();
	});

	test("retry landing infra-lost stays terminal — no third run", async () => {
		const original = await h.run({});
		const retry = await h.run({ retryOf: original.id });

		await hookFor(h)(retry.id);

		expect(h.spawnCalls).toHaveLength(0);
		const decision = await decideInfraLostRetry(h.repos, retry);
		expect(decision.retry).toBe(false);
		expect(decision.skip).toBe("is_retry");
	});

	test("an original that already spawned a retry earns no second one", async () => {
		const original = await h.run({});
		await h.run({ retryOf: original.id });

		await hookFor(h)(original.id);

		expect(h.spawnCalls).toHaveLength(0);
		const decision = await decideInfraLostRetry(h.repos, original);
		expect(decision.skip).toBe("already_retried");
	});

	test("non-infra-lost failure → no retry", async () => {
		const crashed = await h.run({ failureReason: "crashed" });
		await hookFor(h)(crashed.id);
		expect(h.spawnCalls).toHaveLength(0);
		expect(isInfraLostRunFailure("crashed")).toBe(false);
		expect(isInfraLostRunFailure("sandbox_run_lost")).toBe(true);
	});

	// warren-ea4b: Spot preemption joins the retryable infra-lost bucket.
	test("preempted run → one retry; a second preemption stays terminal", async () => {
		expect(isInfraLostRunFailure("preempted")).toBe(true);
		const original = await h.run({ failureReason: "preempted" });

		await hookFor(h)(original.id);

		expect(h.spawnCalls).toHaveLength(1);
		expect(h.spawnCalls[0]?.retryOf).toBe(original.id);
		expect(h.spawnCalls[0]?.dispatchOrigin).toBe("retry_infra_lost");

		// The retry itself landing preempted stays terminal — no third run
		// (the retry-of link IS the budget, same as sandbox_run_lost).
		const retry = await h.run({ retryOf: original.id, failureReason: "preempted" });
		await hookFor(h)(retry.id);
		expect(h.spawnCalls).toHaveLength(1);
		const decision = await decideInfraLostRetry(h.repos, retry);
		expect(decision.retry).toBe(false);
		expect(decision.skip).toBe("is_retry");
	});

	test("exhausted budget → no retry", async () => {
		const original = await h.run({ maxCostUsd: 5, costUsd: 5 });
		await hookFor(h)(original.id);
		expect(h.spawnCalls).toHaveLength(0);
		const decision = await decideInfraLostRetry(h.repos, original);
		expect(decision.skip).toBe("budget_exhausted");
	});

	test("plan-run child infra-lost → run-level hook stands down; coordinator shape covers it", async () => {
		const original = await h.run({ seedId: "warren-a" });
		const { planRun } = await h.repos.planRuns.create({
			planId: "pl-1",
			projectId: h.projectId,
			agentName: "claude-code",
			children: [{ seq: 1, seedId: "warren-a" }],
			now: NOW,
		});
		await h.repos.planRuns.updateChild({
			planRunId: planRun.id,
			seq: 1,
			patch: { runId: original.id, state: "dispatched" },
			now: NOW,
		});

		await hookFor(h)(original.id);

		// No double retry: the coordinator's warren-6de9 shape owns the child.
		expect(h.spawnCalls).toHaveLength(0);
		const decision = await decideInfraLostRetry(h.repos, original);
		expect(decision.skip).toBe("plan_run_child");
		// …and the coordinator shape now recognises the infra-lost cause.
		const child = (await h.repos.planRuns.listChildren(planRun.id))[0];
		expect(child !== undefined && shouldRetryChild(child, "sandbox_run_lost")).toBe(true);
	});
});
