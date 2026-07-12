import { describe, expect, test } from "bun:test";
import type { CoreV1Api } from "@kubernetes/client-node";
import type { RunHandle, RunSpec } from "../contract.ts";
import { RuntimeNotImplementedError } from "../errors.ts";
import { K8S_PROVIDER_CAPABILITIES, K8sProvider, type K8sProviderDeps } from "./provider.ts";

/**
 * Hermetic deps: the coreApi factory throws if invoked. Every method is a
 * deliberate stub that does NOT touch the cluster, so construction + capability
 * reads + stub calls never build a real client (mirrors the LocalProvider shell
 * posture; the live paths land in later plan steps).
 */
const deps: K8sProviderDeps = {
	coreApi: (): CoreV1Api => {
		throw new Error("coreApi factory must not be called by a K8sProvider stub");
	},
};

const handle: RunHandle = {
	runId: "run_test",
	sandboxId: "run-run-test",
	providerRunId: "pod-uid-1",
};

const spec: RunSpec = {
	runId: "run_test",
	originUrl: "https://github.com/acme/widgets.git",
	branch: "warren/run_test",
	baseBranch: "main",
	runtimeId: "claude-code",
	prompt: "do the thing",
	mode: "batch",
	network: "restricted",
	seedFiles: [],
	env: {},
};

describe("K8sProvider", () => {
	test("advertises the degraded K8s v1 capability set", () => {
		const provider = new K8sProvider(deps);
		expect(provider.capabilities).toBe(K8S_PROVIDER_CAPABILITIES);
		expect(provider.capabilities).toEqual({
			previewPorts: false,
			networkPolicy: "coarse",
			longLived: false,
			midRunSteering: false,
			enforcedResourceLimits: true,
			workspaceArchive: false,
		});
	});

	test("capabilities are frozen", () => {
		expect(Object.isFrozen(K8S_PROVIDER_CAPABILITIES)).toBe(true);
	});

	test("construction does not invoke the coreApi factory (no cluster access)", () => {
		expect(() => new K8sProvider(deps)).not.toThrow();
	});

	describe("every method is a not-implemented stub naming its method + plan step", () => {
		const provider = new K8sProvider(deps);

		/** Capture the thrown error so we can assert on both message + recoveryHint. */
		function capture(fn: () => unknown): RuntimeNotImplementedError {
			try {
				fn();
			} catch (err) {
				if (err instanceof RuntimeNotImplementedError) return err;
				throw err;
			}
			throw new Error("expected the stub to throw RuntimeNotImplementedError");
		}

		const cases: ReadonlyArray<[string, string, () => unknown]> = [
			["create", "step 15", () => provider.create(spec)],
			["streamEvents", "step 17", () => provider.streamEvents(handle)],
			["status", "step 16", () => provider.status(handle)],
			["sendMessage", "step 18", () => provider.sendMessage(handle, { body: "hi" })],
			["cancel", "step 19", () => provider.cancel(handle)],
			[
				"finalize",
				"step 20",
				() => provider.finalize(handle, { branch: "b", push: false, mirror: [] }),
			],
			["terminate", "step 19", () => provider.terminate(handle)],
		];

		for (const [method, step, invoke] of cases) {
			test(`${method} → ${step}`, () => {
				const err = capture(invoke);
				expect(err.message).toContain(`K8sProvider.${method}()`);
				expect(err.recoveryHint).toContain(step);
			});
		}
	});
});
