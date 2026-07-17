/**
 * Clone-URL credential helper, shared across the workspace git primitives.
 *
 * Extracted from `src/runtime/k8s/workspace-init.ts` (warren-9574): the helper
 * is not k8s-specific — the reap path (`src/runs/reap/pr-open.ts`,
 * `finalize-collect.ts`) also authenticates clone/fetch URLs — so hosting it in
 * an init-container module created a k8s↔reap coupling. It now lives beside the
 * other neutral `src/workspace/git/` primitives. Behavior is unchanged.
 */

/**
 * Inject a git token into an https clone URL as `x-access-token:<token>@host`
 * (GitHub's app-token scheme, matching the supervisor's `insteadOf` credential).
 * Left untouched for ssh/other schemes or a URL that already carries credentials,
 * and when no token is supplied (public repos clone anonymously). Pure.
 */
export function authenticatedCloneUrl(repoUrl: string, token?: string): string {
	if (token === undefined || token === "") return repoUrl;
	const prefix = "https://";
	if (!repoUrl.startsWith(prefix)) return repoUrl;
	const rest = repoUrl.slice(prefix.length);
	// `@` before the first `/` means the authority already has userinfo.
	const authority = rest.split("/", 1)[0] ?? "";
	if (authority.includes("@")) return repoUrl;
	return `${prefix}x-access-token:${token}@${rest}`;
}
