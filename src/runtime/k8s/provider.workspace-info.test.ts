import { describe, expect, test } from "bun:test";
import { ApiException, type CoreV1Api, type V1Pod, type V1PodList } from "@kubernetes/client-node";
import type { RunHandle } from "../contract.ts";
import { ANNOTATION_BRANCH, LABEL_RUN_ID } from "./pod-spec.ts";
import { K8sProvider, type K8sProviderDeps } from "./provider.ts";

/**
 * `K8sProvider.workspaceInfo` (warren-e9e1): the pod's `/workspace` is
 * host-unreachable, so `workspacePath` is always null; the push branch is read
 * back from the `warren.io/branch` pod annotation stamped at create. Best-effort
 * — a gone pod / API error yields a null branch (never throws) so a succeeded run
 * still reaches finalize.
 */

const handle: RunHandle = {
	runId: "run_ws",
	sandboxId: "run-run-ws",
	providerRunId: "pod-uid-1",
};

interface ListCall {
	labelSelector?: string;
}

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

function podWith(branch: string | null, uid = "pod-uid-1"): V1Pod {
	return {
		metadata: {
			name: "run-run-ws",
			uid,
			labels: { [LABEL_RUN_ID]: "run_ws" },
			...(branch !== null ? { annotations: { [ANNOTATION_BRANCH]: branch } } : {}),
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

describe("K8sProvider.workspaceInfo", () => {
	test("null host path + branch read from the pod annotation", async () => {
		const fake = fakeApi({ items: [podWith("warren/run-ws")] });
		const info = await makeProvider(fake.api).workspaceInfo(handle);
		expect(info).toEqual({ workspacePath: null, branch: "warren/run-ws" });
		expect(fake.lists[0]?.labelSelector).toBe(`${LABEL_RUN_ID}=run_ws`);
	});

	test("a cache hit short-circuits the list", async () => {
		const fake = fakeApi({ items: [] });
		const info = await makeProvider(fake.api, {
			getByRunId: (id) => (id === "run_ws" ? podWith("warren/cached") : undefined),
		}).workspaceInfo(handle);
		expect(info).toEqual({ workspacePath: null, branch: "warren/cached" });
		expect(fake.lists).toHaveLength(0);
	});

	test("pod gone (empty list) → null branch, no throw", async () => {
		const fake = fakeApi({ items: [] });
		const info = await makeProvider(fake.api).workspaceInfo(handle);
		expect(info).toEqual({ workspacePath: null, branch: null });
	});

	test("missing annotation → null branch", async () => {
		const fake = fakeApi({ items: [podWith(null)] });
		const info = await makeProvider(fake.api).workspaceInfo(handle);
		expect(info.branch).toBeNull();
	});

	test("a list API error degrades to null branch (never throws)", async () => {
		const fake = fakeApi({ error: new ApiException(403, "forbidden", { message: "x" }, {}) });
		const info = await makeProvider(fake.api).workspaceInfo(handle);
		expect(info).toEqual({ workspacePath: null, branch: null });
	});
});
