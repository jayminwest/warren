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
 */
export function warrenCommitIdentityArgs(): string[] {
	return [
		"-c",
		`user.name=${WARREN_BOT_IDENTITY.name}`,
		"-c",
		`user.email=${WARREN_BOT_IDENTITY.email}`,
	];
}
