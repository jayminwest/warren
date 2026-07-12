/**
 * `K8sProvider` — the Kubernetes-backed `RuntimeProvider` (contract in
 * `../contract.ts`). It is the scale backend: one bare Pod per run
 * (`restartPolicy: Never`), kubelet-enforced resource limits, and pod-log event
 * streaming — the strategic fix for the co-tenancy OOM crash loop that motivated
 * the migration (docs/design/k8s-migration.md §Motivation).
 *
 * `create()` (pl-829f step 15 / warren-2181) is the first real body: it
 * materializes the workspace in an init container, ships seed files as a
 * ConfigMap, points the agent at warren over Service DNS, and creates the pod.
 * The remaining methods stay deliberate `RuntimeNotImplementedError` stubs that
 * name the plan step that fills each:
 *
 *   - `status`       → step 16 (warren-a7ff): pod-watcher informer → phase reconciliation.
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
import {
	buildRunPod,
	type K8sPodConfig,
	podNameForRun,
	resolveK8sPodConfig,
	serviceDnsCallbackUrl,
} from "./pod-spec.ts";
import { buildSeedConfigMap, seedConfigMapName } from "./seed-configmap.ts";

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

	streamEvents(_handle: RunHandle, _opts?: StreamOpts): AsyncIterable<NormalizedEvent> {
		return notImplemented("streamEvents", "step 17 (warren-026c)");
	}

	status(_handle: RunHandle): Promise<RunStatus> {
		return notImplemented("status", "step 16 (warren-a7ff)");
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
