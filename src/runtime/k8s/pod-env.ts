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

import type { V1EnvVar, V1Volume, V1VolumeMount } from "@kubernetes/client-node";
import type { RunSpec } from "../contract.ts";
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

/** Init container's `WARREN_GIT_TOKEN` source (public repos clone without it). */
export const DEFAULT_K8S_GIT_SECRET_NAME = "warren-git-token";
export const DEFAULT_K8S_GIT_SECRET_KEY = "token";
/** Agent container's `ANTHROPIC_API_KEY` source — from a Secret, NOT the control
 * plane's process env; a key riding `spec.env` (OAuth-token flow) wins. */
export const DEFAULT_K8S_ANTHROPIC_SECRET_NAME = "warren-anthropic-key";
export const DEFAULT_K8S_ANTHROPIC_SECRET_KEY = "api-key";
/** Agent container's `OPENROUTER_API_KEY` source — the multi-provider sibling,
 * needed when a run's provider is `openrouter` (pi harness only; e.g. the
 * moonshotai/kimi-k3 project default). */
export const DEFAULT_K8S_OPENROUTER_SECRET_NAME = "warren-openrouter-key";
export const DEFAULT_K8S_OPENROUTER_SECRET_KEY = "api-key";

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

/** Deterministic name-sort so the generated spec is stable across builds. */
function sortByName(vars: V1EnvVar[]): V1EnvVar[] {
	return vars.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

/**
 * The init container's env — the git coordinates the materializer needs, the
 * workspace mount path, an OPTIONAL `WARREN_GIT_TOKEN` from a Secret, and (when
 * seeds ride a ConfigMap) the manifest path. Name-sorted for a stable spec; the
 * secret ref sorts by name alongside the plain values.
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
	const vars: V1EnvVar[] = Object.entries(plain).map(([name, value]) => ({ name, value }));
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
 *   - `ANTHROPIC_API_KEY` rides as an OPTIONAL secretKeyRef (design §6.3 —
 *     sourced from a Secret, not the control plane's env) UNLESS the domain env
 *     already carries it (an OAuth-token flow), which would make a duplicate env
 *     name illegal.
 *   - `OPENROUTER_API_KEY` rides the same way from its own Secret, so runs
 *     whose provider is `openrouter` (pi harness) can authenticate. The pod
 *     entrypoint spawns the agent with the full pod env, so presence here is
 *     sufficient — pi reads the var directly.
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
		// a credential — the push token stays out of this env by design.
		[ENV_BRANCH]: spec.branch,
		[ENV_BASE_BRANCH]: spec.baseBranch,
	};
	if (spec.metadata !== undefined) plain[ENV_AGENT_METADATA] = JSON.stringify(spec.metadata);
	const vars: V1EnvVar[] = Object.entries(plain).map(([name, value]) => ({ name, value }));
	if (spec.env.ANTHROPIC_API_KEY === undefined) {
		vars.push({
			name: "ANTHROPIC_API_KEY",
			valueFrom: {
				secretKeyRef: {
					name: config.anthropicSecret.name,
					key: config.anthropicSecret.key,
					optional: true,
				},
			},
		});
	}
	if (spec.env.OPENROUTER_API_KEY === undefined) {
		vars.push({
			name: "OPENROUTER_API_KEY",
			valueFrom: {
				secretKeyRef: {
					name: config.openrouterSecret.name,
					key: config.openrouterSecret.key,
					optional: true,
				},
			},
		});
	}
	return sortByName(vars);
}
