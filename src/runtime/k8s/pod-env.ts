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

import type { V1EnvVar, V1VolumeMount } from "@kubernetes/client-node";
import type { RunSpec } from "../contract.ts";
import {
	type BuildRunPodOptions,
	type K8sPodConfig,
	SEED_MANIFEST_PATH,
	SEED_MOUNT_PATH,
	SEED_VOLUME_NAME,
	WORKSPACE_MOUNT_PATH,
	WORKSPACE_VOLUME_NAME,
} from "./pod-spec.ts";

// --- Agent env-var names (the in-pod runner's contract, warren-186c) --------

/** The warren run id — keys the callback (events/finalize/inbox) and finalize env. */
export const ENV_RUN_ID = "WARREN_RUN_ID";
/** The `/workspace` mount the init container materialized; agent cwd + finalize root. */
export const ENV_WORKSPACE_PATH = "WARREN_WORKSPACE_PATH";
/** The runtime the in-pod runner resolves off burrow's registry (claude-code | sapling | …). */
export const ENV_AGENT_RUNTIME = "WARREN_AGENT_RUNTIME";
/** The composed prompt (system section already prepended by the domain). */
export const ENV_PROMPT = "WARREN_PROMPT";
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

export function buildInitVolumeMounts(opts: BuildRunPodOptions): V1VolumeMount[] {
	const mounts: V1VolumeMount[] = [
		{ name: WORKSPACE_VOLUME_NAME, mountPath: WORKSPACE_MOUNT_PATH },
	];
	if (opts.seedConfigMapName !== undefined) {
		mounts.push({ name: SEED_VOLUME_NAME, mountPath: SEED_MOUNT_PATH, readOnly: true });
	}
	return mounts;
}

/**
 * The agent container's env — the in-pod runner's full contract (warren-186c):
 *
 *   - `spec.env` (DOMAIN env) rides first: `WARREN_API_TOKEN`, `WARREN_API_URL`
 *     (the Service-DNS callback the provider folded in), `PLOT_ID`/`PLOT_ACTOR`,
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
	return sortByName(vars);
}
