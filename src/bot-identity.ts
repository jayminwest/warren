/**
 * Canonical warren bot identity for warren-authored commits (warren-598f).
 *
 * Per docs/CONSTITUTION.md Article VII ("Identity is consistent"),
 * agent-authored commits use canonical co-author identities — one agent,
 * one spelling. Historically warren's reap-time bookkeeping commits and
 * the plot-sync commit spelled the bot identity as inline string literals
 * (`user.name=warren`, `user.email=warren@os-eco.dev`), which is how a
 * drift of ~9 inconsistent spellings (`@warren.local`, `@os-eco.local`,
 * `@local`, `@example.com`, ...) crept into git history.
 *
 * This module is the single source of truth. Every place warren authors a
 * commit on the agent's behalf must reference `WARREN_BOT_IDENTITY` (or the
 * `warrenCommitIdentityArgs()` helper) rather than re-spelling the literals.
 *
 * This is distinct from the operator-configured identity in
 * `src/supervisor/git-identity.ts`, which controls the *agent's* own
 * commits (via `WARREN_GIT_AUTHOR_NAME` / `WARREN_GIT_AUTHOR_EMAIL`). The
 * constant below is warren's own bookkeeping bot, not the agent's author.
 */
export const WARREN_BOT_IDENTITY = {
	name: "warren",
	email: "warren@os-eco.dev",
} as const;

/**
 * `-c user.name=… -c user.email=…` arguments that pin the canonical warren
 * bot identity on a single `git` invocation. Returned as a fresh array so
 * callers can splice it into an argv without sharing mutable state.
 *
 * NOTE: `-c user.name` / `user.email` are config, and git's
 * `GIT_AUTHOR_NAME` / `GIT_AUTHOR_EMAIL` / `GIT_COMMITTER_*` env vars take
 * precedence over config. Any warren process that inherited those vars (a
 * parent `git commit` exports them to its hooks, so this repo's own
 * pre-commit gate carries them) would mis-author the bookkeeping commit as
 * the operator. Pair this with `warrenCommitIdentityEnv()` at every commit
 * site so inherited env can never win (warren-035c).
 */
export function warrenCommitIdentityArgs(): string[] {
	return [
		"-c",
		`user.name=${WARREN_BOT_IDENTITY.name}`,
		"-c",
		`user.email=${WARREN_BOT_IDENTITY.email}`,
	];
}

/**
 * Explicit `GIT_AUTHOR_*` / `GIT_COMMITTER_*` env for the canonical warren
 * bot identity. Merge this over the inherited environment at a commit spawn
 * so an inherited `GIT_AUTHOR_NAME` (etc.) can't override the config pinned
 * by `warrenCommitIdentityArgs()` (warren-035c). Derived from the single
 * `WARREN_BOT_IDENTITY` source of truth — never re-spell the literals.
 * Returned as a fresh object so callers can splice it without sharing state.
 */
export function warrenCommitIdentityEnv(): Record<string, string> {
	return {
		GIT_AUTHOR_NAME: WARREN_BOT_IDENTITY.name,
		GIT_AUTHOR_EMAIL: WARREN_BOT_IDENTITY.email,
		GIT_COMMITTER_NAME: WARREN_BOT_IDENTITY.name,
		GIT_COMMITTER_EMAIL: WARREN_BOT_IDENTITY.email,
	};
}
