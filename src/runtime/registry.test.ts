import { describe, expect, test } from "bun:test";
import type { CoreV1Api, V1Pod } from "@kubernetes/client-node";
import type { ReapExec, ReapFs } from "../runs/reap/types.ts";
import { DockerProvider } from "./docker/provider.ts";
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
 * Hermetic deps: the K8s client factory throws if invoked. No shell method
 * calls it, so building a K8sProvider off WARREN_RUNTIME=k8s never touches a
 * cluster — and the local backend needs nothing at all (warren-ea0a).
 */
const deps: RuntimeProviderDeps = {
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

	test("accepts the docker selector (warren-3732, sibling containers)", () => {
		expect(resolveRuntimeKind({ WARREN_RUNTIME: "docker" })).toBe("docker");
	});

	test("fails loudly on an unknown value rather than falling back", () => {
		expect(() => resolveRuntimeKind({ WARREN_RUNTIME: "nomad" })).toThrow(UnknownRuntimeError);
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

	test("accepts the LocalProvider fs/exec seam so reap's fallback can route through the registry", () => {
		// warren-aa4a: the reap pipeline's fallback resolves through
		// `resolveRuntimeProvider({ fs, exec })` instead of constructing a
		// LocalProvider inline. The fs/exec slices are LocalProvider-only
		// (finalize's disk/shell seam) and must not disturb resolution.
		const fs: ReapFs = {
			mkdirp: () => Promise.resolve(),
			readFile: () => Promise.resolve(null),
			writeFile: () => Promise.resolve(),
			readdir: () => Promise.resolve([]),
		};
		const exec: ReapExec = {
			run: () => Promise.resolve({ stdout: "", stderr: "" }),
		};
		const provider = resolveRuntimeProvider({ ...deps, fs, exec }, {});
		expect(provider).toBeInstanceOf(LocalProvider);
	});

	test("advertises the full local capability set", () => {
		const provider = resolveRuntimeProvider(deps, {});
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
			workspaceGc: false,
		});
	});

	test("resolves DockerProvider for WARREN_RUNTIME=docker (warren-3732)", () => {
		const provider = resolveRuntimeProvider(deps, { WARREN_RUNTIME: "docker" });
		expect(provider).toBeInstanceOf(DockerProvider);
	});

	test("DockerProvider advertises the honest docker v1 capability set", () => {
		const provider = resolveRuntimeProvider(deps, { WARREN_RUNTIME: "docker" });
		expect(provider.capabilities).toEqual({
			previewPorts: false,
			networkPolicy: "coarse",
			longLived: true,
			midRunSteering: true,
			enforcedResourceLimits: true,
			workspaceArchive: false,
			workspaceGc: true,
		});
	});

	test("garbage selector throws UnknownRuntimeError", () => {
		expect(() => resolveRuntimeProvider(deps, { WARREN_RUNTIME: "nomad" })).toThrow(
			UnknownRuntimeError,
		);
		expect(() => resolveRuntimeProvider(deps, { WARREN_RUNTIME: "nomad" })).toThrow(/nomad/);
	});

	test("threads k8sPodCache onto the K8sProvider — status() reads the cache, no cluster call", async () => {
		// The shared coreApi factory throws if invoked; a status() that resolves off
		// the injected cache proves the pod-watcher was wired through as podCache
		// (pl-829f step 25 / warren-7c30).
		const pod: V1Pod = {
			metadata: { name: "run-x", labels: { "warren.io/run-id": "x" } },
			status: { phase: "Running" },
		};
		const provider = resolveRuntimeProvider(
			{ ...deps, k8sPodCache: { getByRunId: (id) => (id === "x" ? pod : undefined) } },
			{ WARREN_RUNTIME: "k8s" },
		);
		const status = await provider.status({ runId: "x", sandboxId: "run-x", providerRunId: "" });
		expect(status.exists).toBe(true);
		expect(status.phase).toBe("running");
	});

	test("threads k8sPodAdmission onto the K8sProvider without touching a cluster", () => {
		// Construction accepting the admission source is enough here — the create()
		// admission path is covered by the provider + admission unit suites.
		expect(() =>
			resolveRuntimeProvider(
				{
					...deps,
					k8sPodAdmission: {
						admissionSnapshot: () => ({
							nonTerminalPods: 0,
							pendingPods: 0,
							projectNonTerminalPods: 0,
						}),
					},
				},
				{ WARREN_RUNTIME: "k8s" },
			),
		).not.toThrow();
	});
});
