/**
 * Per-spawn git credential env, the replacement for the supervisor's
 * deleted global `insteadOf` rule (warren-5497; the old module was
 * `src/supervisor/git-credentials.ts`).
 *
 * The supervisor used to install `url.https://x-access-token:<token>@github.com/
 * .insteadOf https://github.com/` into the global git config at boot — but
 * only the local topology boots through the supervisor, and a global rule has
 * no refresh point for expiring App tokens. Under `WARREN_RUNTIME=k8s` the
 * control-plane pod runs `warren serve` directly, so host-side `git clone` /
 * `fetch` / `push` against a private repo died on git's interactive
 * username prompt (exit 128, "could not read Username for 'https://...'").
 *
 * This helper renders the rewrite as `GIT_CONFIG_{COUNT,KEY_0,VALUE_0}`
 * env vars (git ≥2.31), merged into a single spawn's environment via the
 * existing `SpawnOptions.env` seam:
 *
 *   - no global (or repo) git config is mutated — the rule lives and dies
 *     with the one child process;
 *   - the token never appears in argv (unlike a token-in-URL clone), so
 *     `ps` can't see it;
 *   - `insteadOf` rewrites on the wire only, so the clone's stored
 *     `origin` URL stays clean.
 *
 * The username and the host used to be the literals `x-access-token` and
 * `github.com` (warren-1b6f). Both are provider facts, not warren facts:
 * a GitHub App wants `x-access-token`, GitLab wants `oauth2`, and a
 * self-hosted forge answers on its own host. They now arrive on
 * {@link GitSpawnCredential}, minted beside the forge that knows them
 * (`src/forge/credentials.ts`). Harmless on a remote the credential does
 * not name, because the prefix never matches.
 */

/**
 * What ONE git network spawn needs to authenticate. Minted per operation
 * and never held (forge-contract.md §4).
 */
export interface GitSpawnCredential {
	/**
	 * Provider-chosen. A GitHub App mints `x-access-token`, GitLab wants
	 * `oauth2`. No domain code names either string.
	 */
	readonly username: string;
	readonly secret: string;
	/** The remote host the rewrite targets, e.g. `github.com`. */
	readonly host: string;
}

/**
 * Env overrides that let a spawned git authenticate to `credential.host`
 * over https. An absent credential, or one missing any of its three
 * parts, yields `{}`, so call sites can splice unconditionally and
 * public-repo behavior is untouched. Pure.
 */
export function gitCredentialGitEnv(
	credential: GitSpawnCredential | undefined,
): Record<string, string> {
	if (credential === undefined) return {};
	const { username, secret, host } = credential;
	if (username === "" || secret === "" || host === "") return {};
	return {
		GIT_CONFIG_COUNT: "1",
		GIT_CONFIG_KEY_0: `url.https://${username}:${secret}@${host}/.insteadOf`,
		GIT_CONFIG_VALUE_0: `https://${host}/`,
	};
}
