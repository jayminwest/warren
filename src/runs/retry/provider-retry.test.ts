/**
 * The post_reap subscriber of the run-level provider-error retry
 * (warren-339d). Drives the handler directly, the way the seed-close
 * subscriber's tests do, against an in-memory DB with a stubbed spawn
 * seam. It asserts that a transient `provider_error` is redispatched with
 * lineage on both runs' streams, that every fail-closed gate skips
 * (durable message, plan-run child, non-failed outcome), and that the
 * attempt bound stops the lineage and says so.
 *
 * The pure classifier lives in `provider-retry.classify.test.ts`.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { openDatabase, type WarrenDb } from "../../db/client.ts";
import { createRepos } from "../../db/repos/index.ts";
import {
	type LifecycleEnvelope,
	type PostReapPayload,
	WARREN_EXT_PROTOCOL,
} from "../lifecycle-bus.ts";
import type { spawnRun } from "../spawn/index.ts";
import type { BridgeRegistry } from "../stream/types.ts";
import {
	createProviderRetryLifecycleExtension,
	MAX_PROVIDER_RETRIES,
	PROVIDER_RETRY_EVENTS,
	type ProviderRetryLifecycleExtensionInput,
} from "./provider-retry.ts";

// ---- Extension harness ----------------------------------------------------

let openDb: WarrenDb | null = null;
afterEach(() => {
	openDb?.close();
	openDb = null;
});

type Repos = ReturnType<typeof createRepos>;

interface Fixture {
	repos: Repos;
	runId: string;
	projectId: string;
}

async function setup(
	opts: {
		trigger?: string;
		seedId?: string | null;
		providerMessage?: string;
		httpStatus?: number | null;
		upstreamBody?: string | null;
		/** Folded onto the failed run the way a real dispatch freezes it. */
		frontmatter?: Record<string, unknown>;
		/** Provider retries already dispatched in the lineage before this run. */
		priorRetries?: number;
		/** Stamp the failed run itself as a dispatched provider retry (default: `priorRetries > 0`). */
		stampFailedRun?: boolean;
	} = {},
): Promise<Fixture> {
	const db = await openDatabase({ path: ":memory:" });
	openDb = db;
	const repos = createRepos(db);
	await repos.agents.upsert({ name: "refactor-bot", renderedJson: { sections: { system: "x" } } });
	const project = await repos.projects.create({
		gitUrl: "https://github.com/x/y.git",
		localPath: "/data/projects/x/y",
		defaultBranch: "main",
	});
	const ancestorId = await buildRetryLineage(
		repos,
		project.id,
		opts.trigger ?? "manual",
		opts.priorRetries ?? 0,
	);
	const run = await repos.runs.create({
		agentName: "refactor-bot",
		projectId: project.id,
		prompt: "work the seed",
		renderedAgentJson: opts.frontmatter !== undefined ? { frontmatter: opts.frontmatter } : {},
		trigger: opts.trigger ?? "manual",
		sandboxId: "bur_aaaaaaaaaaaa",
		sandboxRunId: "run_zzzzzzzzzzzz",
		...(opts.seedId !== null ? { seedId: opts.seedId ?? "warren-339d" } : {}),
		...(ancestorId !== null ? retryLinks(ancestorId) : {}),
	});
	await repos.runs.markRunning(run.id);
	await repos.runs.finalize(run.id, "failed", new Date(), "provider_error");
	await repos.events.append({
		runId: run.id,
		sandboxEventSeq: 1,
		ts: new Date().toISOString(),
		kind: "reap.provider_error",
		stream: "system",
		payload: {
			message: opts.providerMessage ?? "Network connection lost.",
			httpStatus: opts.httpStatus ?? null,
			upstreamBody: opts.upstreamBody ?? null,
		},
	});
	if (ancestorId !== null && (opts.stampFailedRun ?? true)) {
		await stampProviderRetry(repos, run.id, ancestorId);
	}
	return { repos, runId: run.id, projectId: project.id };
}

/** The row links `dispatchProviderRetry` writes onto the retry it spawns. */
function retryLinks(ancestorId: string) {
	return { parentRunId: ancestorId, cloneKind: "replicate" as const, retryOf: ancestorId };
}

/**
 * The lineage behind the failed run: a root dispatched by hand, then one
 * already-dispatched provider retry for every attempt after the first,
 * linked and stamped the way `dispatchProviderRetry` writes them. Returns
 * the id the failed run links back to, or `null` when it starts a lineage.
 */
async function buildRetryLineage(
	repos: Repos,
	projectId: string,
	trigger: string,
	priorRetries: number,
): Promise<string | null> {
	let ancestorId: string | null = null;
	for (let i = 0; i < priorRetries; i++) {
		const ancestor = await repos.runs.create({
			agentName: "refactor-bot",
			projectId,
			prompt: "work the seed",
			renderedAgentJson: {},
			trigger,
			...(ancestorId !== null ? retryLinks(ancestorId) : {}),
		});
		if (ancestorId !== null) await stampProviderRetry(repos, ancestor.id, ancestorId);
		ancestorId = ancestor.id;
	}
	return ancestorId;
}

/** The lineage stamp `dispatchProviderRetry` appends to a retry's stream. */
async function stampProviderRetry(repos: Repos, runId: string, fromRunId: string): Promise<void> {
	const maxSeq = (await repos.events.maxSeqForRun(runId)) ?? 0;
	await repos.events.append({
		runId,
		sandboxEventSeq: maxSeq + 1,
		ts: new Date().toISOString(),
		kind: PROVIDER_RETRY_EVENTS.spawnRetry,
		stream: "system",
		payload: { retriedFromRunId: fromRunId, providerError: "Network connection lost." },
	});
}

function recordingBridges(): { bridges: BridgeRegistry; started: string[] } {
	const started: string[] = [];
	return {
		started,
		bridges: {
			start: (runId) => void started.push(runId),
			stopAll: async () => {},
			size: () => started.length,
		},
	};
}

function recordingLogger() {
	const lines: Array<{ obj: object; msg?: string }> = [];
	return {
		lines,
		logger: {
			info: (obj: object, msg?: string) => void lines.push({ obj, msg }),
			warn: (obj: object, msg?: string) => void lines.push({ obj, msg }),
			error: (obj: object, msg?: string) => void lines.push({ obj, msg }),
		},
	};
}

type SpawnCall = Parameters<typeof spawnRun>[0];

interface SpawnStub {
	spawnRunFn: typeof spawnRun;
	calls: SpawnCall[];
	newRunId: string;
}

/** A spawnRun stub that persists a real successor row and records its input. */
function stubSpawn(repos: Repos, opts: { throw?: Error } = {}): SpawnStub {
	const calls: SpawnCall[] = [];
	let newRunId = "";
	const spawnRunFn = (async (input: SpawnCall) => {
		calls.push(input);
		if (opts.throw !== undefined) throw opts.throw;
		const row = await repos.runs.create({
			agentName: input.agentName,
			projectId: input.projectId,
			prompt: input.prompt,
			renderedAgentJson: {},
			trigger: input.trigger ?? "manual",
			...(input.seedId !== undefined ? { seedId: input.seedId } : {}),
			...(input.parentRunId !== undefined ? { parentRunId: input.parentRunId } : {}),
			...(input.cloneKind !== undefined ? { cloneKind: input.cloneKind } : {}),
		});
		newRunId = row.id;
		return {
			run: row,
			sandbox: { id: "bur_new", workspacePath: "" },
			sandboxRun: { id: "run_new" },
			agent: { name: input.agentName },
		};
	}) as unknown as typeof spawnRun;
	return {
		spawnRunFn,
		calls,
		get newRunId() {
			return newRunId;
		},
	} as SpawnStub;
}

function envelope(runId: string, projectId: string): LifecycleEnvelope<"post_reap"> {
	const payload: PostReapPayload = {
		runId,
		projectId,
		outcome: "failed",
		branchPushed: false,
		commitsAhead: null,
		prUrl: null,
	};
	return {
		protocol: WARREN_EXT_PROTOCOL,
		hook: "post_reap",
		runId,
		at: "2026-08-07T00:00:00.000Z",
		payload,
	};
}

async function fire(
	fixture: Fixture,
	overrides: Partial<ProviderRetryLifecycleExtensionInput> = {},
): Promise<{ spawn: SpawnStub; started: string[] }> {
	const spawn = stubSpawn(fixture.repos);
	const { bridges, started } = recordingBridges();
	const { logger } = recordingLogger();
	const ext = createProviderRetryLifecycleExtension({
		repos: fixture.repos,
		runtimeProvider: {} as ProviderRetryLifecycleExtensionInput["runtimeProvider"],
		bridges,
		projectsConfig: {} as ProviderRetryLifecycleExtensionInput["projectsConfig"],
		projectSpawn: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
		logger,
		spawnRunFn: spawn.spawnRunFn,
		...overrides,
	});
	await ext.hooks.post_reap?.(envelope(fixture.runId, fixture.projectId));
	return { spawn, started };
}

describe("createProviderRetryLifecycleExtension", () => {
	test("negotiates warren-ext/v1 and subscribes to post_reap only", () => {
		const { logger } = recordingLogger();
		const ext = createProviderRetryLifecycleExtension({
			repos: {} as Repos,
			runtimeProvider: {} as ProviderRetryLifecycleExtensionInput["runtimeProvider"],
			bridges: recordingBridges().bridges,
			projectsConfig: {} as ProviderRetryLifecycleExtensionInput["projectsConfig"],
			projectSpawn: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
			logger,
		});
		expect(ext.name).toBe("provider-retry");
		expect(ext.protocol).toBe(WARREN_EXT_PROTOCOL);
		expect(Object.keys(ext.hooks)).toEqual(["post_reap"]);
	});

	test("redispatches a transient provider_error once with lineage on both streams", async () => {
		const fixture = await setup();
		const { spawn, started } = await fire(fixture);

		expect(spawn.calls).toHaveLength(1);
		const call = spawn.calls[0] as SpawnCall;
		expect(call.agentName).toBe("refactor-bot");
		expect(call.projectId).toBe(fixture.projectId);
		expect(call.prompt).toBe("work the seed");
		expect(call.trigger).toBe("manual");
		expect(call.seedId).toBe("warren-339d");
		// warren-9ce3: origin is the retry path, not the inherited trigger.
		expect(call.dispatchOrigin).toBe("retry_provider");
		expect(call.parentRunId).toBe(fixture.runId);
		expect(call.cloneKind).toBe("replicate");
		// retryOf back-link (warren-eaa6/warren-58ff): the successor row
		// carries the original run's id so retry projections see it.
		expect(call.retryOf).toBe(fixture.runId);
		// A run that declared no provider, model or cap passes none, so the
		// retry resolves off the agent and the project defaults as it did.
		expect(call.providerOverride).toBeUndefined();
		expect(call.modelOverride).toBeUndefined();
		expect(call.maxCostUsdOverride).toBeUndefined();
		expect(started).toEqual([spawn.newRunId]);

		// The successor names its origin (also the single-retry bound marker).
		const newEvents = await fixture.repos.events.listByRun(spawn.newRunId);
		const marker = newEvents.find((e) => e.kind === PROVIDER_RETRY_EVENTS.spawnRetry);
		expect(marker).toBeDefined();
		expect((marker?.payloadJson as { retriedFromRunId?: string }).retriedFromRunId).toBe(
			fixture.runId,
		);
		// The origin names its successor.
		const oldEvents = await fixture.repos.events.listByRun(fixture.runId);
		const dispatched = oldEvents.find((e) => e.kind === PROVIDER_RETRY_EVENTS.retryDispatched);
		expect((dispatched?.payloadJson as { newRunId?: string }).newRunId).toBe(spawn.newRunId);
	});

	test("carries the provider, model and cap the failed run resolved (warren-0d80)", async () => {
		// Observed 2026-08-20: a run dispatched on one model retried on the
		// project default, because the overrides never reached spawnRun.
		const fixture = await setup({
			frontmatter: {
				provider: "openrouter",
				model: "deepseek/deepseek-v4-pro-0813",
				maxCostUsd: 6,
			},
		});
		const { spawn } = await fire(fixture);
		const call = spawn.calls[0] as SpawnCall;
		expect(call.providerOverride).toBe("openrouter");
		expect(call.modelOverride).toBe("deepseek/deepseek-v4-pro-0813");
		expect(call.maxCostUsdOverride).toBe(6);
	});

	test("retries a 5xx httpStatus even when the prose names no status code", async () => {
		const fixture = await setup({
			providerMessage: "the provider returned an empty response",
			httpStatus: 502,
		});
		const { spawn } = await fire(fixture);
		expect(spawn.calls).toHaveLength(1);
	});

	test("does not retry a 4xx httpStatus even when the prose looks transient", async () => {
		const fixture = await setup({
			providerMessage: "connection reset while reaching the model",
			httpStatus: 401,
		});
		const { spawn } = await fire(fixture);
		expect(spawn.calls).toHaveLength(0);
	});

	test("retries an opaque message when the upstreamBody reads transient", async () => {
		const fixture = await setup({
			providerMessage: "Provider returned error",
			upstreamBody: '{"type":"error","error":{"type":"overloaded_error"}}',
		});
		const { spawn } = await fire(fixture);
		expect(spawn.calls).toHaveLength(1);
		expect((spawn.calls[0] as SpawnCall).retryOf).toBe(fixture.runId);
	});

	test("retries an opaque message with a 529 httpStatus", async () => {
		const fixture = await setup({
			providerMessage: "Provider returned error",
			httpStatus: 529,
		});
		const { spawn } = await fire(fixture);
		expect(spawn.calls).toHaveLength(1);
	});

	test("does not retry a 401 httpStatus even when the upstreamBody looks 5xx", async () => {
		const fixture = await setup({
			providerMessage: "Provider returned error",
			httpStatus: 401,
			upstreamBody: "502 bad gateway from the upstream edge",
		});
		const { spawn } = await fire(fixture);
		expect(spawn.calls).toHaveLength(0);
	});

	test("does not retry an opaque message with a durable upstreamBody", async () => {
		const fixture = await setup({
			providerMessage: "Provider returned error",
			upstreamBody: '{"error":{"type":"authentication_error","message":"invalid api key"}}',
		});
		const { spawn } = await fire(fixture);
		expect(spawn.calls).toHaveLength(0);
	});

	test("does not retry a durable provider rejection", async () => {
		const fixture = await setup({
			providerMessage: "400 Your credit balance is too low to access the Anthropic API",
		});
		const { spawn } = await fire(fixture);
		expect(spawn.calls).toHaveLength(0);
	});

	test("does not retry an unrecognized provider message", async () => {
		const fixture = await setup({ providerMessage: "something weird happened" });
		const { spawn } = await fire(fixture);
		expect(spawn.calls).toHaveLength(0);
	});

	test("records reap.provider_retry_skipped with the verdict that declined it", async () => {
		const fixture = await setup({ providerMessage: "401 Unauthorized" });
		await fire(fixture);
		const events = await fixture.repos.events.listByRun(fixture.runId);
		const skipped = events.find((e) => e.kind === PROVIDER_RETRY_EVENTS.retrySkipped);
		expect(skipped).toBeDefined();
		expect(skipped?.payloadJson).toMatchObject({
			verdict: "durable",
			providerError: "401 Unauthorized",
		});
	});

	test("dispatches the retry of a retry, which the old bound refused", async () => {
		// One provider retry already dispatched: the run that just failed IS
		// that retry. The bound used to stop here on the marker alone.
		const fixture = await setup({ priorRetries: 1 });
		const { spawn } = await fire(fixture);
		expect(spawn.calls).toHaveLength(1);
		const events = await fixture.repos.events.listByRun(fixture.runId);
		expect(events.some((e) => e.kind === PROVIDER_RETRY_EVENTS.retryExhausted)).toBe(false);
	});

	test("stops at the bound and records reap.provider_retry_exhausted", async () => {
		const fixture = await setup({ priorRetries: MAX_PROVIDER_RETRIES });
		const { spawn } = await fire(fixture);
		expect(spawn.calls).toHaveLength(0);
		const events = await fixture.repos.events.listByRun(fixture.runId);
		const exhausted = events.find((e) => e.kind === PROVIDER_RETRY_EVENTS.retryExhausted);
		expect(exhausted).toBeDefined();
		expect(exhausted?.payloadJson).toMatchObject({
			attempts: MAX_PROVIDER_RETRIES,
			maxAttempts: MAX_PROVIDER_RETRIES,
		});
	});

	test("counts the stamps, not the retryOf hops, so an infra-lost hop is free", async () => {
		// infra-lost-retry.ts writes `retryOf` on its own dispatch and stamps no
		// `spawn.provider_retry`. A lineage of MAX hops that way therefore still
		// holds one spent provider attempt, not MAX, and has room for another.
		const fixture = await setup({
			priorRetries: MAX_PROVIDER_RETRIES,
			stampFailedRun: false,
		});
		const { spawn } = await fire(fixture);
		expect(spawn.calls).toHaveLength(1);
	});

	test("does not retry plan-run children (the coordinator owns child retry)", async () => {
		for (const trigger of ["plan-run", "auto_plan_run"]) {
			const fixture = await setup({ trigger });
			const { spawn } = await fire(fixture);
			expect(spawn.calls).toHaveLength(0);
			openDb?.close();
			openDb = null;
		}
	});

	test("does not retry a non-provider_error failure", async () => {
		const fixture = await setup();
		// Re-finalize is not possible on a terminal row; create a second run
		// with a different failure reason instead.
		const other = await fixture.repos.runs.create({
			agentName: "refactor-bot",
			projectId: fixture.projectId,
			prompt: "p",
			renderedAgentJson: {},
			trigger: "manual",
		});
		await fixture.repos.runs.markRunning(other.id);
		await fixture.repos.runs.finalize(other.id, "failed", new Date(), "dropped_commit");
		const { spawn } = await fire({ ...fixture, runId: other.id });
		expect(spawn.calls).toHaveLength(0);
	});

	test("records reap.provider_retry_failed when the redispatch throws", async () => {
		const fixture = await setup();
		const spawn = stubSpawn(fixture.repos, { throw: new Error("sandbox provisioning blew up") });
		const { bridges } = recordingBridges();
		const { logger, lines } = recordingLogger();
		const ext = createProviderRetryLifecycleExtension({
			repos: fixture.repos,
			runtimeProvider: {} as ProviderRetryLifecycleExtensionInput["runtimeProvider"],
			bridges,
			projectsConfig: {} as ProviderRetryLifecycleExtensionInput["projectsConfig"],
			projectSpawn: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
			logger,
			spawnRunFn: spawn.spawnRunFn,
		});
		await ext.hooks.post_reap?.(envelope(fixture.runId, fixture.projectId));

		expect(spawn.calls).toHaveLength(1);
		const events = await fixture.repos.events.listByRun(fixture.runId);
		const failed = events.find((e) => e.kind === PROVIDER_RETRY_EVENTS.retryFailed);
		expect(failed).toBeDefined();
		expect(lines.some((l) => l.msg === "provider-retry.failed")).toBe(true);
	});
});
