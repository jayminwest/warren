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

import type { V1Container, V1Pod, V1PodSecurityContext } from "@kubernetes/client-node";
import {
	DEFAULT_K8S_NETWORK,
	type NetworkPolicy,
	type ResourcesConfig,
} from "../../warren-config/index.ts";
import type { RunSpec } from "../contract.ts";
import { type AgentUidDrop, WARREN_POD_AGENT_UID } from "./agent-uid-drop.ts";
import {
	agentContainerSecurityContext,
	buildAgentEnv,
	buildInitEnv,
	buildInitVolumeMounts,
	buildRunPodVolumes,
	containerSecurityContext,
	DEFAULT_K8S_GIT_SECRET_KEY,
	DEFAULT_K8S_GIT_SECRET_NAME,
	pickImagePullPolicy,
	resolveProviderSecrets,
	resolveRepoCacheConfig,
} from "./pod-env.ts";
import {
	clampRequests,
	type ResolvedResourceQuantities,
	resolveCpuMillicores,
	resolveEphemeralStorageMiB,
	resolveMemoryMiB,
	resourceRequirements,
} from "./pod-resources.ts";

// Re-exported so `./pod-spec.ts` stays the single import surface for the pod
// shape; the env builders + ENV name constants live in `./pod-env.ts`.
export {
	agentContainerSecurityContext,
	buildAgentEnv,
	buildInitEnv,
	buildInitVolumeMounts,
	DEFAULT_K8S_GIT_SECRET_KEY,
	DEFAULT_K8S_GIT_SECRET_NAME,
	DEFAULT_PROVIDER_SECRET_KEY,
	defaultProviderSecretName,
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

// warren-cb93: the drop contract lives in `./agent-uid-drop.ts`; re-exported from the pod-shape surface.
export {
	ENV_AGENT_RUN_AS_GID,
	ENV_AGENT_RUN_AS_UID,
	WARREN_POD_AGENT_UID,
} from "./agent-uid-drop.ts";

/** Shared `emptyDir` the init container materializes and the agent mounts (§4.2). */
export const WORKSPACE_VOLUME_NAME = "workspace";
export const WORKSPACE_MOUNT_PATH = "/workspace";

export const INIT_CONTAINER_NAME = "workspace-init";
export const AGENT_CONTAINER_NAME = "agent";

// warren-2e2e: Spot placement (run pods only) lives in `./pod-spot.ts`; re-exported so this file stays the single import point for the pod shape.
export {
	resolveSpot,
	SPOT_NODE_SELECTOR_KEY,
	SPOT_NODE_SELECTOR_VALUE,
	SPOT_TOLERATION,
	spotPlacement,
} from "./pod-spot.ts";

import { resolveSpot, spotPlacement } from "./pod-spot.ts";

// warren-2e2e: pod-name derivation + label-VALUE sanitization extracted to `./pod-name.ts`.
export { podNameForRun, sanitizeLabelValue } from "./pod-name.ts";

import { podNameForRun, sanitizeLabelValue } from "./pod-name.ts";

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
 * SIGTERM grace on `cancel()` (pl-829f step 19 / warren-31d4; warren-01d5).
 * `cancel` is the seam's GRACEFUL stop: it deletes the pod with this
 * `gracePeriodSeconds`, so the kubelet delivers SIGTERM and waits before
 * SIGKILL. The grace must outlast warren-01d5's bounded in-pod salvage window
 * (the termination handler stops the agent, then finalize/salvage runs:
 * `WARREN_CANCEL_FINALIZE_MAX_WAIT_MS`, 25s, + push/POST) → 90s. It also
 * keeps the pod `Terminating` (phase still `Running`) long enough that the
 * domain's `cancelRun` status re-read does not prematurely reap the run
 * `lost`/`failed`. Overridable via `WARREN_K8S_CANCEL_GRACE_SECONDS`.
 */
export const DEFAULT_K8S_CANCEL_GRACE_SECONDS = 90;
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
	/** K8s Secret the git token is sourced from (§6.3) — init-container clone +
	 * the agent container's salvage-window fallback credential (warren-6016). */
	gitTokenSecret: { name: string; key: string };
	/**
	 * Operator-overridden bookkeeping-bot identity (`WARREN_BOT_NAME` +
	 * `WARREN_BOT_EMAIL`, both-or-nothing), threaded onto the agent container
	 * env so the in-pod salvage commit spells it the control plane's way
	 * (Article VII; warren-6016). Absent ⇒ the canonical default applies.
	 */
	botIdentity?: { name: string; email: string };
	/**
	 * Agent-container API-key Secrets (§6.3, warren-fb8d): one entry per
	 * provider in the core registry (`src/core/providers.ts`), resolved
	 * generically by `resolveProviderSecrets` — the pod-spec builder maps each
	 * provider's canonical env key to its Secret without knowing any provider
	 * names.
	 */
	providerSecrets: Record<string, { name: string; key: string }>;
	/** Optional PVC-backed git-mirror cache on the init container (§4.3, pod-env.ts). */
	repoCache?: { claimName: string; mountPath: string };
	/** SIGTERM grace (seconds) `cancel()` deletes the pod with (step 19). */
	cancelGracePeriodSeconds: number;
	/** Grace (seconds) `terminate()` force-deletes the pod with; 0 = immediate (step 19). */
	terminateGracePeriodSeconds: number;
	/**
	 * The entrypoint/agent uid split (warren-cb93, `./agent-uid-drop.ts`). When
	 * set, the agent container carries SETUID/SETGID/KILL for the ENTRYPOINT
	 * and `WARREN_AGENT_RUN_AS_*` env so the entrypoint setpriv-drops the agent
	 * to this identity — closing the `/proc/1/fd/1` provenance-marker forge.
	 * Unset (WARREN_K8S_AGENT_UID_DROP=0) ⇒ the legacy shared-uid shape.
	 */
	agentUidDrop?: AgentUidDrop;
	/** optional ServiceAccount for the run pod (RBAC step). */
	serviceAccountName?: string;
	/** Spot placement (warren-2e2e, `./pod-spot.ts`): run pods only, never the control plane. */
	spot?: boolean;
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
	// Per-project resources block > WARREN_K8S_EPHEMERAL_STORAGE_*_MIB > 10Gi (warren-4a95).
	const ephemeral = resolveEphemeralStorageMiB(env, resources);
	const memory = resolveMemoryMiB(env, resources); // warren-06b8 chain: see pod-resources.ts
	const cpu = resolveCpuMillicores(env, resources);
	const config: K8sPodConfig = {
		namespace: pickString(env, "WARREN_K8S_NAMESPACE", DEFAULT_K8S_NAMESPACE),
		agentImage: pickString(env, "WARREN_K8S_AGENT_IMAGE", DEFAULT_K8S_AGENT_IMAGE),
		initImage: pickString(env, "WARREN_K8S_INIT_IMAGE", DEFAULT_K8S_INIT_IMAGE),
		uid: WARREN_POD_UID,
		gid: WARREN_POD_GID,
		requests: {
			memoryMiB: memory.requestMiB,
			cpuMillicores: cpu.request,
			ephemeralStorageMiB: ephemeral.requestMiB,
		},
		limits: {
			memoryMiB: memory.limitMiB,
			cpuMillicores: cpu.limit,
			ephemeralStorageMiB: ephemeral.limitMiB,
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
		providerSecrets: resolveProviderSecrets(env),
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
	// warren-cb93: the uid split is ON by default; an operator whose runtime
	// does not propagate ambient caps to a non-root pid 1 (containerd/runc do;
	// the entrypoint needs effective SETUID/SETGID for setpriv) opts out here.
	const dropRaw = env.WARREN_K8S_AGENT_UID_DROP?.trim().toLowerCase();
	const dropDisabled =
		dropRaw === "0" || dropRaw === "false" || dropRaw === "no" || dropRaw === "off";
	if (!dropDisabled) config.agentUidDrop = { uid: WARREN_POD_AGENT_UID, gid: WARREN_POD_GID };
	const sa = env.WARREN_K8S_SERVICE_ACCOUNT?.trim();
	if (sa !== undefined && sa !== "") config.serviceAccountName = sa;
	// warren-6016: both halves or nothing, mirroring resolveWarrenBotIdentity.
	const botName = env.WARREN_BOT_NAME?.trim();
	const botEmail = env.WARREN_BOT_EMAIL?.trim();
	if (botName !== undefined && botName !== "" && botEmail !== undefined && botEmail !== "") {
		config.botIdentity = { name: botName, email: botEmail };
	}
	const pullPolicy = pickImagePullPolicy(env);
	if (pullPolicy !== undefined) config.imagePullPolicy = pullPolicy;
	const repoCache = resolveRepoCacheConfig(env);
	if (repoCache !== undefined) config.repoCache = repoCache;
	if (resolveSpot(env)) config.spot = true;
	return config;
}

// --- Builder ---------------------------------------------------------------

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
		// warren-fabb: per-project agentImage override (RunSpec.agentImage, from
		// `.warren/config.yaml`) wins over the env-resolved default. Precedence:
		// project override > WARREN_K8S_AGENT_IMAGE > DEFAULT_K8S_AGENT_IMAGE.
		image: spec.agentImage ?? config.agentImage,
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
		securityContext: agentContainerSecurityContext(config),
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
 * Build the bare `V1Pod` for a run. Pure: a function of `(spec, config, opts)`.
 * `restartPolicy: Never`, hardened securityContext, the workspace-init init
 * container, and the `/workspace` emptyDir shared between init + agent. When
 * `opts.seedConfigMapName` is set, a read-only ConfigMap volume carries the seed
 * manifest into the init container. The agent's callback env is expected to be
 * folded into `spec.env` by the caller (`create()` owns the provider plumbing).
 *
 * Spot (warren-2e2e, `./pod-spot.ts`): when `config.spot` is set, the pod gains
 * the `cloud.google.com/gke-spot=true` nodeSelector plus the matching NoSchedule
 * toleration, pinning it to Autopilot Spot nodes. The builder sets NO explicit
 * `terminationGracePeriodSeconds`, so K8s applies its 30 s pod default —
 * deliberate against Autopilot's 25 s preemption notice: preemption ends the
 * pod as infra-lost regardless (preemption is a retryable failure and the run
 * re-dispatches from scratch), so a longer grace buys nothing on Spot; the
 * 30 s default only matters for explicit `cancel()`, whose delete grace comes
 * from `cancelGracePeriodSeconds`, not this field.
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
	if (config.spot && pod.spec !== undefined) {
		const spot = spotPlacement();
		pod.spec.nodeSelector = spot.nodeSelector;
		pod.spec.tolerations = spot.tolerations;
	}
	return pod;
}
