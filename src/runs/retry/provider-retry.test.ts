/**
 * Run-level provider-error retry (warren-339d).
 *
 * Two halves, exercised separately:
 *
 *   1. `classifyProviderError` — the transient-vs-durable discriminator.
 *      Only network/upstream-class messages retry; auth, model, quota,
 *      rate-limit, and malformed-request rejections fail closed, as does
 *      anything unrecognized.
 *
 *   2. `createProviderRetryLifecycleExtension` — the post_reap subscriber.
 *      Drives the handler directly (like the seed-close subscriber's
 *      tests) against an in-memory DB with a stubbed spawn seam, and
 *      asserts the redispatch fires exactly once for a transient
 *      provider_error, stamps lineage on both runs' streams, and skips
 *      every fail-closed gate (durable message, plan-run child, already
 *      a retry, non-failed outcome).
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
	classifyProviderError,
	createProviderRetryLifecycleExtension,
	PROVIDER_RETRY_EVENTS,
	type ProviderRetryLifecycleExtensionInput,
} from "./provider-retry.ts";

describe("classifyProviderError", () => {
	test("classifies network-class messages as transient", () => {
		expect(classifyProviderError("Network connection lost.")).toBe("transient");
		expect(classifyProviderError("read ECONNRESET")).toBe("transient");
		expect(classifyProviderError("socket hang up")).toBe("transient");
		expect(classifyProviderError("fetch failed")).toBe("transient");
		expect(classifyProviderError("request timed out after 30s")).toBe("transient");
		expect(classifyProviderError("connect ETIMEDOUT 10.0.0.1:443")).toBe("transient");
	});

	test("classifies upstream 5xx / overload messages as transient", () => {
		expect(classifyProviderError("502 Bad Gateway")).toBe("transient");
		expect(classifyProviderError("503 Service Unavailable")).toBe("transient");
		expect(classifyProviderError("529 overloaded_error")).toBe("transient");
		expect(classifyProviderError("Internal server error")).toBe("transient");
	});

	test("classifies auth failures as durable", () => {
		expect(classifyProviderError("401 Unauthorized")).toBe("durable");
		expect(classifyProviderError("invalid x-api-key provided")).toBe("durable");
		expect(classifyProviderError("authentication_error: invalid api key")).toBe("durable");
		expect(classifyProviderError("403 Forbidden")).toBe("durable");
	});

	test("classifies model-not-found as durable", () => {
		expect(classifyProviderError("404 model 'kimi-k3' not found")).toBe("durable");
		expect(classifyProviderError("The model `gpt-x` does not exist")).toBe("durable");
		expect(classifyProviderError("not_found_error: model")).toBe("durable");
	});

	test("classifies quota / billing / rate-limit as durable", () => {
		expect(
			classifyProviderError("400 Your credit balance is too low to access the Anthropic API"),
		).toBe("durable");
		expect(classifyProviderError("402 payment required: quota exceeded")).toBe("durable");
		expect(classifyProviderError("429 rate limit exceeded")).toBe("durable");
		expect(classifyProviderError("Too many requests")).toBe("durable");
	});

	test("fails closed on unrecognized messages", () => {
		expect(classifyProviderError("")).toBe("unknown");
		expect(classifyProviderError("something weird happened")).toBe("unknown");
		expect(classifyProviderError("the agent exploded")).toBe("unknown");
	});

	test("reads the structured httpStatus before the prose fallback", () => {
		// 5xx short-circuits to transient even with no status token in the
		// prose (warren-f8b2).
		expect(classifyProviderError("the upstream gateway choked", 502)).toBe("transient");
		expect(classifyProviderError("something weird happened", 503)).toBe("transient");
		// 4xx short-circuits to durable even when the prose looks transient.
		expect(classifyProviderError("connection reset by peer", 401)).toBe("durable");
		expect(classifyProviderError("request failed", 429)).toBe("durable");
		// Null/undefined/out-of-range status falls back to the message parse.
		expect(classifyProviderError("something weird happened", null)).toBe("unknown");
		expect(classifyProviderError("Network connection lost.", undefined)).toBe("transient");
		expect(classifyProviderError("something weird happened", Number.NaN)).toBe("unknown");
		expect(classifyProviderError("something weird happened", 200)).toBe("unknown");
	});

	test("reads the structured upstreamBody before the message prose", () => {
		// Opaque harness message (pi's OPAQUE_MESSAGE) with a transient
		// upstream body retries (warren-eaa6).
		expect(classifyProviderError("Provider returned error", null, "529 overloaded_error")).toBe(
			"transient",
		);
		expect(classifyProviderError("Provider returned error", null, '{"error":"bad gateway"}')).toBe(
			"transient",
		);
		// A durable upstream body fails closed even though the surface
		// message is opaque.
		expect(classifyProviderError("Provider returned error", null, "invalid api key")).toBe(
			"durable",
		);
		// An unrecognized body falls through to the message prose.
		expect(classifyProviderError("Network connection lost.", null, "weird body")).toBe("transient");
		expect(classifyProviderError("something weird happened", null, "weird body")).toBe("unknown");
		// httpStatus still wins over the body tier.
		expect(classifyProviderError("Provider returned error", 401, "502 bad gateway")).toBe(
			"durable",
		);
	});

	test("durable wins when a message names both a symptom and a cause", () => {
		expect(classifyProviderError("request failed with 401: connection reset by peer")).toBe(
			"durable",
		);
	});
});

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
	const run = await repos.runs.create({
		agentName: "refactor-bot",
		projectId: project.id,
		prompt: "work the seed",
		renderedAgentJson: {},
		trigger: opts.trigger ?? "manual",
		sandboxId: "bur_aaaaaaaaaaaa",
		sandboxRunId: "run_zzzzzzzzzzzz",
		...(opts.seedId !== null ? { seedId: opts.seedId ?? "warren-339d" } : {}),
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
	return { repos, runId: run.id, projectId: project.id };
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

	test("does not retry a run that is itself a provider retry (single-retry bound)", async () => {
		const fixture = await setup();
		await fixture.repos.events.append({
			runId: fixture.runId,
			sandboxEventSeq: 2,
			ts: new Date().toISOString(),
			kind: PROVIDER_RETRY_EVENTS.spawnRetry,
			stream: "system",
			payload: { retriedFromRunId: "run_origin", providerError: "Network connection lost." },
		});
		const { spawn } = await fire(fixture);
		expect(spawn.calls).toHaveLength(0);
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
