/**
 * `K8sProvider.workspaceInfo` support (warren-e9e1) — resolve a run's push branch
 * off its pod, with the workspace path always null (the pod's `/workspace`
 * `emptyDir` is host-unreachable, so finalize runs in-pod and the domain applies
 * the returned mirror deltas to the project clone itself).
 *
 * Extracted from `provider.ts` to keep it under its frozen size budget. Also home
 * to the shared `pickPodForRun` pod-selection helper (`status()` uses it too).
 */

import type { CoreV1Api, V1Pod } from "@kubernetes/client-node";
import type { EnvLike } from "../../runs/spawn/callback-env.ts";
import type { RunHandle, WorkspaceInfo } from "../contract.ts";
import { ANNOTATION_BRANCH, LABEL_RUN_ID, resolveK8sPodConfig } from "./pod-spec.ts";
import type { PodCacheReader } from "./pod-watcher.ts";

/** The pieces of `K8sProviderDeps` the branch resolver reads. */
export interface K8sWorkspaceInfoDeps {
	readonly coreApi: () => CoreV1Api;
	readonly serverEnv?: EnvLike;
	readonly podCache?: PodCacheReader;
}

/**
 * Choose the pod for a run from a label-filtered list. The deterministic pod
 * name makes >1 live pod per runId impossible, but a handle carrying a specific
 * pod uid (`providerRunId`) prefers the exact match so a stale-then-recreated
 * pod can't be mistaken for the current one; otherwise the sole item. Empty ⇒
 * `undefined` (the caller maps that to run-lost).
 */
export function pickPodForRun(items: V1Pod[], handle: RunHandle): V1Pod | undefined {
	if (items.length === 0) return undefined;
	if (handle.providerRunId !== "") {
		const exact = items.find((p) => p.metadata?.uid === handle.providerRunId);
		if (exact !== undefined) return exact;
	}
	return items[0];
}

/** Read the run's push branch off a pod's `warren.io/branch` annotation. */
function branchFromPod(pod: V1Pod): string | null {
	const branch = pod.metadata?.annotations?.[ANNOTATION_BRANCH];
	return branch !== undefined && branch !== "" ? branch : null;
}

/**
 * Resolve `{ workspacePath: null, branch }` for a run. The pod-watcher cache
 * short-circuits the list (same optimization as `status()`); on a miss or no
 * cache we list by the `warren.io/run-id` label. Best-effort: a gone pod / API
 * error / absent annotation yields a `null` branch (never throws) so a succeeded
 * run still reaches finalize (which then pushes `HEAD` or degrades in-pod).
 */
export async function k8sWorkspaceInfo(
	deps: K8sWorkspaceInfoDeps,
	handle: RunHandle,
): Promise<WorkspaceInfo> {
	const cached = deps.podCache?.getByRunId(handle.runId);
	if (cached !== undefined) return { workspacePath: null, branch: branchFromPod(cached) };
	try {
		const config = resolveK8sPodConfig(deps.serverEnv ?? process.env);
		const list = await deps.coreApi().listNamespacedPod({
			namespace: config.namespace,
			labelSelector: `${LABEL_RUN_ID}=${handle.runId}`,
		});
		const pod = pickPodForRun(list.items, handle);
		return { workspacePath: null, branch: pod === undefined ? null : branchFromPod(pod) };
	} catch {
		// A list error must not strand a succeeded run before finalize.
		return { workspacePath: null, branch: null };
	}
}
