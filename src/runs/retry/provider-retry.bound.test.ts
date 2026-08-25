/**
 * The attempt bound of the provider-error retry (warren-ac61).
 *
 * How deep one lineage may go, what it records when it stops, and what it
 * deliberately does not record. Split out of `provider-retry.test.ts`, which
 * sat one line under the file-size ceiling before these arrived.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { closeOpenDb, fire, type SpawnCall, setup } from "./provider-retry.test-fixture.ts";
import { MAX_PROVIDER_RETRIES, PROVIDER_RETRY_EVENTS } from "./provider-retry.ts";

afterEach(closeOpenDb);

describe("the provider-retry attempt bound", () => {
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

	test("carries the overrides on the last retry the bound allows", async () => {
		// The bound raises how deep a lineage goes, so the inheritance has to
		// hold at the deepest hop, not just the first one.
		const fixture = await setup({
			priorRetries: MAX_PROVIDER_RETRIES - 1,
			frontmatter: {
				provider: "openrouter",
				model: "deepseek/deepseek-v4-pro-0813",
				maxCostUsd: 6,
			},
		});
		const { spawn } = await fire(fixture);
		expect(spawn.calls).toHaveLength(1);
		const call = spawn.calls[0] as SpawnCall;
		expect(call.providerOverride).toBe("openrouter");
		expect(call.modelOverride).toBe("deepseek/deepseek-v4-pro-0813");
		expect(call.maxCostUsdOverride).toBe(6);
	});

	test("stays silent with no provider signal, even once the bound is spent", async () => {
		// docs/design/provider-retry.md section 3: a run whose stream holds no
		// reap.provider_error message never reached the classifier, so it gets no
		// event. An exhaustion verdict would describe a decision nobody made.
		const fixture = await setup({
			priorRetries: MAX_PROVIDER_RETRIES,
			providerMessage: "",
		});
		const { spawn } = await fire(fixture);
		expect(spawn.calls).toHaveLength(0);
		const events = await fixture.repos.events.listByRun(fixture.runId);
		// `spawn.provider_retry` is the fixture stamping the prior hops, so the
		// assertion is on the verdicts this gate would have written.
		for (const kind of [
			PROVIDER_RETRY_EVENTS.retryExhausted,
			PROVIDER_RETRY_EVENTS.retrySkipped,
			PROVIDER_RETRY_EVENTS.retryDispatched,
			PROVIDER_RETRY_EVENTS.retryFailed,
		]) {
			expect(
				events.some((e) => e.kind === kind),
				kind,
			).toBe(false);
		}
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
});
