import { describe, expect, test } from "bun:test";
import type { BurrowClientPool } from "../../burrow-client/index.ts";
import type { RunHandle, RunSpec } from "../contract.ts";
import { RuntimeNotImplementedError } from "../errors.ts";
import { LOCAL_PROVIDER_CAPABILITIES, LocalProvider, type LocalProviderDeps } from "./provider.ts";

/** Hermetic deps: the factory throws if the shell ever touches the pool. */
const deps: LocalProviderDeps = {
	burrowClientPool: (): BurrowClientPool => {
		throw new Error("burrowClientPool factory must not be called by the LocalProvider shell");
	},
};

const handle: RunHandle = { runId: "r1", sandboxId: "s1", providerRunId: "p1" };

function newSpec(): RunSpec {
	return {
		runId: "r1",
		originUrl: "https://github.com/o/r.git",
		branch: "warren/r1",
		baseBranch: "main",
		runtimeId: "claude-code",
		prompt: "do the thing",
		mode: "batch",
		network: "restricted",
		seedFiles: [],
		env: {},
	};
}

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
		});
	});

	test("capabilities are frozen", () => {
		expect(Object.isFrozen(LOCAL_PROVIDER_CAPABILITIES)).toBe(true);
	});

	test("create() is a stub that names the method", () => {
		const provider = new LocalProvider(deps);
		expect(() => provider.create(newSpec())).toThrow(RuntimeNotImplementedError);
		expect(() => provider.create(newSpec())).toThrow(/create/);
	});

	test("status() is a stub", () => {
		const provider = new LocalProvider(deps);
		expect(() => provider.status(handle)).toThrow(RuntimeNotImplementedError);
	});

	test("sendMessage() is a stub", () => {
		const provider = new LocalProvider(deps);
		expect(() => provider.sendMessage(handle, { body: "hi" })).toThrow(RuntimeNotImplementedError);
	});

	test("cancel() is a stub", () => {
		const provider = new LocalProvider(deps);
		expect(() => provider.cancel(handle)).toThrow(RuntimeNotImplementedError);
	});

	test("finalize() is a stub", () => {
		const provider = new LocalProvider(deps);
		expect(() =>
			provider.finalize(handle, { branch: "warren/r1", push: true, mirror: [] }),
		).toThrow(RuntimeNotImplementedError);
	});

	test("terminate() is a stub", () => {
		const provider = new LocalProvider(deps);
		expect(() => provider.terminate(handle)).toThrow(RuntimeNotImplementedError);
	});

	test("streamEvents() is a stub that throws synchronously", () => {
		const provider = new LocalProvider(deps);
		expect(() => provider.streamEvents(handle)).toThrow(RuntimeNotImplementedError);
	});
});
