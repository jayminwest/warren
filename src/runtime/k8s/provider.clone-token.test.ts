/**
 * Window-1 (init-container clone) mint-at-pod-spec-time tests (warren-c9ac,
 * forge-contract.md §4.1) — split out of `./provider.test.ts` for the file-size
 * budget. The fake CoreV1Api below is the minimal `create()` surface.
 */

import { describe, expect, test } from "bun:test";
import type { CoreV1Api, V1Pod, V1PodList } from "@kubernetes/client-node";
import type { RunSpec } from "../contract.ts";
import { K8sProvider, type K8sProviderDeps } from "./provider.ts";

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

function fakeApi(): { api: CoreV1Api; pods: V1Pod[] } {
	const pods: V1Pod[] = [];
	const api = {
		listNamespacedPod: (): Promise<V1PodList> => Promise.resolve({ items: [] } as V1PodList),
		createNamespacedPod: (param: { body: V1Pod }): Promise<V1Pod> => {
			pods.push(param.body);
			return Promise.resolve({ metadata: { name: param.body.metadata?.name, uid: "uid-1" } });
		},
	} as unknown as CoreV1Api;
	return { api, pods };
}

function makeProvider(
	fake: ReturnType<typeof fakeApi>,
	extra: Partial<K8sProviderDeps> = {},
): K8sProvider {
	return new K8sProvider({ coreApi: () => fake.api, serverEnv: {}, ...extra });
}

describe("K8sProvider.create — window-1 clone token (warren-c9ac)", () => {
	test("mints the clone credential at pod-spec time", async () => {
		const fake = fakeApi();
		const minted: string[] = [];
		await makeProvider(fake, {
			mintGitCredential: async (gitUrl) => {
				minted.push(gitUrl);
				return "ghs_fresh_clone";
			},
		}).create(spec);
		expect(minted).toEqual([spec.originUrl]);
		const pod = fake.pods[0];
		// Init container: the minted token rides as a PLAIN value; the static
		// Secret ref is skipped (an App-mode pod never references it).
		const initToken = pod?.spec?.initContainers?.[0]?.env?.find(
			(e) => e.name === "WARREN_GIT_TOKEN",
		);
		expect(initToken?.value).toBe("ghs_fresh_clone");
		expect(initToken?.valueFrom).toBeUndefined();
		// Agent container: same — the finalize/salvage window sees the fresh token.
		const agentToken = pod?.spec?.containers?.[0]?.env?.find((e) => e.name === "WARREN_GIT_TOKEN");
		expect(agentToken?.value).toBe("ghs_fresh_clone");
		expect(agentToken?.valueFrom).toBeUndefined();
	});

	test("a domain-pinned WARREN_GIT_TOKEN wins; the mint is not called", async () => {
		const fake = fakeApi();
		let called = false;
		await makeProvider(fake, {
			mintGitCredential: async () => {
				called = true;
				return "ghs_fresh_clone";
			},
		}).create({ ...spec, env: { WARREN_GIT_TOKEN: "ghp_pinned" } });
		expect(called).toBe(false);
		const initToken = fake.pods[0]?.spec?.initContainers?.[0]?.env?.find(
			(e) => e.name === "WARREN_GIT_TOKEN",
		);
		expect(initToken?.value).toBe("ghp_pinned");
	});

	test("an anonymous mint keeps the static Secret ref on the init container", async () => {
		const fake = fakeApi();
		await makeProvider(fake, { mintGitCredential: async () => undefined }).create(spec);
		const initToken = fake.pods[0]?.spec?.initContainers?.[0]?.env?.find(
			(e) => e.name === "WARREN_GIT_TOKEN",
		);
		expect(initToken?.value).toBeUndefined();
		expect(initToken?.valueFrom?.secretKeyRef?.name).toBe("warren-git-token");
	});

	test("a mint failure fails the dispatch loud (never clones on a dead token)", async () => {
		const fake = fakeApi();
		const provider = makeProvider(fake, {
			mintGitCredential: async () => {
				throw new Error("mint boom");
			},
		});
		await expect(provider.create(spec)).rejects.toThrow("mint boom");
		expect(fake.pods).toHaveLength(0);
	});
});
