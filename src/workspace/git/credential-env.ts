/**
 * GitHub-credential git env — the per-spawn replacement for the supervisor's
 * deleted global `insteadOf` rule (warren-5497; the old module was
 * `src/supervisor/git-credentials.ts`).
 *
 * The supervisor used to install `url.https://x-access-token:<token>@github.com/
 * .insteadOf https://github.com/` into the global git config at boot — but
 * only the local topology boots through the supervisor, and a global rule has
 * no refresh point for expiring App tokens. Under `WARREN_RUNTIME=k8s` the
 * control-plane pod runs `warren serve` directly, so host-side `git clone` /
 * `fetch` / `push` against a private github.com repo died on git's interactive
 * username prompt (exit 128, "could not read Username for 'https://github.com'").
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
 * Harmless on non-github.com remotes (prefix never matches).
 */

/**
 * Env overrides that let a spawned git authenticate to github.com over
 * https with `token` (GitHub's `x-access-token` app-token scheme). Empty /
 * undefined token → `{}`, so call sites can splice unconditionally and
 * public-repo behavior is untouched. Pure.
 */
export function githubCredentialGitEnv(token: string | undefined): Record<string, string> {
	if (token === undefined || token === "") return {};
	return {
		GIT_CONFIG_COUNT: "1",
		GIT_CONFIG_KEY_0: `url.https://x-access-token:${token}@github.com/.insteadOf`,
		GIT_CONFIG_VALUE_0: "https://github.com/",
	};
}
