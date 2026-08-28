import { describe, expect, test } from "bun:test";
import {
	ApiException,
	type CoreV1Api,
	type V1ConfigMapList,
	type V1Pod,
	type V1Status,
} from "@kubernetes/client-node";
import type { RunHandle } from "../contract.ts";
import { RuntimeRunNotFoundError } from "../errors.ts";
import { K8sProvider } from "./provider.ts";

const handle: RunHandle = {
	runId: "run_prov_teardown",
	sandboxId: "run-run-prov-teardown",
	providerRunId: "pod-uid-7",
};

interface PodDelete {
	name: string;
	namespace: string;
	gracePeriodSeconds?: number;
}

function fakeApi(opts: { podDeleteError?: unknown } = {}): {
	api: CoreV1Api;
	podDeletes: PodDelete[];
} {
	const podDeletes: PodDelete[] = [];
	const api = {
		deleteNamespacedPod: (param: PodDelete): Promise<V1Pod> => {
			podDeletes.push(param);
			if (opts.podDeleteError !== undefined) return Promise.reject(opts.podDeleteError);
			return Promise.resolve({ metadata: { name: param.name } });
		},
		listNamespacedConfigMap: (): Promise<V1ConfigMapList> =>
			Promise.resolve({ items: [] } as V1ConfigMapList),
		deleteNamespacedConfigMap: (): Promise<V1Status> => Promise.resolve({} as V1Status),
	} as unknown as CoreV1Api;
	return { api, podDeletes };
}

describe("K8sProvider.cancel — delegation + env plumbing", () => {
	test("deletes the pod with the default 90s SIGTERM grace (warren-01d5 salvage window)", async () => {
		const fake = fakeApi();
		await new K8sProvider({ coreApi: () => fake.api, serverEnv: {} }).cancel(handle);
		expect(fake.podDeletes[0]).toEqual({
			name: "run-run-prov-teardown",
			namespace: "warren-runs",
			gracePeriodSeconds: 90,
		});
	});

	test("threads WARREN_K8S_CANCEL_GRACE_SECONDS from serverEnv into the delete", async () => {
		const fake = fakeApi();
		await new K8sProvider({
			coreApi: () => fake.api,
			serverEnv: { WARREN_K8S_CANCEL_GRACE_SECONDS: "8" },
		}).cancel(handle, "user requested");
		expect(fake.podDeletes[0]?.gracePeriodSeconds).toBe(8);
	});

	test("a 404 surfaces RuntimeRunNotFoundError for the domain to terminalize", async () => {
		const fake = fakeApi({ podDeleteError: new ApiException(404, "not found", {}, {}) });
		await expect(
			new K8sProvider({ coreApi: () => fake.api, serverEnv: {} }).cancel(handle),
		).rejects.toThrow(RuntimeRunNotFoundError);
	});
});

describe("K8sProvider.terminate — delegation + env plumbing", () => {
	test("force-deletes the pod (grace 0) and returns a TeardownResult", async () => {
		const fake = fakeApi();
		const result = await new K8sProvider({ coreApi: () => fake.api, serverEnv: {} }).terminate(
			handle,
		);
		expect(fake.podDeletes[0]?.gracePeriodSeconds).toBe(0);
		expect(result).toEqual({
			archived: false,
			deletedEvents: 0,
			deletedMessages: 0,
			deletedRuns: 1,
		});
	});
});
