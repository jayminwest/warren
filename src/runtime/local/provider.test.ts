import { describe, expect, test } from "bun:test";
import { LOCAL_PROVIDER_CAPABILITIES, LocalProvider } from "./provider.ts";

/**
 * The provider is engine-only now (warren-ea0a): building it with no deps
 * yields the in-process engine. The live method paths are covered per-method
 * (`engine.test.ts`, `finalize.test.ts`, `drive.test.ts`).
 */
describe("LocalProvider", () => {
	test("advertises the full local capability set", () => {
		const provider = new LocalProvider();
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

	test("reports kind local (warren-e1f1)", () => {
		expect(new LocalProvider().kind).toBe("local");
	});

	test("capabilities are frozen", () => {
		expect(Object.isFrozen(LOCAL_PROVIDER_CAPABILITIES)).toBe(true);
	});
});
