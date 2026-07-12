/**
 * Pure pod-spec builder for the K8s runtime backend (pl-829f step 14 /
 * warren-ac7a). Maps a provider-neutral `RunSpec` (contract in `../contract.ts`)
 * onto a bare Kubernetes `V1Pod` — no cluster access, no I/O, no clock. The
 * K8sProvider (`./provider.ts`) calls `buildRunPod` inside `create()` (plan step
 * 15) and hands the result to the K8s API; keeping the mapping a pure function
 * makes every invariant unit-testable without a cluster.
 *
 * Design decisions baked in (docs/design/k8s-migration.md §1.2/§2.2/§3.1):
 *
 *   - **Bare Pod, `restartPolicy: Never`** (§1.2). NOT a Job: warren already owns
 *     the `queued → running → succeeded/failed/cancelled` state machine, and a
 *     Job's restart-on-failure would silently re-run an OOMKilled agent from
 *     scratch. `Never` means an OOMKilled container ends the pod in `Failed`
 *     phase and the pod-watcher (plan step 16) surfaces `oom_killed` immediately.
 *   - **Hardened securityContext** (§2.2): `runAsNonRoot`, `runAsUser 1000`,
 *     `allowPrivilegeEscalation: false`, `seccompProfile: RuntimeDefault`,
 *     `capabilities.drop: [ALL]`. Stricter than the retired Fly/bwrap posture.
 *   - **Init container for workspace materialization** (§4.2): a `workspace-init`
 *     container clones/worktrees onto a shared `emptyDir` before the agent starts,
 *     so clone failures show as a distinct `Init:Error` pod condition. This step
 *     only REFERENCES the init container in the spec; its materialization body is
 *     plan step 15.
 *   - **`warren.io/run-id` label** (§1.3): the pod-watcher's informer selects on
 *     it. The label VALUE is the exact `runId` (underscores legal in label
 *     values); the pod NAME is DNS-1123-sanitized — see `podNameForRun`.
 */

import type {
	V1Container,
	V1EnvVar,
	V1Pod,
	V1PodSecurityContext,
	V1ResourceRequirements,
	V1SecurityContext,
} from "@kubernetes/client-node";
import {
	DEFAULT_K8S_CPU_LIMIT_MILLICORES,
	DEFAULT_K8S_CPU_REQUEST_MILLICORES,
	DEFAULT_K8S_MEMORY_LIMIT_MIB,
	DEFAULT_K8S_MEMORY_REQUEST_MIB,
	DEFAULT_K8S_NETWORK,
	type DefaultsConfig,
	type NetworkPolicy,
} from "../../warren-config/index.ts";
import type { RunSpec } from "../contract.ts";

// --- Pod-shape constants ---------------------------------------------------

/** Unprivileged uid/gid the agent + init containers run as (§2.2, was `DEFAULT_SANDBOX_UID`). */
export const WARREN_POD_UID = 1000;
export const WARREN_POD_GID = 1000;

/** Shared `emptyDir` the init container materializes and the agent mounts (§4.2). */
export const WORKSPACE_VOLUME_NAME = "workspace";
export const WORKSPACE_MOUNT_PATH = "/workspace";

export const INIT_CONTAINER_NAME = "workspace-init";
export const AGENT_CONTAINER_NAME = "agent";

// --- Label keys (all under the `warren.io/` namespace) ---------------------

/** Selected by the pod-watcher informer (§1.3). Value is the exact `runId`. */
export const LABEL_RUN_ID = "warren.io/run-id";
export const LABEL_RUNTIME = "warren.io/runtime";
export const LABEL_MANAGED_BY = "warren.io/managed-by";
export const LABEL_MODE = "warren.io/mode";
/** Coarse network intent (§5 `networkPolicy: "coarse"`) — the standalone K8s
 * `NetworkPolicy` resource (manifests step) selects pods on this. */
export const LABEL_NETWORK = "warren.io/network";
export const MANAGED_BY_VALUE = "warren";

// --- Config resolution -----------------------------------------------------

/** Default namespace runs land in (§1.1). Overridable via `WARREN_K8S_NAMESPACE`. */
export const DEFAULT_K8S_NAMESPACE = "warren-runs";
/** Baked toolchain image (§4.3). Overridable via `WARREN_K8S_AGENT_IMAGE`. */
export const DEFAULT_K8S_AGENT_IMAGE = "warren-agent:latest";
/** Lightweight bun+git image the init container runs (§4.2). `WARREN_K8S_INIT_IMAGE`. */
export const DEFAULT_K8S_INIT_IMAGE = "warren-workspace-init:latest";

/** A fully-resolved memory+cpu pair (whole MiB / millicores). */
export interface ResolvedResourceQuantities {
	memoryMiB: number;
	cpuMillicores: number;
}

/**
 * Everything the pure `buildRunPod` needs beyond the `RunSpec` — cluster-shaped
 * defaults resolved once (from env + `.warren/config.yaml`) so the builder stays
 * pure. Resolve with `resolveK8sPodConfig`.
 */
export interface K8sPodConfig {
	namespace: string;
	agentImage: string;
	initImage: string;
	uid: number;
	gid: number;
	requests: ResolvedResourceQuantities;
	limits: ResolvedResourceQuantities;
	network: NetworkPolicy;
	/** optional ServiceAccount for the run pod (RBAC step). */
	serviceAccountName?: string;
}

/** Minimal env surface `resolveK8sPodConfig` reads. */
export type K8sPodConfigEnv = Readonly<Record<string, string | undefined>>;

function pickString(env: K8sPodConfigEnv, key: string, fallback: string): string {
	const raw = env[key]?.trim();
	return raw === undefined || raw === "" ? fallback : raw;
}

/**
 * Resolve the cluster-shaped pod defaults from the server env and a project's
 * `.warren/config.yaml` `resources` block. The `resources` block, when present,
 * arrives with all inner fields `.default()`-filled by the schema; when absent
 * we fall back to the `DEFAULT_K8S_*` constants (same posture as
 * `agent.pauseTimeoutMs`). Pure — no cluster access.
 */
export function resolveK8sPodConfig(
	env: K8sPodConfigEnv,
	defaults?: DefaultsConfig | null,
): K8sPodConfig {
	const resources = defaults?.resources;
	const config: K8sPodConfig = {
		namespace: pickString(env, "WARREN_K8S_NAMESPACE", DEFAULT_K8S_NAMESPACE),
		agentImage: pickString(env, "WARREN_K8S_AGENT_IMAGE", DEFAULT_K8S_AGENT_IMAGE),
		initImage: pickString(env, "WARREN_K8S_INIT_IMAGE", DEFAULT_K8S_INIT_IMAGE),
		uid: WARREN_POD_UID,
		gid: WARREN_POD_GID,
		requests: {
			memoryMiB: resources?.requests?.memoryMiB ?? DEFAULT_K8S_MEMORY_REQUEST_MIB,
			cpuMillicores: resources?.requests?.cpuMillicores ?? DEFAULT_K8S_CPU_REQUEST_MILLICORES,
		},
		limits: {
			memoryMiB: resources?.limits?.memoryMiB ?? DEFAULT_K8S_MEMORY_LIMIT_MIB,
			cpuMillicores: resources?.limits?.cpuMillicores ?? DEFAULT_K8S_CPU_LIMIT_MILLICORES,
		},
		network: resources?.network ?? DEFAULT_K8S_NETWORK,
	};
	const sa = env.WARREN_K8S_SERVICE_ACCOUNT?.trim();
	if (sa !== undefined && sa !== "") config.serviceAccountName = sa;
	return config;
}

// --- Name sanitization -----------------------------------------------------

/**
 * Derive the pod name for a run. warren run ids look like `run_01tdf3a0wg5e`;
 * the underscore is legal in a K8s label VALUE but NOT in a resource NAME
 * (DNS-1123: lowercase alphanumerics + `-`, ≤253). We lowercase, replace every
 * illegal char with `-`, collapse runs of `-`, and trim leading/trailing `-`.
 * The exact `runId` still travels verbatim on the `warren.io/run-id` label so
 * the pod-watcher can select it (labels permit `_`).
 */
export function podNameForRun(runId: string): string {
	const sanitized = runId
		.toLowerCase()
		.replace(/[^a-z0-9-]/g, "-")
		.replace(/-+/g, "-")
		.replace(/^-+|-+$/g, "");
	const name = `run-${sanitized}`;
	return name.length > 253 ? name.slice(0, 253).replace(/-+$/g, "") : name;
}

// --- Builder ---------------------------------------------------------------

function quantityString(q: ResolvedResourceQuantities): { memory: string; cpu: string } {
	return { memory: `${q.memoryMiB}Mi`, cpu: `${q.cpuMillicores}m` };
}

/** Requests can never exceed limits (K8s rejects it) — clamp per-dimension. */
function clampRequests(
	requests: ResolvedResourceQuantities,
	limits: ResolvedResourceQuantities,
): ResolvedResourceQuantities {
	return {
		memoryMiB: Math.min(requests.memoryMiB, limits.memoryMiB),
		cpuMillicores: Math.min(requests.cpuMillicores, limits.cpuMillicores),
	};
}

function resourceRequirements(
	requests: ResolvedResourceQuantities,
	limits: ResolvedResourceQuantities,
): V1ResourceRequirements {
	const req = quantityString(requests);
	const lim = quantityString(limits);
	return {
		requests: { memory: req.memory, cpu: req.cpu },
		limits: { memory: lim.memory, cpu: lim.cpu },
	};
}

/** Container-level hardening applied to BOTH the init and agent containers (§2.2). */
function containerSecurityContext(config: K8sPodConfig): V1SecurityContext {
	return {
		runAsNonRoot: true,
		runAsUser: config.uid,
		runAsGroup: config.gid,
		allowPrivilegeEscalation: false,
		capabilities: { drop: ["ALL"] },
		seccompProfile: { type: "RuntimeDefault" },
	};
}

/** Pod-level securityContext (§2.2). `fsGroup` lets uid 1000 write the emptyDir. */
function podSecurityContext(config: K8sPodConfig): V1PodSecurityContext {
	return {
		runAsNonRoot: true,
		runAsUser: config.uid,
		runAsGroup: config.gid,
		fsGroup: config.gid,
		seccompProfile: { type: "RuntimeDefault" },
	};
}

/** Deterministic (name-sorted) env-var list so the spec is stable across builds. */
function toEnvVars(env: Record<string, string>): V1EnvVar[] {
	return Object.keys(env)
		.sort()
		.map((name) => ({ name, value: env[name] ?? "" }));
}

/**
 * The `workspace-init` init container (§4.2). This step only REFERENCES it — the
 * materialization body (clone/worktree via `src/workspace/`) lands in plan step
 * 15. It receives the git coordinates the materializer needs and shares the
 * `/workspace` emptyDir with the agent container.
 */
function buildInitContainer(spec: RunSpec, config: K8sPodConfig): V1Container {
	const initEnv: Record<string, string> = {
		WARREN_RUN_ID: spec.runId,
		WARREN_REPO_URL: spec.originUrl,
		WARREN_BRANCH: spec.branch,
		WARREN_BASE_BRANCH: spec.baseBranch,
	};
	return {
		name: INIT_CONTAINER_NAME,
		image: config.initImage,
		env: toEnvVars(initEnv),
		volumeMounts: [{ name: WORKSPACE_VOLUME_NAME, mountPath: WORKSPACE_MOUNT_PATH }],
		securityContext: containerSecurityContext(config),
	};
}

function buildAgentContainer(spec: RunSpec, config: K8sPodConfig): V1Container {
	// Per-run override of the memory/cpu LIMIT (RunSpec.resources), else the
	// config default. Requests stay at the config default but are clamped so
	// they never exceed the (possibly lowered) limit.
	const limits: ResolvedResourceQuantities = {
		memoryMiB: spec.resources?.memoryMiB ?? config.limits.memoryMiB,
		cpuMillicores: spec.resources?.cpuMillicores ?? config.limits.cpuMillicores,
	};
	const requests = clampRequests(config.requests, limits);
	return {
		name: AGENT_CONTAINER_NAME,
		image: config.agentImage,
		workingDir: WORKSPACE_MOUNT_PATH,
		env: toEnvVars(spec.env),
		volumeMounts: [{ name: WORKSPACE_VOLUME_NAME, mountPath: WORKSPACE_MOUNT_PATH }],
		resources: resourceRequirements(requests, limits),
		securityContext: containerSecurityContext(config),
	};
}

/** Labels stamped on every run pod. `warren.io/run-id` is the informer selector. */
export function podLabelsForRun(spec: RunSpec, config: K8sPodConfig): Record<string, string> {
	return {
		[LABEL_RUN_ID]: spec.runId,
		[LABEL_RUNTIME]: spec.runtimeId,
		[LABEL_MODE]: spec.mode,
		[LABEL_NETWORK]: config.network,
		[LABEL_MANAGED_BY]: MANAGED_BY_VALUE,
	};
}

/**
 * Build the bare `V1Pod` for a run. Pure: a function of `(spec, config)` only.
 * `restartPolicy: Never`, hardened securityContext, an init container reference,
 * and the `/workspace` emptyDir shared between init + agent.
 */
export function buildRunPod(spec: RunSpec, config: K8sPodConfig): V1Pod {
	const pod: V1Pod = {
		apiVersion: "v1",
		kind: "Pod",
		metadata: {
			name: podNameForRun(spec.runId),
			namespace: config.namespace,
			labels: podLabelsForRun(spec, config),
		},
		spec: {
			restartPolicy: "Never",
			automountServiceAccountToken: false,
			securityContext: podSecurityContext(config),
			initContainers: [buildInitContainer(spec, config)],
			containers: [buildAgentContainer(spec, config)],
			volumes: [{ name: WORKSPACE_VOLUME_NAME, emptyDir: {} }],
		},
	};
	if (config.serviceAccountName !== undefined && pod.spec !== undefined) {
		pod.spec.serviceAccountName = config.serviceAccountName;
		pod.spec.automountServiceAccountToken = true;
	}
	return pod;
}
