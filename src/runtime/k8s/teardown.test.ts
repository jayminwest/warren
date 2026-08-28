import { describe, expect, test } from "bun:test";
import {
	ApiException,
	type CoreV1Api,
	type V1ConfigMap,
	type V1ConfigMapList,
	type V1Pod,
	type V1Status,
} from "@kubernetes/client-node";
import type { RunHandle } from "../contract.ts";
import { RuntimeProviderError, RuntimeRunNotFoundError } from "../errors.ts";
import { type K8sPodConfig, LABEL_RUN_ID, resolveK8sPodConfig } from "./pod-spec.ts";
import { cancelK8sRun, deleteRunConfigMaps, terminateK8sRun } from "./teardown.ts";

const handle: RunHandle = {
	runId: "run_teardown",
	sandboxId: "run-run-teardown",
	providerRunId: "pod-uid-3",
};

const config: K8sPodConfig = resolveK8sPodConfig({});

interface DeletePodCall {
	name: string;
	namespace: string;
	gracePeriodSeconds?: number;
}
interface DeleteCmCall {
	name: string;
	namespace: string;
}
interface ListCmCall {
	namespace: string;
	labelSelector?: string;
}

function cm(name: string, runId = handle.runId): V1ConfigMap {
	return { metadata: { name, namespace: config.namespace, labels: { [LABEL_RUN_ID]: runId } } };
}

/**
 * Recording fake of the object-param `CoreV1Api` surface cancel/terminate touch.
 * `podDeleteError` steers the pod delete; `cmItems` seed the configmap list;
 * `cmDeleteError` steers configmap deletes; `listError` steers the list call.
 */
function fakeApi(
	opts: {
		podDeleteError?: unknown;
		cmItems?: V1ConfigMap[];
		cmDeleteError?: unknown;
		listError?: unknown;
	} = {},
): {
	api: CoreV1Api;
	podDeletes: DeletePodCall[];
	cmDeletes: DeleteCmCall[];
	cmLists: ListCmCall[];
} {
	const podDeletes: DeletePodCall[] = [];
	const cmDeletes: DeleteCmCall[] = [];
	const cmLists: ListCmCall[] = [];
	const api = {
		deleteNamespacedPod: (param: DeletePodCall): Promise<V1Pod> => {
			podDeletes.push(param);
			if (opts.podDeleteError !== undefined) return Promise.reject(opts.podDeleteError);
			return Promise.resolve({ metadata: { name: param.name } });
		},
		listNamespacedConfigMap: (param: ListCmCall): Promise<V1ConfigMapList> => {
			cmLists.push(param);
			if (opts.listError !== undefined) return Promise.reject(opts.listError);
			return Promise.resolve({ items: opts.cmItems ?? [] } as V1ConfigMapList);
		},
		deleteNamespacedConfigMap: (param: DeleteCmCall): Promise<V1Status> => {
			cmDeletes.push(param);
			if (opts.cmDeleteError !== undefined) return Promise.reject(opts.cmDeleteError);
			return Promise.resolve({} as V1Status);
		},
	} as unknown as CoreV1Api;
	return { api, podDeletes, cmDeletes, cmLists };
}

describe("cancelK8sRun", () => {
	test("deletes the pod by NAME with the configured SIGTERM grace", async () => {
		const fake = fakeApi();
		await cancelK8sRun(fake.api, config, handle);
		expect(fake.podDeletes).toHaveLength(1);
		expect(fake.podDeletes[0]).toEqual({
			name: "run-run-teardown",
			namespace: "warren-runs",
			gracePeriodSeconds: 90,
		});
	});

	test("honors a WARREN_K8S_CANCEL_GRACE_SECONDS override", async () => {
		const fake = fakeApi();
		const custom = resolveK8sPodConfig({ WARREN_K8S_CANCEL_GRACE_SECONDS: "5" });
		await cancelK8sRun(fake.api, custom, handle);
		expect(fake.podDeletes[0]?.gracePeriodSeconds).toBe(5);
	});

	test("a 404 (pod already gone) neutralizes into RuntimeRunNotFoundError", async () => {
		const fake = fakeApi({ podDeleteError: new ApiException(404, "not found", {}, {}) });
		await expect(cancelK8sRun(fake.api, config, handle)).rejects.toThrow(RuntimeRunNotFoundError);
	});

	test("a non-404 API error maps onto a structured RuntimeProviderError", async () => {
		const fake = fakeApi({
			podDeleteError: new ApiException(403, "forbidden", { message: "no rbac" }, {}),
		});
		await expect(cancelK8sRun(fake.api, config, handle)).rejects.toThrow(RuntimeProviderError);
		await expect(
			cancelK8sRun(
				fakeApi({
					podDeleteError: new ApiException(403, "forbidden", {}, {}),
				}).api,
				config,
				handle,
			),
		).rejects.toThrow(/HTTP 403/);
	});
});

describe("terminateK8sRun", () => {
	test("force-deletes the pod (grace 0) + its labelled ConfigMap, returns TeardownResult", async () => {
		const fake = fakeApi({ cmItems: [cm("run-run-teardown-seeds")] });
		const result = await terminateK8sRun(fake.api, config, handle);
		expect(fake.podDeletes[0]).toEqual({
			name: "run-run-teardown",
			namespace: "warren-runs",
			gracePeriodSeconds: 0,
		});
		// ConfigMaps selected by the run-id LABEL, then deleted by name.
		expect(fake.cmLists[0]?.labelSelector).toBe(`${LABEL_RUN_ID}=run_teardown`);
		expect(fake.cmDeletes.map((d) => d.name)).toEqual(["run-run-teardown-seeds"]);
		expect(result).toEqual({
			archived: false,
			deletedEvents: 0,
			deletedMessages: 0,
			deletedRuns: 1,
		});
	});

	test("is idempotent: a 404 pod leaves deletedRuns:0 but still sweeps ConfigMaps", async () => {
		const fake = fakeApi({
			podDeleteError: new ApiException(404, "not found", {}, {}),
			cmItems: [cm("run-run-teardown-seeds")],
		});
		const result = await terminateK8sRun(fake.api, config, handle);
		expect(result.deletedRuns).toBe(0);
		// The ConfigMap sweep still ran.
		expect(fake.cmDeletes.map((d) => d.name)).toEqual(["run-run-teardown-seeds"]);
	});

	test("skips a ConfigMap that 404s mid-sweep (raced with GC)", async () => {
		const fake = fakeApi({
			cmItems: [cm("a"), cm("b")],
			cmDeleteError: new ApiException(404, "gone", {}, {}),
		});
		const result = await terminateK8sRun(fake.api, config, handle);
		// Both attempted; neither counts, no throw.
		expect(fake.cmDeletes).toHaveLength(2);
		expect(result.deletedRuns).toBe(1);
	});

	test("maps a non-404 pod-delete failure onto RuntimeProviderError", async () => {
		const fake = fakeApi({
			podDeleteError: new ApiException(500, "boom", { message: "boom" }, {}),
		});
		await expect(terminateK8sRun(fake.api, config, handle)).rejects.toThrow(RuntimeProviderError);
	});

	test("no ConfigMaps for the run → pod deleted, nothing to sweep", async () => {
		const fake = fakeApi({ cmItems: [] });
		const result = await terminateK8sRun(fake.api, config, handle);
		expect(fake.cmDeletes).toHaveLength(0);
		expect(result.deletedRuns).toBe(1);
	});
});

describe("deleteRunConfigMaps", () => {
	test("maps a list RBAC failure onto RuntimeProviderError", async () => {
		const fake = fakeApi({
			listError: new ApiException(403, "forbidden", { message: "no rbac" }, {}),
		});
		await expect(deleteRunConfigMaps(fake.api, config.namespace, handle.runId)).rejects.toThrow(
			RuntimeProviderError,
		);
	});

	test("maps a non-404 delete failure onto RuntimeProviderError", async () => {
		const fake = fakeApi({
			cmItems: [cm("x")],
			cmDeleteError: new ApiException(403, "forbidden", { message: "no rbac" }, {}),
		});
		await expect(deleteRunConfigMaps(fake.api, config.namespace, handle.runId)).rejects.toThrow(
			/HTTP 403/,
		);
	});

	test("returns the number of ConfigMaps deleted", async () => {
		const fake = fakeApi({ cmItems: [cm("x"), cm("y")] });
		const n = await deleteRunConfigMaps(fake.api, config.namespace, handle.runId);
		expect(n).toBe(2);
	});
});
