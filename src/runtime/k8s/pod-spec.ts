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
	V1Pod,
	V1PodSecurityContext,
	V1SecurityContext,
} from "@kubernetes/client-node";
import {
	DEFAULT_K8S_CPU_LIMIT_MILLICORES,
	DEFAULT_K8S_CPU_REQUEST_MILLICORES,
	DEFAULT_K8S_EPHEMERAL_STORAGE_LIMIT_MIB,
	DEFAULT_K8S_EPHEMERAL_STORAGE_REQUEST_MIB,
	DEFAULT_K8S_MEMORY_LIMIT_MIB,
	DEFAULT_K8S_MEMORY_REQUEST_MIB,
	DEFAULT_K8S_NETWORK,
	type NetworkPolicy,
	type ResourcesConfig,
} from "../../warren-config/index.ts";
import type { RunSpec } from "../contract.ts";
import {
	buildAgentEnv,
	buildInitEnv,
	buildInitVolumeMounts,
	buildRunPodVolumes,
	DEFAULT_K8S_ANTHROPIC_SECRET_KEY,
	DEFAULT_K8S_ANTHROPIC_SECRET_NAME,
	DEFAULT_K8S_GIT_SECRET_KEY,
	DEFAULT_K8S_GIT_SECRET_NAME,
	DEFAULT_K8S_OPENROUTER_SECRET_KEY,
	DEFAULT_K8S_OPENROUTER_SECRET_NAME,
	resolveRepoCacheConfig,
} from "./pod-env.ts";
import {
	clampRequests,
	type ResolvedResourceQuantities,
	resourceRequirements,
} from "./pod-resources.ts";

// Re-exported so `./pod-spec.ts` stays the single import surface for the pod
// shape; the env builders + ENV name constants live in `./pod-env.ts` (split
// out to keep this file under the size ratchet).
export {
	buildAgentEnv,
	buildInitEnv,
	buildInitVolumeMounts,
	DEFAULT_K8S_ANTHROPIC_SECRET_KEY,
	DEFAULT_K8S_ANTHROPIC_SECRET_NAME,
	DEFAULT_K8S_GIT_SECRET_KEY,
	DEFAULT_K8S_GIT_SECRET_NAME,
	DEFAULT_K8S_OPENROUTER_SECRET_KEY,
	DEFAULT_K8S_OPENROUTER_SECRET_NAME,
	ENV_AGENT_METADATA,
	ENV_AGENT_RUNTIME,
	ENV_PROMPT,
	ENV_RUN_ID,
	ENV_WORKSPACE_PATH,
	serviceDnsCallbackUrl,
} from "./pod-env.ts";
// warren-653f: the resource-quantity types/helpers live in `./pod-resources.ts`
// (split out for the file-size ratchet); re-exported so `./pod-spec.ts` stays the
// single import surface for the pod shape.
export type { ResolvedResourceQuantities } from "./pod-resources.ts";

// --- Pod-shape constants ---------------------------------------------------

/** Unprivileged uid/gid the agent + init containers run as (§2.2, was `DEFAULT_SANDBOX_UID`). */
export const WARREN_POD_UID = 1000;
export const WARREN_POD_GID = 1000;

/** Shared `emptyDir` the init container materializes and the agent mounts (§4.2). */
export const WORKSPACE_VOLUME_NAME = "workspace";
export const WORKSPACE_MOUNT_PATH = "/workspace";

export const INIT_CONTAINER_NAME = "workspace-init";
export const AGENT_CONTAINER_NAME = "agent";

/**
 * The init container's entry command. Runs warren's `workspace:init` package
 * script (`src/runtime/k8s/workspace-init.ts`) so the path resolves against the
 * init image's WORKDIR rather than being hard-coded; the image is built with
 * warren's source + bun (manifests step, warren-74b5).
 */
export const K8S_INIT_COMMAND: readonly string[] = ["bun", "run", "workspace:init"];

/**
 * The agent container's entry command (warren-186c). Runs warren's `agent:run`
 * package script (`src/runtime/k8s/agent-entrypoint.ts`) — the in-pod runner
 * that launches the selected agent, streams its events as NDJSON on stdout
 * (parsed by `./log-parse.ts` off the pod log), drains the steering inbox, and
 * execs the finalize entrypoint after the agent exits. The path resolves against
 * the agent image's WORKDIR, same as the init command.
 */
export const K8S_AGENT_COMMAND: readonly string[] = ["bun", "run", "agent:run"];

/** ConfigMap-backed seed drop shared into the init container (see `./seed-configmap.ts`). */
export const SEED_VOLUME_NAME = "seeds";
export const SEED_MOUNT_PATH = "/seeds";
/** Single manifest key the whole seed set travels under (§4.2). */
export const SEED_MANIFEST_KEY = "seeds.json";
/** Absolute path the init container reads the manifest from (mount + key). */
export const SEED_MANIFEST_PATH = `${SEED_MOUNT_PATH}/${SEED_MANIFEST_KEY}`;

// --- Label keys (all under the `warren.io/` namespace) ---------------------

/** Selected by the pod-watcher informer (§1.3). Value is the exact `runId`. */
export const LABEL_RUN_ID = "warren.io/run-id";
export const LABEL_RUNTIME = "warren.io/runtime";
export const LABEL_MANAGED_BY = "warren.io/managed-by";
export const LABEL_MODE = "warren.io/mode";
/** The warren project id (from `RunSpec.projectId`) — the per-project admission
 * gate counts non-terminal pods on this label (warren-b6f2). Omitted if unset. */
export const LABEL_PROJECT = "warren.io/project";
/** Coarse network intent (§5 `networkPolicy: "coarse"`) — the standalone K8s
 * `NetworkPolicy` resource (manifests step) selects pods on this. */
export const LABEL_NETWORK = "warren.io/network";
export const MANAGED_BY_VALUE = "warren";
/** The run's push branch (`RunSpec.branch`) — an ANNOTATION not a label (branch
 * names carry `/`, illegal in a label value). `K8sProvider.workspaceInfo` reads
 * it back so reap builds the finalize intent without a burrow round-trip
 * (warren-e9e1). Omitted when the spec carries no branch. */
export const ANNOTATION_BRANCH = "warren.io/branch";

// --- Config resolution -----------------------------------------------------

/** Default namespace runs land in (§1.1). Overridable via `WARREN_K8S_NAMESPACE`. */
export const DEFAULT_K8S_NAMESPACE = "warren-runs";
/** Baked toolchain image (§4.3). Overridable via `WARREN_K8S_AGENT_IMAGE`. */
export const DEFAULT_K8S_AGENT_IMAGE = "warren-agent:latest";
/** Lightweight bun+git image the init container runs (§4.2). `WARREN_K8S_INIT_IMAGE`. */
export const DEFAULT_K8S_INIT_IMAGE = "warren-workspace-init:latest";

/**
 * Warren control-plane Service the in-pod agent dials for its callback
 * (event/finalize POSTs). K8s replaces LocalProvider's `http://localhost:PORT`
 * loopback (co-tenancy assumption) with in-cluster Service DNS
 * (`<service>.<namespace>.svc.cluster.local:<port>`, contract §6.3). The
 * namespace is the CONTROL-PLANE namespace (where warren runs), NOT
 * `warren-runs` (where the pods run). All three overridable via env.
 */
export const DEFAULT_K8S_CALLBACK_SERVICE = "warren";
export const DEFAULT_K8S_CALLBACK_NAMESPACE = "warren";
export const DEFAULT_K8S_CALLBACK_PORT = "8080";

/**
 * SIGTERM grace on `cancel()` (pl-829f step 19 / warren-31d4). `cancel` is the
 * seam's GRACEFUL stop: it deletes the pod with this `gracePeriodSeconds`, so
 * the kubelet delivers SIGTERM and waits this long before SIGKILL — giving the
 * agent a window to flush. A positive default matters: during the window the
 * pod lingers `Terminating` (phase still `Running`), so a `status()` re-read
 * from the domain's `cancelRun` sees a NON-terminal phase and does NOT
 * prematurely reap the run as `lost`/`failed` (grace=0 would risk the pod
 * vanishing before the domain records the cancel). Overridable via
 * `WARREN_K8S_CANCEL_GRACE_SECONDS`.
 */
export const DEFAULT_K8S_CANCEL_GRACE_SECONDS = 30;
/**
 * Grace on `terminate()` (pl-829f step 19 / warren-31d4). `terminate` reclaims
 * the sandbox AFTER `finalize` already ran (contract §6.8 ordering), so the
 * workspace-dependent work is done and there is nothing to flush — the pod is
 * force-deleted immediately (`gracePeriodSeconds: 0`). Overridable via
 * `WARREN_K8S_TERMINATE_GRACE_SECONDS`.
 */
export const DEFAULT_K8S_TERMINATE_GRACE_SECONDS = 0;

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
	/** In-cluster Service DNS coordinates for the agent's warren callback (§6.3). */
	callback: { service: string; namespace: string; port: string };
	/** K8s Secret the init container's git token is sourced from (§6.3). */
	gitTokenSecret: { name: string; key: string };
	/** Agent-container API-key Secrets: `ANTHROPIC_API_KEY` / `OPENROUTER_API_KEY` (§6.3). */
	anthropicSecret: { name: string; key: string };
	openrouterSecret: { name: string; key: string };
	/** Optional PVC-backed git-mirror cache on the init container (§4.3, pod-env.ts). */
	repoCache?: { claimName: string; mountPath: string };
	/** SIGTERM grace (seconds) `cancel()` deletes the pod with (step 19). */
	cancelGracePeriodSeconds: number;
	/** Grace (seconds) `terminate()` force-deletes the pod with; 0 = immediate (step 19). */
	terminateGracePeriodSeconds: number;
	/** optional ServiceAccount for the run pod (RBAC step). */
	serviceAccountName?: string;
	/**
	 * `imagePullPolicy` for BOTH run-pod containers (`WARREN_K8S_IMAGE_PULL_POLICY`).
	 * Absent ⇒ omit ⇒ K8s default (`Always` for `:latest`). On kind/k3d the images
	 * are `k3d image import`-ed onto the node, so a local overlay MUST set this to
	 * `IfNotPresent`/`Never` or every dispatch ImagePullBackOffs (warren-245d).
	 */
	imagePullPolicy?: string;
}

/** Minimal env surface `resolveK8sPodConfig` reads. */
export type K8sPodConfigEnv = Readonly<Record<string, string | undefined>>;

function pickString(env: K8sPodConfigEnv, key: string, fallback: string): string {
	const raw = env[key]?.trim();
	return raw === undefined || raw === "" ? fallback : raw;
}

/**
 * Read a non-negative integer env override (grace-period seconds). A blank,
 * missing, non-numeric, negative, or non-integer value falls back to `fallback`
 * rather than propagating a nonsensical grace to the K8s API.
 */
function pickNonNegativeInt(env: K8sPodConfigEnv, key: string, fallback: number): number {
	const raw = env[key]?.trim();
	if (raw === undefined || raw === "") return fallback;
	const n = Number(raw);
	return Number.isInteger(n) && n >= 0 ? n : fallback;
}

/**
 * Resolve the cluster-shaped pod defaults from the server env and a project's
 * `.warren/config.yaml` `resources` block (carried on `RunSpec.projectResources`
 * by the dispatch path, warren-aedd). Each field the block supplies overrides the
 * matching env/global default; any it omits falls back to the `DEFAULT_K8S_*`
 * constants. Pure — no cluster access.
 */
export function resolveK8sPodConfig(
	env: K8sPodConfigEnv,
	resources?: ResourcesConfig | null,
): K8sPodConfig {
	const config: K8sPodConfig = {
		namespace: pickString(env, "WARREN_K8S_NAMESPACE", DEFAULT_K8S_NAMESPACE),
		agentImage: pickString(env, "WARREN_K8S_AGENT_IMAGE", DEFAULT_K8S_AGENT_IMAGE),
		initImage: pickString(env, "WARREN_K8S_INIT_IMAGE", DEFAULT_K8S_INIT_IMAGE),
		uid: WARREN_POD_UID,
		gid: WARREN_POD_GID,
		requests: {
			memoryMiB: resources?.requests?.memoryMiB ?? DEFAULT_K8S_MEMORY_REQUEST_MIB,
			cpuMillicores: resources?.requests?.cpuMillicores ?? DEFAULT_K8S_CPU_REQUEST_MILLICORES,
			ephemeralStorageMiB:
				resources?.requests?.ephemeralStorageMiB ?? DEFAULT_K8S_EPHEMERAL_STORAGE_REQUEST_MIB,
		},
		limits: {
			memoryMiB: resources?.limits?.memoryMiB ?? DEFAULT_K8S_MEMORY_LIMIT_MIB,
			cpuMillicores: resources?.limits?.cpuMillicores ?? DEFAULT_K8S_CPU_LIMIT_MILLICORES,
			ephemeralStorageMiB:
				resources?.limits?.ephemeralStorageMiB ?? DEFAULT_K8S_EPHEMERAL_STORAGE_LIMIT_MIB,
		},
		network: resources?.network ?? DEFAULT_K8S_NETWORK,
		callback: {
			service: pickString(env, "WARREN_K8S_CALLBACK_SERVICE", DEFAULT_K8S_CALLBACK_SERVICE),
			namespace: pickString(env, "WARREN_K8S_CALLBACK_NAMESPACE", DEFAULT_K8S_CALLBACK_NAMESPACE),
			port: pickString(env, "WARREN_K8S_CALLBACK_PORT", DEFAULT_K8S_CALLBACK_PORT),
		},
		gitTokenSecret: {
			name: pickString(env, "WARREN_K8S_GIT_SECRET_NAME", DEFAULT_K8S_GIT_SECRET_NAME),
			key: pickString(env, "WARREN_K8S_GIT_SECRET_KEY", DEFAULT_K8S_GIT_SECRET_KEY),
		},
		anthropicSecret: {
			name: pickString(env, "WARREN_K8S_ANTHROPIC_SECRET_NAME", DEFAULT_K8S_ANTHROPIC_SECRET_NAME),
			key: pickString(env, "WARREN_K8S_ANTHROPIC_SECRET_KEY", DEFAULT_K8S_ANTHROPIC_SECRET_KEY),
		},
		openrouterSecret: {
			name: pickString(
				env,
				"WARREN_K8S_OPENROUTER_SECRET_NAME",
				DEFAULT_K8S_OPENROUTER_SECRET_NAME,
			),
			key: pickString(env, "WARREN_K8S_OPENROUTER_SECRET_KEY", DEFAULT_K8S_OPENROUTER_SECRET_KEY),
		},
		cancelGracePeriodSeconds: pickNonNegativeInt(
			env,
			"WARREN_K8S_CANCEL_GRACE_SECONDS",
			DEFAULT_K8S_CANCEL_GRACE_SECONDS,
		),
		terminateGracePeriodSeconds: pickNonNegativeInt(
			env,
			"WARREN_K8S_TERMINATE_GRACE_SECONDS",
			DEFAULT_K8S_TERMINATE_GRACE_SECONDS,
		),
	};
	const sa = env.WARREN_K8S_SERVICE_ACCOUNT?.trim();
	if (sa !== undefined && sa !== "") config.serviceAccountName = sa;
	const pullPolicy = pickImagePullPolicy(env);
	if (pullPolicy !== undefined) config.imagePullPolicy = pullPolicy;
	const repoCache = resolveRepoCacheConfig(env);
	if (repoCache !== undefined) config.repoCache = repoCache;
	return config;
}

/** Valid K8s `imagePullPolicy` values; anything else is ignored (field omitted). */
const IMAGE_PULL_POLICIES = new Set(["Always", "IfNotPresent", "Never"]);

/**
 * Resolve `WARREN_K8S_IMAGE_PULL_POLICY` to a valid K8s `imagePullPolicy`, or
 * `undefined` (omit the field ⇒ K8s default). A blank/missing/invalid value maps
 * to `undefined` rather than propagating an invalid policy the API would reject.
 */
function pickImagePullPolicy(env: K8sPodConfigEnv): string | undefined {
	const raw = env.WARREN_K8S_IMAGE_PULL_POLICY?.trim();
	if (raw === undefined || raw === "") return undefined;
	return IMAGE_PULL_POLICIES.has(raw) ? raw : undefined;
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

/** Options threaded from `create()` that shape the seed-delivery wiring. */
export interface BuildRunPodOptions {
	/** When set, mount this ConfigMap's seed manifest into the init container. */
	seedConfigMapName?: string;
}

/**
 * The `workspace-init` init container (§4.2). Runs warren's `workspace:init`
 * entry (`./workspace-init.ts`), which clones the base branch fresh, carves the
 * per-run branch, and drops the seed files — all onto the `/workspace` emptyDir
 * the agent container then mounts. A clone failure surfaces as a distinct
 * `Init:Error` pod condition before the agent ever starts.
 */
function buildInitContainer(
	spec: RunSpec,
	config: K8sPodConfig,
	opts: BuildRunPodOptions,
): V1Container {
	return {
		name: INIT_CONTAINER_NAME,
		image: config.initImage,
		...(config.imagePullPolicy !== undefined ? { imagePullPolicy: config.imagePullPolicy } : {}),
		command: [...K8S_INIT_COMMAND],
		env: buildInitEnv(spec, config, opts),
		volumeMounts: buildInitVolumeMounts(config, opts),
		// warren-653f: the init container fills the /workspace emptyDir with the
		// fresh clone, so it too needs an explicit ephemeral-storage request+limit —
		// otherwise Autopilot injects a 1Gi default and evicts the pod mid-clone.
		// cpu/memory stay at the config requests/limits (clamped), matching the agent.
		resources: resourceRequirements(clampRequests(config.requests, config.limits), config.limits),
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
		ephemeralStorageMiB: spec.resources?.ephemeralStorageMiB ?? config.limits.ephemeralStorageMiB,
	};
	const requests = clampRequests(config.requests, limits);
	return {
		name: AGENT_CONTAINER_NAME,
		image: config.agentImage,
		...(config.imagePullPolicy !== undefined ? { imagePullPolicy: config.imagePullPolicy } : {}),
		// NO `workingDir` override (warren-245d): the container starts in the image
		// WORKDIR (`/app`) so `bun run agent:run` resolves — `bun run` reads the
		// CWD's package.json and does NOT walk up, so a `/workspace` CWD (the clone
		// has no package.json) fails "Script not found". The agent still runs in
		// `/workspace`: agent-entrypoint spawns it with `cwd: WARREN_WORKSPACE_PATH`.
		command: [...K8S_AGENT_COMMAND],
		env: buildAgentEnv(spec, config),
		volumeMounts: [{ name: WORKSPACE_VOLUME_NAME, mountPath: WORKSPACE_MOUNT_PATH }],
		resources: resourceRequirements(requests, limits),
		securityContext: containerSecurityContext(config),
	};
}

/** Labels stamped on every run pod. `warren.io/run-id` is the informer selector. */
export function podLabelsForRun(spec: RunSpec, config: K8sPodConfig): Record<string, string> {
	const labels: Record<string, string> = {
		[LABEL_RUN_ID]: spec.runId,
		[LABEL_RUNTIME]: spec.runtimeId,
		[LABEL_MODE]: spec.mode,
		[LABEL_NETWORK]: config.network,
		[LABEL_MANAGED_BY]: MANAGED_BY_VALUE,
	};
	// warren-b6f2: stamp the project id so the per-project admission gate can
	// count pods by project. Sanitized to a valid K8s label VALUE (DNS-safe,
	// ≤63) — a normal `proj_<ulid>` id passes through byte-for-byte.
	const project = sanitizeLabelValue(spec.projectId);
	if (project !== undefined) labels[LABEL_PROJECT] = project;
	return labels;
}

/**
 * Coerce a value into a legal K8s label VALUE: ≤63 chars of `[A-Za-z0-9._-]`,
 * beginning and ending with an alphanumeric. Illegal chars collapse to `-`;
 * blank/all-illegal input ⇒ `undefined` (no label stamped). Warren project ids
 * (`proj_<ulid>`) are already legal, so this is a defensive normalizer, not a
 * transform of the common case.
 */
export function sanitizeLabelValue(raw: string | undefined): string | undefined {
	if (raw === undefined || raw === "") return undefined;
	const collapsed = raw
		.replace(/[^A-Za-z0-9._-]/g, "-")
		.replace(/-+/g, "-")
		.slice(0, 63);
	const trimmed = collapsed.replace(/^[._-]+|[._-]+$/g, "");
	return trimmed === "" ? undefined : trimmed;
}

/**
 * Build the bare `V1Pod` for a run. Pure: a function of `(spec, config, opts)`.
 * `restartPolicy: Never`, hardened securityContext, the workspace-init init
 * container, and the `/workspace` emptyDir shared between init + agent. When
 * `opts.seedConfigMapName` is set, a read-only ConfigMap volume carries the seed
 * manifest into the init container. The agent's callback env is expected to be
 * folded into `spec.env` by the caller (`create()` owns the provider plumbing).
 */
export function buildRunPod(
	spec: RunSpec,
	config: K8sPodConfig,
	opts: BuildRunPodOptions = {},
): V1Pod {
	// Workspace emptyDir + optional seed ConfigMap + optional repo-cache PVC
	// (§4.3/R2 — the cache mounts on the init container only, never the agent).
	const volumes = buildRunPodVolumes(config, opts);
	const pod: V1Pod = {
		apiVersion: "v1",
		kind: "Pod",
		metadata: {
			name: podNameForRun(spec.runId),
			namespace: config.namespace,
			labels: podLabelsForRun(spec, config),
			// warren-e9e1: push branch → annotation (read back by workspaceInfo).
			...(spec.branch !== "" ? { annotations: { [ANNOTATION_BRANCH]: spec.branch } } : {}),
		},
		spec: {
			restartPolicy: "Never",
			automountServiceAccountToken: false,
			securityContext: podSecurityContext(config),
			initContainers: [buildInitContainer(spec, config, opts)],
			containers: [buildAgentContainer(spec, config)],
			volumes,
		},
	};
	if (config.serviceAccountName !== undefined && pod.spec !== undefined) {
		pod.spec.serviceAccountName = config.serviceAccountName;
		pod.spec.automountServiceAccountToken = true;
	}
	return pod;
}
