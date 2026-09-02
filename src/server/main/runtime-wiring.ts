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

import {
	ApiException,
	CoreV1Api,
	type CoreV1Event,
	KubeConfig,
	type V1Pod,
	Watch,
} from "@kubernetes/client-node";
import type { Forge } from "../../forge/contract.ts";
import { mintGitCredential } from "../../forge/credentials.ts";
import type { RuntimeProvider } from "../../runtime/contract.ts";
import type { AdmissionCounterSink } from "../../runtime/k8s/admission.ts";
import {
	type EventListFn,
	type EventWatchFn,
	PodEventWatcher,
	type PodWarningSignal,
} from "../../runtime/k8s/pod-event-watcher.ts";
import { PodGc } from "../../runtime/k8s/pod-gc.ts";
import { LABEL_RUN_ID, resolveK8sPodConfig } from "../../runtime/k8s/pod-spec.ts";
import {
	type CounterSink,
	DEFAULT_RESYNC_PERIOD_MS,
	type PodListFn,
	PodWatcher,
	type WatchFn,
} from "../../runtime/k8s/pod-watcher.ts";
import type { K8sInboxStore } from "../../runtime/k8s/send-message.ts";
import { resolveRuntimeKind, resolveRuntimeProvider } from "../../runtime/registry.ts";
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
	/**
	 * Sink for deduplicated pod WARNING events (warren-32f8) —
	 * `FailedAttachVolume`, `FailedScheduling`, `ImagePullBackOff`-class stalls
	 * that pod status cannot express. Boot wires this to append onto the run's
	 * event stream (`k8s-pod-warning-sink.ts`); absent ⇒ warn-log only.
	 */
	readonly onPodWarning?: (signal: PodWarningSignal) => void;
}

/** Handle over the started K8s background loops. `stop()` is idempotent. */
export interface K8sRuntimeHandle {
	readonly podWatcher: PodWatcher;
	readonly podGc: PodGc;
	readonly podEventWatcher: PodEventWatcher;
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
/** One-shot guard so repeated boots (tests) install the backstop only once. */
let abortBackstopInstalled = false;

/**
 * Last-line-of-defense against the K8s log-follow teardown AbortError
 * (warren-4e36, third recurrence of warren-595f's crash class). Under Bun the
 * abort-event dispatch can surface an AbortError DOMException as an UNCAUGHT
 * exception that no try/catch on the teardown path reaches — live on GKE it
 * crash-looped the control plane 8 times before this backstop. `log-follow.ts`
 * now avoids dispatching the signal at all (it destroys the piped source
 * instead), but this class of escape has recurred through two targeted fixes,
 * so the K8s boot also refuses to die for ANY stray AbortError: expected
 * teardown noise is logged and swallowed; every other error keeps Bun's
 * fail-fast default (exit for exceptions, log for rejections).
 */
function installAbortErrorBackstop(logger: Logger): void {
	if (abortBackstopInstalled) return;
	abortBackstopInstalled = true;
	const isAbort = (err: unknown): boolean => err instanceof Error && err.name === "AbortError";
	process.on("uncaughtException", (err) => {
		if (isAbort(err)) {
			logger.warn({ err: String(err) }, "swallowed uncaught AbortError (K8s stream teardown)");
			return;
		}
		logger.error({ err }, "uncaught exception; exiting");
		process.exit(1);
	});
	process.on("unhandledRejection", (err) => {
		if (isAbort(err)) {
			logger.warn({ err: String(err) }, "swallowed AbortError rejection (K8s stream teardown)");
			return;
		}
		logger.error({ err }, "unhandled promise rejection");
	});
}

export function bootK8sRuntime(input: BootK8sRuntimeInput): K8sRuntimeHandle | undefined {
	if (resolveRuntimeKind(input.env) !== "k8s") return undefined;

	installAbortErrorBackstop(input.logger);
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
		resyncPeriodMs: resolveResyncPeriodMs(input.env),
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

	// warren-32f8: warning-events informer. Correlates core v1 Warning events
	// (FailedAttachVolume / FailedScheduling / pull-backoffs) to runs via the
	// pod-watcher's cache, so a wedged pod surfaces on the run's event stream
	// instead of reading as a bare `queued`.
	const podEventWatcher = new PodEventWatcher({
		list: realEventList(coreApi, namespace),
		watch: clients.watchEvents,
		namespace,
		runIdForPodName: (podName) => podWatcher.runIdForPodName(podName),
		podPhaseForRunId: (runId) => podWatcher.getByRunId(runId)?.status?.phase,
		onWarning:
			input.onPodWarning ??
			((signal) =>
				wireLogger.warn(
					{ runId: signal.runId, reason: signal.reason, podName: signal.podName },
					"run pod warning (no run-stream sink wired)",
				)),
		logger: wireLogger,
		resyncPeriodMs: resolveResyncPeriodMs(input.env),
	});

	podWatcher.start();
	podGc.start();
	podEventWatcher.start();

	return {
		podWatcher,
		podGc,
		podEventWatcher,
		coreApi,
		stop: async () => {
			// Stop the GC first (it only sweeps) then the watchers, awaiting all so
			// no loop outlives boot teardown.
			await podGc.stop();
			await podWatcher.stop();
			await podEventWatcher.stop();
		},
	};
}

export interface ResolveBootRuntimeProviderInput {
	readonly env: EnvLike;
	/** run_inbox steering store (K8s `sendMessage`); ignored by LocalProvider. */
	readonly runInbox: () => K8sInboxStore;
	/** Admission-rejection metric sink (K8s, warren-b6f2); absent ⇒ uncounted. */
	readonly admissionMetrics?: AdmissionCounterSink;
	/**
	 * Structured logger threaded onto the `K8sProvider` pod-log stream pump so its
	 * backoff/disconnect warnings surface (warren-72a8); ignored by LocalProvider.
	 */
	readonly logger?: Logger;
	/**
	 * The started K8s runtime (pod-watcher + shared client), present only under
	 * `WARREN_RUNTIME=k8s`. Its pod-watcher is threaded as the provider's status
	 * cache + admission source; its core-API factory keeps the provider on one
	 * client. Absent ⇒ `resolveRuntimeProvider` builds a LocalProvider.
	 */
	readonly k8sRuntime?: K8sRuntimeHandle;
	/**
	 * Boot-resolved forge (warren-c9ac). Drives the K8s token windows
	 * (forge-contract.md §4.1): the provider mints the init-container clone
	 * credential per pod-spec, and the window-2 static-env push-token fallback
	 * is allowed only when the forge's `credentialLifetime` is `static` (PAT).
	 */
	readonly forge?: Forge;
}

/**
 * Resolve the runtime provider ONCE at boot (warren-c531) — the sole composition
 * point. `bootServer` calls this BEFORE `bootBridges` so the same provider
 * instance flows into the bridge registry, the run-state poller, the watchdog,
 * and `ServerDeps`. Selects on `WARREN_RUNTIME`: default `local` → the
 * burrow-backed `LocalProvider` (its burrow client is built + owned by the
 * `LocalBootBackend`, warren-f796); `k8s` → the `K8sProvider` fed the started
 * pod-watcher. Extracted here (rather than inline in `index.ts`) to keep the
 * orchestrator under its file-size budget and co-locate it with `bootK8sRuntime`.
 */
/**
 * The forge-driven K8s token-window deps (warren-c9ac, forge-contract.md §4.1):
 * a per-pod-spec clone-credential mint (window 1) plus the window-2 gate that
 * keeps an App-mode run off the static env fallback. `{}` when no forge is
 * wired (a `local` boot ignores both fields anyway).
 */
function k8sForgeTokenWindows(forge: Forge | undefined): {
	readonly k8sMintGitCredential?: (gitUrl: string) => Promise<string | undefined>;
	readonly k8sAllowStaticPushTokenFallback?: boolean;
} {
	if (forge === undefined) return {};
	return {
		// The in-pod finalize wire (v1) still carries a bare secret, so the
		// credential is flattened at this ONE boundary. Its username and host
		// stay GitHub's literals inside the pod, which is the remaining half of
		// warren-1b6f and needs a wire-version decision to close.
		k8sMintGitCredential: async (gitUrl) => (await mintGitCredential(forge, gitUrl))?.secret,
		k8sAllowStaticPushTokenFallback: forge.capabilities.credentialLifetime === "static",
	};
}

export function resolveBootRuntimeProvider(
	input: ResolveBootRuntimeProviderInput,
): RuntimeProvider {
	return resolveRuntimeProvider(
		{
			k8sRunInbox: input.runInbox,
			...(input.admissionMetrics !== undefined
				? { k8sAdmissionMetrics: input.admissionMetrics }
				: {}),
			...(input.logger !== undefined ? { k8sLogger: adaptLogger(input.logger) } : {}),
			...(input.k8sRuntime !== undefined
				? {
						k8sCoreApi: input.k8sRuntime.coreApi,
						k8sPodCache: input.k8sRuntime.podWatcher,
						k8sPodAdmission: input.k8sRuntime.podWatcher,
						k8sPreemptedPods: input.k8sRuntime.podWatcher,
					}
				: {}),
			...k8sForgeTokenWindows(input.forge),
		},
		input.env,
	);
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
	watchEvents: EventWatchFn;
} {
	if (input.coreApi !== undefined && input.watch !== undefined) {
		const injected = input.watch;
		return {
			coreApi: input.coreApi,
			watch: injected,
			// Tests inject one scripted watch seam; the events watcher reuses it
			// (cast: the fake delivers whatever objects the test scripts).
			watchEvents: injected as unknown as EventWatchFn,
		};
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
	const defaultWatchEvents: EventWatchFn = (path, query, onEvent, onDone) => {
		if (cachedWatch === undefined) cachedWatch = new Watch(loadConfig());
		return cachedWatch.watch(
			path,
			query,
			(phase, obj) => onEvent(phase, obj as CoreV1Event),
			onDone,
		);
	};
	return {
		coreApi: input.coreApi ?? defaultCoreApi,
		watch: input.watch ?? defaultWatch,
		watchEvents: defaultWatchEvents,
	};
}

/** Real list-then-watch `list` seam: one labelled page + its resourceVersion. */
function realPodList(coreApi: () => CoreV1Api, namespace: string): PodListFn {
	return async () => {
		const list = await coreApi().listNamespacedPod({ namespace, labelSelector: LABEL_RUN_ID });
		return { items: list.items, resourceVersion: list.metadata?.resourceVersion };
	};
}

/** Events list seam: the warning events in the run namespace (warren-32f8). */
function realEventList(coreApi: () => CoreV1Api, namespace: string): EventListFn {
	return async () => {
		const list = await coreApi().listNamespacedEvent({
			namespace,
			fieldSelector: "type=Warning",
		});
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
 * Parse `WARREN_K8S_POD_WATCHER_RESYNC_MS` (warren-4f2b): non-negative int
 * milliseconds. `0` disables the periodic force-relist; absent/blank yields the
 * `DEFAULT_RESYNC_PERIOD_MS` 5-minute default. Rejects non-integer / negative /
 * malformed values loudly so a typo in a deploy config fails boot rather than
 * silently disarming the cache-staleness backstop.
 */
function resolveResyncPeriodMs(env: EnvLike): number {
	const raw = env.WARREN_K8S_POD_WATCHER_RESYNC_MS;
	if (raw === undefined || raw.trim() === "") return DEFAULT_RESYNC_PERIOD_MS;
	const n = Number.parseInt(raw, 10);
	if (!Number.isFinite(n) || n < 0 || String(n) !== raw.trim()) {
		throw new Error(
			`WARREN_K8S_POD_WATCHER_RESYNC_MS must be a non-negative integer (got ${JSON.stringify(raw)})`,
		);
	}
	return n;
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
