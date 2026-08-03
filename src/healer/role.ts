/**
 * Eager validation of `healer.role` (warren-50a7).
 *
 * `healer.role` names the agent warren dispatches when an alert routes to
 * a project. The config schema only checks its charset, so a typo used to
 * survive config load, survive routing, and only blow up deep inside
 * `spawnRun` as a bare `agent not found` \u2014 long after the operator could
 * connect it to their `.warren/config.yaml`. This module turns that into a
 * loud, self-describing config error at alert-intake time, before any run
 * is created.
 *
 * Pure on purpose: the caller supplies the registered agent names, so the
 * domain module stays free of repo/HTTP wiring.
 */

export interface HealerRoleCheckInput {
	readonly role: string;
	readonly projectId: string;
	/** Names of the agents registered in the agents table. */
	readonly knownRoles: readonly string[];
}

export type HealerRoleCheck =
	| { readonly kind: "ok" }
	| { readonly kind: "unknown_role"; readonly message: string };

const MAX_LISTED_ROLES = 12;

/**
 * Check that `role` resolves against the registered agents. Comparison is
 * exact \u2014 agent names are the canonical registry keys.
 */
export function checkHealerRole(input: HealerRoleCheckInput): HealerRoleCheck {
	const { role, projectId, knownRoles } = input;
	if (knownRoles.includes(role)) return { kind: "ok" };
	const listed = [...knownRoles].sort();
	const shown = listed.slice(0, MAX_LISTED_ROLES).join(", ");
	const suffix = listed.length > MAX_LISTED_ROLES ? ", \u2026" : "";
	const known = listed.length === 0 ? "(no agents registered)" : `${shown}${suffix}`;
	return {
		kind: "unknown_role",
		message:
			`healer.role "${role}" (project ${projectId}) is not a registered agent. ` +
			`Fix healer.role in the project's .warren/config.yaml. Known agents: ${known}`,
	};
}
