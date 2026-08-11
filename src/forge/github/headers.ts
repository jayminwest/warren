/**
 * GitHub REST transport — header builder.
 *
 * The single canonical header set for every `api.github.com` call in
 * warren (plan pl-d1c9 step 1, docs/design/forge-contract.md §6.1).
 * Consolidates four drifted copies: `src/runs/pr-checks.ts`,
 * `src/runs/pr-annotate.ts`, `src/ci-fixer/check-runs.ts` (which omitted
 * `content-type`), and the inline literal in acceptance scenario 35.
 *
 * Per §6.9 this module holds NO assumption about token shape or length:
 * installation tokens are now a stateless `ghs_` format observed live at
 * 383 characters. The token is interpolated verbatim.
 */

export const GITHUB_API_BASE = "https://api.github.com";

/** Pinned GitHub REST API version (the `X-GitHub-Api-Version` header). */
export const GITHUB_API_VERSION = "2022-11-28";

/**
 * Default `User-Agent` when the caller does not name its subsystem.
 * GitHub rejects requests with no UA, so there is always one.
 */
export const DEFAULT_GITHUB_USER_AGENT = "warren";

export interface BuildGitHubHeadersOptions {
	/** Subsystem UA (e.g. "warren-ci-fixer"). Defaults to `DEFAULT_GITHUB_USER_AGENT`. */
	readonly userAgent?: string;
}

/**
 * Build the canonical GitHub REST header set. `content-type` is always
 * included — the check-runs copy omitted it, which only worked because
 * its requests were all GETs; a single builder must serve PATCH/POST too.
 */
export function buildGitHubHeaders(
	token: string,
	options: BuildGitHubHeadersOptions = {},
): Record<string, string> {
	return {
		accept: "application/vnd.github+json",
		authorization: `Bearer ${token}`,
		"content-type": "application/json",
		"user-agent": options.userAgent ?? DEFAULT_GITHUB_USER_AGENT,
		"x-github-api-version": GITHUB_API_VERSION,
	};
}
