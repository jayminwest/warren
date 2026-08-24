/**
 * Clone-URL credential helper, shared across the workspace git primitives.
 *
 * Extracted from `src/runtime/k8s/workspace-init.ts` (warren-9574): the helper
 * is not k8s-specific — the reap path (`src/runs/reap/pr-open.ts`,
 * `finalize-collect.ts`) also authenticates clone/fetch URLs — so hosting it in
 * an init-container module created a k8s↔reap coupling. It now lives beside the
 * other neutral `src/workspace/git/` primitives.
 */

/**
 * The username to use when the caller holds a token and nothing else.
 *
 * This is GitHub's App-token scheme. It is the right answer only where the
 * token genuinely arrives without a forge beside it, which today is the
 * in-pod finalize path: the pod reads `WARREN_GIT_TOKEN` or the credential
 * endpoint, and neither carries a username. Everywhere a `GitCloneCredential`
 * exists, pass it, because the forge is the one that knows (`oauth2` for
 * GitLab, `x-access-token` for a GitHub App).
 */
export const DEFAULT_GIT_USERNAME = "x-access-token";

/**
 * The half of a minted git credential a clone URL can carry. Structurally a
 * `GitSpawnCredential` (src/workspace/git/credential-env.ts) minus the host,
 * so a caller passes the minted credential straight through.
 */
export interface GitCloneCredential {
	readonly username: string;
	readonly secret: string;
}

/**
 * Inject a git credential into an https clone URL as `<username>:<secret>@host`.
 *
 * The username comes from the credential rather than from a literal here: a
 * GitHub App mints `x-access-token`, GitLab wants `oauth2`, and hardcoding
 * either makes the other fail to authenticate (warren-1b6f). Taking the whole
 * credential rather than a bare secret is deliberate, so a caller cannot drop
 * the username by passing `.secret` alone.
 *
 * Left untouched for ssh/other schemes or a URL that already carries
 * credentials, and when no credential is supplied (public repos clone
 * anonymously). Pure.
 */
export function authenticatedCloneUrl(repoUrl: string, credential?: GitCloneCredential): string {
	if (credential === undefined || credential.secret === "") return repoUrl;
	const username = credential.username === "" ? DEFAULT_GIT_USERNAME : credential.username;
	const prefix = "https://";
	if (!repoUrl.startsWith(prefix)) return repoUrl;
	const rest = repoUrl.slice(prefix.length);
	// `@` before the first `/` means the authority already has userinfo.
	const authority = rest.split("/", 1)[0] ?? "";
	if (authority.includes("@")) return repoUrl;
	return `${prefix}${username}:${credential.secret}@${rest}`;
}

/**
 * Wrap a bare token as a credential, for the paths that only ever have one.
 *
 * The init and finalize containers read a token out of env or the in-pod
 * credential endpoint, and no username arrives with it. This is where that
 * gap is filled, named and in one place, rather than inside the URL helper
 * where every caller would inherit it silently.
 */
export function bareTokenCredential(token: string | undefined): GitCloneCredential | undefined {
	if (token === undefined || token === "") return undefined;
	return { username: DEFAULT_GIT_USERNAME, secret: token };
}
