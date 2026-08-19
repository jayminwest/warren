/**
 * Project capability flags (warren-9bbc / pl-1c02 step 8).
 *
 * The project domain owns the capability vocabulary here, in one module,
 * rather than letting call sites probe the filesystem ad hoc. The shape
 * started life inside `refresh.ts` (warren-4e20, warren-9990) as
 * `detectProjectFeatures`; this extraction gives the flags a home of
 * their own so `refresh.ts` goes back to owning git mechanics only.
 *
 * The contract:
 *
 *   - ONE probe site: {@link detectProjectFeatures} walks the clone for
 *     the directories in {@link PROJECT_FEATURE_DIRS} and returns a
 *     {@link ProjectFeatureFlags} record. It is the only place in warren
 *     that turns on-disk feature directories into booleans.
 *   - Callers persist the flags onto the `projects` row (`addProject`
 *     after the initial clone, `refreshProject` after each fetch/reset)
 *     and every consumer — plan-run dispatch, reap's seeds commit, the
 *     seed-close lifecycle extension, the UI — reads the FLAG off the
 *     row (`project.hasSeeds`), never the disk. A call site that finds
 *     itself reaching for `existsSync(join(localPath, ".seeds"))` is a
 *     bug: extend the flags here instead.
 *
 * The seed plan (pl-2047 step 2) leaves room for the existing opt-in
 * integrations (`.mulch/`, `.pi/`) to start surfacing the same way
 * without changing the probe shape — add the directory to
 * {@link PROJECT_FEATURE_DIRS}, add the flag, and the probe + both
 * persistence call sites pick it up unchanged.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";

/**
 * Feature directories warren probes for at clone refresh time (warren-4e20).
 * `.seeds/` joined in warren-9990 to gate plan-run dispatch. `.mulch/`
 * joined in warren-cb46 to gate the mulch prompt fragments (probe-only:
 * there is no `has_mulch` column yet, so the flag is consumed at
 * dispatch time by the prompt-capability resolver rather than off the
 * projects row).
 */
export const PROJECT_FEATURE_DIRS = {
	seeds: ".seeds",
	mulch: ".mulch",
} as const;

/**
 * Result of probing a project clone for opt-in feature directories. One
 * boolean per gated integration; addProject / refreshProject persist the
 * fields to the corresponding `projects` row columns.
 */
export interface ProjectFeatureFlags {
	readonly hasSeeds: boolean;
	/** Probe-only (warren-cb46): no projects-row column yet — dispatch reads it fresh. */
	readonly hasMulch: boolean;
}

/**
 * Synchronous probe of the on-disk clone for the directories that gate
 * warren's opt-in integrations. Returns booleans; never throws. The
 * `exists` probe is injectable so tests don't touch disk and so a future
 * git-tree reader can swap to a non-checked-out ref.
 *
 * Called from `refreshProjectClone` after the post-fetch reset and from
 * `addProject` immediately after the initial clone so the row reflects
 * the feature shape of the freshly-checked-out tree. The detection is
 * read-only and stateless on its own — persistence is the caller's job.
 */
export function detectProjectFeatures(
	localPath: string,
	exists: (path: string) => boolean = existsSync,
): ProjectFeatureFlags {
	return {
		hasSeeds: exists(join(localPath, PROJECT_FEATURE_DIRS.seeds)),
		hasMulch: exists(join(localPath, PROJECT_FEATURE_DIRS.mulch)),
	};
}
