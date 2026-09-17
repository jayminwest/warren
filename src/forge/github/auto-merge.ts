/**
 * The GitHub auto-merge arm of the Forge seam (plan pl-92a3).
 *
 * GitHub's REST surface has no enable-auto-merge endpoint — the mutation is
 * GraphQL (`enablePullRequestAutoMerge`), and that transport is step 3 of
 * the plan. Until it lands, both GitHub providers hold
 * `capabilities.autoMergeArm: false` and answer `armAutoMerge` with the
 * capability-false refusal below, so the seam's arming vocabulary ships
 * ahead of its first real implementation (warren-8a74).
 *
 * This module exists so `provider.ts` — at its check:size cap — gains only
 * the delegation line; the GraphQL implementation lands here in step 3.
 */

import type { ArmAutoMergeResult } from "../contract.ts";

/**
 * The refusal the capability-false GitHub providers answer `armAutoMerge`
 * with (the §5 discipline: calling past a false flag returns the
 * capability's refusal). A frozen constant, not a builder: one shape, no
 * parameters, nothing to drift.
 */
export const UNSUPPORTED_AUTO_MERGE_ARM: ArmAutoMergeResult = {
	ok: false,
	error: {
		reason: "unsupported_forge",
		message:
			"GitHubForge cannot arm auto-merge yet — the GraphQL transport arrives in plan pl-92a3 step 3",
	},
};
