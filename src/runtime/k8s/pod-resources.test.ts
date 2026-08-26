import { describe, expect, test } from "bun:test";
import type { ResourcesConfig } from "../../warren-config/index.ts";
import type { RunSpec } from "../contract.ts";
import { clampRequests, resourceRequirements } from "./pod-resources.ts";
import { buildRunPod, type K8sPodConfig, resolveK8sPodConfig } from "./pod-spec.ts";

function baseSpec(overrides: Partial<RunSpec> = {}): RunSpec {
	return {
		runId: "run_01tdf3a0wg5e",
		originUrl: "https://github.com/acme/widgets.git",
		branch: "warren/run_01tdf3a0wg5e",
		baseBranch: "main",
		runtimeId: "claude-code",
		prompt: "do the thing",
		mode: "batch",
		network: "restricted",
		seedFiles: [],
		env: { PLOT_ID: "plot_1", WARREN_API_TOKEN: "tok" },
		...overrides,
	};
}

const config: K8sPodConfig = resolveK8sPodConfig({});

// warren-653f: the resource-quantity helpers were split out of pod-spec.ts.
describe("clampRequests", () => {
	test("clamps each dimension down to the limit; never exceeds it", () => {
		const clamped = clampRequests(
			{ memoryMiB: 4096, cpuMillicores: 4000, ephemeralStorageMiB: 40_960 },
			{ memoryMiB: 2048, cpuMillicores: 1000, ephemeralStorageMiB: 10_240 },
		);
		expect(clamped).toEqual({
			memoryMiB: 2048,
			cpuMillicores: 1000,
			ephemeralStorageMiB: 10_240,
		});
	});

	test("leaves a request already under the limit untouched", () => {
		const clamped = clampRequests(
			{ memoryMiB: 512, cpuMillicores: 250, ephemeralStorageMiB: 4096 },
			{ memoryMiB: 2048, cpuMillicores: 1000, ephemeralStorageMiB: 10_240 },
		);
		expect(clamped).toEqual({ memoryMiB: 512, cpuMillicores: 250, ephemeralStorageMiB: 4096 });
	});
});

describe("resourceRequirements", () => {
	test("renders memory/cpu/ephemeral-storage to K8s quantity strings", () => {
		const req = resourceRequirements(
			{ memoryMiB: 2048, cpuMillicores: 1000, ephemeralStorageMiB: 10_240 },
			{ memoryMiB: 4096, cpuMillicores: 4000, ephemeralStorageMiB: 20_480 },
		);
		expect(req.requests).toEqual({
			memory: "2048Mi",
			cpu: "1000m",
			"ephemeral-storage": "10240Mi",
		});
		expect(req.limits).toEqual({
			memory: "4096Mi",
			cpu: "4000m",
			"ephemeral-storage": "20480Mi",
		});
	});
});

describe("resolveK8sPodConfig — ephemeral-storage", () => {
	test("sources resources + network from the .warren/config.yaml resources block", () => {
		const resources: ResourcesConfig = {
			requests: { memoryMiB: 512, cpuMillicores: 250 },
			limits: { memoryMiB: 8192, cpuMillicores: 8000 },
			network: "none",
		};
		const c = resolveK8sPodConfig({}, resources);
		// memory/cpu come from the block; ephemeral-storage falls back to the default
		// (the block pinned only two dimensions), same posture as the other knobs.
		expect(c.requests).toEqual({ memoryMiB: 512, cpuMillicores: 250, ephemeralStorageMiB: 10_240 });
		expect(c.limits).toEqual({ memoryMiB: 8192, cpuMillicores: 8000, ephemeralStorageMiB: 10_240 });
		expect(c.network).toBe("none");
	});

	test("sources ephemeral-storage from the .warren/config.yaml resources block", () => {
		const resources: ResourcesConfig = {
			requests: { ephemeralStorageMiB: 4096 },
			limits: { ephemeralStorageMiB: 20_480 },
		};
		const c = resolveK8sPodConfig({}, resources);
		// only ephemeral-storage was pinned; memory/cpu fall back to the defaults.
		expect(c.requests).toEqual({ memoryMiB: 2048, cpuMillicores: 1000, ephemeralStorageMiB: 4096 });
		expect(c.limits).toEqual({ memoryMiB: 4096, cpuMillicores: 4000, ephemeralStorageMiB: 20_480 });
	});

	// warren-4a95: cluster-wide env defaults — a UI-building workload that
	// outgrows 10Gi should not need a per-project config edit on every repo.
	test("reads bounded MiB integers from the WARREN_K8S_EPHEMERAL_STORAGE_*_MIB env", () => {
		const c = resolveK8sPodConfig({
			WARREN_K8S_EPHEMERAL_STORAGE_REQUEST_MIB: "20480",
			WARREN_K8S_EPHEMERAL_STORAGE_LIMIT_MIB: "30720",
		});
		expect(c.requests.ephemeralStorageMiB).toBe(20_480);
		expect(c.limits.ephemeralStorageMiB).toBe(30_720);
	});

	test("invalid env (out-of-bounds / non-integer / blank) falls back to the 10Gi default", () => {
		for (const raw of ["63", "1048577", "-5", "1.5", "  ", "abc"]) {
			expect(
				resolveK8sPodConfig({ WARREN_K8S_EPHEMERAL_STORAGE_LIMIT_MIB: raw }).limits
					.ephemeralStorageMiB,
			).toBe(10_240);
		}
	});

	test("a per-project resources block beats the env default", () => {
		const c = resolveK8sPodConfig(
			{ WARREN_K8S_EPHEMERAL_STORAGE_LIMIT_MIB: "20480" },
			{ limits: { ephemeralStorageMiB: 40_960 } },
		);
		expect(c.limits.ephemeralStorageMiB).toBe(40_960);
		expect(c.requests.ephemeralStorageMiB).toBe(10_240);
	});

	// warren-06b8: memory follows the same three-tier chain. The first payer is
	// the openclaw contribution fork — its repo cannot carry a .warren/ config
	// (the file would ride every upstream PR diff), and the monorepo test run
	// used ~3.9GiB against the 2Gi default request, so the node evicted the
	// agent an hour into paid work.
	test("reads bounded MiB integers from the WARREN_K8S_MEMORY_*_MIB env", () => {
		const c = resolveK8sPodConfig({
			WARREN_K8S_MEMORY_REQUEST_MIB: "4096",
			WARREN_K8S_MEMORY_LIMIT_MIB: "6144",
		});
		expect(c.requests.memoryMiB).toBe(4096);
		expect(c.limits.memoryMiB).toBe(6144);
	});

	test("invalid memory env falls back to the 2Gi/4Gi defaults", () => {
		for (const raw of ["63", "1048577", "-5", "1.5", "  ", "abc"]) {
			const c = resolveK8sPodConfig({
				WARREN_K8S_MEMORY_REQUEST_MIB: raw,
				WARREN_K8S_MEMORY_LIMIT_MIB: raw,
			});
			expect(c.requests.memoryMiB).toBe(2048);
			expect(c.limits.memoryMiB).toBe(4096);
		}
	});

	test("a per-project memory block beats the memory env default", () => {
		const c = resolveK8sPodConfig(
			{ WARREN_K8S_MEMORY_LIMIT_MIB: "6144" },
			{ limits: { memoryMiB: 8192 } },
		);
		expect(c.limits.memoryMiB).toBe(8192);
		expect(c.requests.memoryMiB).toBe(2048);
	});
});

describe("buildRunPod — resource rendering", () => {
	test("agent resources map config requests/limits to K8s quantity strings", () => {
		const pod = buildRunPod(baseSpec(), config);
		const res = pod.spec?.containers?.[0]?.resources;
		expect(res?.requests).toEqual({
			memory: "2048Mi",
			cpu: "1000m",
			"ephemeral-storage": "10240Mi",
		});
		expect(res?.limits).toEqual({
			memory: "4096Mi",
			cpu: "4000m",
			"ephemeral-storage": "10240Mi",
		});
	});

	test("the workspace-init container carries an explicit ephemeral-storage req+limit", () => {
		// Without this the init clone runs under Autopilot's injected 1Gi default and
		// evicts the pod mid-clone; both containers must pin ephemeral-storage.
		const pod = buildRunPod(baseSpec(), config);
		const initRes = pod.spec?.initContainers?.[0]?.resources;
		expect(initRes?.requests?.["ephemeral-storage"]).toBe("10240Mi");
		expect(initRes?.limits?.["ephemeral-storage"]).toBe("10240Mi");
	});

	test("the workspace emptyDir is capped at the ephemeral-storage limit", () => {
		const pod = buildRunPod(baseSpec(), config);
		expect(pod.spec?.volumes?.[0]?.emptyDir?.sizeLimit).toBe("10240Mi");
	});

	test("RunSpec.resources overrides the limit; requests clamp so they never exceed it", () => {
		const pod = buildRunPod(
			baseSpec({ resources: { memoryMiB: 1024, cpuMillicores: 500 } }),
			config,
		);
		const res = pod.spec?.containers?.[0]?.resources;
		expect(res?.limits).toEqual({
			memory: "1024Mi",
			cpu: "500m",
			"ephemeral-storage": "10240Mi",
		});
		// config requests were 2048Mi/1000m — clamped down to the lowered limit;
		// ephemeral-storage is untouched by the memory/cpu override.
		expect(res?.requests).toEqual({
			memory: "1024Mi",
			cpu: "500m",
			"ephemeral-storage": "10240Mi",
		});
	});

	test("a partial RunSpec.resources override only touches the dimension it sets", () => {
		const pod = buildRunPod(baseSpec({ resources: { memoryMiB: 1024 } }), config);
		const res = pod.spec?.containers?.[0]?.resources;
		expect(res?.limits).toEqual({
			memory: "1024Mi",
			cpu: "4000m",
			"ephemeral-storage": "10240Mi",
		});
		// memory request clamps to 1024; cpu request stays at the config default.
		expect(res?.requests).toEqual({
			memory: "1024Mi",
			cpu: "1000m",
			"ephemeral-storage": "10240Mi",
		});
	});

	test("RunSpec.resources can override the ephemeral-storage limit", () => {
		const pod = buildRunPod(baseSpec({ resources: { ephemeralStorageMiB: 30_720 } }), config);
		const res = pod.spec?.containers?.[0]?.resources;
		expect(res?.limits?.["ephemeral-storage"]).toBe("30720Mi");
		// the request clamps to the (raised) limit — it stays at the config default 10240.
		expect(res?.requests?.["ephemeral-storage"]).toBe("10240Mi");
		// the emptyDir sizeLimit tracks the config limit, not the per-run override.
		expect(pod.spec?.volumes?.[0]?.emptyDir?.sizeLimit).toBe("10240Mi");
	});
});
