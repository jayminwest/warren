/**
 * K8s runtime boot wiring (pl-829f step 25 / warren-7c30). The production
 * composition point that stands up the K8s backend's provider-internal
 * background loops — the pod-watcher informer (step 16 / warren-a7ff) and the
 * pod-GC loop (step 19 / warren-31d4) — under `WARREN_RUNTIME=k8s`. Until this
 * module existed, both classes were unit-tested but nothing constructed them in
 * `bootServer`; steps 16/19/21 each flagged the same wiring gap.
 *
 * ## What it builds (and why here)
 *   - A single lazy `CoreV1Api` + `Watch` pair, backed by ONE `KubeConfig`, so
 *     the watcher, the GC loop, AND the `K8sProvider` (threaded on via
 *     `deps.ts`) all share one client rather than each loading in-cluster config
 *     independently. Construction never touches a cluster — the KubeConfig is
 *     loaded lazily on first API call — so a test can build the whole wiring by
 *     injecting fake `coreApi`/`watch` seams.
 *   - A `PodWatcher` (list-then-watch informer) fed the shared `MetricsRegistry`
 *     as its `CounterSink`. It satisfies three seams at once: `PodCacheReader`
 *     (the provider's `status()` cache), `PodAdmissionSource` (admission counts),
 *     and `PodMetricsSource` (the `/metrics` pod-phase gauges).
 *   - A `PodGc` loop, also fed the shared `MetricsRegistry`, that reclaims
 *     terminal pods + their seed ConfigMaps past the retention window.
 *
 * Both loops are `start()`ed here and stopped by the returned handle's `stop()`,
 * which `bootServer` calls alongside its other lifecycle teardown.
 *
 * ## Local backend stays untouched
 * `bootK8sRuntime` returns `undefined` for any non-`k8s` runtime (the default
 * `local`), so under `WARREN_RUNTIME=local` nothing here is constructed and the
 * self-host boot path is byte-identical.
 */

import { ApiException, CoreV1Api, KubeConfig, type V1Pod, Watch } from "@kubernetes/client-node";
import { PodGc } from "../../runtime/k8s/pod-gc.ts";
import { LABEL_RUN_ID, resolveK8sPodConfig } from "../../runtime/k8s/pod-spec.ts";
import {
	type CounterSink,
	type PodListFn,
	PodWatcher,
	type WatchFn,
} from "../../runtime/k8s/pod-watcher.ts";
import { resolveRuntimeKind } from "../../runtime/registry.ts";
import type { EnvLike } from "../config.ts";
import type { Logger } from "../types.ts";

export interface BootK8sRuntimeInput {
	readonly env: EnvLike;
	/**
	 * Shared counter registry (the process-wide `MetricsRegistry`) — the same
	 * instance the `/metrics` handler renders, so the watcher's OOM / reconnect /
	 * init-failure counters and the GC's deletion counter surface with no extra
	 * wiring. Structurally a `CounterSink`.
	 */
	readonly metrics: CounterSink;
	readonly logger: Logger;
	/**
	 * OPTIONAL injected lazy core-API factory — tests pass a fake so the wiring
	 * builds (and the loops start) without a reachable cluster. Absent ⇒ a lazy
	 * in-cluster/kubeconfig-backed client.
	 */
	readonly coreApi?: () => CoreV1Api;
	/**
	 * OPTIONAL injected low-level watch seam (mirrors `@kubernetes/client-node`'s
	 * `Watch.watch`) — tests script the watch source. Absent ⇒ a lazy
	 * `Watch`-backed stream over the shared KubeConfig.
	 */
	readonly watch?: WatchFn;
	readonly now?: () => Date;
}

/** Handle over the started K8s background loops. `stop()` is idempotent. */
export interface K8sRuntimeHandle {
	readonly podWatcher: PodWatcher;
	readonly podGc: PodGc;
	/**
	 * The shared lazy core-API factory — threaded onto the `K8sProvider` (via
	 * `buildServerDeps`) so the provider's own pod create/get/delete calls reuse
	 * the same client the watcher + GC drive.
	 */
	readonly coreApi: () => CoreV1Api;
	stop(): Promise<void>;
}

/**
 * Stand up the K8s runtime's background loops when `WARREN_RUNTIME=k8s`; return
 * `undefined` otherwise (the loops are meaningless for `local`). Starts the
 * watcher + GC before returning.
 */
export function bootK8sRuntime(input: BootK8sRuntimeInput): K8sRuntimeHandle | undefined {
	if (resolveRuntimeKind(input.env) !== "k8s") return undefined;

	const config = resolveK8sPodConfig(input.env);
	const namespace = config.namespace;
	const clients = resolveK8sClients(input);
	const coreApi = clients.coreApi;
	const wireLogger = adaptLogger(input.logger);

	const podWatcher = new PodWatcher({
		list: realPodList(coreApi, namespace),
		watch: clients.watch,
		namespace,
		metrics: input.metrics,
		logger: wireLogger,
		...(input.now !== undefined ? { now: input.now } : {}),
	});

	const podGc = new PodGc({
		listPods: realPodListItems(coreApi, namespace),
		listConfigMaps: realConfigMapListItems(coreApi, namespace),
		deletePod: realDeletePod(coreApi, namespace),
		deleteConfigMap: realDeleteConfigMap(coreApi, namespace),
		metrics: input.metrics,
		logger: wireLogger,
		...(input.now !== undefined ? { now: input.now } : {}),
	});

	podWatcher.start();
	podGc.start();

	return {
		podWatcher,
		podGc,
		coreApi,
		stop: async () => {
			// Stop the GC first (it only sweeps) then the watcher, awaiting both so
			// no loop outlives boot teardown.
			await podGc.stop();
			await podWatcher.stop();
		},
	};
}

/**
 * Resolve the shared `CoreV1Api` + `WatchFn` seams. When both are injected
 * (tests), they win; otherwise ONE lazily-loaded `KubeConfig` backs both a
 * memoized `CoreV1Api` and a `Watch`, so the whole K8s runtime shares a single
 * client + config.
 */
function resolveK8sClients(input: BootK8sRuntimeInput): {
	coreApi: () => CoreV1Api;
	watch: WatchFn;
} {
	if (input.coreApi !== undefined && input.watch !== undefined) {
		return { coreApi: input.coreApi, watch: input.watch };
	}
	let kubeConfig: KubeConfig | undefined;
	const loadConfig = (): KubeConfig => {
		if (kubeConfig === undefined) {
			kubeConfig = new KubeConfig();
			kubeConfig.loadFromDefault();
		}
		return kubeConfig;
	};
	let cachedApi: CoreV1Api | undefined;
	const defaultCoreApi = (): CoreV1Api => {
		if (cachedApi === undefined) cachedApi = loadConfig().makeApiClient(CoreV1Api);
		return cachedApi;
	};
	let cachedWatch: Watch | undefined;
	const defaultWatch: WatchFn = (path, query, onEvent, onDone) => {
		if (cachedWatch === undefined) cachedWatch = new Watch(loadConfig());
		return cachedWatch.watch(path, query, (phase, obj) => onEvent(phase, obj as V1Pod), onDone);
	};
	return {
		coreApi: input.coreApi ?? defaultCoreApi,
		watch: input.watch ?? defaultWatch,
	};
}

/** Real list-then-watch `list` seam: one labelled page + its resourceVersion. */
function realPodList(coreApi: () => CoreV1Api, namespace: string): PodListFn {
	return async () => {
		const list = await coreApi().listNamespacedPod({ namespace, labelSelector: LABEL_RUN_ID });
		return { items: list.items, resourceVersion: list.metadata?.resourceVersion };
	};
}

/** GC pod list seam: the labelled run pods in the namespace. */
function realPodListItems(coreApi: () => CoreV1Api, namespace: string): () => Promise<V1Pod[]> {
	return async () => {
		const list = await coreApi().listNamespacedPod({ namespace, labelSelector: LABEL_RUN_ID });
		return list.items;
	};
}

/** GC ConfigMap list seam: the labelled seed ConfigMaps in the namespace. */
function realConfigMapListItems(coreApi: () => CoreV1Api, namespace: string) {
	return async () => {
		const list = await coreApi().listNamespacedConfigMap({
			namespace,
			labelSelector: LABEL_RUN_ID,
		});
		return list.items;
	};
}

/** GC pod delete seam: force-delete by name, resolving cleanly on a 404. */
function realDeletePod(
	coreApi: () => CoreV1Api,
	namespace: string,
): (name: string) => Promise<void> {
	return async (name: string) => {
		try {
			await coreApi().deleteNamespacedPod({ name, namespace, gracePeriodSeconds: 0 });
		} catch (err) {
			if (!isNotFound(err)) throw err;
		}
	};
}

/** GC ConfigMap delete seam: delete by name, resolving cleanly on a 404. */
function realDeleteConfigMap(
	coreApi: () => CoreV1Api,
	namespace: string,
): (name: string) => Promise<void> {
	return async (name: string) => {
		try {
			await coreApi().deleteNamespacedConfigMap({ name, namespace });
		} catch (err) {
			if (!isNotFound(err)) throw err;
		}
	};
}

/** A 404 from the K8s API — the resource is already gone (idempotent delete). */
function isNotFound(err: unknown): boolean {
	return err instanceof ApiException && err.code === 404;
}

/**
 * Adapt warren's `Logger` (params typed `object`) to the narrow `{ info?, warn? }`
 * seam the watcher + GC expect (params typed `unknown`) — strict function-type
 * variance rejects passing the `Logger` directly.
 */
function adaptLogger(logger: Logger): {
	info: (obj: unknown, msg: string) => void;
	warn: (obj: unknown, msg: string) => void;
} {
	return {
		info: (obj, msg) => logger.info(obj as object, msg),
		warn: (obj, msg) => logger.warn(obj as object, msg),
	};
}
