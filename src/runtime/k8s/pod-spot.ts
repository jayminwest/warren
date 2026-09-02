/**
 * GKE Autopilot Spot placement for RUN pods (warren-2e2e, pl-6076). Split out
 * of `pod-spec.ts` for the file-size ratchet; `pod-spec.ts` re-exports this
 * surface so it stays the single import point for the pod shape.
 *
 * `WARREN_K8S_SPOT` truthy (`1`/`true`, case-insensitive) pins RUN pods only
 * onto Spot nodes via a `cloud.google.com/gke-spot=true` nodeSelector plus the
 * matching NoSchedule toleration — Spot nodes are tainted, and Autopilot adds
 * the toleration exactly this way. The control-plane Deployment is a manifest,
 * not built here, so it is structurally untouched. Run pods are ephemeral and
 * retry-safe, so a 25 s-notice preemption is an infra-lost retry, not data
 * loss; the aborted attempt's model spend (bounded by `maxCostUsd`) is the
 * whole cost of the trade. See RUNBOOK-K8S.md §3, "Spot run pods".
 */

/** Truthy spellings for `WARREN_K8S_SPOT`. Deliberately narrow: a typo
 * (`yes`, `on`) must not silently move run pods onto preemptible capacity. */
export const SPOT_NODE_SELECTOR_KEY = "cloud.google.com/gke-spot";
export const SPOT_NODE_SELECTOR_VALUE = "true";
export const SPOT_TOLERATION = {
	key: SPOT_NODE_SELECTOR_KEY,
	operator: "Equal",
	value: SPOT_NODE_SELECTOR_VALUE,
	effect: "NoSchedule",
} as const;

/**
 * Parse `WARREN_K8S_SPOT`. Truthy exactly `1`/`true` (case-insensitive,
 * trimmed); any other value — blank, `0`, `yes`, `on`, garbage — is unset.
 */
export function resolveSpot(env: Readonly<Record<string, string | undefined>>): boolean {
	const raw = env.WARREN_K8S_SPOT?.trim().toLowerCase();
	return raw === "1" || raw === "true";
}

/**
 * The pod-spec fragment Spot pods carry: nodeSelector + tolerations. `undefined`
 * when Spot is off so callers can spread nothing (`buildRunPod` adds neither
 * field, keeping the unset golden byte-identical).
 */
export function spotPlacement(): {
	nodeSelector: Record<string, string>;
	tolerations: Array<{ key: string; operator: string; value: string; effect: string }>;
} {
	return {
		nodeSelector: { [SPOT_NODE_SELECTOR_KEY]: SPOT_NODE_SELECTOR_VALUE },
		tolerations: [{ ...SPOT_TOLERATION }],
	};
}
