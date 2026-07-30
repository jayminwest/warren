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
 * identity below is warren's own bookkeeping bot, not the agent's author.
 *
 * The spelling is operator-configurable (warren-02cd): `WARREN_BOT_NAME` +
 * `WARREN_BOT_EMAIL` override the default when BOTH are set (both halves
 * or nothing, mirroring the supervisor's agent-identity rule). Warren is
 * self-hosted by strangers, so the default must attribute to nobody: the
 * historical `warren@os-eco.dev` default lived at a domain the project
 * does not own, and any real domain would pin every deployment's
 * bookkeeping commits to whoever owns that mailbox. `warren.invalid` is
 * RFC 2606-reserved — unregistrable and unroutable by construction.
 * Operators who want GitHub attribution point `WARREN_BOT_EMAIL` at an
 * address verified on their own bot/machine account (see `.env.example`).
 */
export const WARREN_BOT_IDENTITY = {
	name: "warren",
	email: "bot@warren.invalid",
} as const;

/** Minimal env surface for identity resolution — injectable for tests. */
export type BotIdentityEnv = Record<string, string | undefined>;

/**
 * Resolve the effective bookkeeping-bot identity: the operator override
 * (`WARREN_BOT_NAME` + `WARREN_BOT_EMAIL`, both non-blank) when present,
 * else the canonical default. A half-set pair is ignored rather than
 * half-applied, so a typo can't produce a hybrid spelling — the drift
 * class warren-598f exists to prevent.
 */
export function resolveWarrenBotIdentity(env: BotIdentityEnv = process.env): {
	name: string;
	email: string;
} {
	const name = env.WARREN_BOT_NAME?.trim();
	const email = env.WARREN_BOT_EMAIL?.trim();
	if (name && email) return { name, email };
	return WARREN_BOT_IDENTITY;
}

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
export function warrenCommitIdentityArgs(env: BotIdentityEnv = process.env): string[] {
	const identity = resolveWarrenBotIdentity(env);
	return ["-c", `user.name=${identity.name}`, "-c", `user.email=${identity.email}`];
}

/**
 * Explicit `GIT_AUTHOR_*` / `GIT_COMMITTER_*` env for the canonical warren
 * bot identity. Merge this over the inherited environment at a commit spawn
 * so an inherited `GIT_AUTHOR_NAME` (etc.) can't override the config pinned
 * by `warrenCommitIdentityArgs()` (warren-035c). Derived from the single
 * `WARREN_BOT_IDENTITY` source of truth — never re-spell the literals.
 * Returned as a fresh object so callers can splice it without sharing state.
 */
export function warrenCommitIdentityEnv(env: BotIdentityEnv = process.env): Record<string, string> {
	const identity = resolveWarrenBotIdentity(env);
	return {
		GIT_AUTHOR_NAME: identity.name,
		GIT_AUTHOR_EMAIL: identity.email,
		GIT_COMMITTER_NAME: identity.name,
		GIT_COMMITTER_EMAIL: identity.email,
	};
}

/**
 * Git environment variables that pin repo discovery / index / object storage to
 * a specific worktree. A parent `git commit` exports these to its hooks
 * (`GIT_INDEX_FILE`, `GIT_PREFIX`, and — when the invocation was already inside
 * a git dir — `GIT_DIR`), so warren's OWN pre-commit gate, which runs the test
 * suite, carries them. If a git subprocess spawned by warren inherited them it
 * would ignore its `cwd` and read/write the PARENT repo instead of the project
 * clone: warren-fa84 saw a leaked repo-context env write a stray `chore(warren)`
 * commit into the real repo (and warren-e9e1 earlier saw it flip `core.bare`).
 * Scrub the whole dangerous family at every warren-authored git spawn so
 * hermeticity never depends on the caller's environment or on test-level env
 * clearing.
 */
const GIT_REPO_CONTEXT_ENV_KEYS = [
	"GIT_DIR",
	"GIT_WORK_TREE",
	"GIT_INDEX_FILE",
	"GIT_COMMON_DIR",
	"GIT_PREFIX",
	"GIT_OBJECT_DIRECTORY",
	"GIT_ALTERNATE_OBJECT_DIRECTORIES",
	"GIT_NAMESPACE",
	"GIT_CEILING_DIRECTORIES",
] as const;

/**
 * An `env` override map that unsets the repo-context `GIT_*` vars in the child
 * environment (the exec adaptor treats an `undefined` value as "remove this
 * key" — see `resolveSpawnEnv` in `src/projects/clone.ts`). Merge identity or
 * other entries OVER this to keep them; the two families don't overlap.
 *
 * Co-located with the identity helpers above because both compose onto the
 * `env` of a warren-authored git spawn — the identity env pins WHO authors the
 * commit, this scrub pins WHERE the git subprocess operates (its `cwd`, never a
 * leaked parent repo). Warren-bot commit sites pass
 * `{ ...gitRepoContextScrubEnv(), ...warrenCommitIdentityEnv() }`; their
 * non-commit git calls in the same flow pass the scrub alone (warren-23dd,
 * warren-fa84). Returned as a fresh object so callers can splice it without
 * sharing state.
 */
export function gitRepoContextScrubEnv(): Record<string, string | undefined> {
	const env: Record<string, string | undefined> = {};
	for (const key of GIT_REPO_CONTEXT_ENV_KEYS) env[key] = undefined;
	return env;
}
