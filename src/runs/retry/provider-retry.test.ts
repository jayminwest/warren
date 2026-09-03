/**
 * The post_reap subscriber of the run-level provider-error retry
 * (warren-339d). Drives the handler directly, the way the seed-close
 * subscriber's tests do, against an in-memory DB with a stubbed spawn
 * seam. It asserts that a transient `provider_error` is redispatched with
 * lineage on both runs' streams and that every fail-closed gate skips
 * (durable message, plan-run child, non-failed outcome).
 *
 * The attempt bound lives in `provider-retry.bound.test.ts`, the pure
 * classifier in `provider-retry.classify.test.ts`, and the fixture the two
 * suites share in `provider-retry.test-fixture.ts`.
 */

import { afterEach, describe, expect, test } from "bun:test";
import {
	closeOpenDb,
	createProviderRetryLifecycleExtension,
	envelope,
	fire,
	type ProviderRetryLifecycleExtensionInput,
	type Repos,
	recordingBridges,
	recordingLogger,
	type SpawnCall,
	setup,
	stubSpawn,
	WARREN_EXT_PROTOCOL,
} from "./provider-retry.test-fixture.ts";
import { PROVIDER_RETRY_EVENTS } from "./provider-retry.ts";

afterEach(closeOpenDb);

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

	test("retries an OpenRouter stream break with no structured status", async () => {
		const fixture = await setup({ providerMessage: "Stream ended without finish_reason" });
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

	test("does not retry plan-run children (the coordinator owns child retry)", async () => {
		for (const trigger of ["plan-run", "auto_plan_run"]) {
			const fixture = await setup({ trigger });
			const { spawn } = await fire(fixture);
			expect(spawn.calls).toHaveLength(0);
			closeOpenDb();
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
