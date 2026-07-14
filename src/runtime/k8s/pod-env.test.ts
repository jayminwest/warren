import { describe, expect, test } from "bun:test";
import type { RunSpec } from "../contract.ts";
import {
	buildRunPodVolumes,
	DEFAULT_REPO_CACHE_MOUNT_PATH,
	REPO_CACHE_VOLUME_NAME,
	resolveRepoCacheConfig,
	serviceDnsCallbackUrl,
} from "./pod-env.ts";
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

describe("serviceDnsCallbackUrl", () => {
	test("builds in-cluster Service DNS from the callback coordinates", () => {
		const c = resolveK8sPodConfig({
			WARREN_K8S_CALLBACK_SERVICE: "cp",
			WARREN_K8S_CALLBACK_NAMESPACE: "sys",
			WARREN_K8S_CALLBACK_PORT: "9000",
		});
		expect(serviceDnsCallbackUrl(c)).toBe("http://cp.sys.svc.cluster.local:9000");
	});
});

describe("resolveRepoCacheConfig (warren-e908, §4.3/R2)", () => {
	test("returns undefined when the claim env is absent or blank", () => {
		expect(resolveRepoCacheConfig({})).toBeUndefined();
		expect(resolveRepoCacheConfig({ WARREN_K8S_REPO_CACHE_PVC: "   " })).toBeUndefined();
	});

	test("reads the claim name + default/overridden mount path", () => {
		expect(resolveRepoCacheConfig({ WARREN_K8S_REPO_CACHE_PVC: "warren-repo-cache" })).toEqual({
			claimName: "warren-repo-cache",
			mountPath: DEFAULT_REPO_CACHE_MOUNT_PATH,
		});
		expect(
			resolveRepoCacheConfig({
				WARREN_K8S_REPO_CACHE_PVC: "warren-repo-cache",
				WARREN_K8S_REPO_CACHE_PATH: "/cache",
			}),
		).toEqual({ claimName: "warren-repo-cache", mountPath: "/cache" });
	});
});

describe("buildRunPodVolumes (warren-e908)", () => {
	test("workspace emptyDir only when no seed ConfigMap + no repo cache", () => {
		const volumes = buildRunPodVolumes(config, {});
		expect(volumes).toHaveLength(1);
		expect(volumes[0]?.emptyDir).toBeDefined();
		expect(volumes.some((v) => v.name === REPO_CACHE_VOLUME_NAME)).toBe(false);
	});

	test("appends the repo-cache PVC volume when the cache is configured", () => {
		const cached = resolveK8sPodConfig({ WARREN_K8S_REPO_CACHE_PVC: "warren-repo-cache" });
		const vol = buildRunPodVolumes(cached, {}).find((v) => v.name === REPO_CACHE_VOLUME_NAME);
		expect(vol?.persistentVolumeClaim?.claimName).toBe("warren-repo-cache");
	});
});

describe("repo-cache wiring through buildRunPod (warren-e908, §4.3/R2)", () => {
	test("no PVC volume/mount + no WARREN_REPO_CACHE_DIR env when repoCache is unset", () => {
		const pod = buildRunPod(baseSpec(), config);
		expect(pod.spec?.volumes?.some((v) => v.name === REPO_CACHE_VOLUME_NAME)).toBe(false);
		const init = pod.spec?.initContainers?.[0];
		expect(init?.volumeMounts?.some((m) => m.name === REPO_CACHE_VOLUME_NAME)).toBe(false);
		const env = Object.fromEntries((init?.env ?? []).map((e) => [e.name, e.value]));
		expect(env.WARREN_REPO_CACHE_DIR).toBeUndefined();
	});

	test("repoCache wires a PVC volume + init-only mount + WARREN_REPO_CACHE_DIR env", () => {
		const cached = resolveK8sPodConfig({ WARREN_K8S_REPO_CACHE_PVC: "warren-repo-cache" });
		const pod = buildRunPod(baseSpec(), cached);
		const vol = pod.spec?.volumes?.find((v) => v.name === REPO_CACHE_VOLUME_NAME);
		expect(vol?.persistentVolumeClaim?.claimName).toBe("warren-repo-cache");
		const init = pod.spec?.initContainers?.[0];
		const mount = init?.volumeMounts?.find((m) => m.name === REPO_CACHE_VOLUME_NAME);
		expect(mount).toEqual({
			name: REPO_CACHE_VOLUME_NAME,
			mountPath: DEFAULT_REPO_CACHE_MOUNT_PATH,
		});
		const env = Object.fromEntries((init?.env ?? []).map((e) => [e.name, e.value]));
		expect(env.WARREN_REPO_CACHE_DIR).toBe(DEFAULT_REPO_CACHE_MOUNT_PATH);
		// The agent container must NOT mount the cache — the run workspace is the emptyDir.
		const agent = pod.spec?.containers?.[0];
		expect(agent?.volumeMounts?.some((m) => m.name === REPO_CACHE_VOLUME_NAME)).toBe(false);
	});
});
