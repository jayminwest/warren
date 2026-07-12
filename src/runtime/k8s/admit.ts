/**
 * The impure half of K8s admission control (warren-b6f2) — the orchestration
 * that sources live pod counts and applies the pure gate in `./admission.ts`.
 * Split out of `K8sProvider.create()` so the provider stays lean and the
 * count-sourcing (a wired pod-watcher snapshot, else a cache-cold list) lives
 * next to the gate it feeds. Throws `RuntimeAdmissionError` (→ 429) on refusal.
 */

import type { CoreV1Api, V1Pod } from "@kubernetes/client-node";
import type { RunSpec } from "../contract.ts";
import { RuntimeAdmissionError } from "../errors.ts";
import {
	type AdmissionCounterSink,
	type AdmissionCounts,
	type AdmissionEnv,
	admissionDisabled,
	countPodsForAdmission,
	evaluateAdmission,
	METRIC_ADMISSION_REJECTIONS_TOTAL,
	type PodAdmissionSource,
	resolveAdmissionCaps,
} from "./admission.ts";
import { mapApiError } from "./api-error.ts";
import { LABEL_MANAGED_BY, LABEL_PROJECT, MANAGED_BY_VALUE } from "./pod-spec.ts";

/** Everything the admission gate needs, threaded from `K8sProvider.create()`. */
export interface K8sAdmissionInput {
	readonly api: CoreV1Api;
	readonly namespace: string;
	readonly env: AdmissionEnv;
	readonly spec: Pick<RunSpec, "runId" | "projectId" | "maxProjectConcurrency">;
	/** Live count source (pod-watcher); `undefined` ⇒ cache-cold list-by-label. */
	readonly podAdmission: PodAdmissionSource | undefined;
	/** Rejection-metric sink (`{reason}`-labelled); `undefined` ⇒ uncounted. */
	readonly metrics: AdmissionCounterSink | undefined;
}

/**
 * Gate a dispatch. Resolve caps from env + the spec's per-project override,
 * gather current run-pod counts, and apply `evaluateAdmission`. A rejection
 * increments the `{reason}` metric and throws `RuntimeAdmissionError` (mapped to
 * 429 + `Retry-After`). When every cap is unlimited the counting round-trip is
 * skipped entirely — admission is off unless an operator opts a cap in.
 */
export async function admitK8sCreate(input: K8sAdmissionInput): Promise<void> {
	const caps = resolveAdmissionCaps(input.env, input.spec.maxProjectConcurrency);
	if (admissionDisabled(caps)) return;
	const counts = await gatherAdmissionCounts(input);
	const decision = evaluateAdmission(counts, caps);
	if (decision.admit) return;
	input.metrics?.increment(METRIC_ADMISSION_REJECTIONS_TOTAL, { reason: decision.reason });
	throw new RuntimeAdmissionError(`run ${input.spec.runId} rejected: ${decision.detail}`, {
		reason: decision.reason,
		retryAfterSeconds: decision.retryAfterSeconds,
		recoveryHint: `the cluster is at capacity; retry after ${decision.retryAfterSeconds}s or raise the relevant admission cap`,
	});
}

/**
 * Source the counts: prefer the pod-watcher's in-memory snapshot (no API call),
 * else list all warren-managed run pods by label and tally them with the same
 * pure `countPodsForAdmission` — so admission works cache-cold (mirrors
 * `status()`'s cache-preferred posture).
 */
async function gatherAdmissionCounts(input: K8sAdmissionInput): Promise<AdmissionCounts> {
	if (input.podAdmission !== undefined) {
		return input.podAdmission.admissionSnapshot(input.spec.projectId);
	}
	let items: V1Pod[];
	try {
		const list = await input.api.listNamespacedPod({
			namespace: input.namespace,
			labelSelector: `${LABEL_MANAGED_BY}=${MANAGED_BY_VALUE}`,
		});
		items = list.items;
	} catch (err) {
		throw mapApiError(err, "admission pod list");
	}
	return countPodsForAdmission(items, input.spec.projectId, LABEL_PROJECT);
}
