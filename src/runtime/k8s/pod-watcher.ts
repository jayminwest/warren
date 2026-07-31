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
 * ## Reconnect story (design doc §1.3 "watch latency ~1-2s")
 *   - Initial `list` seeds the cache and captures a `resourceVersion`.
 *   - `watch` resumes from that `resourceVersion`; each event advances it, so a
 *     clean disconnect RESUMES without a relist (no missed events, no dup work).
 *   - A `410 Gone` (resourceVersion aged out of etcd's window) forces a full
 *     relist — the only correct recovery — refreshing the cache + version.
 *   - Any other disconnect reconnects after an exponential backoff, resuming
 *     from the last `resourceVersion`. Every reconnect bumps the reconnect
 *     counter.
 *
 * ## Periodic resync (warren-4f2b)
 * A watch that silently stops delivering events (server stall, missed DELETED
 * whose RV has aged out of our resume cursor) leaves a phantom cache entry
 * indefinitely — the loop has no reason to reconnect — masking a real
 * termination from `K8sProvider.status()` and the watchdog terminal-reconcile
 * net, so a run row wedges `running`. An independent `resyncPeriodMs` timer
 * (default 5 min) force-relists: `reconcileCache` drops any run id absent from
 * the fresh page, so a phantom cannot survive past one window.
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
	METRIC_EVICTED_TOTAL,
	METRIC_INIT_FAILURES_TOTAL,
	METRIC_OOM_KILLED_TOTAL,
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

/** The watch phases the K8s watch callback delivers. */
export type WatchPhase = "ADDED" | "MODIFIED" | "DELETED" | "BOOKMARK" | string;

/** Aborts an in-flight watch — `AbortController` satisfies this structurally. */
export interface WatchController {
	abort(): void;
}

/**
 * The low-level watch seam (mirrors `@kubernetes/client-node`'s `Watch.watch`):
 * open a watch at `path` with `queryParams`, invoking `onEvent(phase, obj)` per
 * event and `onDone(err)` exactly once when the stream ends (err is the failure
 * or `undefined`/`null` on a clean server close). Resolves to a controller that
 * aborts the stream.
 */
export type WatchFn = (
	path: string,
	queryParams: Readonly<Record<string, string | number | boolean | undefined>>,
	onEvent: (phase: WatchPhase, obj: V1Pod) => void,
	onDone: (err: unknown) => void,
) => Promise<WatchController>;

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
	/** Injected clock for pending-duration math. Default `() => new Date()`. */
	readonly now?: () => Date;
	/** Backoff floor / ceiling for reconnects (ms). Defaults 1s / 30s. */
	readonly backoffBaseMs?: number;
	readonly backoffMaxMs?: number;
	/**
	 * Periodic force-relist cadence (ms). Default `DEFAULT_RESYNC_PERIOD_MS`
	 * (5 min); `0` disables the resync. A watch that silently stops delivering
	 * events (server stall, missed DELETED) can leave the cache stale
	 * indefinitely; every resync tick force-relists so a phantom pod cannot
	 * survive more than one window past its real deletion (warren-4f2b).
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

const DEFAULT_BACKOFF_BASE_MS = 1_000;
const DEFAULT_BACKOFF_MAX_MS = 30_000;

/**
 * Force-relist cadence (warren-4f2b): 5 minutes. Bounds the worst-case window a
 * phantom cache entry can survive a silent watch by. Long enough that the
 * healthy path (watch delivers DELETED within ~1-2s of pod deletion) pays no
 * meaningful API-list overhead; short enough that a zombie run reaches the
 * watchdog's terminal-reconcile net (2 min grace, 30s tick) inside ~8 minutes
 * worst-case rather than the 30+ min the incident saw. Override via
 * `WARREN_K8S_POD_WATCHER_RESYNC_MS`; `0` disables.
 */
export const DEFAULT_RESYNC_PERIOD_MS = 5 * 60 * 1000;

/**
 * The list-then-watch informer. Construct with the injected seams, call
 * `start()` to seed the cache + begin watching, `stop()` to abort. Implements
 * both `PodCacheReader` (for `status()`) and `PodMetricsSource` (for `/metrics`).
 */
export class PodWatcher implements PodCacheReader, PodMetricsSource, PodAdmissionSource {
	private readonly cache = new Map<string, V1Pod>();
	/** runIds whose OOM kill we have already counted (count once, not per event). */
	private readonly oomCounted = new Set<string>();
	/** runIds whose eviction we have already counted (count once, not per event). */
	private readonly evictedCounted = new Set<string>();
	/** runIds whose workspace-init terminal we have already accounted for. */
	private readonly initAccounted = new Set<string>();
	private lastInitDurationSeconds: number | null = null;
	private resourceVersion: string | undefined;
	private running = false;
	private activeWatch: WatchController | undefined;
	/** Resolver for the in-flight `watchOnce` — invoked by `stop()` so the loop
	 * unparks even when the underlying watch never fires its own `done`. */
	private resolveWatch: ((err: unknown) => void) | undefined;
	private loopDone: Promise<void> | undefined;
	private backoffMs: number;
	/** Periodic force-relist timer (warren-4f2b). Cleared by `stop()`. */
	private resyncTimer: ReturnType<typeof setInterval> | undefined;
	/** Serializes a resync relist against the watch loop's own relist path. */
	private relistInFlight: Promise<void> | undefined;

	constructor(private readonly deps: PodWatcherDeps) {
		this.backoffMs = deps.backoffBaseMs ?? DEFAULT_BACKOFF_BASE_MS;
	}

	private get now(): () => Date {
		return this.deps.now ?? (() => new Date());
	}

	/** Begin watching. Idempotent — a second call while running is a no-op. */
	start(): void {
		if (this.running) return;
		this.running = true;
		this.loopDone = this.loop();
		this.scheduleResync();
	}

	/** Abort the watch and await the loop's exit. Idempotent. */
	async stop(): Promise<void> {
		this.running = false;
		if (this.resyncTimer !== undefined) {
			clearInterval(this.resyncTimer);
			this.resyncTimer = undefined;
		}
		this.activeWatch?.abort();
		this.activeWatch = undefined;
		// Unpark a `watchOnce` that is still waiting on `done` (abort may not fire
		// it) so the loop sees `!running` and exits rather than hanging `stop()`.
		this.resolveWatch?.(undefined);
		await this.loopDone?.catch(() => {});
		this.loopDone = undefined;
	}

	/**
	 * Schedule the periodic force-relist (warren-4f2b). Cache staleness caused by
	 * a silently-stalled watch or a missed DELETED event otherwise persists until
	 * the next natural reconnect/410 — potentially hours. A resync tick is a
	 * definitive server-truth snapshot: `reconcileCache` drops any run id not in
	 * the returned page, so a phantom cache entry (with its stale `phase: Running`)
	 * cannot survive past one window. `resyncPeriodMs: 0` opts out.
	 */
	private scheduleResync(): void {
		const period = this.deps.resyncPeriodMs ?? DEFAULT_RESYNC_PERIOD_MS;
		if (period <= 0) return;
		this.resyncTimer = setInterval(() => {
			if (!this.running) return;
			// Fire-and-forget: the loop's own relist path awaits `relistInFlight`
			// so this can't race with a concurrent 410 relist.
			void this.resyncRelist();
		}, period);
	}

	/**
	 * Serialize a force-relist against the watch loop's own relist (warren-4f2b).
	 * A resync tick that fires while the loop is already relisting after a 410
	 * awaits that relist rather than issuing a redundant API call.
	 */
	private async resyncRelist(): Promise<void> {
		if (this.relistInFlight !== undefined) {
			await this.relistInFlight;
			return;
		}
		this.deps.logger?.info?.(
			{ namespace: this.deps.namespace },
			"pod-watch periodic resync; relisting",
		);
		const promise = this.safeRelist();
		this.relistInFlight = promise.finally(() => {
			this.relistInFlight = undefined;
		});
		await this.relistInFlight;
	}

	// --- PodCacheReader ------------------------------------------------------

	getByRunId(runId: string): V1Pod | undefined {
		return this.cache.get(runId);
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

	// --- Watch loop ----------------------------------------------------------

	private async loop(): Promise<void> {
		await this.safeRelist();
		while (this.running) {
			const err = await this.watchOnce();
			if (!this.running) break;
			// The watch stream ended (clean close or error). Re-attach.
			this.deps.metrics.increment(METRIC_WATCH_RECONNECTS_TOTAL);
			if (isGone(err)) {
				this.deps.logger?.info?.(
					{ namespace: this.deps.namespace },
					"pod-watch 410 gone; relisting",
				);
				await this.safeRelist();
				this.resetBackoff();
			} else {
				this.deps.logger?.warn?.(
					{ namespace: this.deps.namespace, err: errText(err) },
					"pod-watch disconnected; backing off before resume",
				);
				await this.sleep(this.nextBackoff());
			}
		}
	}

	/** Re-list from scratch: refresh the cache to the server's truth + capture RV. */
	private async safeRelist(): Promise<void> {
		try {
			const { items, resourceVersion } = await this.deps.list();
			this.reconcileCache(items);
			this.resourceVersion = resourceVersion;
			this.resetBackoff();
		} catch (err) {
			this.deps.logger?.warn?.(
				{ namespace: this.deps.namespace, err: errText(err) },
				"pod-watch list failed; backing off",
			);
			if (this.running) await this.sleep(this.nextBackoff());
		}
	}

	/** Open one watch; resolve with the terminating error (or `undefined`). */
	private watchOnce(): Promise<unknown> {
		return new Promise<unknown>((resolve) => {
			let settled = false;
			const done = (err: unknown): void => {
				if (settled) return;
				settled = true;
				this.resolveWatch = undefined;
				resolve(err);
			};
			this.resolveWatch = done;
			const query: Record<string, string | number | boolean | undefined> = {
				labelSelector: LABEL_RUN_ID,
				allowWatchBookmarks: true,
				...(this.resourceVersion !== undefined ? { resourceVersion: this.resourceVersion } : {}),
			};
			this.deps
				.watch(this.watchPath(), query, (phase, obj) => this.onEvent(phase, obj), done)
				.then((controller) => {
					this.activeWatch = controller;
					if (!this.running) controller.abort();
				})
				.catch((err) => done(err));
		});
	}

	private watchPath(): string {
		return `/api/v1/namespaces/${this.deps.namespace}/pods`;
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

	private onEvent(phase: WatchPhase, obj: V1Pod): void {
		if (phase === "BOOKMARK") {
			// Bookmarks carry only an advanced resourceVersion (no pod payload).
			const rv = obj.metadata?.resourceVersion;
			if (rv !== undefined) this.resourceVersion = rv;
			return;
		}
		const rv = obj.metadata?.resourceVersion;
		if (rv !== undefined) this.resourceVersion = rv;
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
		this.accountInit(runId, pod);
	}

	private forget(runId: string): void {
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
	}

	// --- Backoff -------------------------------------------------------------

	private nextBackoff(): number {
		const current = this.backoffMs;
		const max = this.deps.backoffMaxMs ?? DEFAULT_BACKOFF_MAX_MS;
		this.backoffMs = Math.min(current * 2, max);
		return current;
	}

	private resetBackoff(): void {
		this.backoffMs = this.deps.backoffBaseMs ?? DEFAULT_BACKOFF_BASE_MS;
	}

	private sleep(ms: number): Promise<void> {
		if (ms <= 0) return Promise.resolve();
		return new Promise((resolve) => setTimeout(resolve, ms));
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

/** A `410 Gone` — the resourceVersion aged out of etcd's window; relist. */
function isGone(err: unknown): boolean {
	if (err === undefined || err === null) return false;
	const code = (err as { code?: unknown; statusCode?: unknown }).code;
	const statusCode = (err as { statusCode?: unknown }).statusCode;
	if (code === 410 || statusCode === 410) return true;
	const msg = errText(err);
	return /\b410\b/.test(msg) || /gone|expired|too old resource version/i.test(msg);
}

function errText(err: unknown): string {
	if (err === undefined || err === null) return "";
	if (err instanceof Error) return err.message;
	return String(err);
}
