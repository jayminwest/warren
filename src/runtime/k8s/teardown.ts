/**
 * `K8sProvider.cancel` + `terminate` bodies (pl-829f step 19 / warren-31d4,
 * design k8s-migration.md §1.3 + runtime-provider-contract.md §4). Both delete
 * the run's pod; they differ in intent — the same split LocalProvider draws
 * between `../local/cancel.ts` (POST /cancel) and `../local/teardown.ts`
 * (burrows.destroy):
 *
 *   - **cancel(handle)** — a GRACEFUL stop of the AGENT. Deletes the pod with a
 *     positive `gracePeriodSeconds` (`config.cancelGracePeriodSeconds`), which is
 *     kubelet-native SIGTERM → grace → SIGKILL. Best-effort; the domain still
 *     reaps + terminates afterward (contract §3/§4). Returns `void`.
 *   - **terminate(handle)** — destroys the SANDBOX and reclaims its resources.
 *     Force-deletes the pod (`config.terminateGracePeriodSeconds`, default 0 —
 *     finalize already ran, nothing to flush) AND deletes the run's seed
 *     ConfigMap(s) by the `warren.io/run-id` label, returning a `TeardownResult`.
 *
 * ## Idempotency (both are safe to re-invoke)
 *   - **cancel:** a 404 (pod already gone — GC'd, or a double-cancel) is
 *     NEUTRALIZED into the seam-neutral `RuntimeRunNotFoundError`, exactly as
 *     LocalProvider maps burrow's 404 (`../local/cancel.ts`). The domain's
 *     `cancelRun` catches THIS to terminalize the ghost row (warren-b1a9) without
 *     importing a backend error class.
 *   - **terminate:** a 404 on the pod delete is treated as "already reclaimed"
 *     (`deletedRuns` stays 0) and teardown CONTINUES to the ConfigMap sweep, so a
 *     re-run is a clean no-op — matching the contract's "idempotent, best-effort"
 *     obligation. A 404 on any individual ConfigMap delete is likewise skipped.
 *
 * Every OTHER API failure (403 RBAC, 404 namespace-missing on a list, 5xx) maps
 * through the shared `mapApiError` onto a structured `RuntimeProviderError` — the
 * domain owns the best-effort try/catch at the call-site (`cancelRun`;
 * reap's `runWorkspaceDestroy`), never this provider seam.
 *
 * ## `TeardownResult` mapping (K8s ⇄ the burrow-shaped contract)
 *
 * | seam field        | K8s value | why                                                     |
 * |-------------------|-----------|---------------------------------------------------------|
 * | `archived`        | `false`   | the workspace is an `emptyDir`, destroyed with the pod  |
 * |                   |           | (`workspaceArchive: false` capability) — nothing to keep |
 * | `deletedEvents`   | `0`       | pod logs die with the pod; warren keeps no ephemeral    |
 * |                   |           | K8s event store to prune (unlike burrow)                |
 * | `deletedMessages` | `0`       | `run_inbox` rows CASCADE on the warren run-row delete    |
 * |                   |           | (step 18), not on pod teardown                          |
 * | `deletedRuns`     | `0 | 1`   | the pod itself — 1 when this call deleted it, 0 when it  |
 * |                   |           | was already gone (idempotent re-run)                    |
 */

import { ApiException, type CoreV1Api, type V1ConfigMap } from "@kubernetes/client-node";
import type { RunHandle, TeardownResult } from "../contract.ts";
import { RuntimeRunNotFoundError } from "../errors.ts";
import { mapApiError } from "./api-error.ts";
import { type K8sPodConfig, LABEL_RUN_ID } from "./pod-spec.ts";

/** Is this API failure a 404 (the resource is already gone)? */
function isNotFound(err: unknown): boolean {
	return err instanceof ApiException && err.code === 404;
}

/**
 * Graceful cancel: delete the run's pod with the configured SIGTERM grace. A 404
 * (pod already gone) surfaces as the seam-neutral `RuntimeRunNotFoundError` so
 * the domain recognizes a lost run without importing `@kubernetes/client-node`'s
 * error class; every other API failure maps onto `RuntimeProviderError`.
 *
 * Correlation is by pod NAME (`handle.sandboxId`, the sanitized `podNameForRun`
 * value `create()` stamped) — the same name `create()` returned in the handle.
 */
export async function cancelK8sRun(
	api: CoreV1Api,
	config: K8sPodConfig,
	handle: RunHandle,
): Promise<void> {
	try {
		await api.deleteNamespacedPod({
			name: handle.sandboxId,
			namespace: config.namespace,
			gracePeriodSeconds: config.cancelGracePeriodSeconds,
		});
	} catch (err) {
		if (isNotFound(err)) {
			throw new RuntimeRunNotFoundError(`run ${handle.runId} has no pod to cancel (already gone)`, {
				cause: err,
				recoveryHint: "the pod is unknown to the cluster; terminalize the warren row",
			});
		}
		throw mapApiError(err, `pod cancel (delete) for run ${handle.runId}`);
	}
}

/**
 * Destroy the sandbox: force-delete the pod, then delete the run's seed
 * ConfigMap(s) by label. Idempotent — an already-gone pod leaves `deletedRuns:0`
 * and the ConfigMap sweep still runs. Returns the `TeardownResult` the domain's
 * reap emits on `reap.workspace_destroyed`.
 */
export async function terminateK8sRun(
	api: CoreV1Api,
	config: K8sPodConfig,
	handle: RunHandle,
): Promise<TeardownResult> {
	let deletedRuns = 0;
	try {
		await api.deleteNamespacedPod({
			name: handle.sandboxId,
			namespace: config.namespace,
			gracePeriodSeconds: config.terminateGracePeriodSeconds,
		});
		deletedRuns = 1;
	} catch (err) {
		// Already gone ⇒ idempotent no-op; keep sweeping the ConfigMaps.
		if (!isNotFound(err)) {
			throw mapApiError(err, `pod terminate (delete) for run ${handle.runId}`);
		}
	}

	await deleteRunConfigMaps(api, config.namespace, handle.runId);

	return { archived: false, deletedEvents: 0, deletedMessages: 0, deletedRuns };
}

/**
 * Delete every ConfigMap labelled for this run (`warren.io/run-id=<runId>`) —
 * the seed ConfigMap `create()` made. Uses a label selector (not the derived
 * name) so a run that somehow owns more than one labelled ConfigMap is fully
 * reclaimed. Best-effort per item: a 404 on an individual delete is skipped
 * (raced with GC); a list/delete RBAC or server failure maps onto
 * `RuntimeProviderError`. Returns the count deleted.
 */
export async function deleteRunConfigMaps(
	api: CoreV1Api,
	namespace: string,
	runId: string,
): Promise<number> {
	let items: V1ConfigMap[];
	try {
		const list = await api.listNamespacedConfigMap({
			namespace,
			labelSelector: `${LABEL_RUN_ID}=${runId}`,
		});
		items = list.items;
	} catch (err) {
		throw mapApiError(err, `configmap list for run ${runId}`);
	}

	let deleted = 0;
	for (const cm of items) {
		const name = cm.metadata?.name;
		if (name === undefined) continue;
		try {
			await api.deleteNamespacedConfigMap({ name, namespace });
			deleted++;
		} catch (err) {
			if (isNotFound(err)) continue;
			throw mapApiError(err, `configmap delete ${name} for run ${runId}`);
		}
	}
	return deleted;
}
