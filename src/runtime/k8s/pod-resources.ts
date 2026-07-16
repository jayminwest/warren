/**
 * Pure resource-quantity helpers for the K8s pod-spec builder (warren-653f).
 * Split out of `./pod-spec.ts` so that file stays under the frozen file-size
 * ratchet — the memory/cpu/ephemeral-storage → K8s quantity-string mapping is a
 * cohesive, side-effect-free unit. `./pod-spec.ts` re-exports
 * `ResolvedResourceQuantities` so it stays the single import surface for the pod
 * shape.
 */

import type { V1ResourceRequirements } from "@kubernetes/client-node";

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
