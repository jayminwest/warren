/**
 * Pod-watcher informer for the K8s runtime backend (pl-829f step 16 /
 * warren-a7ff, design doc §1.3/§3.2). A list-then-watch loop over run pods in
 * the `warren-runs` namespace filtered to `warren.io/run-id`, feeding:
 *
 *   1. a live in-memory cache keyed by run id that `K8sProvider.status()` may
 *      consult as an optimization (status() still works cache-cold — it lists by
 *      label when the cache misses); and
 *   2. Prometheus metrics — the OOM-kill / watch-reconnect / init-failure
 *      counters (through warren's shared `MetricsRegistry`) and the pod-phase /
 *      pending-duration / init-duration gauges (via `metricsSnapshot()`).
 *
 * ## Why list-then-watch, not `makeInformer`
 * `@kubernetes/client-node` ships `makeInformer` / `ListWatch`, but those bury
 * the reconnect + relist behind a live `KubeConfig` + HTTP client that is
 * awkward to drive from a unit test. This watcher takes the `list` and `watch`
 * seams as injected functions (real construction wires them to `CoreV1Api` +
 * `Watch`; tests pass fakes), so the reconnect / backoff / 410-relist logic is
 * exercised against a mocked watch. The `Watch.watch` low-level callback API is
 * the most mockable seam the library exposes.
 *
 * ## Loop machinery (warren-32f8)
 * The reconnect / backoff / 410-relist / periodic-resync loop itself is the
 * generic `ListWatchLoop` in `./list-watch.ts`, extracted so the pod-warning
 * events watcher (`./pod-event-watcher.ts`) shares it rather than copy-pasting
 * (see that module for the reconnect + resync story, warren-4f2b). This class
 * keeps only the pod-specific state: the run-id cache, the OOM / eviction /
 * init-terminal metric accounting.
 *
 * ## Scope (warren-a7ff)
 * Provider-internal plumbing + metrics ONLY. This watcher does NOT mutate warren
 * run rows / dispatch / reap — the pod-phase → run-row reconcile is a later step
 * (the watchdog wiring in design doc §3.2). It observes; it does not drive the
 * domain.
 */

import type { V1Pod } from "@kubernetes/client-node";
import {
	type AdmissionCounts,
	countPodsForAdmission,
	type PodAdmissionSource,
} from "./admission.ts";
import {
	DEFAULT_RESYNC_PERIOD_MS,
	type ListWatchFn,
	ListWatchLoop,
	type WatchController,
	type WatchPhase,
} from "./list-watch.ts";
import {
	METRIC_EVICTED_TOTAL,
	METRIC_INIT_FAILURES_TOTAL,
	METRIC_OOM_KILLED_TOTAL,
	METRIC_PREEMPTED_TOTAL,
	METRIC_WATCH_RECONNECTS_TOTAL,
	type PodMetricsSnapshot,
	type PodMetricsSource,
} from "./pod-metrics.ts";
import { INIT_CONTAINER_NAME, LABEL_PROJECT, LABEL_RUN_ID } from "./pod-spec.ts";
import { mapPodToRunStatus } from "./status-map.ts";

/** kubelet's `terminated.reason` for a cgroup OOM kill. */
const OOM_KILLED_REASON = "OOMKilled";

/** Minimal counter surface the watcher feeds — satisfied by `MetricsRegistry`. */
export interface CounterSink {
	increment(name: string, labels?: Readonly<Record<string, string>>, by?: number): void;
}

export { DEFAULT_RESYNC_PERIOD_MS, type WatchController, type WatchPhase };

/** The pod-typed watch seam (mirrors `@kubernetes/client-node`'s `Watch.watch`). */
export type WatchFn = ListWatchFn<V1Pod>;

/** Lists the current run pods — one page is assumed (the run namespace is small). */
export type PodListFn = () => Promise<{
	items: V1Pod[];
	resourceVersion: string | undefined;
}>;

export interface PodWatcherDeps {
	readonly list: PodListFn;
	readonly watch: WatchFn;
	/** `warren-runs` namespace the watch path is built for. */
	readonly namespace: string;
	/** Shared counter registry (OOM / reconnect / init-failure totals). */
	readonly metrics: CounterSink;
	/**
	 * Workspace-ready signal (warren-7116) — the runtime → domain edge for the
	 * `runs.workspace_ready_at` stamp. Fired once per run when the
	 * workspace-init container terminates (success or failure); the writer is
	 * first-write-wins domain-side. Optional so tests that never assert the
	 * stamp can omit it.
	 */
	readonly onWorkspaceReady?: (runId: string, at: Date) => void;
	/**
	 * Optional cluster seam (warren-ea4b): reports whether a NODE was deleted
	 * while carrying the `cloud.google.com/gke-spot=true` label. Consulted when
	 * a tracked pod VANISHES (`forget`) so a spot reclamation that removed the
	 * pod before its terminal status could be observed still counts as a
	 * preemption and lands the run on the retryable `preempted` cause. Absent ⇒
	 * the vanished-pod arm is inert and only the in-status witnesses classify.
	 */
	readonly deletedSpotNode?: (nodeName: string) => boolean;
	/** Injected clock for pending-duration math. Default `() => new Date()`. */
	readonly now?: () => Date;
	/** Backoff floor / ceiling for reconnects (ms). Defaults 1s / 30s. */
	readonly backoffBaseMs?: number;
	readonly backoffMaxMs?: number;
	/**
	 * Periodic force-relist cadence (ms). Default `DEFAULT_RESYNC_PERIOD_MS`
	 * (5 min); `0` disables the resync. See `ListWatchLoop` (warren-4f2b).
	 */
	readonly resyncPeriodMs?: number;
	readonly logger?: {
		info?: (obj: unknown, msg: string) => void;
		warn?: (obj: unknown, msg: string) => void;
	};
}

/** Read seam `K8sProvider.status()` consults before a cache-cold list. */
export interface PodCacheReader {
	getByRunId(runId: string): V1Pod | undefined;
}

/**
 * Informer sync-state seam (warren-39e1). The `/readyz` `k8s_api_reachable`
 * check reads this as the positive K8s-topology readiness signal: `true`
 * means the watcher has listed against the API server and holds a live watch;
 * `false` means the API is unreachable or the stream is down.
 */
export interface PodSyncSource {
	isSynced(): boolean;
}

/**
 * The pod informer. Construct with the injected seams, call `start()` to seed
 * the cache + begin watching, `stop()` to abort. Implements `PodCacheReader`
 * (for `status()`), `PodMetricsSource` (for `/metrics`), and
 * `PodAdmissionSource` (for the admission gate).
 */
export class PodWatcher
	implements PodCacheReader, PodMetricsSource, PodAdmissionSource, PodSyncSource
{
	private readonly cache = new Map<string, V1Pod>();
	/** runIds whose OOM kill we have already counted (count once, not per event). */
	private readonly oomCounted = new Set<string>();
	/** runIds whose eviction we have already counted (count once, not per event). */
	private readonly evictedCounted = new Set<string>();
	/** runIds whose preemption we have already counted (count once, not per event). */
	private readonly preemptedCounted = new Set<string>();
	/**
	 * runIds whose pod vanished while its (spot-labelled) node was deleted —
	 * the third preemption witness. Kept AFTER the cache forgets the pod so the
	 * provider's `status()` can still classify the absent pod as `preempted`.
	 */
	private readonly vanishedPreempted = new Set<string>();
	/** runIds whose workspace-init terminal we have already accounted for. */
	private readonly initAccounted = new Set<string>();
	private lastInitDurationSeconds: number | null = null;
	private readonly loop: ListWatchLoop<V1Pod>;

	constructor(private readonly deps: PodWatcherDeps) {
		this.loop = new ListWatchLoop<V1Pod>({
			label: "pod-watch",
			path: `/api/v1/namespaces/${deps.namespace}/pods`,
			query: { labelSelector: LABEL_RUN_ID, allowWatchBookmarks: true },
			list: deps.list,
			watch: deps.watch,
			onRelist: (items) => this.reconcileCache(items),
			onEvent: (phase, obj) => this.handleEvent(phase, obj),
			onReconnect: () => deps.metrics.increment(METRIC_WATCH_RECONNECTS_TOTAL),
			...(deps.backoffBaseMs !== undefined ? { backoffBaseMs: deps.backoffBaseMs } : {}),
			...(deps.backoffMaxMs !== undefined ? { backoffMaxMs: deps.backoffMaxMs } : {}),
			...(deps.resyncPeriodMs !== undefined ? { resyncPeriodMs: deps.resyncPeriodMs } : {}),
			...(deps.logger !== undefined ? { logger: deps.logger } : {}),
		});
	}

	private get now(): () => Date {
		return this.deps.now ?? (() => new Date());
	}

	/** Begin watching. Idempotent — a second call while running is a no-op. */
	start(): void {
		this.loop.start();
	}

	/** Abort the watch and await the loop's exit. Idempotent. */
	async stop(): Promise<void> {
		await this.loop.stop();
	}

	// --- PodSyncSource -------------------------------------------------------

	/**
	 * Whether the informer is synced against the K8s API server (warren-39e1).
	 * Delegates to the loop's sync state; `/readyz` consults it for the
	 * `k8s_api_reachable` check.
	 */
	isSynced(): boolean {
		return this.loop.isSynced();
	}

	// --- PodCacheReader ------------------------------------------------------

	getByRunId(runId: string): V1Pod | undefined {
		return this.cache.get(runId);
	}

	/**
	 * Reverse lookup — pod NAME → run id (warren-32f8). The pod-warning events
	 * watcher correlates a core Event's `involvedObject.name` back to the run
	 * through this, because the DNS-1123-sanitized pod name cannot be
	 * losslessly reversed (the verbatim run id lives only on the label).
	 */
	runIdForPodName(podName: string): string | undefined {
		for (const [runId, pod] of this.cache) {
			if (pod.metadata?.name === podName) return runId;
		}
		return undefined;
	}

	// --- PodAdmissionSource --------------------------------------------------

	/**
	 * Point-in-time admission counts off the live cache (warren-b6f2) — the K8s
	 * provider's `create()` reads these to gate on queue-depth / max-pending /
	 * per-project caps without an API round-trip. Shares the pure
	 * `countPodsForAdmission` tally the cache-cold list path also uses.
	 */
	admissionSnapshot(projectId: string | undefined): AdmissionCounts {
		return countPodsForAdmission([...this.cache.values()], projectId, LABEL_PROJECT);
	}

	/**
	 * Whether the run's pod vanished while its (spot-labelled) node was deleted
	 * (warren-ea4b). Wired into `K8sProvider.status()` so an absent pod maps to
	 * the retryable `preempted` terminalReason instead of plain `lost`.
	 */
	wasPreempted(runId: string): boolean {
		return this.vanishedPreempted.has(runId);
	}

	// --- PodMetricsSource ----------------------------------------------------

	metricsSnapshot(): PodMetricsSnapshot {
		const phaseCounts: Record<string, number> = {};
		let pendingDurationSeconds = 0;
		const nowMs = this.now().getTime();
		for (const pod of this.cache.values()) {
			const phase = pod.status?.phase ?? "Pending";
			phaseCounts[phase] = (phaseCounts[phase] ?? 0) + 1;
			if (phase === "Pending") {
				const age = pendingAgeSeconds(pod, nowMs);
				if (age > pendingDurationSeconds) pendingDurationSeconds = age;
			}
		}
		return {
			phaseCounts,
			pendingDurationSeconds,
			lastInitDurationSeconds: this.lastInitDurationSeconds,
		};
	}

	// --- Cache + metric reconciliation ---------------------------------------

	/** Replace the cache with a fresh list, dropping run ids no longer present. */
	private reconcileCache(items: V1Pod[]): void {
		const seen = new Set<string>();
		for (const pod of items) {
			const runId = runIdOf(pod);
			if (runId === undefined) continue;
			seen.add(runId);
			this.applyPod(runId, pod);
		}
		for (const runId of [...this.cache.keys()]) {
			if (!seen.has(runId)) this.forget(runId);
		}
	}

	private handleEvent(phase: WatchPhase, obj: V1Pod): void {
		const runId = runIdOf(obj);
		if (runId === undefined) return;
		if (phase === "DELETED") {
			this.forget(runId);
			return;
		}
		this.applyPod(runId, obj);
	}

	/** Store a pod and fold its OOM / eviction / init-terminal signals into the metrics. */
	private applyPod(runId: string, pod: V1Pod): void {
		this.cache.set(runId, pod);
		this.accountOom(runId, pod);
		this.accountEvicted(runId, pod);
		this.accountPreempted(runId, pod);
		this.accountInit(runId, pod);
	}

	private forget(runId: string): void {
		const pod = this.cache.get(runId);
		// warren-ea4b: a pod disappearing while its Spot node is being deleted is
		// a preemption the pod may never live long enough to report in status.
		const nodeName = pod?.spec?.nodeName;
		if (
			pod !== undefined &&
			nodeName !== undefined &&
			this.deps.deletedSpotNode?.(nodeName) === true &&
			!this.preemptedCounted.has(runId)
		) {
			this.preemptedCounted.add(runId);
			this.vanishedPreempted.add(runId);
			this.deps.metrics.increment(METRIC_PREEMPTED_TOTAL);
			this.deps.logger?.warn?.(
				{ runId, nodeName },
				"run pod vanished while its spot node was deleted",
			);
		}
		this.cache.delete(runId);
		this.oomCounted.delete(runId);
		this.evictedCounted.delete(runId);
		this.initAccounted.delete(runId);
	}

	/** Count an OOM kill once per run, the first time the pod maps to `oom_killed`. */
	private accountOom(runId: string, pod: V1Pod): void {
		if (this.oomCounted.has(runId)) return;
		if (mapPodToRunStatus(pod).terminalReason === "oom_killed") {
			this.oomCounted.add(runId);
			this.deps.metrics.increment(METRIC_OOM_KILLED_TOTAL);
		}
	}

	/** Count an eviction once per run, the first time the pod maps to `evicted` (warren-c0cd). */
	private accountEvicted(runId: string, pod: V1Pod): void {
		if (this.evictedCounted.has(runId)) return;
		const status = mapPodToRunStatus(pod);
		if (status.terminalReason === "evicted") {
			this.evictedCounted.add(runId);
			this.deps.metrics.increment(METRIC_EVICTED_TOTAL);
			// Warn-log the kubelet's eviction message the moment it is observed
			// (warren-4a95): the pod and its kubectl events age out of the API, so
			// this line is often the only surviving copy of the cause (e.g. `Pod
			// ephemeral local storage usage exceeds the total limit of containers
			// 10Gi`). The watchdog reconcile event carries the same detail onto
			// the run record.
			this.deps.logger?.warn?.(
				{
					runId,
					reason: pod.status?.reason,
					...(status.terminalDetail != null ? { detail: status.terminalDetail } : {}),
				},
				"run pod evicted by kubelet",
			);
		}
	}

	/**
	 * Count a Spot preemption once per run (warren-ea4b): either the pod's own
	 * terminal status witnesses it (`isPreemptedPod`) or it vanished while its
	 * spot node was deleted (recorded in `forget`, already counted there).
	 */
	private accountPreempted(runId: string, pod: V1Pod): void {
		if (this.preemptedCounted.has(runId)) return;
		if (mapPodToRunStatus(pod).terminalReason === "preempted") {
			this.preemptedCounted.add(runId);
			this.deps.metrics.increment(METRIC_PREEMPTED_TOTAL);
			this.deps.logger?.warn?.(
				{
					runId,
					reason: pod.status?.reason,
					...(pod.status?.message != null ? { detail: pod.status.message } : {}),
				},
				"run pod preempted (spot node reclaimed)",
			);
		}
	}

	/** Record the workspace-init container's runtime + failures, once per run. */
	private accountInit(runId: string, pod: V1Pod): void {
		if (this.initAccounted.has(runId)) return;
		const init = (pod.status?.initContainerStatuses ?? []).find(
			(cs) => cs.name === INIT_CONTAINER_NAME,
		);
		const term = init?.state?.terminated;
		if (term === undefined) return;
		this.initAccounted.add(runId);
		const seconds = durationSeconds(term.startedAt, term.finishedAt);
		if (seconds !== null) this.lastInitDurationSeconds = seconds;
		if ((term.exitCode ?? 0) !== 0 || term.reason === OOM_KILLED_REASON) {
			this.deps.metrics.increment(METRIC_INIT_FAILURES_TOTAL);
		}
		// warren-7116: stamp the workspace-ready stage timestamp off the init
		// container's own completion (kubelet clock), falling back to the
		// watcher's clock when the pod didn't carry a finishedAt stamp.
		const finishedAt = term.finishedAt ?? this.now();
		try {
			this.deps.onWorkspaceReady?.(runId, finishedAt);
		} catch {
			// The stamp is best-effort observability; a writer fault must never
			// tear down the watch loop.
		}
	}
}

/** The `warren.io/run-id` label value — the run correlation key. */
function runIdOf(pod: V1Pod): string | undefined {
	const value = pod.metadata?.labels?.[LABEL_RUN_ID];
	return value === undefined || value === "" ? undefined : value;
}

/** Seconds a currently-`Pending` pod has been pending, from its creation stamp. */
function pendingAgeSeconds(pod: V1Pod, nowMs: number): number {
	const created = pod.metadata?.creationTimestamp;
	if (created === undefined) return 0;
	const ms = nowMs - toMs(created);
	return ms > 0 ? Math.floor(ms / 1000) : 0;
}

function durationSeconds(
	start: Date | string | undefined,
	end: Date | string | undefined,
): number | null {
	if (start === undefined || end === undefined) return null;
	const ms = toMs(end) - toMs(start);
	return ms >= 0 ? ms / 1000 : null;
}

function toMs(value: Date | string): number {
	return (value instanceof Date ? value : new Date(value)).getTime();
}
