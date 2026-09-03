/**
 * One-shot run-pod memory sample (warren-fe11). Reads a run pod's last
 * metrics.k8s.io memory usage for the agent (and workspace-init) containers and
 * returns a plain, JSON-serializable sample — or `undefined` on ANY failure
 * (no cluster config, metrics-server absent, pod gone, timeout). Never throws:
 * finalize re-sizings must not break because a metrics read did.
 *
 * Deliberately NOT wired into the pod-watcher or any gauge — this is a
 * finalize-time snapshot of the *peak-relevant last reading* so future sizing
 * decisions (RUNBOOK-K8S §5.6) ride measured data instead of guesses.
 */

import { KubeConfig, Metrics, type PodMetric } from "@kubernetes/client-node";
import type { FinalizeResult } from "../contract.ts";
import { podNameForRun } from "./pod-name.ts";
import { AGENT_CONTAINER_NAME, DEFAULT_K8S_NAMESPACE, INIT_CONTAINER_NAME } from "./pod-spec.ts";

/** A finalize-time memory snapshot for one run pod, in MiB. */
export interface PodMemorySample {
	readonly runId: string;
	readonly podName: string;
	/** Last-reported agent-container memory, MiB. */
	readonly agentMemoryMiB: number;
	/** Last-reported workspace-init memory, MiB, when the reading exists. */
	readonly workspaceInitMemoryMiB?: number;
	readonly sampledAt: string;
}

/** Injectable metrics source so tests never touch a cluster. */
export type PodMetricsFetcher = (namespace: string) => Promise<PodMetric[]>;

/** k8s quantity suffix → bytes. Bare numbers are bytes. */
const SUFFIX_BYTES: Record<string, number> = {
	Ki: 1024,
	Mi: 1024 ** 2,
	Gi: 1024 ** 3,
	Ti: 1024 ** 4,
	K: 1000,
	M: 1e6,
	G: 1e9,
	T: 1e12,
};

/**
 * Parse a K8s resource quantity (e.g. `"1129Mi"`, `"512Ki"`, `"1234567"`) into
 * MiB. Returns `undefined` for anything unparseable — callers must tolerate it.
 */
export function parseMemoryMiB(raw: string): number | undefined {
	const match = /^(\d+(?:\.\d+)?)\s*([A-Za-z]*)$/.exec(raw.trim());
	if (match === null || match[1] === undefined) return undefined;
	const value = Number(match[1]);
	if (!Number.isFinite(value)) return undefined;
	const suffix = match[2] ?? "";
	if (suffix === "") return value / (1024 * 1024);
	const bytes = SUFFIX_BYTES[suffix];
	if (bytes === undefined) return undefined;
	return (value * bytes) / (1024 * 1024);
}

/** Sum one named container's last memory reading off a PodMetric, in MiB. */
export function containerMemoryMiB(pod: PodMetric, containerName: string): number | undefined {
	const container = pod.containers?.find((c) => c.name === containerName);
	const raw = container?.usage?.memory;
	return raw === undefined ? undefined : parseMemoryMiB(raw);
}

/** Shape a PodMetricsList item into a `PodMemorySample` (undefined when the agent reading is absent). */
export function toPodMemorySample(
	runId: string,
	podName: string,
	pod: PodMetric,
): PodMemorySample | undefined {
	const agentMiB = containerMemoryMiB(pod, AGENT_CONTAINER_NAME);
	if (agentMiB === undefined) return undefined;
	const initMiB = containerMemoryMiB(pod, INIT_CONTAINER_NAME);
	return {
		runId,
		podName,
		agentMemoryMiB: agentMiB,
		...(initMiB !== undefined ? { workspaceInitMemoryMiB: initMiB } : {}),
		sampledAt: new Date().toISOString(),
	};
}

/** Default fetcher: lazily loads in-cluster/kubeconfig config and lists pod metrics for `namespace`. */
export const defaultPodMetricsFetcher: PodMetricsFetcher = (namespace) => {
	const kc = new KubeConfig();
	kc.loadFromDefault();
	// Not memoized: this runs at most once per run finalize, and memoizing a
	// config that may be absent is worth less than the simplicity. Fail fast (no
	// network attempt) when no cluster config resolves — the sampler degrades to
	// `undefined`.
	if (kc.getCurrentCluster() === null) throw new Error("no cluster config resolved");
	return new Metrics(kc).getPodMetrics(namespace).then((list) => list.items);
};

/**
 * Sample one run pod's memory. Never throws; resolves `undefined` on any
 * failure (config absent, metrics-server unreachable, pod gone, timeout).
 */
export async function sampleRunPodMemoryMiB(
	runId: string,
	opts: {
		podName?: string;
		namespace?: string;
		timeoutMs?: number;
		fetchPodMetrics?: PodMetricsFetcher;
	} = {},
): Promise<PodMemorySample | undefined> {
	const podName = opts.podName ?? podNameForRun(runId);
	const namespace = opts.namespace ?? DEFAULT_K8S_NAMESPACE;
	const fetchPodMetrics = opts.fetchPodMetrics ?? defaultPodMetricsFetcher;
	const timeoutMs = opts.timeoutMs ?? 5000;
	try {
		const pods = await Promise.race([
			fetchPodMetrics(namespace),
			new Promise<never>((_, reject) => {
				setTimeout(() => reject(new Error("pod memory sample timed out")), timeoutMs);
			}),
		]);
		const pod = pods.find((p) => p.metadata?.name === podName);
		if (pod === undefined) return undefined;
		return toPodMemorySample(runId, podName, pod);
	} catch {
		return undefined;
	}
}

/** A provider dep seam for the sampler (tests inject a stub). */
export type PodMemorySampler = (runId: string) => Promise<PodMemorySample | undefined>;

/**
 * warren-fe11 finalize hook: append one `run_pod_memory_sample` system event to
 * `result.events` carrying the pod's last memory reading, so future re-sizings
 * ride measured data. Best-effort — a failed sample (no metrics-server, pod
 * gone) returns `result` untouched; this never throws.
 */
export async function stampPodMemorySampleEvent(
	result: FinalizeResult,
	sampler: PodMemorySampler,
	runId: string,
): Promise<FinalizeResult> {
	try {
		const sample = await sampler(runId);
		if (sample === undefined) return result;
		return {
			...result,
			events: [...result.events, { kind: "run_pod_memory_sample", payload: sample }],
		};
	} catch {
		return result;
	}
}
