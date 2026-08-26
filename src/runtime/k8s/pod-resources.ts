/**
 * Pure resource-quantity helpers for the K8s pod-spec builder (warren-653f).
 * Split out of `./pod-spec.ts` so that file stays under the frozen file-size
 * ratchet — the memory/cpu/ephemeral-storage → K8s quantity-string mapping is a
 * cohesive, side-effect-free unit. `./pod-spec.ts` re-exports
 * `ResolvedResourceQuantities` so it stays the single import surface for the pod
 * shape.
 */

import type { V1ResourceRequirements } from "@kubernetes/client-node";
import {
	DEFAULT_K8S_EPHEMERAL_STORAGE_LIMIT_MIB,
	DEFAULT_K8S_EPHEMERAL_STORAGE_REQUEST_MIB,
	DEFAULT_K8S_MEMORY_LIMIT_MIB,
	DEFAULT_K8S_MEMORY_REQUEST_MIB,
	type ResourcesConfig,
} from "../../warren-config/index.ts";

/** Minimal env surface `resolveEphemeralStorageMiB` reads. */
type ResourceEnv = Readonly<Record<string, string | undefined>>;

/**
 * Read a MiB-budget env override (warren-4a95), validated against the same
 * 64 MiB..1 TiB bounds the `.warren/config.yaml` `resources` schema enforces
 * (`resources-config.ts`). A blank, missing, non-numeric, or out-of-bounds
 * value falls back to `fallback` rather than propagating an unschedulable
 * budget to the K8s API.
 */
function pickMiB(env: ResourceEnv, key: string, fallback: number): number {
	const raw = env[key]?.trim();
	if (raw === undefined || raw === "") return fallback;
	const n = Number(raw);
	return Number.isInteger(n) && n >= 64 && n <= 1_048_576 ? n : fallback;
}

/**
 * Resolve the ephemeral-storage request/limit (MiB) for a run pod (warren-4a95).
 * Precedence: the per-project `.warren/config.yaml` `resources` block wins,
 * then the `WARREN_K8S_EPHEMERAL_STORAGE_REQUEST_MIB` / `_LIMIT_MIB` env
 * defaults (a cluster-wide raise for workloads like UI builds that outgrow
 * 10Gi), then the compiled-in 10Gi defaults. The limit doubles as the
 * workspace emptyDir `sizeLimit` (`./pod-env.ts`).
 */
export function resolveEphemeralStorageMiB(
	env: ResourceEnv,
	resources: ResourcesConfig | null | undefined,
): { requestMiB: number; limitMiB: number } {
	return {
		requestMiB:
			resources?.requests?.ephemeralStorageMiB ??
			pickMiB(
				env,
				"WARREN_K8S_EPHEMERAL_STORAGE_REQUEST_MIB",
				DEFAULT_K8S_EPHEMERAL_STORAGE_REQUEST_MIB,
			),
		limitMiB:
			resources?.limits?.ephemeralStorageMiB ??
			pickMiB(
				env,
				"WARREN_K8S_EPHEMERAL_STORAGE_LIMIT_MIB",
				DEFAULT_K8S_EPHEMERAL_STORAGE_LIMIT_MIB,
			),
	};
}

/**
 * Resolve the memory request/limit (MiB) for a run pod. Same precedence as
 * `resolveEphemeralStorageMiB`: the per-project `.warren/config.yaml`
 * `resources` block wins, then the `WARREN_K8S_MEMORY_REQUEST_MIB` /
 * `_LIMIT_MIB` env defaults, then the compiled-in 2Gi/4Gi defaults. The env
 * slot exists for workloads whose repo the operator cannot carry a
 * `.warren/` directory in — the first payer is the openclaw fork
 * (warren-06b8): a monorepo pnpm test run used ~3.9GiB against the 2Gi
 * default request and the node evicted the agent an hour into paid work.
 */
export function resolveMemoryMiB(
	env: ResourceEnv,
	resources: ResourcesConfig | null | undefined,
): { requestMiB: number; limitMiB: number } {
	return {
		requestMiB:
			resources?.requests?.memoryMiB ??
			pickMiB(env, "WARREN_K8S_MEMORY_REQUEST_MIB", DEFAULT_K8S_MEMORY_REQUEST_MIB),
		limitMiB:
			resources?.limits?.memoryMiB ??
			pickMiB(env, "WARREN_K8S_MEMORY_LIMIT_MIB", DEFAULT_K8S_MEMORY_LIMIT_MIB),
	};
}

/** A fully-resolved memory+cpu+ephemeral-storage triple (whole MiB / millicores). */
export interface ResolvedResourceQuantities {
	memoryMiB: number;
	cpuMillicores: number;
	/**
	 * Ephemeral-storage budget in MiB (warren-653f). Rendered to the pod's
	 * `ephemeral-storage` request+limit on BOTH the agent and workspace-init
	 * containers so the emptyDir workspace (clone + install) can't trip GKE
	 * Autopilot's injected 1Gi default and evict the pod mid-run.
	 */
	ephemeralStorageMiB: number;
}

/** Render a resolved triple to the K8s quantity strings (`<n>Mi`, `<n>m`). */
function quantityString(q: ResolvedResourceQuantities): {
	memory: string;
	cpu: string;
	ephemeralStorage: string;
} {
	return {
		memory: `${q.memoryMiB}Mi`,
		cpu: `${q.cpuMillicores}m`,
		ephemeralStorage: `${q.ephemeralStorageMiB}Mi`,
	};
}

/** Requests can never exceed limits (K8s rejects it) — clamp per-dimension. */
export function clampRequests(
	requests: ResolvedResourceQuantities,
	limits: ResolvedResourceQuantities,
): ResolvedResourceQuantities {
	return {
		memoryMiB: Math.min(requests.memoryMiB, limits.memoryMiB),
		cpuMillicores: Math.min(requests.cpuMillicores, limits.cpuMillicores),
		ephemeralStorageMiB: Math.min(requests.ephemeralStorageMiB, limits.ephemeralStorageMiB),
	};
}

/** Map a resolved requests/limits pair onto a K8s `V1ResourceRequirements`. */
export function resourceRequirements(
	requests: ResolvedResourceQuantities,
	limits: ResolvedResourceQuantities,
): V1ResourceRequirements {
	const req = quantityString(requests);
	const lim = quantityString(limits);
	return {
		requests: { memory: req.memory, cpu: req.cpu, "ephemeral-storage": req.ephemeralStorage },
		limits: { memory: lim.memory, cpu: lim.cpu, "ephemeral-storage": lim.ephemeralStorage },
	};
}
