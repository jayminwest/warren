/**
 * The V0 GitHub mutation-flag vocabulary (plan pl-91b6 step 2, warren-5055).
 *
 * A repository policy must bind EVERY flag explicitly, and every flag must
 * be `false` in V0: the dry-run boundary is enforced by the schema, not by
 * convention (design record §7.1, risk 1). When a later phase opens one of
 * these, the schema change is the reviewable event.
 */

/** Every GitHub mutation the controller could ever represent. */
export const MUTATION_FLAGS = [
	"createPullRequest",
	"pushCommits",
	"updateBranch",
	"postComment",
	"editComment",
	"requestReview",
	"addLabels",
	"closePullRequest",
	"reopenPullRequest",
	"enableAutoMerge",
	"mergePullRequest",
	"editIssue",
] as const;

/** One mutation permission; `true` means "allowed by policy". */
export type MutationFlag = (typeof MUTATION_FLAGS)[number];

/** The complete mutations block a repository policy must carry. */
export type Mutations = Readonly<Record<MutationFlag, boolean>>;

/** All-false V0 mutations — the only admitted value. */
export const NO_MUTATIONS: Mutations = Object.freeze(
	Object.fromEntries(MUTATION_FLAGS.map((flag) => [flag, false])) as Record<MutationFlag, boolean>,
);
