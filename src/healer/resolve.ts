/**
 * Alert→project routing for the healer (warren-3db0, Phase 2).
 *
 * Two strategies, tried in order (per the design review decision —
 * "static mapping WITH payload fallback"):
 *
 *   1. Static mapping — a healer-enabled project's
 *      `healer.projectMapping` lists routing keys. Matching is anchored
 *      and case-insensitive: a key matches when it equals the alert
 *      fingerprint, culprit, or title in full. A key may opt into
 *      wildcard matching with `*`, which stands for any run of
 *      characters (`src/runs/*`, `*ErrorRate`, `pay*service`). There is
 *      no implicit substring matching — warren-50a7 removed it, because
 *      a short key like `api` silently claimed every alert whose title
 *      happened to contain "api". The first enabled project with a hit
 *      wins.
 *   2. Payload fallback — the alert's inferred `owner/repo` is matched
 *      against each enabled project's git URL. Used only when no mapping
 *      key matched, so an explicit mapping always takes precedence.
 *
 * Only projects whose resolved `healer.enabled` is true are candidates;
 * a matching but disabled project is reported as `not_enabled` so the
 * handler can return a meaningful skip reason instead of a bare 404.
 */

import type { HealAlert } from "./alert.ts";
import { inferRepoSlug } from "./alert.ts";
import type { HealerSettings } from "./dispatch.ts";

export interface HealProjectCandidate {
	readonly projectId: string;
	readonly gitUrl: string;
	readonly localPath: string;
	/** Resolved healer settings, or undefined when the project has no block. */
	readonly settings: HealerSettings | undefined;
	/** Healer agent name to dispatch (`healer.role`); default when unset. */
	readonly role: string;
	readonly projectMapping: readonly string[];
}

export type HealResolveResult =
	| { readonly kind: "matched"; readonly candidate: HealProjectCandidate }
	| { readonly kind: "no_match" }
	| { readonly kind: "not_enabled" };

const GLOB_SPECIALS = /[.*+?^${}()|[\]\\]/g;

/**
 * Compile one mapping key into an anchored, case-insensitive matcher.
 * Every regex metacharacter is escaped; only `*` survives, as `.*`.
 */
function compileKey(key: string): RegExp {
	const pattern = key
		.split("*")
		.map((part) => part.replace(GLOB_SPECIALS, "\\$&"))
		.join(".*");
	return new RegExp(`^${pattern}$`, "i");
}

/**
 * True when `key` matches `value` under the documented semantics: full,
 * case-insensitive equality, widened only by explicit `*` wildcards.
 */
export function healMappingKeyMatches(key: string, value: string): boolean {
	if (!key.includes("*")) return key.toLowerCase() === value.toLowerCase();
	return compileKey(key).test(value);
}

function mappingMatches(alert: HealAlert, mapping: readonly string[]): boolean {
	if (mapping.length === 0) return false;
	const haystacks = [alert.fingerprint, alert.culprit ?? "", alert.title];
	return mapping.some((key) => haystacks.some((value) => healMappingKeyMatches(key, value)));
}

function repoMatches(alert: HealAlert, gitUrl: string): boolean {
	if (alert.repo === null) return false;
	const projectSlug = inferRepoSlug(gitUrl);
	return projectSlug !== null && projectSlug.toLowerCase() === alert.repo.toLowerCase();
}

export function resolveHealProject(
	alert: HealAlert,
	candidates: readonly HealProjectCandidate[],
): HealResolveResult {
	const enabled = candidates.filter((c) => c.settings?.enabled === true);

	const byMapping = enabled.find((c) => mappingMatches(alert, c.projectMapping));
	if (byMapping !== undefined) return { kind: "matched", candidate: byMapping };

	const byRepo = enabled.find((c) => repoMatches(alert, c.gitUrl));
	if (byRepo !== undefined) return { kind: "matched", candidate: byRepo };

	// Distinguish "a project would have matched but isn't opted in" from
	// "nothing matched at all" so the handler's skip reason is precise.
	const disabledHit = candidates.some(
		(c) =>
			c.settings?.enabled !== true &&
			(mappingMatches(alert, c.projectMapping) || repoMatches(alert, c.gitUrl)),
	);
	return disabledHit ? { kind: "not_enabled" } : { kind: "no_match" };
}
