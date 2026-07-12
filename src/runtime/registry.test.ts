import { describe, expect, test } from "bun:test";
import type { CoreV1Api } from "@kubernetes/client-node";
import type { BurrowClient } from "../burrow-client/index.ts";
import { UnknownRuntimeError } from "./errors.ts";
import { K8sProvider } from "./k8s/provider.ts";
import { LocalProvider } from "./local/provider.ts";
import {
	DEFAULT_RUNTIME_KIND,
	type RuntimeProviderDeps,
	resolveRuntimeKind,
	resolveRuntimeProvider,
} from "./registry.ts";

/**
 * Hermetic deps: the pool factory throws if invoked. No stub method calls it, so
 * resolution + capability reads never touch burrow — no socket, no DB.
 */
const deps: RuntimeProviderDeps = {
	burrowClient: (): BurrowClient => {
		throw new Error("burrowClient factory must not be called by the LocalProvider shell");
	},
	// Fake K8s client factory: throws if invoked. No shell method calls it, so
	// building a K8sProvider off WARREN_RUNTIME=k8s never touches a cluster.
	k8sCoreApi: (): CoreV1Api => {
		throw new Error("k8sCoreApi factory must not be called by the K8sProvider shell");
	},
};

describe("resolveRuntimeKind", () => {
	test("defaults to local when WARREN_RUNTIME is unset", () => {
		expect(resolveRuntimeKind({})).toBe("local");
		expect(DEFAULT_RUNTIME_KIND).toBe("local");
	});

	test("treats a blank / whitespace value as unset (default local)", () => {
		expect(resolveRuntimeKind({ WARREN_RUNTIME: "" })).toBe("local");
		expect(resolveRuntimeKind({ WARREN_RUNTIME: "   " })).toBe("local");
	});

	test("accepts the explicit local selector", () => {
		expect(resolveRuntimeKind({ WARREN_RUNTIME: "local" })).toBe("local");
	});

	test("accepts the k8s selector (kind parses; provider build is what defers)", () => {
		expect(resolveRuntimeKind({ WARREN_RUNTIME: "k8s" })).toBe("k8s");
	});

	test("fails loudly on an unknown value rather than falling back", () => {
		expect(() => resolveRuntimeKind({ WARREN_RUNTIME: "docker" })).toThrow(UnknownRuntimeError);
	});
});

describe("resolveRuntimeProvider", () => {
	test("resolves LocalProvider by default", () => {
		const provider = resolveRuntimeProvider(deps, {});
		expect(provider).toBeInstanceOf(LocalProvider);
	});

	test("resolves LocalProvider for explicit WARREN_RUNTIME=local", () => {
		const provider = resolveRuntimeProvider(deps, { WARREN_RUNTIME: "local" });
		expect(provider).toBeInstanceOf(LocalProvider);
	});

	test("advertises the full burrow capability set", () => {
		const provider = resolveRuntimeProvider(deps, {});
		expect(provider.capabilities).toEqual({
			previewPorts: true,
			networkPolicy: "domain-allowlist",
			longLived: true,
			midRunSteering: true,
			enforcedResourceLimits: true,
			workspaceArchive: true,
		});
	});

	test("resolves K8sProvider for WARREN_RUNTIME=k8s (skeleton, phase K8S)", () => {
		const provider = resolveRuntimeProvider(deps, { WARREN_RUNTIME: "k8s" });
		expect(provider).toBeInstanceOf(K8sProvider);
	});

	test("builds K8sProvider without a cluster — the coreApi factory is not invoked at construction", () => {
		// The fake k8sCoreApi throws if called; construction succeeding proves the
		// shell never touches the cluster (mirrors the LocalProvider pool posture).
		expect(() => resolveRuntimeProvider(deps, { WARREN_RUNTIME: "k8s" })).not.toThrow();
	});

	test("K8sProvider advertises the degraded K8s v1 capability set", () => {
		const provider = resolveRuntimeProvider(deps, { WARREN_RUNTIME: "k8s" });
		expect(provider.capabilities).toEqual({
			previewPorts: false,
			networkPolicy: "coarse",
			longLived: false,
			midRunSteering: false,
			enforcedResourceLimits: true,
			workspaceArchive: false,
		});
	});

	test("garbage selector throws UnknownRuntimeError", () => {
		expect(() => resolveRuntimeProvider(deps, { WARREN_RUNTIME: "nomad" })).toThrow(
			UnknownRuntimeError,
		);
		expect(() => resolveRuntimeProvider(deps, { WARREN_RUNTIME: "nomad" })).toThrow(/nomad/);
	});
});
