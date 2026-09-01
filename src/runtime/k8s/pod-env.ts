/**
 * Container ENV + volume-mount builders for the K8s run pod (warren-186c). Split
 * out of `./pod-spec.ts` so that file stays under the file-size ratchet — the
 * env contract is the same pure mapping, just isolated. Everything here is a
 * side-effect-free function of `(spec, config, opts)`; `./pod-spec.ts` calls
 * these from `buildInitContainer` / `buildAgentContainer`.
 *
 * The path/name constants + config/spec types come from `./pod-spec.ts`; the
 * import is used only inside function bodies (evaluated when the builders are
 * called), so the module pairing carries no initialization-order coupling.
 */

import type { V1EnvVar, V1SecurityContext, V1Volume, V1VolumeMount } from "@kubernetes/client-node";
import { KNOWN_PROVIDER_NAMES, primaryProviderEnvKey } from "../../core/providers.ts";
import type { RunSpec } from "../contract.ts";
import { ENV_AGENT_RUN_AS_GID, ENV_AGENT_RUN_AS_UID } from "./agent-uid-drop.ts";
import {
	type BuildRunPodOptions,
	type K8sPodConfig,
	type K8sPodConfigEnv,
	SEED_MANIFEST_PATH,
	SEED_MOUNT_PATH,
	SEED_VOLUME_NAME,
	WORKSPACE_MOUNT_PATH,
	WORKSPACE_VOLUME_NAME,
} from "./pod-spec.ts";

/**
 * Derive the in-cluster callback URL the agent dials to POST events/finalize
 * back to warren (contract §6.3). Kubernetes Service DNS — reachable from the
 * run pod, unlike LocalProvider's `http://localhost:PORT`. Pure.
 */
export function serviceDnsCallbackUrl(config: K8sPodConfig): string {
	const { service, namespace, port } = config.callback;
	return `http://${service}.${namespace}.svc.cluster.local:${port}`;
}

// --- Secret sources (design §6.3) -------------------------------------------
// Each is referenced as an OPTIONAL secretKeyRef so a pod still schedules when
// the Secret is absent; each pair is overridable via the matching
// `WARREN_K8S_*_SECRET_NAME` / `_KEY` env. Provisioned by the manifests step
// (see deploy/k8s/base/secrets.yaml); all three live in the RUNS namespace.

/**
 * `WARREN_GIT_TOKEN` source — the init container clones with it, and (warren-6016)
 * the agent container's harness holds it for the salvage-window rescue push
 * (scrubbed from the agent child's env; public repos run without it).
 */
export const DEFAULT_K8S_GIT_SECRET_NAME = "warren-git-token";
export const DEFAULT_K8S_GIT_SECRET_KEY = "token";

/**
 * Default Secret key every provider credential rides under (warren-fb8d) —
 * one `api-key` entry per provider Secret, provisioned by the manifests step
 * (deploy/k8s/base/secrets.yaml).
 */
export const DEFAULT_PROVIDER_SECRET_KEY = "api-key";

/**
 * Default Secret name for a registry provider's credential —
 * `warren-<provider>-key` (e.g. `warren-anthropic-key`,
 * `warren-openrouter-key`). Generic derivation off `src/core/providers.ts`,
 * so a new registry entry needs no warren code change here.
 */
export function defaultProviderSecretName(provider: string): string {
	return `warren-${provider}-key`;
}

/**
 * Resolve the Secret coordinates for EVERY registry provider (warren-fb8d):
 * each defaults to `warren-<provider>-key` / `api-key` and is overridable
 * per provider via `WARREN_K8S_<PROVIDER>_SECRET_NAME` / `_KEY`, with the
 * provider uppercased and every hyphen mapped to an underscore, so
 * `openrouter` reads `WARREN_K8S_OPENROUTER_SECRET_NAME` and `opencode-go`
 * reads `WARREN_K8S_OPENCODE_GO_SECRET_NAME`. A hyphen left in place would
 * make a name no shell can export and no kubelet will pass through.
 */
export function resolveProviderSecrets(
	env: K8sPodConfigEnv,
): Record<string, { name: string; key: string }> {
	const out: Record<string, { name: string; key: string }> = {};
	for (const provider of KNOWN_PROVIDER_NAMES) {
		const stem = provider.toUpperCase().replaceAll("-", "_");
		const name = env[`WARREN_K8S_${stem}_SECRET_NAME`]?.trim();
		const key = env[`WARREN_K8S_${stem}_SECRET_KEY`]?.trim();
		out[provider] = {
			name: name === undefined || name === "" ? defaultProviderSecretName(provider) : name,
			key: key === undefined || key === "" ? DEFAULT_PROVIDER_SECRET_KEY : key,
		};
	}
	return out;
}

// --- Repo-cache PVC (design §4.3, R2 — warren-e908) -------------------------

/**
 * Optional PVC-backed git-mirror cache the init container fetches into instead
 * of a full clone. Mounted ONLY on the init container at `config.repoCache
 * .mountPath`; the run workspace itself stays on the per-pod `emptyDir` (pods
 * must never share a working tree). Wired only when `WARREN_K8S_REPO_CACHE_PVC`
 * names the claim — absent ⇒ every run clones fresh over the network. The claim
 * is RWO today (single node); a multi-node cluster needs an RWX class first
 * (see deploy README).
 */
export const REPO_CACHE_VOLUME_NAME = "repo-cache";
export const DEFAULT_REPO_CACHE_MOUNT_PATH = "/repo-cache";

/** The mirror-cache mount that the workspace-init materializer keys off. */
export const ENV_REPO_CACHE_DIR = "WARREN_REPO_CACHE_DIR";

/**
 * Resolve the repo-cache claim + mount path from env, or `undefined` when the
 * cache is off (no/blank `WARREN_K8S_REPO_CACHE_PVC`). Mount path overridable
 * via `WARREN_K8S_REPO_CACHE_PATH` (default `/repo-cache`). Pure.
 */
export function resolveRepoCacheConfig(
	env: K8sPodConfigEnv,
): { claimName: string; mountPath: string } | undefined {
	const claim = env.WARREN_K8S_REPO_CACHE_PVC?.trim();
	if (claim === undefined || claim === "") return undefined;
	const path = env.WARREN_K8S_REPO_CACHE_PATH?.trim();
	return {
		claimName: claim,
		mountPath: path === undefined || path === "" ? DEFAULT_REPO_CACHE_MOUNT_PATH : path,
	};
}

/** Valid K8s `imagePullPolicy` values; anything else is ignored (field omitted). */
const IMAGE_PULL_POLICIES = new Set(["Always", "IfNotPresent", "Never"]);

/**
 * Resolve `WARREN_K8S_IMAGE_PULL_POLICY` to a valid K8s `imagePullPolicy`, or
 * `undefined` (omit the field ⇒ K8s default). A blank/missing/invalid value maps
 * to `undefined` rather than propagating an invalid policy the API would reject.
 * (Lives here so `pod-spec.ts` stays under the file-size budget.)
 */
export function pickImagePullPolicy(env: K8sPodConfigEnv): string | undefined {
	const raw = env.WARREN_K8S_IMAGE_PULL_POLICY?.trim();
	if (raw === undefined || raw === "") return undefined;
	return IMAGE_PULL_POLICIES.has(raw) ? raw : undefined;
}

/**
 * The run pod's volumes: the `/workspace` emptyDir the init container
 * materializes and the agent mounts, an optional read-only seed ConfigMap, and
 * the optional repo-cache PVC (init-only mount — see `buildInitVolumeMounts`).
 */
export function buildRunPodVolumes(config: K8sPodConfig, opts: BuildRunPodOptions): V1Volume[] {
	// warren-653f: cap the workspace emptyDir at the ephemeral-storage limit so an
	// overrun fails the emptyDir first — a crisp "workspace too big" signal — rather
	// than surfacing only as a whole-pod ephemeral-storage eviction. Autopilot
	// counts emptyDir usage against the pod ephemeral-storage budget either way; the
	// sizeLimit just makes the boundary attributable to the workspace.
	const workspaceSizeLimit = `${config.limits.ephemeralStorageMiB}Mi`;
	const volumes: V1Volume[] = [
		{ name: WORKSPACE_VOLUME_NAME, emptyDir: { sizeLimit: workspaceSizeLimit } },
	];
	if (opts.seedConfigMapName !== undefined) {
		volumes.push({ name: SEED_VOLUME_NAME, configMap: { name: opts.seedConfigMapName } });
	}
	if (config.repoCache !== undefined) {
		volumes.push({
			name: REPO_CACHE_VOLUME_NAME,
			persistentVolumeClaim: { claimName: config.repoCache.claimName },
		});
	}
	return volumes;
}

// --- Agent env-var names (the in-pod runner's contract, warren-186c) --------

/** The warren run id — keys the callback (events/finalize/inbox) and finalize env. */
export const ENV_RUN_ID = "WARREN_RUN_ID";
/** The `/workspace` mount the init container materialized; agent cwd + finalize root. */
export const ENV_WORKSPACE_PATH = "WARREN_WORKSPACE_PATH";
/** The runtime the in-pod runner resolves off burrow's registry (claude-code | sapling | …). */
export const ENV_AGENT_RUNTIME = "WARREN_AGENT_RUNTIME";
/** The composed prompt (system section already prepended by the domain). */
export const ENV_PROMPT = "WARREN_PROMPT";
/** The run's own branch (warren-cd3b) — surfaced on the in-pod salvage envelope. */
export const ENV_BRANCH = "WARREN_BRANCH";
/** Base ref the run branch was cut from (warren-cd3b) — bounds the salvage bundle range. */
export const ENV_BASE_BRANCH = "WARREN_BASE_BRANCH";
/** The agent frontmatter/metadata (JSON) — provider/model overrides the runtime honors. */
export const ENV_AGENT_METADATA = "WARREN_AGENT_METADATA";

/* --- Container security contexts (§2.2 + warren-cb93) ----------------------- */

/** Container-level hardening applied to BOTH the init and agent containers (§2.2). */
export function containerSecurityContext(config: K8sPodConfig): V1SecurityContext {
	return {
		runAsNonRoot: true,
		runAsUser: config.uid,
		runAsGroup: config.gid,
		allowPrivilegeEscalation: false,
		capabilities: { drop: ["ALL"] },
		seccompProfile: { type: "RuntimeDefault" },
	};
}

/**
 * The agent container's hardening (§2.2 + warren-cb93 + warren-950d). Same
 * non-root base as the init container — the ENTRYPOINT keeps uid 1000 —
 * plus, when the uid split is enabled, the shape the split needs:
 *
 *   - `SETUID`/`SETGID` in `capabilities.add`: they must sit in the
 *     container's BOUNDING set for the agent image's file-caps setpriv
 *     (`setcap cap_setuid,cap_setgid+ep`, Dockerfile.agent) to gain them on
 *     exec — a non-root pid 1 gets `capabilities.add` bounding-only on
 *     containerd 2.x, never effective, so the file caps are what actually
 *     privilege the drop (warren-950d; verified on GKE Autopilot).
 *   - `allowPrivilegeEscalation: true`: keeps no_new_privs OFF for the
 *     entrypoint so those file caps can take effect at all. This is the one
 *     deliberate relaxation of the §2.2 posture, scoped to the agent
 *     container and only while the split is on.
 *   - `KILL`: legacy best-effort — on a runtime that still grants added caps
 *     effectively (containerd 1.x) it lets the watchdog's direct `kill()`
 *     land cross-uid. On containerd 2.x the kill routes through setpriv
 *     instead (`./agent-uid-drop.ts` `withCrossUidKill`).
 *
 * The AGENT keeps none of this: setpriv runs it under no_new_privs (file
 * caps inert, irrevocably inherited) with an emptied bounding set
 * (`./agent-uid-drop.ts`), so the escalation path stops at warren's own
 * entrypoint — the preflight proves the drop and the run fails legibly
 * (`spawn_failed`) when the cluster no longer supports it.
 */
export function agentContainerSecurityContext(config: K8sPodConfig): V1SecurityContext {
	const base = containerSecurityContext(config);
	if (config.agentUidDrop === undefined) return base;
	return {
		...base,
		allowPrivilegeEscalation: true,
		capabilities: { drop: ["ALL"], add: ["SETUID", "SETGID", "KILL"] },
	};
}

/** Deterministic name-sort so the generated spec is stable across builds. */
function sortByName(vars: V1EnvVar[]): V1EnvVar[] {
	return vars.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

/**
 * The init container's env — the git coordinates the materializer needs, the
 * workspace mount path, an OPTIONAL `WARREN_GIT_TOKEN` from a Secret, and (when
 * seeds ride a ConfigMap) the manifest path. Name-sorted for a stable spec; the
 * secret ref sorts by name alongside the plain values.
 *
 * warren-c9ac (forge-contract.md §4.1 window 1): when the spec carries a
 * `WARREN_GIT_TOKEN` value — the credential `K8sProvider.create` minted at
 * pod-spec time under App mode — it rides as a PLAIN value and the static
 * Secret ref is skipped entirely, so a short-lived token is fresh for the
 * clone and the pod never references the long-lived Secret.
 */
export function buildInitEnv(
	spec: RunSpec,
	config: K8sPodConfig,
	opts: BuildRunPodOptions,
): V1EnvVar[] {
	const plain: Record<string, string> = {
		WARREN_RUN_ID: spec.runId,
		WARREN_REPO_URL: spec.originUrl,
		WARREN_BRANCH: spec.branch,
		WARREN_BASE_BRANCH: spec.baseBranch,
		WARREN_WORKSPACE_PATH: WORKSPACE_MOUNT_PATH,
	};
	if (opts.seedConfigMapName !== undefined) plain.WARREN_SEED_MANIFEST = SEED_MANIFEST_PATH;
	if (config.repoCache !== undefined) plain[ENV_REPO_CACHE_DIR] = config.repoCache.mountPath;
	const specToken = spec.env.WARREN_GIT_TOKEN;
	if (specToken !== undefined) plain.WARREN_GIT_TOKEN = specToken;
	const vars: V1EnvVar[] = Object.entries(plain).map(([name, value]) => ({ name, value }));
	if (specToken === undefined) {
		vars.push({
			name: "WARREN_GIT_TOKEN",
			valueFrom: {
				secretKeyRef: {
					name: config.gitTokenSecret.name,
					key: config.gitTokenSecret.key,
					optional: true,
				},
			},
		});
	}
	return sortByName(vars);
}

export function buildInitVolumeMounts(
	config: K8sPodConfig,
	opts: BuildRunPodOptions,
): V1VolumeMount[] {
	const mounts: V1VolumeMount[] = [
		{ name: WORKSPACE_VOLUME_NAME, mountPath: WORKSPACE_MOUNT_PATH },
	];
	if (opts.seedConfigMapName !== undefined) {
		mounts.push({ name: SEED_VOLUME_NAME, mountPath: SEED_MOUNT_PATH, readOnly: true });
	}
	// §4.3/R2: mirror cache is init-only (the agent container never mounts it).
	if (config.repoCache !== undefined) {
		mounts.push({ name: REPO_CACHE_VOLUME_NAME, mountPath: config.repoCache.mountPath });
	}
	return mounts;
}

/**
 * The agent container's env — the in-pod runner's full contract (warren-186c):
 *
 *   - `spec.env` (DOMAIN env) rides first: `WARREN_API_TOKEN`, `WARREN_API_URL`
 *     (the Service-DNS callback the provider folded in),
 *     `WARREN_QUALITY_GATE`, `BUN_INSTALL_CACHE_DIR`.
 *   - The DERIVED run vars fold on top (a domain env must not carry them):
 *     `WARREN_RUN_ID`, `WARREN_WORKSPACE_PATH`, `WARREN_AGENT_RUNTIME` (the
 *     runtime the runner resolves off burrow's registry), `WARREN_PROMPT` (the
 *     composed prompt), and `WARREN_AGENT_METADATA` (frontmatter JSON) when set.
 *     These plus `WARREN_API_URL`/`WARREN_API_TOKEN` satisfy the finalize
 *     entrypoint's env contract (`./finalize-entrypoint.ts`), which the runner
 *     execs after the agent exits.
 *   - Every provider in the core registry (`src/core/providers.ts`,
 *     warren-fb8d) contributes its canonical credential key as an OPTIONAL
 *     secretKeyRef from its per-provider Secret (design §6.3 — sourced from
 *     a Secret, not the control plane's env) UNLESS the domain env already
 *     carries it (an OAuth-token flow), which would make a duplicate env
 *     name illegal. A run whose provider is unknown to the registry gets no
 *     extra ref — unknown is not invalid, just unprovisioned.
 *
 * The prompt travels as an env var: composed prompts are bounded (system section
 * + user input) and fit comfortably under K8s's per-pod object size. A prompt
 * large enough to threaten that limit is a signal to move it onto the seed
 * ConfigMap (as `create()` already does for seed files) — a documented follow-up,
 * not a v1 concern.
 */
export function buildAgentEnv(spec: RunSpec, config: K8sPodConfig): V1EnvVar[] {
	const plain: Record<string, string> = {
		...spec.env,
		[ENV_RUN_ID]: spec.runId,
		[ENV_WORKSPACE_PATH]: WORKSPACE_MOUNT_PATH,
		[ENV_AGENT_RUNTIME]: spec.runtimeId,
		[ENV_PROMPT]: spec.prompt,
		// warren-cd3b: the in-pod salvage (finalize-entrypoint) bundles
		// `<base>..HEAD` and labels the envelope with the run branch. Neither is
		// a credential.
		[ENV_BRANCH]: spec.branch,
		[ENV_BASE_BRANCH]: spec.baseBranch,
	};
	// warren-cb93: the entrypoint/agent uid split. The entrypoint reads these
	// and setpriv-drops the agent process to a uid distinct from its own, so an
	// agent write at `/proc/1/fd/1` (the provenance-marker forge, warren-6646's
	// residual) fails EACCES. Stamped only when the split is enabled on the
	// resolved config (see `resolveK8sPodConfig`).
	if (config.agentUidDrop !== undefined) {
		plain[ENV_AGENT_RUN_AS_UID] = String(config.agentUidDrop.uid);
		plain[ENV_AGENT_RUN_AS_GID] = String(config.agentUidDrop.gid);
	}
	if (spec.metadata !== undefined) plain[ENV_AGENT_METADATA] = JSON.stringify(spec.metadata);
	// warren-6016: thread the operator's bookkeeping-bot identity override so
	// the in-pod salvage commit resolves the SAME spelling the control plane's
	// reap commits use (Article VII — the resolver in src/bot-identity.ts reads
	// these off the pod env; a half-set pair never reaches the pod).
	if (config.botIdentity !== undefined) {
		plain.WARREN_BOT_NAME = config.botIdentity.name;
		plain.WARREN_BOT_EMAIL = config.botIdentity.email;
	}
	const vars: V1EnvVar[] = Object.entries(plain).map(([name, value]) => ({ name, value }));
	// warren-6016: the push token rides the agent CONTAINER env (same Secret
	// the init container clones with) so the finalize/salvage window can
	// authenticate a rescue push even when no reap intent ever parked one. The
	// blast-radius posture is preserved for the agent itself: the entrypoint
	// scrubs this key from the agent child's spawn env (agent-io.ts).
	if (spec.env.WARREN_GIT_TOKEN === undefined) {
		vars.push({
			name: "WARREN_GIT_TOKEN",
			valueFrom: {
				secretKeyRef: {
					name: config.gitTokenSecret.name,
					key: config.gitTokenSecret.key,
					optional: true,
				},
			},
		});
	}
	// warren-fb8d: every registry provider's canonical credential key rides as
	// an OPTIONAL secretKeyRef from its per-provider Secret (design §6.3 —
	// sourced from a Secret, not the control plane's env) UNLESS the domain env
	// already carries it (an OAuth-token flow), which would make a duplicate env
	// name illegal. Generic over `src/core/providers.ts` — the builder knows no
	// provider names; a run whose provider is unknown to the registry simply
	// gets no extra ref. The pod entrypoint spawns the agent with the full pod
	// env, so presence here is sufficient — pi reads the var directly.
	for (const provider of KNOWN_PROVIDER_NAMES) {
		const envKey = primaryProviderEnvKey(provider);
		const secret = config.providerSecrets[provider];
		if (envKey === undefined || secret === undefined) continue;
		if (spec.env[envKey] !== undefined) continue;
		vars.push({
			name: envKey,
			valueFrom: {
				secretKeyRef: { name: secret.name, key: secret.key, optional: true },
			},
		});
	}
	return sortByName(vars);
}
