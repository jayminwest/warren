import { describe, expect, test } from "bun:test";
import {
	ApiException,
	type CoreV1Api,
	type V1ConfigMap,
	type V1Pod,
} from "@kubernetes/client-node";
import type { EnvLike } from "../../runs/spawn/callback-env.ts";
import type { RunSpec } from "../contract.ts";
import { RuntimeProviderError } from "../errors.ts";
import { SEED_MANIFEST_KEY } from "./pod-spec.ts";
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

	// finalize() is implemented (pl-829f step 20 / warren-0d35) — its wiring +
	// race semantics are covered in provider.finalize.test.ts + finalize.test.ts.
});

// --- create() ---------------------------------------------------------------

interface PodCall {
	namespace: string;
	body: V1Pod;
}
interface CmCall {
	namespace: string;
	body: V1ConfigMap;
}

/**
 * A recording fake of the object-param `CoreV1Api` surface `create()` touches.
 * `podResult`/`podError` and `cmError` steer the two create calls; every call is
 * recorded so tests can assert ordering + payloads. Cast through `unknown` — we
 * implement only the three methods `create()` uses.
 */
function fakeApi(opts: { podError?: unknown; podUid?: string; cmError?: unknown } = {}): {
	api: CoreV1Api;
	pods: PodCall[];
	cms: CmCall[];
	deletedCms: string[];
} {
	const pods: PodCall[] = [];
	const cms: CmCall[] = [];
	const deletedCms: string[] = [];
	const api = {
		createNamespacedPod: (param: PodCall): Promise<V1Pod> => {
			pods.push(param);
			if (opts.podError !== undefined) return Promise.reject(opts.podError);
			return Promise.resolve({
				metadata: { name: param.body.metadata?.name, uid: opts.podUid ?? "pod-uid-xyz" },
			});
		},
		createNamespacedConfigMap: (param: CmCall): Promise<V1ConfigMap> => {
			cms.push(param);
			if (opts.cmError !== undefined) return Promise.reject(opts.cmError);
			return Promise.resolve(param.body);
		},
		deleteNamespacedConfigMap: (param: { name: string; namespace: string }): Promise<unknown> => {
			deletedCms.push(param.name);
			return Promise.resolve({});
		},
	} as unknown as CoreV1Api;
	return { api, pods, cms, deletedCms };
}

function makeProvider(fake: ReturnType<typeof fakeApi>, serverEnv: EnvLike = {}): K8sProvider {
	const providerDeps: K8sProviderDeps = { coreApi: () => fake.api, serverEnv };
	return new K8sProvider(providerDeps);
}

describe("K8sProvider.create", () => {
	test("creates a pod and maps its name/uid onto the opaque RunHandle", async () => {
		const fake = fakeApi({ podUid: "uid-42" });
		const runHandle = await makeProvider(fake).create(spec);
		expect(runHandle).toEqual({
			runId: "run_test",
			sandboxId: "run-run-test",
			providerRunId: "uid-42",
		});
		expect(fake.pods).toHaveLength(1);
		expect(fake.pods[0]?.namespace).toBe("warren-runs");
		expect(fake.pods[0]?.body.metadata?.name).toBe("run-run-test");
		// No seed files → no ConfigMap + no seed volume on the pod.
		expect(fake.cms).toHaveLength(0);
		expect(fake.pods[0]?.body.spec?.volumes?.some((v) => v.configMap)).toBe(false);
	});

	test("folds the Service-DNS callback URL into the agent env when a token is present", async () => {
		const fake = fakeApi();
		await makeProvider(fake).create({ ...spec, env: { WARREN_API_TOKEN: "tok" } });
		const agentEnv = Object.fromEntries(
			(fake.pods[0]?.body.spec?.containers?.[0]?.env ?? []).map((e) => [e.name, e.value]),
		);
		expect(agentEnv.WARREN_API_URL).toBe("http://warren.warren.svc.cluster.local:8080");
		expect(agentEnv.WARREN_API_TOKEN).toBe("tok");
		expect(agentEnv.BUN_INSTALL_CACHE_DIR).toBe("/tmp/bun-install-cache");
	});

	test("honors callback env overrides for the Service-DNS URL", async () => {
		const fake = fakeApi();
		await makeProvider(fake, {
			WARREN_K8S_CALLBACK_SERVICE: "warren-cp",
			WARREN_K8S_CALLBACK_NAMESPACE: "control",
			WARREN_K8S_CALLBACK_PORT: "9090",
		}).create({ ...spec, env: { WARREN_API_TOKEN: "tok" } });
		const agentEnv = Object.fromEntries(
			(fake.pods[0]?.body.spec?.containers?.[0]?.env ?? []).map((e) => [e.name, e.value]),
		);
		expect(agentEnv.WARREN_API_URL).toBe("http://warren-cp.control.svc.cluster.local:9090");
	});

	test("omits the callback URL when the domain supplied no token", async () => {
		const fake = fakeApi();
		await makeProvider(fake).create({ ...spec, env: { PLOT_ID: "pl_1" } });
		const agentEnv = Object.fromEntries(
			(fake.pods[0]?.body.spec?.containers?.[0]?.env ?? []).map((e) => [e.name, e.value]),
		);
		expect(agentEnv.WARREN_API_URL).toBeUndefined();
	});

	test("creates the seed ConfigMap BEFORE the pod and references it as a volume", async () => {
		const fake = fakeApi();
		await makeProvider(fake).create({
			...spec,
			seedFiles: [{ path: ".canopy/agent.json", contents: "{}" }],
		});
		expect(fake.cms).toHaveLength(1);
		expect(fake.cms[0]?.namespace).toBe("warren-runs");
		expect(fake.cms[0]?.body.metadata?.name).toBe("run-run-test-seeds");
		const manifest = fake.cms[0]?.body.data?.[SEED_MANIFEST_KEY];
		expect(JSON.parse(manifest ?? "[]")).toEqual([{ path: ".canopy/agent.json", contents: "{}" }]);
		// The pod's seed volume references the ConfigMap by name.
		const vol = fake.pods[0]?.body.spec?.volumes?.find((v) => v.configMap);
		expect(vol?.configMap?.name).toBe("run-run-test-seeds");
		// Init container carries the manifest path env.
		const initEnv = Object.fromEntries(
			(fake.pods[0]?.body.spec?.initContainers?.[0]?.env ?? []).map((e) => [e.name, e.value]),
		);
		expect(initEnv.WARREN_SEED_MANIFEST).toBe("/seeds/seeds.json");
	});

	test("rejects an oversize seed manifest before any API call", async () => {
		const fake = fakeApi();
		const huge = "x".repeat(1024 * 1024 + 10);
		await expect(
			makeProvider(fake).create({ ...spec, seedFiles: [{ path: "big.txt", contents: huge }] }),
		).rejects.toThrow(RuntimeProviderError);
		expect(fake.cms).toHaveLength(0);
		expect(fake.pods).toHaveLength(0);
	});

	test("a 409 pod conflict surfaces a structured already-exists error", async () => {
		const fake = fakeApi({ podError: new ApiException(409, "conflict", {}, {}) });
		await expect(makeProvider(fake).create(spec)).rejects.toThrow(/already exists/);
	});

	test("maps a namespace/API failure onto RuntimeProviderError", async () => {
		const fake = fakeApi({
			podError: new ApiException(
				404,
				"not found",
				{ message: 'namespaces "warren-runs" not found' },
				{},
			),
		});
		await expect(makeProvider(fake).create(spec)).rejects.toThrow(RuntimeProviderError);
		await expect(
			makeProvider(fakeApi({ podError: new ApiException(403, "forbidden", {}, {}) })).create(spec),
		).rejects.toThrow(/HTTP 403/);
	});

	test("best-effort deletes the seed ConfigMap when the pod create fails (non-409)", async () => {
		const fake = fakeApi({ podError: new ApiException(500, "boom", { message: "boom" }, {}) });
		await expect(
			makeProvider(fake).create({ ...spec, seedFiles: [{ path: "a", contents: "b" }] }),
		).rejects.toThrow(RuntimeProviderError);
		expect(fake.deletedCms).toEqual(["run-run-test-seeds"]);
	});

	test("does NOT delete the ConfigMap on a 409 (it belongs to the existing pod)", async () => {
		const fake = fakeApi({ podError: new ApiException(409, "conflict", {}, {}) });
		await expect(
			makeProvider(fake).create({ ...spec, seedFiles: [{ path: "a", contents: "b" }] }),
		).rejects.toThrow(/already exists/);
		expect(fake.deletedCms).toEqual([]);
	});

	test("maps a ConfigMap create failure onto RuntimeProviderError before the pod", async () => {
		const fake = fakeApi({
			cmError: new ApiException(403, "forbidden", { message: "no rbac" }, {}),
		});
		await expect(
			makeProvider(fake).create({ ...spec, seedFiles: [{ path: "a", contents: "b" }] }),
		).rejects.toThrow(RuntimeProviderError);
		expect(fake.pods).toHaveLength(0);
	});
});
