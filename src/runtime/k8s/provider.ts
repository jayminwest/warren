/**
 * `K8sProvider` — the Kubernetes-backed `RuntimeProvider` (contract in
 * `../contract.ts`). It is the scale backend: one bare Pod per run
 * (`restartPolicy: Never`), kubelet-enforced resource limits, and pod-log event
 * streaming — the strategic fix for the co-tenancy OOM crash loop that motivated
 * the migration (docs/design/k8s-migration.md §Motivation).
 *
 * This step (pl-829f step 14 / warren-ac7a, phase K8S) lands the SHELL plus the
 * pure pod-spec builder (`./pod-spec.ts`). The capability set is real and final
 * (the K8s v1 degradations the domain branches on — §5 of the contract doc), but
 * every method body is a deliberate stub that throws `RuntimeNotImplementedError`
 * naming the plan step that fills it:
 *
 *   - `create`       → step 15 (warren-2181): init-container materialization + pod create.
 *   - `status`       → step 16 (warren-a7ff): pod-watcher informer → phase reconciliation.
 *   - `streamEvents` → step 17 (warren-026c): follow pod logs, synthesize the seq cursor.
 *   - `sendMessage`  → step 18 (warren-3d0b): `run_inbox` table + poll endpoint.
 *   - `cancel`/`terminate` → step 19 (warren-31d4): delete pod + SIGTERM grace + GC.
 *   - `finalize`     → step 20 (warren-0d35): in-pod post-agent reap emitting deltas.
 *
 * The K8s API client is taken as a FACTORY (`() => CoreV1Api`) rather than a live
 * client — mirroring `LocalProvider`'s `() => BurrowClientPool`. Construction
 * never touches a cluster (no stub invokes the factory), so the registry can
 * build a `K8sProvider` off `WARREN_RUNTIME=k8s` in any environment; only the
 * real method bodies (later steps) need in-cluster config.
 */

import { CoreV1Api, KubeConfig } from "@kubernetes/client-node";
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
import { RuntimeNotImplementedError } from "../errors.ts";

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

/** Raise the standard stub error, naming the method and the plan step that fills it. */
function notImplemented(method: string, step: string): never {
	throw new RuntimeNotImplementedError(`K8sProvider.${method}() is not implemented yet`, {
		recoveryHint:
			`Filled in ${step} of the K8s migration (pl-829f, phase K8S). This shell (step 14) ` +
			"lands the capability set + the pure pod-spec builder (src/runtime/k8s/pod-spec.ts); " +
			'until then run with WARREN_RUNTIME="local" (the default).',
	});
}

export class K8sProvider implements RuntimeProvider {
	readonly capabilities: RuntimeCapabilities = K8S_PROVIDER_CAPABILITIES;

	constructor(private readonly deps: K8sProviderDeps) {
		// `deps` is intentionally retained but unused until the method bodies land.
		void this.deps;
	}

	create(_spec: RunSpec): Promise<RunHandle> {
		return notImplemented("create", "step 15 (warren-2181)");
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
