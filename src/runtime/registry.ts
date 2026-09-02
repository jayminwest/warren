/**
 * Runtime-provider registry + the `WARREN_RUNTIME` selector.
 *
 * One place resolves which `RuntimeProvider` (contract in `./contract.ts`) a
 * warren process runs against, exactly once at boot. The default is the
 * in-process `LocalProvider`; the `k8s` backend (`K8sProvider`, pl-829f phase
 * K8S) is opt-in behind `WARREN_RUNTIME=k8s`.
 *
 * Selection rules (design doc §5 registry/selector semantics):
 *   - `WARREN_RUNTIME` unset (or blank) → `local` (the default backend).
 *   - `local` → in-process `LocalProvider` (warren-413d; the burrow-backed
 *     legacy mode was deleted in warren-ea0a).
 *   - `k8s`   → `K8sProvider`.
 *   - `docker` → `DockerProvider` (warren-3732, sibling containers).
 *   - anything else → `UnknownRuntimeError` (fail loud — never silently fall
 *     back to the default, so a typo can't route runs onto the wrong backend).
 *
 * Composition point: `src/server/main/index.ts` (`bootServer`) resolves the
 * local backend via `src/runtime/local/boot-backend.ts`, which builds the
 * in-process engine directly (warren-413d).
 */

import type { CoreV1Api } from "@kubernetes/client-node";
import type { ReapExec, ReapFs } from "../runs/reap/types.ts";
import type { EnvLike } from "../runs/spawn/callback-env.ts";
import type { RuntimeProvider } from "./contract.ts";
import { DockerProvider, type DockerProviderDeps } from "./docker/provider.ts";
import type { DockerSpawnDeps } from "./docker/spawn.ts";
import { UnknownRuntimeError } from "./errors.ts";
import type { AdmissionCounterSink, PodAdmissionSource } from "./k8s/admission.ts";
import type { FinalizeCoordinator } from "./k8s/finalize-coordinator.ts";
import type { StreamLogger } from "./k8s/log-stream.ts";
import type { PodCacheReader } from "./k8s/pod-watcher.ts";
import { defaultCoreApiFactory, K8sProvider } from "./k8s/provider.ts";
import type { K8sInboxStore } from "./k8s/send-message.ts";
import type { SidecarCascade } from "./local/engine.ts";
import { LocalProvider } from "./local/provider.ts";
import type { LocalRunStore } from "./local/run-store.ts";

/** Runtime backends the selector understands. */
export type RuntimeKind = "local" | "k8s" | "docker";

/** Selector default when `WARREN_RUNTIME` is unset — the self-host backend. */
export const DEFAULT_RUNTIME_KIND: RuntimeKind = "local";

/** Every recognized `WARREN_RUNTIME` value (used for validation + error hints). */
export const RUNTIME_KINDS: readonly RuntimeKind[] = ["local", "k8s", "docker"];

/** Minimal env surface the selector reads. */
export type RuntimeEnv = Readonly<Record<string, string | undefined>>;

/**
 * Dependencies every provider the registry can build is threaded. Kept as a
 * single bag so adding the `k8s` backend later doesn't change the selector's
 * signature. The client is a factory so the registry needn't own a live client
 * (see `LocalProviderDeps`).
 */
export interface RuntimeProviderDeps {
	/**
	 * Server-process env a provider reads to compute its own plumbing (the
	 * LocalProvider's loopback callback URL, §6.3). Optional — providers
	 * default to `process.env`. Kept on the shared bag so the selector's
	 * signature is stable as backends are added.
	 */
	readonly serverEnv?: EnvLike;
	/**
	 * Disk/shell seam the `LocalProvider.finalize()` runs the reap
	 * merge functions over (`ReapFs` / `ReapExec`, `src/runs/reap/types.ts`) —
	 * only consulted for `WARREN_RUNTIME=local`; the `K8sProvider` ignores them.
	 * Optional so callers (and tests) that accept the real `defaultFs` /
	 * `defaultExec` needn't supply them. Kept on the shared bag so the reap
	 * pipeline can route its fallback provider through `resolveRuntimeProvider`
	 * (warren-aa4a) instead of constructing a `LocalProvider` inline.
	 */
	readonly fs?: ReapFs;
	readonly exec?: ReapExec;
	/**
	 * Lazy Kubernetes core API factory the `K8sProvider` drives — only consulted
	 * for `WARREN_RUNTIME=k8s`. Optional so `local` callers (and tests) needn't
	 * supply one; when omitted, `defaultCoreApiFactory()` loads in-cluster /
	 * kubeconfig config lazily. A test injects a fake here to build a
	 * `K8sProvider` without a cluster.
	 */
	readonly k8sCoreApi?: () => CoreV1Api;
	/**
	 * Lazy run_inbox store the `K8sProvider.sendMessage` persists steering
	 * messages into (pl-829f step 18 / warren-3d0b) — only consulted for
	 * `WARREN_RUNTIME=k8s`. Optional so `local` callers (and tests that never
	 * steer a K8s run) needn't supply one; a K8sProvider built without it raises
	 * `RuntimeProviderError` on `sendMessage`. Boot threads `() => repos.runInbox`.
	 */
	readonly k8sRunInbox?: () => K8sInboxStore;
	/**
	 * Correlation registry for the in-pod finalize callback (pl-829f step 20 /
	 * warren-0d35) — only consulted for `WARREN_RUNTIME=k8s`. Optional: the
	 * `K8sProvider` defaults to the process-wide `sharedFinalizeCoordinator`, which
	 * the finalize HTTP endpoints also default to, so they correlate without
	 * explicit wiring. A test injects a private instance into both sides.
	 */
	readonly k8sFinalizeCoordinator?: FinalizeCoordinator;
	/**
	 * OPTIONAL counter sink for the K8s admission-rejection metric
	 * (`warren_run_admission_rejections_total`, pl-829f step 21 / warren-b6f2) —
	 * only consulted for `WARREN_RUNTIME=k8s`. Boot threads the shared
	 * `MetricsRegistry`; absent, rejections still throw but aren't counted.
	 */
	readonly k8sAdmissionMetrics?: AdmissionCounterSink;
	/**
	 * OPTIONAL live pod cache the pod-watcher maintains (pl-829f step 16 /
	 * warren-a7ff) — only consulted for `WARREN_RUNTIME=k8s`. `status()` reads it
	 * to skip a list-by-label round-trip; absent (or on a miss) it lists cache-
	 * cold. Boot threads the started `PodWatcher` (src/server/main/runtime-wiring.ts).
	 */
	readonly k8sPodCache?: PodCacheReader;
	/**
	 * OPTIONAL live admission-count source the pod-watcher maintains (warren-b6f2)
	 * — only consulted for `WARREN_RUNTIME=k8s`. `create()` reads counts off it to
	 * gate a dispatch; absent, it lists pods by label instead. Boot threads the
	 * same started `PodWatcher` as `k8sPodCache`.
	 */
	readonly k8sPodAdmission?: PodAdmissionSource;
	/**
	 * OPTIONAL preemption-witness source (warren-ea4b) — only consulted for
	 * `WARREN_RUNTIME=k8s`. Boot threads the started `PodWatcher`, whose
	 * `wasPreempted` records pods that vanished while their (spot-labelled)
	 * node was deleted.
	 */
	readonly k8sPreemptedPods?: { wasPreempted(runId: string): boolean };
	/**
	 * OPTIONAL structured logger for the K8s pod-log stream pump (warren-72a8) —
	 * only consulted for `WARREN_RUNTIME=k8s`. Threaded onto the provider so the
	 * pump's backoff/disconnect warnings surface instead of being silent no-ops;
	 * absent ⇒ the pump logs nothing. Boot threads the shared pino logger.
	 */
	readonly k8sLogger?: StreamLogger;
	/**
	 * OPTIONAL git-credential mint seam for the K8s token windows
	 * (forge-contract.md §4.1, warren-c9ac) — only consulted for
	 * `WARREN_RUNTIME=k8s`. Boot wires it to `mintGitCredential` over the
	 * resolved forge so `create()` mints the init-container clone credential at
	 * pod-spec time (window 1).
	 */
	readonly k8sMintGitCredential?: (gitUrl: string) => Promise<string | undefined>;
	/**
	 * Whether the K8s window-2 finalize push may fall back to the static
	 * control-plane env token (warren-c9ac). Boot sets it from the forge's
	 * `credentialLifetime`; absent, the provider's own default (allow) applies.
	 */
	readonly k8sAllowStaticPushTokenFallback?: boolean;
	/**
	 * OPTIONAL shared run store for the in-process LocalProvider engine
	 * (warren-413d) — only consulted for `WARREN_RUNTIME=local`. Boot
	 * threads the store it also hands the preview sidecar registry
	 * (warren-4bf3), so sidecars resolve profiles off the same records the
	 * engine writes. Absent ⇒ the provider's private default (tests).
	 */
	readonly localStore?: LocalRunStore;
	/**
	 * OPTIONAL preview sidecar cascade for the in-process LocalProvider
	 * (warren-4bf3) — only consulted for `WARREN_RUNTIME=local`. Boot
	 * threads the warren-owned registry so `terminate` releases sidecars +
	 * port forwards. Absent ⇒ terminate skips the cascade (tests).
	 */
	readonly localSidecars?: SidecarCascade;
	/**
	 * OPTIONAL docker spawn seams — only consulted for `WARREN_RUNTIME=docker`
	 * (warren-3732). A test injects a scripted docker CLI here; production
	 * leaves it unset so the seam spawns the real CLI.
	 */
	readonly docker?: DockerSpawnDeps;
}

/**
 * Parse + validate the `WARREN_RUNTIME` selector. Blank/unset resolves to the
 * default; an unrecognized value throws `UnknownRuntimeError`.
 */
export function resolveRuntimeKind(env: RuntimeEnv = process.env): RuntimeKind {
	const raw = env.WARREN_RUNTIME?.trim();
	if (raw === undefined || raw === "") {
		return DEFAULT_RUNTIME_KIND;
	}
	if ((RUNTIME_KINDS as readonly string[]).includes(raw)) {
		return raw as RuntimeKind;
	}
	throw new UnknownRuntimeError(`Unknown WARREN_RUNTIME "${raw}"`, {
		recoveryHint: `Set WARREN_RUNTIME to one of: ${RUNTIME_KINDS.join(", ")} (or leave it unset for "${DEFAULT_RUNTIME_KIND}").`,
	});
}

/**
 * Resolve the runtime provider for this process — call ONCE at boot. Selects on
 * `WARREN_RUNTIME` (see module doc) and constructs the chosen backend from
 * `deps`.
 */
export function resolveRuntimeProvider(
	deps: RuntimeProviderDeps,
	env: RuntimeEnv = process.env,
): RuntimeProvider {
	const kind = resolveRuntimeKind(env);
	switch (kind) {
		case "local":
			// warren-413d + warren-ea0a: the local backend is the in-process
			// engine, full stop — there is no client to wire.
			return new LocalProvider({
				...(deps.serverEnv !== undefined ? { serverEnv: deps.serverEnv } : {}),
				...(deps.fs !== undefined ? { fs: deps.fs } : {}),
				...(deps.exec !== undefined ? { exec: deps.exec } : {}),
				...(deps.localStore !== undefined ? { store: deps.localStore } : {}),
				...(deps.localSidecars !== undefined ? { sidecars: deps.localSidecars } : {}),
			});
		case "k8s":
			return buildK8sProvider(deps);
		case "docker":
			return buildDockerProvider(deps);
	}
}

/**
 * Construct the `DockerProvider` (warren-3732) from the shared deps bag.
 * The sibling-container backend reuses the local state roots, run store,
 * and reap seams; only the spawn boundary differs.
 */
function buildDockerProvider(deps: RuntimeProviderDeps): DockerProvider {
	const providerDeps: DockerProviderDeps = {
		...(deps.serverEnv !== undefined ? { serverEnv: deps.serverEnv } : {}),
		...(deps.fs !== undefined ? { fs: deps.fs } : {}),
		...(deps.exec !== undefined ? { exec: deps.exec } : {}),
		...(deps.localStore !== undefined ? { store: deps.localStore } : {}),
		...(deps.localSidecars !== undefined ? { sidecars: deps.localSidecars } : {}),
		...(deps.docker !== undefined ? { docker: deps.docker } : {}),
	};
	return new DockerProvider(providerDeps);
}

/**
 * Construct the `K8sProvider` from the optional K8s slices of the shared deps
 * bag. Every field is spread conditionally so an absent slice leaves the
 * provider's own default in place (default core-API factory, shared finalize
 * coordinator, cache-cold status/admission). Extracted from
 * `resolveRuntimeProvider` to keep that selector under the complexity budget.
 */
function buildK8sProvider(deps: RuntimeProviderDeps): K8sProvider {
	return new K8sProvider({
		coreApi: deps.k8sCoreApi ?? defaultCoreApiFactory(),
		...(deps.serverEnv !== undefined ? { serverEnv: deps.serverEnv } : {}),
		...(deps.k8sRunInbox !== undefined ? { runInbox: deps.k8sRunInbox } : {}),
		...(deps.k8sFinalizeCoordinator !== undefined
			? { finalizeCoordinator: deps.k8sFinalizeCoordinator }
			: {}),
		...(deps.k8sAdmissionMetrics !== undefined
			? { admissionMetrics: deps.k8sAdmissionMetrics }
			: {}),
		...(deps.k8sPodCache !== undefined ? { podCache: deps.k8sPodCache } : {}),
		...(deps.k8sPodAdmission !== undefined ? { podAdmission: deps.k8sPodAdmission } : {}),
		...(deps.k8sPreemptedPods !== undefined ? { preemptedPods: deps.k8sPreemptedPods } : {}),
		...(deps.k8sLogger !== undefined ? { logger: deps.k8sLogger } : {}),
		...(deps.k8sMintGitCredential !== undefined
			? { mintGitCredential: deps.k8sMintGitCredential }
			: {}),
		...(deps.k8sAllowStaticPushTokenFallback !== undefined
			? { allowStaticPushTokenFallback: deps.k8sAllowStaticPushTokenFallback }
			: {}),
	});
}
