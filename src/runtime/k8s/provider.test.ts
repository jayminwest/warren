import { describe, expect, test } from "bun:test";
import {
	ApiException,
	type CoreV1Api,
	type V1ConfigMap,
	type V1Pod,
} from "@kubernetes/client-node";
import type { EnvLike } from "../../runs/spawn/callback-env.ts";
import type { RunSpec } from "../contract.ts";
import { RuntimeAdmissionError, RuntimeProviderError } from "../errors.ts";
import {
	type AdmissionCounterSink,
	type AdmissionCounts,
	METRIC_ADMISSION_REJECTIONS_TOTAL,
	type PodAdmissionSource,
} from "./admission.ts";
import { LABEL_NETWORK, LABEL_PROJECT, SEED_MANIFEST_KEY } from "./pod-spec.ts";
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
			workspaceGc: false,
		});
	});

	test("reports kind k8s (warren-e1f1)", () => {
		expect(new K8sProvider(deps).kind).toBe("k8s");
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
function fakeApi(
	opts: {
		podError?: unknown;
		podUid?: string;
		cmError?: unknown;
		listItems?: V1Pod[];
		listError?: unknown;
	} = {},
): {
	api: CoreV1Api;
	pods: PodCall[];
	cms: CmCall[];
	deletedCms: string[];
	listCalls: number;
} {
	const pods: PodCall[] = [];
	const cms: CmCall[] = [];
	const deletedCms: string[] = [];
	const box = { listCalls: 0 };
	const api = {
		// Admission's cache-cold count source (warren-b6f2). Default: no run pods
		// (so create() admits and proceeds, matching pre-admission behavior).
		listNamespacedPod: (_param: {
			namespace: string;
			labelSelector?: string;
		}): Promise<{ items: V1Pod[] }> => {
			box.listCalls += 1;
			if (opts.listError !== undefined) return Promise.reject(opts.listError);
			return Promise.resolve({ items: opts.listItems ?? [] });
		},
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
	return {
		api,
		pods,
		cms,
		deletedCms,
		get listCalls() {
			return box.listCalls;
		},
	};
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
			seedFiles: [{ path: ".warren/agent.json", contents: "{}" }],
		});
		expect(fake.cms).toHaveLength(1);
		expect(fake.cms[0]?.namespace).toBe("warren-runs");
		expect(fake.cms[0]?.body.metadata?.name).toBe("run-run-test-seeds");
		const manifest = fake.cms[0]?.body.data?.[SEED_MANIFEST_KEY];
		expect(JSON.parse(manifest ?? "[]")).toEqual([{ path: ".warren/agent.json", contents: "{}" }]);
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

	test("stamps the warren.io/project label from the RunSpec projectId", async () => {
		const fake = fakeApi();
		await makeProvider(fake).create({ ...spec, projectId: "proj_abc" });
		expect(fake.pods[0]?.body.metadata?.labels?.[LABEL_PROJECT]).toBe("proj_abc");
	});

	// warren-aedd: per-project `.warren/config.yaml` `resources` (carried on
	// RunSpec.projectResources by the dispatch path) must reach the pod spec.
	// Precedence: per-run spec.resources limit > projectResources > env defaults.
	test("folds RunSpec.projectResources into the pod's requests/limits + network label", async () => {
		const fake = fakeApi();
		await makeProvider(fake).create({
			...spec,
			projectResources: {
				requests: { memoryMiB: 512, cpuMillicores: 250 },
				limits: { memoryMiB: 8192, cpuMillicores: 8000 },
				network: "open",
			},
		});
		const resources = fake.pods[0]?.body.spec?.containers?.[0]?.resources;
		expect(resources?.requests).toEqual({
			memory: "512Mi",
			cpu: "250m",
			"ephemeral-storage": "10240Mi",
		});
		expect(resources?.limits).toEqual({
			memory: "8192Mi",
			cpu: "8000m",
			"ephemeral-storage": "10240Mi",
		});
		expect(fake.pods[0]?.body.metadata?.labels?.[LABEL_NETWORK]).toBe("open");
	});

	test("per-run spec.resources limit WINS over projectResources.limits", async () => {
		const fake = fakeApi();
		await makeProvider(fake).create({
			...spec,
			resources: { memoryMiB: 1024, cpuMillicores: 2000 },
			projectResources: {
				requests: { memoryMiB: 512, cpuMillicores: 250 },
				limits: { memoryMiB: 8192, cpuMillicores: 8000 },
			},
		});
		const resources = fake.pods[0]?.body.spec?.containers?.[0]?.resources;
		// Limit reflects the per-run override, not the project block's 8192Mi/8000m;
		// ephemeral-storage is untouched by the memory/cpu override (config default).
		expect(resources?.limits).toEqual({
			memory: "1024Mi",
			cpu: "2000m",
			"ephemeral-storage": "10240Mi",
		});
		// Requests still come from the project block, clamped to never exceed the limit.
		expect(resources?.requests).toEqual({
			memory: "512Mi",
			cpu: "250m",
			"ephemeral-storage": "10240Mi",
		});
	});

	test("absent projectResources falls back to the env/global DEFAULT_K8S_* defaults", async () => {
		const fake = fakeApi();
		await makeProvider(fake).create(spec);
		const resources = fake.pods[0]?.body.spec?.containers?.[0]?.resources;
		expect(resources?.requests).toEqual({
			memory: "2048Mi",
			cpu: "1000m",
			"ephemeral-storage": "10240Mi",
		});
		expect(resources?.limits).toEqual({
			memory: "4096Mi",
			cpu: "4000m",
			"ephemeral-storage": "10240Mi",
		});
		expect(fake.pods[0]?.body.metadata?.labels?.[LABEL_NETWORK]).toBe("restricted");
	});
});

// --- create() admission control (warren-b6f2) -------------------------------

/** A Pending run pod carrying an optional project label. */
function pendingPod(projectId?: string): V1Pod {
	return {
		status: { phase: "Pending" },
		metadata: projectId !== undefined ? { labels: { [LABEL_PROJECT]: projectId } } : {},
	};
}
/** A Running (non-terminal, not Pending) run pod. */
function runningPod(projectId?: string): V1Pod {
	return {
		status: { phase: "Running" },
		metadata: projectId !== undefined ? { labels: { [LABEL_PROJECT]: projectId } } : {},
	};
}

class RecordingMetrics implements AdmissionCounterSink {
	readonly calls: Array<{ name: string; labels?: Record<string, string> }> = [];
	increment(name: string, labels?: Readonly<Record<string, string>>): void {
		this.calls.push({ name, ...(labels !== undefined ? { labels: { ...labels } } : {}) });
	}
}

describe("K8sProvider.create admission", () => {
	test("admits and creates the pod when under every cap (cache-cold list)", async () => {
		const fake = fakeApi({ listItems: [pendingPod(), runningPod()] });
		await makeProvider(fake).create(spec);
		expect(fake.listCalls).toBe(1); // cache-cold: listed by label
		expect(fake.pods).toHaveLength(1);
	});

	test("rejects with 429-shaped RuntimeAdmissionError when pending pods hit the cap", async () => {
		const items = Array.from({ length: 20 }, () => pendingPod());
		const fake = fakeApi({ listItems: items });
		const metrics = new RecordingMetrics();
		const provider = new K8sProvider({
			coreApi: () => fake.api,
			serverEnv: {},
			admissionMetrics: metrics,
		});
		const err = (await provider.create(spec).catch((e) => e)) as RuntimeAdmissionError;
		expect(err).toBeInstanceOf(RuntimeAdmissionError);
		expect(err.reason).toBe("cluster_pending_saturated");
		expect(err.retryAfterSeconds).toBe(30);
		// Rejected BEFORE any pod/configmap write.
		expect(fake.pods).toHaveLength(0);
		expect(fake.cms).toHaveLength(0);
		expect(metrics.calls).toEqual([
			{ name: METRIC_ADMISSION_REJECTIONS_TOTAL, labels: { reason: "cluster_pending_saturated" } },
		]);
	});

	test("rejects on the per-project concurrency cap with a distinct reason", async () => {
		// 3 active pods for this project, cap of 3 → reject. Other pods present but
		// under the (default) cluster caps so only the project cap trips.
		const items = [
			runningPod("proj_hot"),
			pendingPod("proj_hot"),
			runningPod("proj_hot"),
			runningPod("proj_other"),
		];
		const fake = fakeApi({ listItems: items });
		const err = (await makeProvider(fake)
			.create({ ...spec, projectId: "proj_hot", maxProjectConcurrency: 3 })
			.catch((e) => e)) as RuntimeAdmissionError;
		expect(err).toBeInstanceOf(RuntimeAdmissionError);
		expect(err.reason).toBe("project_concurrency_exceeded");
		expect(fake.pods).toHaveLength(0);
	});

	test("rejects on queue-depth when total non-terminal pods hit the cap", async () => {
		// 50 Running pods (none Pending, so pending cap is not hit first) → the
		// queue-depth cap (default 50) trips.
		const items = Array.from({ length: 50 }, () => runningPod());
		const fake = fakeApi({ listItems: items });
		const err = (await makeProvider(fake)
			.create(spec)
			.catch((e) => e)) as RuntimeAdmissionError;
		expect(err.reason).toBe("queue_depth_exceeded");
		expect(fake.pods).toHaveLength(0);
	});

	test("prefers a wired pod-watcher snapshot over a cache-cold list", async () => {
		const fake = fakeApi(); // list would return [] (admit) — but snapshot rejects
		const snapshotSource: PodAdmissionSource = {
			admissionSnapshot: (): AdmissionCounts => ({
				nonTerminalPods: 25,
				pendingPods: 25,
				projectNonTerminalPods: 0,
			}),
		};
		const provider = new K8sProvider({
			coreApi: () => fake.api,
			serverEnv: {},
			podAdmission: snapshotSource,
		});
		const err = (await provider.create(spec).catch((e) => e)) as RuntimeAdmissionError;
		expect(err.reason).toBe("cluster_pending_saturated");
		expect(fake.listCalls).toBe(0); // snapshot used — no API round-trip
	});

	test("skips counting entirely when every cap is disabled via env", async () => {
		const fake = fakeApi({ listItems: Array.from({ length: 99 }, () => pendingPod()) });
		const provider = new K8sProvider({
			coreApi: () => fake.api,
			serverEnv: {
				WARREN_K8S_MAX_QUEUE_DEPTH: "0",
				WARREN_K8S_MAX_PENDING_PODS: "0",
			},
		});
		await provider.create(spec);
		expect(fake.listCalls).toBe(0); // admission off → no count round-trip
		expect(fake.pods).toHaveLength(1);
	});

	test("maps a cache-cold list failure onto RuntimeProviderError (no pod created)", async () => {
		const fake = fakeApi({
			listError: new ApiException(403, "forbidden", { message: "no rbac" }, {}),
		});
		await expect(makeProvider(fake).create(spec)).rejects.toThrow(RuntimeProviderError);
		expect(fake.pods).toHaveLength(0);
	});

	test("honors env-raised caps (a higher max-pending-pods admits)", async () => {
		const fake = fakeApi({ listItems: Array.from({ length: 20 }, () => pendingPod()) });
		const provider = new K8sProvider({
			coreApi: () => fake.api,
			serverEnv: { WARREN_K8S_MAX_PENDING_PODS: "50" },
		});
		await provider.create(spec);
		expect(fake.pods).toHaveLength(1);
	});
});
