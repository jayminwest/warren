import { describe, expect, test } from "bun:test";
import type { CoreV1Api, V1PodList } from "@kubernetes/client-node";
import type { FinalizeIntent, FinalizeResult, RunHandle } from "../contract.ts";
import { FinalizeCoordinator } from "./finalize-coordinator.ts";
import { K8sProvider } from "./provider.ts";

const handle: RunHandle = {
	runId: "run_prov_finalize",
	sandboxId: "run-run-prov-finalize",
	providerRunId: "pod-uid-9",
};

function intent(): FinalizeIntent {
	return {
		branch: "warren/run_prov_finalize",
		push: true,
		artifacts: ["mulch", "seeds", "plans"],
		commit: ["seeds"],
		baseBranch: "main",
		projectClonePathHint: "/data/projects/x",
	};
}

function podResult(): FinalizeResult {
	return {
		pushed: true,
		commitsAhead: 5,
		emptyPush: false,
		dirty: false,
		workspacePlansBody: null,
		events: [],
		artifacts: {},
		prBranch: "warren/run_prov_finalize",
		stages: [{ stage: "branch_push", status: "ok" }],
	};
}

/** coreApi whose pod list is scriptable — empty ⇒ status() reports run-lost. */
function fakeApi(podItems: V1PodList["items"]): CoreV1Api {
	return {
		listNamespacedPod: (): Promise<V1PodList> => Promise.resolve({ items: podItems } as V1PodList),
	} as unknown as CoreV1Api;
}

/** A setTimer firing callbacks at exactly `fireMs`; others are inert. */
function firingTimer(fireMs: number): (fn: () => void, ms: number) => { cancel: () => void } {
	return (fn, ms) => {
		if (ms === fireMs) queueMicrotask(fn);
		return { cancel: () => {} };
	};
}
const inertTimer = (): { cancel: () => void } => ({ cancel: () => {} });

describe("K8sProvider.finalize — pod-memory sample (warren-fe11)", () => {
	async function runFinalize(
		sampler: (runId: string) => Promise<unknown>,
	): Promise<FinalizeResult> {
		const coordinator = new FinalizeCoordinator();
		const provider = new K8sProvider({
			coreApi: () => fakeApi([{ metadata: { name: handle.sandboxId } }]),
			serverEnv: { WARREN_GIT_TOKEN: "ghp_pushtoken" },
			finalizeCoordinator: coordinator,
			finalizeSetTimer: inertTimer,
			podMemorySampler: sampler as never,
		});
		const p = provider.finalize(handle, intent());
		await Promise.resolve();
		const parked = coordinator.peekIntent(handle.runId);
		coordinator.submit(handle.runId, parked?.attemptId ?? "", podResult());
		return p;
	}

	test("stamps a single run_pod_memory_sample event when the sampler yields (warren-fe11)", async () => {
		const result = await runFinalize(async () => ({
			runId: handle.runId,
			podName: handle.sandboxId,
			agentMemoryMiB: 1494,
			sampledAt: "2026-09-02T00:00:00.000Z",
		}));
		const samples = result.events.filter((e) => e.kind === "run_pod_memory_sample");
		expect(samples).toHaveLength(1);
		expect((samples[0]?.payload as { agentMemoryMiB: number }).agentMemoryMiB).toBe(1494);
	});

	test("returns the result untouched when the sampler yields undefined (warren-fe11)", async () => {
		const result = await runFinalize(async () => undefined);
		expect(result.events.some((e) => e.kind === "run_pod_memory_sample")).toBe(false);
	});

	test("never throws out of the sampler hook (warren-fe11)", async () => {
		const result = await runFinalize(async () => {
			throw new Error("boom");
		});
		expect(result.pushed).toBe(true);
		expect(result.events.some((e) => e.kind === "run_pod_memory_sample")).toBe(false);
	});
});

describe("K8sProvider.finalize — wiring", () => {
	test("embeds the WARREN_GIT_TOKEN push credential into the served intent", async () => {
		const coordinator = new FinalizeCoordinator();
		const provider = new K8sProvider({
			coreApi: () => fakeApi([{ metadata: { name: handle.sandboxId } }]),
			serverEnv: { WARREN_GIT_TOKEN: "ghp_pushtoken" },
			finalizeCoordinator: coordinator,
			finalizeSetTimer: inertTimer,
		});
		const p = provider.finalize(handle, intent());
		await Promise.resolve();
		const parked = coordinator.peekIntent(handle.runId);
		expect(parked?.gitToken).toBe("ghp_pushtoken");
		// Host-only hint never crosses to the pod.
		expect(parked && "projectClonePathHint" in parked).toBe(false);
		coordinator.submit(handle.runId, parked?.attemptId ?? "", podResult());
		await expect(p).resolves.toMatchObject({ pushed: true, commitsAhead: 5 });
	});

	test("an intent-carried minted credential wins over the env-derived token (warren-4e1c)", async () => {
		const coordinator = new FinalizeCoordinator();
		const provider = new K8sProvider({
			coreApi: () => fakeApi([{ metadata: { name: handle.sandboxId } }]),
			serverEnv: { WARREN_GIT_TOKEN: "ghp_envtoken" },
			finalizeCoordinator: coordinator,
			finalizeSetTimer: inertTimer,
		});
		const p = provider.finalize(handle, {
			...intent(),
			gitCredential: { username: "x-access-token", secret: "minted_per_spawn", host: "github.com" },
		});
		await Promise.resolve();
		const parked = coordinator.peekIntent(handle.runId);
		expect(parked?.gitToken).toBe("minted_per_spawn");
		coordinator.submit(handle.runId, parked?.attemptId ?? "", podResult());
		await expect(p).resolves.toMatchObject({ pushed: true });
	});

	test("falls back to GITHUB_TOKEN, and omits the token when neither is set", async () => {
		const coordinator = new FinalizeCoordinator();
		const provider = new K8sProvider({
			coreApi: () => fakeApi([{ metadata: { name: handle.sandboxId } }]),
			serverEnv: { GITHUB_TOKEN: "ghp_fallback" },
			finalizeCoordinator: coordinator,
			finalizeSetTimer: inertTimer,
		});
		const p = provider.finalize(handle, intent());
		await Promise.resolve();
		expect(coordinator.peekIntent(handle.runId)?.gitToken).toBe("ghp_fallback");
		coordinator.submit(
			handle.runId,
			coordinator.peekIntent(handle.runId)?.attemptId ?? "",
			podResult(),
		);
		await p;

		const coord2 = new FinalizeCoordinator();
		const provider2 = new K8sProvider({
			coreApi: () => fakeApi([{ metadata: { name: handle.sandboxId } }]),
			serverEnv: {},
			finalizeCoordinator: coord2,
			finalizeSetTimer: inertTimer,
		});
		const p2 = provider2.finalize(handle, intent());
		await Promise.resolve();
		const parked2 = coord2.peekIntent(handle.runId);
		expect(parked2 && "gitToken" in parked2).toBe(false);
		coord2.submit(handle.runId, parked2?.attemptId ?? "", podResult());
		await p2;
	});

	test("App mode (allowStaticPushTokenFallback: false) never serves the static env token (warren-c9ac)", async () => {
		const coordinator = new FinalizeCoordinator();
		const provider = new K8sProvider({
			coreApi: () => fakeApi([{ metadata: { name: handle.sandboxId } }]),
			serverEnv: { WARREN_GIT_TOKEN: "ghp_static", GITHUB_TOKEN: "ghp_fallback" },
			allowStaticPushTokenFallback: false,
			finalizeCoordinator: coordinator,
			finalizeSetTimer: inertTimer,
		});
		const p = provider.finalize(handle, intent());
		await Promise.resolve();
		const parked = coordinator.peekIntent(handle.runId);
		expect(parked && "gitToken" in parked).toBe(false);
		coordinator.submit(handle.runId, parked?.attemptId ?? "", podResult());
		await p;
	});

	test("App mode still serves the minted intent token when the gate is off", async () => {
		const coordinator = new FinalizeCoordinator();
		const provider = new K8sProvider({
			coreApi: () => fakeApi([{ metadata: { name: handle.sandboxId } }]),
			serverEnv: { WARREN_GIT_TOKEN: "ghp_static" },
			allowStaticPushTokenFallback: false,
			finalizeCoordinator: coordinator,
			finalizeSetTimer: inertTimer,
		});
		const p = provider.finalize(handle, {
			...intent(),
			gitCredential: { username: "x-access-token", secret: "ghs_minted", host: "github.com" },
		});
		await Promise.resolve();
		const parked = coordinator.peekIntent(handle.runId);
		expect(parked?.gitToken).toBe("ghs_minted");
		coordinator.submit(handle.runId, parked?.attemptId ?? "", podResult());
		await p;
	});

	test("reads WARREN_K8S_FINALIZE_TIMEOUT_MS from env as the timeout budget", async () => {
		// The env knob (warren-fd08) must reach `finalizeK8sRun` as `timeoutMs`. Prove
		// it by firing ONLY the timer scheduled at the env value; the pod stays
		// present (a pod is listed) so the pod-gone probe never resolves.
		const coordinator = new FinalizeCoordinator();
		const provider = new K8sProvider({
			coreApi: () => fakeApi([{ metadata: { name: handle.sandboxId } }]),
			serverEnv: { WARREN_K8S_FINALIZE_TIMEOUT_MS: "4321" },
			finalizeCoordinator: coordinator,
			finalizeSetTimer: firingTimer(4321),
		});
		const res = await provider.finalize(handle, intent());
		expect((res.events[0]?.payload as { message: string }).message).toContain("4321ms");
	});

	test("an explicit finalizeTimeoutMs dep wins over the env knob", async () => {
		const coordinator = new FinalizeCoordinator();
		const provider = new K8sProvider({
			coreApi: () => fakeApi([{ metadata: { name: handle.sandboxId } }]),
			serverEnv: { WARREN_K8S_FINALIZE_TIMEOUT_MS: "4321" },
			finalizeCoordinator: coordinator,
			finalizeTimeoutMs: 777,
			finalizeSetTimer: firingTimer(777),
		});
		const res = await provider.finalize(handle, intent());
		expect((res.events[0]?.payload as { message: string }).message).toContain("777ms");
	});

	test("degrades to a failed result when the pod is gone (status lists no pod)", async () => {
		const coordinator = new FinalizeCoordinator();
		const provider = new K8sProvider({
			coreApi: () => fakeApi([]), // no pod ⇒ status().exists === false
			serverEnv: {},
			finalizeCoordinator: coordinator,
			finalizePodPollMs: 500,
			finalizeTimeoutMs: 999_999,
			finalizeSetTimer: firingTimer(500),
		});
		const res = await provider.finalize(handle, intent());
		expect(res.pushed).toBe(false);
		expect((res.events[0]?.payload as { message: string }).message).toContain("pod is gone");
	});
});
