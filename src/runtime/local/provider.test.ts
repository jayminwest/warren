import { describe, expect, test } from "bun:test";
import type { BurrowClient } from "../../burrow-client/index.ts";
import { LOCAL_PROVIDER_CAPABILITIES, LocalProvider, type LocalProviderDeps } from "./provider.ts";

/**
 * Hermetic deps for the capability assertions below: the factory throws if a
 * method ever touches the pool. Every method now has a real body — the live
 * paths are covered per-method (`create.test.ts`, `stream.test.ts`,
 * `status.test.ts`, `send-message.test.ts`, `cancel.test.ts`,
 * `teardown.test.ts`, `finalize.test.ts`).
 */
const deps: LocalProviderDeps = {
	burrowClient: (): BurrowClient => {
		throw new Error("burrowClient factory must not be called by a LocalProvider stub");
	},
};

describe("LocalProvider", () => {
	test("advertises the full burrow capability set", () => {
		const provider = new LocalProvider(deps);
		expect(provider.capabilities).toBe(LOCAL_PROVIDER_CAPABILITIES);
		expect(provider.capabilities).toEqual({
			previewPorts: true,
			networkPolicy: "domain-allowlist",
			longLived: true,
			midRunSteering: true,
			enforcedResourceLimits: true,
			workspaceArchive: true,
			workspaceGc: true,
		});
	});

	test("capabilities are frozen", () => {
		expect(Object.isFrozen(LOCAL_PROVIDER_CAPABILITIES)).toBe(true);
	});
});
