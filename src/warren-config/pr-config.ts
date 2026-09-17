/**
 * Per-project PR-delivery config for `.warren/config.yaml`
 * (warren-6c5a, plan pl-92a3 step 4): `pr.autoMerge` opts a project into
 * warren-armed auto-merge. The block is opt-in — an absent `pr.autoMerge`
 * means the feature is OFF and behavior stays byte-identical (pl-92a3
 * acceptance #2). Present, the shape is fixed by the warren-b312 design
 * record: `{ method: 'squash' | 'merge' | 'rebase' (default 'squash'),
 * protectedPaths: string[] (default []) }`.
 *
 * Housed in its own file (same idiom as `tracker-config.ts` /
 * `resources-config.ts`) because `schema.ts` sits a handful of lines under
 * its file-size budget; `schema.ts` imports the block and folds it into
 * `DefaultsConfigSchema`. Because `config.yaml` and the legacy
 * `defaults.json` parse against that one shared schema, the block is
 * accepted in both files — the same vintage rule its siblings (tracker,
 * admission) follow, and `warren config migrate` carries it unchanged.
 *
 * Nothing consumes the block yet — the reap PR-open step (warren-14d6)
 * is the first consumer, behind the arming policy (warren-970a). Two
 * invariants those steps rely on are pinned here in prose because no
 * schema can enforce them: `.warren/config.yaml` itself is ALWAYS
 * implicitly protected, and the policy resolves from the base branch,
 * never the run branch — an agent must not be able to edit its own
 * merge policy.
 *
 * `protectedPaths` entries are repo-relative path prefixes or globs
 * (e.g. `docs/` or `src/forge/**`). Count and per-entry-length bounds
 * keep a runaway list from bloating every policy check; both bounds are
 * exported constants so tests and the future consumer share one source.
 */

import { z } from "zod";

/** Merge methods GitHub's enablePullRequestAutoMerge accepts. */
export const AUTO_MERGE_METHODS = ["squash", "merge", "rebase"] as const;
export type AutoMergeMethod = (typeof AUTO_MERGE_METHODS)[number];

/** Merge method applied when `pr.autoMerge.method` is omitted. */
export const DEFAULT_AUTO_MERGE_METHOD: AutoMergeMethod = "squash";

/** Upper bound on `pr.autoMerge.protectedPaths` entries. */
export const MAX_AUTO_MERGE_PROTECTED_PATHS = 100;

/** Upper bound on one `protectedPaths` entry, in characters. */
export const MAX_AUTO_MERGE_PROTECTED_PATH_CHARS = 512;

const AutoMergeMethodSchema = z.enum(AUTO_MERGE_METHODS, {
	error: `pr.autoMerge.method must be one of: ${AUTO_MERGE_METHODS.join(", ")}`,
});

// Repo-relative path prefix or glob. A leading "/" would never match a
// repo-relative diff path (a silent no-op guard), and a ".." segment lets a
// pattern climb out of the repo — both are config typos, so both fail at
// load time with a message that names the fix.
const ProtectedPathSchema = z
	.string()
	.min(1, "pr.autoMerge.protectedPaths entries must be non-empty")
	.max(
		MAX_AUTO_MERGE_PROTECTED_PATH_CHARS,
		`pr.autoMerge.protectedPaths entries must be at most ${MAX_AUTO_MERGE_PROTECTED_PATH_CHARS} characters`,
	)
	.refine((value) => !value.startsWith("/"), {
		message: 'pr.autoMerge.protectedPaths entries must be repo-relative (no leading "/")',
	})
	.refine((value) => !value.split("/").includes(".."), {
		message: 'pr.autoMerge.protectedPaths entries must not traverse upward (no ".." segment)',
	});

export const AutoMergeConfigSchema = z
	.object(
		{
			method: AutoMergeMethodSchema.default(DEFAULT_AUTO_MERGE_METHOD),
			protectedPaths: z
				.array(ProtectedPathSchema)
				.max(
					MAX_AUTO_MERGE_PROTECTED_PATHS,
					`pr.autoMerge.protectedPaths must hold at most ${MAX_AUTO_MERGE_PROTECTED_PATHS} entries`,
				)
				.default([]),
		},
		{
			// `autoMerge: true` is the shorthand an operator reaches for first.
			// Zod's raw invalid-type message ("expected object, received
			// boolean") names neither the block nor the fix, so intercept the
			// type failure and show the object form instead. Every other issue
			// (strict-mode unknown keys, field messages) keeps its own message.
			error: (issue) =>
				issue.code === "invalid_type"
					? `pr.autoMerge must be an object, e.g. { method: "squash", protectedPaths: [] } — a bare \`true\` is not accepted`
					: undefined,
		},
	)
	.strict();

export type AutoMergeConfig = z.infer<typeof AutoMergeConfigSchema>;

// The `pr` wrapper holds only `autoMerge` today. It exists so later
// PR-delivery knobs land as siblings without another DefaultsConfigSchema
// key (the same forward-compat idiom as the triggers `kind:`
// discriminator).
export const PrConfigSchema = z
	.object({
		autoMerge: AutoMergeConfigSchema.optional(),
	})
	.strict();

export type PrConfig = z.infer<typeof PrConfigSchema>;
