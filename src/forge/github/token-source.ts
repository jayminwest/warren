/**
 * The credential source behind `GitHubForge` (forge-contract.md §4 —
 * credentials are minted, never held).
 *
 * Two implementations exist:
 *
 *   - `StaticGitHubTokenSource` (here): the PAT mode. `mint()` is a free
 *     read of the configured secret with `expiresAt: null`, so the domain
 *     skips the re-mint path (`credentialLifetime: "static"`).
 *   - `InstallationTokenSource` (`src/forge/github-app/`): the App mode.
 *     `mint()` is a cache hit or a `POST /app/installations/:id/access_tokens`
 *     re-mint, and the returned secret carries a real `expiresAt`
 *     (`credentialLifetime: "short-lived"`).
 *
 * The interface lives in the `github/` transport directory because
 * `GitHubForge` consumes it; the App provider supplies the short-lived
 * implementation. Both arms share the whole PR/checks transport surface —
 * only the credential's provenance differs.
 */

import type { ForgeResult } from "../contract.ts";

/** A minted bearer secret plus its expiry (epoch ms; null = no known expiry). */
export interface GitHubCredentialSecret {
	readonly secret: string;
	readonly expiresAt: number | null;
}

/** Mints (or reuses) the credential for ONE forge API call. Never throws. */
export interface GitHubForgeTokenSource {
	mint(): Promise<ForgeResult<GitHubCredentialSecret>>;
}

/** PAT/static mode: the configured secret, returned verbatim on every call. */
export class StaticGitHubTokenSource implements GitHubForgeTokenSource {
	private readonly token: string;

	constructor(token: string) {
		this.token = token;
	}

	mint(): Promise<ForgeResult<GitHubCredentialSecret>> {
		if (this.token === "") {
			return Promise.resolve({
				ok: false,
				error: { kind: "no_credential", detail: "no GitHub credential configured" },
			});
		}
		return Promise.resolve({ ok: true, value: { secret: this.token, expiresAt: null } });
	}
}
