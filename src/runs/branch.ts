/**
 * Run-branch composition (warren-9993).
 *
 * Every warren run lands on a sandbox branch warren passes to burrow via the
 * `branch` field on `POST /burrows`. Historically warren passed nothing and
 * burrow fell back to `burrow/<bur-id>` — the `burrow/` namespace confused
 * agents into looking in the burrow repo on `git log` / PR review (the
 * motivating bug on warren-9993).
 *
 * Warren now composes the branch as `${prefix}/${run.id}` where:
 *   - `run.id` is the warren `run_xxxxxxxxxxxx`, so the branch traces back
 *     to the warren run on `git log` and PR review without a separate lookup.
 *   - `prefix` resolves with the precedence
 *       project default (`.warren/defaults.json.runBranchPrefix`)
 *         > WARREN_RUN_BRANCH_PREFIX env
 *         > built-in DEFAULT_RUN_BRANCH_PREFIX ("burrow")
 *     so existing deployments are unchanged by default and operators can
 *     opt in to a friendlier prefix per deployment or per project.
 *
 * The env loader is intentionally lenient: an invalid value silently
 * downgrades to `undefined` (next precedence slot wins). A bad env should
 * never block a spawn; the schema-level validation catches typos at
 * project-config parse time, where the operator can act on them.
 */

export const DEFAULT_RUN_BRANCH_PREFIX = "burrow";

const PREFIX_PATTERN = /^[a-z0-9][a-z0-9._-]*$/;

export type RunBranchEnvLike = Readonly<Record<string, string | undefined>>;

/**
 * Read `WARREN_RUN_BRANCH_PREFIX` from the env. Returns the trimmed value
 * when it parses as a valid prefix, `undefined` otherwise — including for
 * an unset or whitespace-only value. Mirrors the `runBranchPrefix` schema
 * regex in src/warren-config/schema.ts.
 */
export function loadRunBranchPrefixFromEnv(
	env: RunBranchEnvLike = process.env,
): string | undefined {
	const raw = env.WARREN_RUN_BRANCH_PREFIX;
	if (raw === undefined) return undefined;
	const trimmed = raw.trim();
	if (trimmed === "" || !PREFIX_PATTERN.test(trimmed)) return undefined;
	return trimmed;
}

/**
 * Resolve the effective run-branch prefix for a single spawn, applying the
 * project default > deployment env > built-in precedence. Whitespace-only
 * strings are treated the same as "not provided" so an explicit empty
 * config value can't sneak past the schema and yield a bad branch.
 */
export function resolveRunBranchPrefix(input: {
	readonly projectDefault?: string;
	readonly envDefault?: string;
}): string {
	const pd = input.projectDefault?.trim();
	if (pd !== undefined && pd !== "") return pd;
	const env = input.envDefault?.trim();
	if (env !== undefined && env !== "") return env;
	return DEFAULT_RUN_BRANCH_PREFIX;
}

/**
 * Compose the burrow workspace branch warren passes to `burrows.up`. The
 * suffix is always the warren run id so the branch back-references the
 * warren run row even when the burrow id is stripped from logs.
 *
 * `targetBranch` (warren-05ea) overrides the composed `${prefix}/${runId}`
 * shape entirely: a CI-fixer run must push to the *existing* PR branch so
 * the PR's CI re-runs, rather than opening a fresh `${prefix}/run_xxx`
 * branch. A non-empty `targetBranch` short-circuits prefix composition;
 * an empty / whitespace-only value falls back to the composed branch so a
 * stray config can never strand a spawn on a blank ref.
 */
export function composeRunBranch(prefix: string, runId: string, targetBranch?: string): string {
	const override = targetBranch?.trim();
	if (override !== undefined && override !== "") return override;
	return `${prefix}/${runId}`;
}
