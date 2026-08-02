/**
 * The finalize STAGE vocabulary (warren-357c), split out of `contract.ts` so
 * the seam stays under its size budget. Re-exported from `./contract.ts` —
 * that remains the canonical import site.
 *
 * The stage trail no longer enumerates features: the merge and bookkeeping-
 * commit stages are DERIVED from the opaque artifact keys
 * ({@link finalizeMergeStage} / {@link finalizeCommitStage}), and only the
 * TRUE pipeline stages below are enumerated. The k8s pod and control plane
 * ship in the same image, so both sides derive together with no wire
 * compatibility concern.
 */

/**
 * The TRUE pipeline stages `finalize` runs, in pipeline order. Everything else
 * in the stage trail derives from the opaque artifact keys, so this const is
 * the only enumerated stage vocabulary at the seam.
 */
export const FINALIZE_PIPELINE_STAGES = ["seed_reset", "branch_push", "commits_ahead"] as const;
export type FinalizePipelineStage = (typeof FINALIZE_PIPELINE_STAGES)[number];

/**
 * The workspace-touching stages `finalize` reports: the true pipeline stages
 * plus the derived `${key}_merge` / `${key}_commit` names over opaque keys.
 */
export type FinalizeStage = FinalizePipelineStage | `${string}_merge` | `${string}_commit`;

/** The merge stage name for an opaque artifact key — `${key}_merge`. */
export function finalizeMergeStage(artifactKey: string): FinalizeStage {
	return `${artifactKey}_merge`;
}

/** The bookkeeping-commit stage name for an opaque artifact key — `${key}_commit`. */
export function finalizeCommitStage(artifactKey: string): FinalizeStage {
	return `${artifactKey}_commit`;
}

/**
 * Structural check for a stage name arriving over the wire: a pipeline stage,
 * or a derived `${key}_merge` / `${key}_commit` name.
 */
export function isFinalizeStage(name: string): name is FinalizeStage {
	return (
		(FINALIZE_PIPELINE_STAGES as readonly string[]).includes(name) ||
		name.endsWith("_merge") ||
		name.endsWith("_commit")
	);
}
