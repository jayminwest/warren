import { describe, expect, test } from "bun:test";
import { ApiException, type CoreV1Api, type V1Pod, type V1PodList } from "@kubernetes/client-node";
import type { RunHandle } from "../contract.ts";
import { RuntimeProviderError } from "../errors.ts";
import { AGENT_CONTAINER_NAME, LABEL_RUN_ID } from "./pod-spec.ts";
import { K8sProvider, type K8sProviderDeps } from "./provider.ts";

const handle: RunHandle = {
	runId: "run_status",
	sandboxId: "run-run-status",
	providerRunId: "pod-uid-9",
};

interface ListCall {
	namespace: string;
	labelSelector?: string;
}

/**
 * A recording fake of the object-param `listNamespacedPod` surface `status()`
 * touches. `items`/`error` steer the single list call; every call is recorded so
 * tests can assert the namespace + label selector.
 */
function fakeApi(opts: { items?: V1Pod[]; error?: unknown } = {}): {
	api: CoreV1Api;
	lists: ListCall[];
} {
	const lists: ListCall[] = [];
	const api = {
		listNamespacedPod: (param: ListCall): Promise<V1PodList> => {
			lists.push(param);
			if (opts.error !== undefined) return Promise.reject(opts.error);
			return Promise.resolve({ items: opts.items ?? [] } as V1PodList);
		},
	} as unknown as CoreV1Api;
	return { api, lists };
}

function podWith(opts: { phase: string; uid?: string; exitCode?: number; reason?: string }): V1Pod {
	return {
		metadata: {
			name: "run-run-status",
			uid: opts.uid,
			labels: { [LABEL_RUN_ID]: "run_status" },
		},
		status: {
			phase: opts.phase,
			...(opts.exitCode !== undefined
				? {
						containerStatuses: [
							{
								name: AGENT_CONTAINER_NAME,
								image: "warren-agent:latest",
								imageID: "",
								ready: false,
								restartCount: 0,
								state: {
									terminated: {
										exitCode: opts.exitCode,
										...(opts.reason !== undefined ? { reason: opts.reason } : {}),
									},
								},
							},
						],
					}
				: {}),
		},
	};
}

function makeProvider(api: CoreV1Api, podCache?: K8sProviderDeps["podCache"]): K8sProvider {
	return new K8sProvider({
		coreApi: () => api,
		serverEnv: {},
		...(podCache !== undefined ? { podCache } : {}),
	});
}

describe("K8sProvider.status — cache-cold list-by-label", () => {
	test("lists by the run-id LABEL (verbatim runId), never by pod name", async () => {
		const fake = fakeApi({ items: [podWith({ phase: "Running", uid: "pod-uid-9" })] });
		const status = await makeProvider(fake.api).status(handle);
		expect(fake.lists).toHaveLength(1);
		expect(fake.lists[0]?.namespace).toBe("warren-runs");
		expect(fake.lists[0]?.labelSelector).toBe(`${LABEL_RUN_ID}=run_status`);
		expect(status.phase).toBe("running");
		expect(status.exists).toBe(true);
	});

	test("Succeeded pod → succeeded/completed exit 0", async () => {
		const fake = fakeApi({ items: [podWith({ phase: "Succeeded", exitCode: 0 })] });
		const status = await makeProvider(fake.api).status(handle);
		expect(status).toMatchObject({ phase: "succeeded", terminalReason: "completed", exitCode: 0 });
	});

	test("OOMKilled pod → failed/oom_killed, surfaced fast", async () => {
		const fake = fakeApi({
			items: [podWith({ phase: "Failed", exitCode: 137, reason: "OOMKilled" })],
		});
		const status = await makeProvider(fake.api).status(handle);
		expect(status).toMatchObject({ phase: "failed", terminalReason: "oom_killed", exitCode: 137 });
	});

	test("empty list (pod GC'd / never created) → exists:false + lost, no throw", async () => {
		const fake = fakeApi({ items: [] });
		const status = await makeProvider(fake.api).status(handle);
		expect(status).toEqual({
			phase: "failed",
			exitCode: null,
			terminalReason: "lost",
			lastEventSeq: 0,
			lastEventTs: null,
			exists: false,
		});
	});

	// warren-ea4b: the pod watcher's vanished-spot-pod witness upgrades the
	// lost mapping to the retryable `preempted` cause.
	test("vanished pod on a deleted spot node → exists:false + preempted", async () => {
		const fake = fakeApi({ items: [] });
		const provider = new K8sProvider({
			coreApi: () => fake.api,
			serverEnv: {},
			preemptedPods: { wasPreempted: (runId) => runId === "run_status" },
		});
		const status = await provider.status(handle);
		expect(status.terminalReason).toBe("preempted");
		expect(status.exists).toBe(false);
	});

	test("prefers the pod whose uid matches the handle's providerRunId", async () => {
		const stale = podWith({ phase: "Failed", uid: "old-uid", exitCode: 1 });
		const current = podWith({ phase: "Running", uid: "pod-uid-9" });
		const fake = fakeApi({ items: [stale, current] });
		const status = await makeProvider(fake.api).status(handle);
		expect(status.phase).toBe("running");
	});

	test("a list API error maps onto a structured RuntimeProviderError", async () => {
		const fake = fakeApi({ error: new ApiException(403, "forbidden", { message: "no rbac" }, {}) });
		await expect(makeProvider(fake.api).status(handle)).rejects.toThrow(RuntimeProviderError);
		await expect(makeProvider(fake.api).status(handle)).rejects.toThrow(/HTTP 403/);
	});
});

describe("K8sProvider.status — cache consult", () => {
	test("a cache hit short-circuits the list entirely", async () => {
		const fake = fakeApi({ items: [] });
		const cached = podWith({ phase: "Running", uid: "pod-uid-9" });
		const status = await makeProvider(fake.api, {
			getByRunId: (runId) => (runId === "run_status" ? cached : undefined),
		}).status(handle);
		expect(status.phase).toBe("running");
		// The list was never consulted — served straight from the cache.
		expect(fake.lists).toHaveLength(0);
	});

	test("a cache miss falls back to the cache-cold list", async () => {
		const fake = fakeApi({ items: [podWith({ phase: "Succeeded", exitCode: 0 })] });
		const status = await makeProvider(fake.api, { getByRunId: () => undefined }).status(handle);
		expect(status.phase).toBe("succeeded");
		expect(fake.lists).toHaveLength(1);
	});
});
