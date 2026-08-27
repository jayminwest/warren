/**
 * One-shot `GET /user` lookup for the `warren up` credential wizard
 * (warren-80e9, pl-26f3 step 4).
 *
 * The wizard defaults the git author identity from the GitHub token's
 * own login, instead of demanding the operator set up a machine
 * account. `api.github.com` literals live only inside `src/forge/`
 * (layer rule `github-api-literal-is-forge-only`), so this lookup
 * belongs here even though its only caller is the CLI.
 *
 * Fail-soft by design: the author default is a convenience, never a
 * boot requirement, so any transport or shape failure returns
 * `undefined` and the wizard simply skips the default.
 */

import { GITHUB_API_BASE } from "./github/headers.ts";
import { requestGitHub } from "./github/http.ts";

export interface GitHubUserLogin {
	readonly login: string;
	readonly id: number;
}

export interface FetchGitHubUserLoginOptions {
	/** Injected fetch seam; defaults to `globalThis.fetch`. */
	readonly fetch?: typeof fetch;
}

/**
 * Resolve the authenticated user behind `token` (`GET /user`, one call).
 * Returns `undefined` on any failure — the caller treats the author
 * default as optional.
 */
export async function fetchGitHubUserLogin(
	token: string,
	options: FetchGitHubUserLoginOptions = {},
): Promise<GitHubUserLogin | undefined> {
	const result = await requestGitHub({
		url: `${GITHUB_API_BASE}/user`,
		token,
		context: "GET /user",
		fetch: options.fetch,
		// A wizard boot must not hang on a flaky network with the default
		// retry ladder; one attempt, then skip the default.
		retry: { maxRetries: 0 },
	});
	if (!result.ok) return undefined;
	let body: unknown;
	try {
		body = await result.response.json();
	} catch {
		return undefined;
	}
	if (typeof body !== "object" || body === null) return undefined;
	const record = body as Record<string, unknown>;
	const login = record.login;
	const id = record.id;
	if (typeof login !== "string" || login === "" || typeof id !== "number") return undefined;
	return { login, id };
}
