/**
 * The V0 GitHub mutation-flag vocabulary (plan pl-91b6 step 2, warren-5055).
 *
 * A repository policy must bind EVERY flag explicitly. The dry-run
 * boundary is enforced by the schema, not by convention (design record
 * §7.1, risk 1): only flags in `EXECUTABLE_MUTATION_FLAGS` may be `true`,
 * and each addition there is its own reviewable schema+code event. Phase 2
 * (warren-84da) opened `createPullRequest`; Phase 3 (warren-094b) opened the
 * response-loop mutations `updatePullRequest`, `postComment`, `updateBranch`,
 * and `followUpPush` — each still individually policy-gated and
 * digest-covered.
 */

/** Every GitHub mutation the controller could ever represent. */
export const MUTATION_FLAGS = [
	"createPullRequest",
	"followUpPush",
	"updatePullRequest",
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

/** All-false mutations — the dry-run posture and the default. */
export const NO_MUTATIONS: Mutations = Object.freeze(
	Object.fromEntries(MUTATION_FLAGS.map((flag) => [flag, false])) as Record<MutationFlag, boolean>,
);

/**
 * The flags an executable code path exists for. Phase 2 (warren-84da) opened
 * `createPullRequest`; Phase 3 (warren-094b) opened the response-loop
 * vocabulary. Everything outside this list is still refused by the policy
 * schema: widening it is a reviewable code change, never a config change.
 */
export const EXECUTABLE_MUTATION_FLAGS: readonly MutationFlag[] = Object.freeze([
	"createPullRequest",
	"updatePullRequest",
	"postComment",
	"updateBranch",
	"followUpPush",
]);
