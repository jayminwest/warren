/**
 * `K8sProvider` — the Kubernetes-backed `RuntimeProvider` (contract in
 * `../contract.ts`). It is the scale backend: one bare Pod per run
 * (`restartPolicy: Never`), kubelet-enforced resource limits, and pod-log event
 * streaming — the strategic fix for the co-tenancy OOM crash loop that motivated
 * the migration (docs/design/k8s-migration.md §Motivation).
 *
 * `create()` (pl-829f step 15 / warren-2181) and `status()` (step 16 /
 * warren-a7ff) are the first real bodies: `create` materializes the workspace in
 * an init container, ships seed files as a ConfigMap, points the agent at warren
 * over Service DNS, and creates the pod; `status` reconciles the pod's
 * phase/container state onto the seam's `RunStatus` (OOMKilled → `oom_killed`,
 * absent pod → `exists:false`). The remaining methods stay deliberate
 * `RuntimeNotImplementedError` stubs that name the plan step that fills each:
 *
 *   - `streamEvents` → step 17 (warren-026c): follow pod logs, synthesize the seq cursor.
 *   - `sendMessage`  → step 18 (warren-3d0b): `run_inbox` table + poll endpoint.
 *   - `cancel`/`terminate` → step 19 (warren-31d4): delete pod + SIGTERM grace + GC.
 *   - `finalize`     → step 20 (warren-0d35): in-pod post-agent reap emitting deltas.
 *
 * The K8s API client is taken as a FACTORY (`() => CoreV1Api`) rather than a live
 * client — mirroring `LocalProvider`'s `() => BurrowClient`. Construction
 * never touches a cluster (no stub invokes the factory), so the registry can
 * build a `K8sProvider` off `WARREN_RUNTIME=k8s` in any environment; only the
 * real method bodies (later steps) need in-cluster config.
 */

import { ApiException, CoreV1Api, KubeConfig, type V1Pod } from "@kubernetes/client-node";
import type { EnvLike } from "../../runs/spawn/callback-env.ts";
import type {
	FinalizeIntent,
	FinalizeResult,
	Message,
	NormalizedEvent,
	OutboundMessage,
	RunHandle,
	RunSpec,
	RunStatus,
	RuntimeCapabilities,
	RuntimeProvider,
	StreamOpts,
	TeardownResult,
} from "../contract.ts";
import { RuntimeNotImplementedError, RuntimeProviderError } from "../errors.ts";
import { defaultLogFollowFactory } from "./log-follow.ts";
import {
	isTerminalPhase,
	type LogFollowFn,
	type StreamCounterSink,
	type StreamTerminalState,
	streamK8sLogs,
} from "./log-stream.ts";
import {
	AGENT_CONTAINER_NAME,
	buildRunPod,
	type K8sPodConfig,
	LABEL_RUN_ID,
	podNameForRun,
	resolveK8sPodConfig,
	serviceDnsCallbackUrl,
} from "./pod-spec.ts";
import type { PodCacheReader } from "./pod-watcher.ts";
import { buildSeedConfigMap, seedConfigMapName } from "./seed-configmap.ts";
import { mapPodToRunStatus, runLostStatus } from "./status-map.ts";

/** Dependencies the K8s-backed provider methods wrap in later steps. */
export interface K8sProviderDeps {
	/**
	 * Lazily supplies the Kubernetes core API client the real methods drive
	 * (pod create/get/delete, log follow). A factory so the provider can be
	 * built before — or without — in-cluster config; no stub invokes it. Build
	 * the default with `defaultCoreApiFactory()`.
	 */
	readonly coreApi: () => CoreV1Api;
	/**
	 * Server-process env the provider reads for its OWN plumbing — the run
	 * namespace + agent/init images (`resolveK8sPodConfig`) and the Service-DNS
	 * callback URL (contract §6.3; K8s replaces LocalProvider's loopback URL).
	 * Defaults to `process.env`.
	 */
	readonly serverEnv?: EnvLike;
	/**
	 * OPTIONAL live pod cache the pod-watcher (`./pod-watcher.ts`) maintains
	 * (pl-829f step 16). `status()` consults it as an optimization to skip a
	 * list-by-label round-trip; when absent — or on a cache miss — `status()`
	 * still works cache-cold by listing the run's pod itself. The watcher is
	 * provider-internal plumbing, so wiring this stays optional.
	 */
	readonly podCache?: PodCacheReader;
	/**
	 * OPTIONAL injectable pod-log follow seam `streamEvents` drives (pl-829f step
	 * 17). A factory-free direct fn (mirrors the pod-watcher's `WatchFn`) so tests
	 * script the log source; when absent the provider lazily builds the real
	 * `@kubernetes/client-node` `Log`-backed follow via `defaultLogFollowFactory`.
	 */
	readonly logFollow?: LogFollowFn;
	/**
	 * OPTIONAL counter sink for the pod-log parse-failure metric
	 * (`METRIC_LOG_PARSE_FAILURES_TOTAL`) — satisfied by the shared
	 * `MetricsRegistry`. When absent, malformed lines are still dropped safely;
	 * only the observability counter is skipped.
	 */
	readonly metrics?: StreamCounterSink;
}

/**
 * The K8s v1 feature set (contract doc §5). Several capabilities are DEGRADED
 * relative to `LocalProvider` — the domain branches on these, it does not assume:
 *
 *   - `previewPorts: false` — preview via Service/Ingress URL is deferred (§5.F).
 *   - `networkPolicy: "coarse"` — no per-domain allowlist at v1; `restricted`
 *     degrades to a coarse pod NetworkPolicy.
 *   - `longLived: false` — conversation pods need a separate long-lived template
 *     (design doc Q3); `restartPolicy: Never` is batch-shaped.
 *   - `midRunSteering: false` — steering rides the `run_inbox` poll (~5s), folded
 *     in at the next turn rather than delivered mid-turn over live stdin.
 *   - `enforcedResourceLimits: true` — the whole point: kubelet cgroup v2 limits.
 *   - `workspaceArchive: false` — the workspace is an `emptyDir`, destroyed with
 *     the pod; `terminate` returns no archive handle.
 *
 * Frozen so the domain can read but never mutate a provider's advertised caps.
 */
export const K8S_PROVIDER_CAPABILITIES: RuntimeCapabilities = Object.freeze({
	previewPorts: false,
	networkPolicy: "coarse",
	longLived: false,
	midRunSteering: false,
	enforcedResourceLimits: true,
	workspaceArchive: false,
});

/**
 * Build the default lazy `CoreV1Api` factory: loads in-cluster (or kubeconfig)
 * config and constructs the client on FIRST call, memoized thereafter. Not
 * invoked at construction, so importing this never requires a reachable cluster.
 */
export function defaultCoreApiFactory(): () => CoreV1Api {
	let cached: CoreV1Api | undefined;
	return () => {
		if (cached === undefined) {
			const kc = new KubeConfig();
			kc.loadFromDefault();
			cached = kc.makeApiClient(CoreV1Api);
		}
		return cached;
	};
}

/**
 * Extract a human message from a K8s `ApiException` — its `body` is the API's
 * `Status` object (`{ message, reason, code }`), sometimes still a JSON string.
 * Falls back to the exception's own message.
 */
function apiErrorMessage(err: ApiException<unknown>): string {
	let body: unknown = err.body;
	if (typeof body === "string") {
		const raw = body;
		try {
			body = JSON.parse(raw);
		} catch {
			return raw;
		}
	}
	if (typeof body === "object" && body !== null && "message" in body) {
		const msg = (body as { message?: unknown }).message;
		if (typeof msg === "string" && msg !== "") return msg;
	}
	return err.message;
}

/**
 * Map a K8s API failure onto the seam's structured `RuntimeProviderError`
 * (namespace-missing, RBAC-forbidden, quota, transport). Non-`ApiException`
 * errors (a bug in our own code) rethrow unchanged rather than being disguised
 * as a provider error.
 */
function mapApiError(err: unknown, context: string): Error {
	if (err instanceof ApiException) {
		return new RuntimeProviderError(
			`K8s ${context} failed (HTTP ${err.code}): ${apiErrorMessage(err)}`,
			{
				cause: err,
				recoveryHint:
					"verify the warren-runs namespace exists, the run ServiceAccount has pods/configmaps create RBAC, and no ResourceQuota is exhausted (plan step 26 provisions these).",
			},
		);
	}
	return err instanceof Error ? err : new Error(String(err));
}

/**
 * Choose the pod for a run from a label-filtered list. The deterministic pod
 * name makes >1 live pod per runId impossible, but a handle carrying a specific
 * pod uid (`providerRunId`) prefers the exact match so a stale-then-recreated
 * pod can't be mistaken for the current one; otherwise the sole item. Empty ⇒
 * `undefined` (the caller maps that to run-lost).
 */
function pickPodForRun(items: V1Pod[], handle: RunHandle): V1Pod | undefined {
	if (items.length === 0) return undefined;
	if (handle.providerRunId !== "") {
		const exact = items.find((p) => p.metadata?.uid === handle.providerRunId);
		if (exact !== undefined) return exact;
	}
	return items[0];
}

/** Raise the standard stub error, naming the method and the plan step that fills it. */
function notImplemented(method: string, step: string): never {
	throw new RuntimeNotImplementedError(`K8sProvider.${method}() is not implemented yet`, {
		recoveryHint:
			`Filled in ${step} of the K8s migration (pl-829f, phase K8S). This shell (step 14) ` +
			"lands the capability set + the pure pod-spec builder (src/runtime/k8s/pod-spec.ts); " +
			'until then run with WARREN_RUNTIME="local" (the default).',
	});
}

/**
 * Route Bun's install cache outside the workspace so `git add .` never sweeps
 * it — provider-owned filesystem-layout env, mirroring LocalProvider (§6.1).
 */
const BUN_INSTALL_CACHE_DIR = "/tmp/bun-install-cache";

export class K8sProvider implements RuntimeProvider {
	readonly capabilities: RuntimeCapabilities = K8S_PROVIDER_CAPABILITIES;

	/** Memoized default log-follow factory — built lazily, never at construction. */
	private readonly defaultLogFollow = defaultLogFollowFactory();

	constructor(private readonly deps: K8sProviderDeps) {}

	/**
	 * Provision one bare Pod per run (contract §6.1: burrow's two-call provision
	 * collapses to a single `create`). The provider OWNS: workspace
	 * materialization (an init container clones + carves the per-run branch),
	 * seed-file delivery (a ConfigMap the init reads), the callback URL (in-cluster
	 * Service DNS, not loopback), and the filesystem-layout env. The domain
	 * supplies only neutral `RunSpec` intent.
	 *
	 * Ordering: seed ConfigMap first (the pod's volume references it by name),
	 * then the pod. On a pod-create failure the freshly-made ConfigMap is
	 * best-effort deleted so a failed dispatch strands nothing (mirrors
	 * LocalProvider's burrow rollback). A 409 (re-dispatch onto the deterministic
	 * pod name) surfaces as a structured `RuntimeProviderError` — the domain
	 * decides whether to reconcile; we never silently adopt a stale pod.
	 */
	async create(spec: RunSpec): Promise<RunHandle> {
		const api = this.deps.coreApi();
		const env = this.deps.serverEnv ?? process.env;
		const config = resolveK8sPodConfig(env);
		const podName = podNameForRun(spec.runId);
		const composedSpec: RunSpec = {
			...spec,
			env: this.composeAgentEnv(spec.env, config),
		};

		let seedCmName: string | undefined;
		if (spec.seedFiles.length > 0) {
			// buildSeedConfigMap throws RuntimeProviderError on an oversize manifest
			// before any API call — nothing to clean up.
			const cm = buildSeedConfigMap(spec, config, podName);
			try {
				await api.createNamespacedConfigMap({ namespace: config.namespace, body: cm });
			} catch (err) {
				throw mapApiError(err, `seed ConfigMap create for run ${spec.runId}`);
			}
			seedCmName = seedConfigMapName(podName);
		}

		const pod = buildRunPod(
			composedSpec,
			config,
			seedCmName !== undefined ? { seedConfigMapName: seedCmName } : {},
		);
		let created: V1Pod;
		try {
			created = await api.createNamespacedPod({ namespace: config.namespace, body: pod });
		} catch (err) {
			if (err instanceof ApiException && err.code === 409) {
				throw new RuntimeProviderError(`a pod for run ${spec.runId} already exists (${podName})`, {
					cause: err,
					recoveryHint:
						"the pod name is derived deterministically from the run id; a re-dispatch must wait for the prior pod to be terminated/GC'd (plan step 19) before a fresh pod can be created.",
				});
			}
			// Non-conflict failure: reclaim the ConfigMap we just created, then map.
			if (seedCmName !== undefined) {
				await this.bestEffortDeleteConfigMap(api, config.namespace, seedCmName);
			}
			throw mapApiError(err, `pod create for run ${spec.runId}`);
		}

		return {
			runId: spec.runId,
			sandboxId: created.metadata?.name ?? podName,
			providerRunId: created.metadata?.uid ?? "",
		};
	}

	/**
	 * Fold the provider's OWN plumbing onto the domain env: the Bun cache dir and
	 * the Service-DNS callback URL (`WARREN_API_URL`). The URL is advertised only
	 * when the domain supplied a `WARREN_API_TOKEN` — no token ⇒ no credential to
	 * call back with, so the URL would be dead (same rule as LocalProvider). The
	 * domain must NOT set `WARREN_API_URL`; provider keys apply last so it can't.
	 */
	private composeAgentEnv(
		domainEnv: Record<string, string>,
		config: K8sPodConfig,
	): Record<string, string> {
		const env: Record<string, string> = { ...domainEnv, BUN_INSTALL_CACHE_DIR };
		const token = domainEnv.WARREN_API_TOKEN;
		if (token !== undefined && token !== "") {
			env.WARREN_API_URL = serviceDnsCallbackUrl(config);
		}
		return env;
	}

	/**
	 * Best-effort delete of a seed ConfigMap after a failed pod create — swallowed
	 * so a cleanup failure never masks the original dispatch error the caller is
	 * about to see. Not invoked on 409 (the ConfigMap belongs to the pre-existing
	 * pod, not this attempt).
	 */
	private async bestEffortDeleteConfigMap(
		api: CoreV1Api,
		namespace: string,
		name: string,
	): Promise<void> {
		try {
			await api.deleteNamespacedConfigMap({ name, namespace });
		} catch {
			// swallowed by contract — see doc comment.
		}
	}

	/**
	 * Ordered, resumable, lossless event stream over the agent container's pod
	 * logs (contract §6.4 — the single biggest K8s burden). The provider
	 * SYNTHESIZES the monotonic per-run `seq` burrow gets for free: it is the
	 * physical line index of the container's log replay, deterministic and stable
	 * across reconnects (see `./log-stream.ts` for the full scheme + rotation
	 * semantics). Correlation is by pod NAME (`handle.sandboxId`) + the well-known
	 * agent container; the run-id label already pinned that pod at create.
	 *
	 * The log source is injectable (`deps.logFollow`); absent, the real
	 * `Log`-backed follow is built lazily. Termination consults `status(handle)`
	 * (which itself prefers the pod-watcher cache): a terminal phase drains the
	 * tail then ends; a vanished pod (`exists:false` / a 404 mid-follow) throws
	 * `RuntimeRunNotFoundError`, the seam's `lost` signal — never a crash.
	 */
	streamEvents(handle: RunHandle, opts?: StreamOpts): AsyncIterable<NormalizedEvent> {
		const env = this.deps.serverEnv ?? process.env;
		const config = resolveK8sPodConfig(env);
		const follow = this.deps.logFollow ?? this.defaultLogFollow();
		return streamK8sLogs({
			follow,
			probe: () => this.streamTerminalProbe(handle),
			params: {
				namespace: config.namespace,
				podName: handle.sandboxId,
				containerName: AGENT_CONTAINER_NAME,
			},
			...(opts !== undefined ? { opts } : {}),
			...(this.deps.metrics !== undefined ? { metrics: this.deps.metrics } : {}),
		});
	}

	/**
	 * Project `status()` onto the log stream's terminate-vs-reconnect decision: an
	 * absent pod ⇒ `exists:false` (the stream ends with `lost`); a terminal phase
	 * ⇒ drain then end; anything else ⇒ a transient disconnect the stream retries.
	 */
	private async streamTerminalProbe(handle: RunHandle): Promise<StreamTerminalState> {
		const status = await this.status(handle);
		return {
			exists: status.exists,
			terminal: status.exists && isTerminalPhase(status.phase),
		};
	}

	/**
	 * Out-of-band reconcile snapshot (contract §6.7) — what the watchdog /
	 * recovery / pod-watcher read. NEVER throws on a missing run: an absent pod
	 * returns `exists:false` + `terminalReason:"lost"` (`runLostStatus`), a value
	 * not a throw.
	 *
	 * Correlation is by the `warren.io/run-id` LABEL (the exact runId), never by
	 * pod name — the pod name is a DNS-sanitized derivative (`podNameForRun`),
	 * whereas the label carries the runId verbatim (contract-preserving, step 15).
	 *
	 * A wired pod-watcher cache short-circuits the list; on a miss (or no cache)
	 * we list the run's pod by label — so `status()` works cache-cold. The pure
	 * `mapPodToRunStatus` (`./status-map.ts`) does the phase/container →
	 * `RunStatus` mapping, surfacing OOMKilled as `oom_killed` FAST (design §3.2).
	 */
	async status(handle: RunHandle): Promise<RunStatus> {
		const cached = this.deps.podCache?.getByRunId(handle.runId);
		if (cached !== undefined) return mapPodToRunStatus(cached);

		const api = this.deps.coreApi();
		const env = this.deps.serverEnv ?? process.env;
		const config = resolveK8sPodConfig(env);
		let items: V1Pod[];
		try {
			const list = await api.listNamespacedPod({
				namespace: config.namespace,
				labelSelector: `${LABEL_RUN_ID}=${handle.runId}`,
			});
			items = list.items;
		} catch (err) {
			throw mapApiError(err, `pod status list for run ${handle.runId}`);
		}
		const pod = pickPodForRun(items, handle);
		if (pod === undefined) return runLostStatus();
		return mapPodToRunStatus(pod);
	}

	sendMessage(_handle: RunHandle, _msg: OutboundMessage): Promise<Message> {
		return notImplemented("sendMessage", "step 18 (warren-3d0b)");
	}

	cancel(_handle: RunHandle, _reason?: string): Promise<void> {
		return notImplemented("cancel", "step 19 (warren-31d4)");
	}

	finalize(_handle: RunHandle, _intent: FinalizeIntent): Promise<FinalizeResult> {
		return notImplemented("finalize", "step 20 (warren-0d35)");
	}

	terminate(_handle: RunHandle): Promise<TeardownResult> {
		return notImplemented("terminate", "step 19 (warren-31d4)");
	}
}
