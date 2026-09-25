/**
 * Installation-token cache — the App mode's `GitHubForgeTokenSource`
 * (forge-contract.md §4: "It caches a token until `expiresAt` minus a
 * safety margin, then re-mints").
 *
 * One `mint()` call: return the cached token while
 * `now < expiresAt - EXPIRY_MARGIN_MS`, otherwise sign a fresh App JWT
 * (./jwt.ts) and trade it at
 * `POST /app/installations/:id/access_tokens`. The margin is what keeps a
 * long run from handing out a token that dies mid-operation: installation
 * tokens expire one hour after minting (§4), so any mint inside the last
 * five minutes of a token's life re-mints instead.
 *
 * No length assumption on the token (§6.9 — the stateless `ghs_` format
 * was observed at 383 characters); the secret is interpolated verbatim and
 * never logged. `mint()` is installation-wide: it serves the REST surface
 * (PR open, checks, auto-merge) across every repo the installation covers.
 *
 * `mintForRepository()` (warren-b425) is the down-scoped path behind
 * `gitCredential`. That credential reaches the run pod, so it is minted for
 * the ONE repository the run targets, with `contents` + `workflows` write
 * only. Each repository gets its own cache slot. An installation that was
 * not granted `workflows` answers 422, and the mint retries with `contents`
 * alone.
 *
 * Seam discipline (§2.2): `mint()` never throws. A transport failure maps
 * through the shared classifier; a JWT that `node:crypto` refuses to sign
 * (a non-RSA key that parsed fine at boot) surfaces as `no_credential`
 * with the underlying message — the credential is unusable, which is what
 * the kind means.
 */

import type { KeyObject } from "node:crypto";
import type { ForgeResult } from "../contract.ts";
import { GITHUB_API_BASE } from "../github/headers.ts";
import { requestGitHub } from "../github/http.ts";
import { toForgeError } from "../github/provider.ts";
import { readJson } from "../github/readers.ts";
import type { GitHubCredentialSecret, GitHubForgeTokenSource } from "../github/token-source.ts";
import { mintGitHubAppJwt } from "./jwt.ts";

const USER_AGENT = "warren-forge-github-app";

/**
 * Re-mint this long before `expiresAt`. Sized against §4.1's windows: the
 * finalize push and the reap-side PR open each complete in seconds, so
 * five minutes of remaining life is always enough for the operation the
 * token was minted for.
 */
export const INSTALLATION_TOKEN_EXPIRY_MARGIN_MS = 5 * 60 * 1000;

export interface InstallationTokenSourceOptions {
	/** The App id (JWT `iss`). */
	readonly appId: string;
	/** Pre-parsed App private key (boot-validated by the provider). */
	readonly privateKey: KeyObject;
	/** The installation this deployment mints tokens for. */
	readonly installationId: string;
	/** Injected fetch seam; defaults to `globalThis.fetch`. */
	readonly fetch?: typeof fetch;
	/** Clock seam for tests; epoch ms. Defaults to `Date.now`. */
	readonly now?: () => number;
	/** Expiry-margin override for tests. Defaults to `INSTALLATION_TOKEN_EXPIRY_MARGIN_MS`. */
	readonly expiryMarginMs?: number;
}

/** The cached token. Field name `installationToken` is log-redact-listed. */
interface CachedInstallationToken {
	readonly installationToken: string;
	readonly expiresAt: number;
}

/**
 * Permissions for a repository-scoped git credential. `workflows` lets a
 * run push `.github/workflows/` edits; an installation without that grant
 * falls back to `contents` alone.
 */
const REPOSITORY_PERMISSIONS = { contents: "write", workflows: "write" } as const;
const REPOSITORY_PERMISSIONS_FALLBACK = { contents: "write" } as const;

interface AccessTokenResponseJson {
	readonly token?: unknown;
	readonly expires_at?: unknown;
}

export class InstallationTokenSource implements GitHubForgeTokenSource {
	private readonly options: InstallationTokenSourceOptions;
	private readonly fetch: typeof fetch;
	private readonly now: () => number;
	private readonly marginMs: number;
	private cached: CachedInstallationToken | null = null;
	private readonly repoCache = new Map<string, CachedInstallationToken>();

	constructor(options: InstallationTokenSourceOptions) {
		this.options = options;
		this.fetch = options.fetch ?? globalThis.fetch;
		this.now = options.now ?? Date.now;
		this.marginMs = options.expiryMarginMs ?? INSTALLATION_TOKEN_EXPIRY_MARGIN_MS;
	}

	/**
	 * Force a re-mint, bypassing the cache read (warren-1295). The
	 * credential heartbeat probe (./heartbeat.ts) uses this: a cache hit
	 * proves nothing about whether the App credential is still alive, so
	 * the probe always trades a fresh JWT. The minted token still lands
	 * in the cache, so a probe tick doubles as a cache warmer.
	 */
	async mintFresh(): Promise<ForgeResult<GitHubCredentialSecret>> {
		return this.reMint();
	}

	async mint(): Promise<ForgeResult<GitHubCredentialSecret>> {
		const cached = this.fresh(this.cached);
		if (cached !== null) return cached;
		const minted = await this.exchange({});
		if (minted.ok) this.cached = toCached(minted.value);
		return minted;
	}

	/**
	 * Mint a git credential scoped to ONE repository of the installation
	 * (warren-b425). `repository` is the bare repo name, without the owner.
	 */
	async mintForRepository(repository: string): Promise<ForgeResult<GitHubCredentialSecret>> {
		const cached = this.fresh(this.repoCache.get(repository) ?? null);
		if (cached !== null) return cached;
		const repositories = [repository];
		let minted = await this.exchange({ repositories, permissions: REPOSITORY_PERMISSIONS });
		if (!minted.ok && minted.error.status === 422) {
			minted = await this.exchange({ repositories, permissions: REPOSITORY_PERMISSIONS_FALLBACK });
		}
		if (minted.ok) this.repoCache.set(repository, toCached(minted.value));
		return minted;
	}

	private fresh(
		cached: CachedInstallationToken | null,
	): ForgeResult<GitHubCredentialSecret> | null {
		if (cached === null || this.now() >= cached.expiresAt - this.marginMs) return null;
		return { ok: true, value: { secret: cached.installationToken, expiresAt: cached.expiresAt } };
	}

	private async reMint(): Promise<ForgeResult<GitHubCredentialSecret>> {
		const minted = await this.exchange({});
		if (minted.ok) this.cached = toCached(minted.value);
		return minted;
	}

	/** Trade a fresh App JWT for an installation token. Caches nothing. */
	private async exchange(body: object): Promise<ForgeResult<GitHubCredentialSecret>> {
		let jwt: string;
		try {
			jwt = mintGitHubAppJwt({
				appId: this.options.appId,
				privateKey: this.options.privateKey,
				now: this.now,
			});
		} catch (cause) {
			return {
				ok: false,
				error: {
					kind: "no_credential",
					detail: `failed to sign the GitHub App JWT: ${cause instanceof Error ? cause.message : String(cause)}`,
				},
			};
		}
		const result = await requestGitHub({
			url: `${GITHUB_API_BASE}/app/installations/${encodeURIComponent(this.options.installationId)}/access_tokens`,
			method: "POST",
			token: jwt,
			userAgent: USER_AGENT,
			context: "POST /app/installations/:id/access_tokens",
			body,
			fetch: this.fetch,
		});
		if (!result.ok) return { ok: false, error: toForgeError(result.error) };
		const json = (await readJson(result.response)) as AccessTokenResponseJson | null;
		const expiresAtMs = typeof json?.expires_at === "string" ? Date.parse(json.expires_at) : NaN;
		if (typeof json?.token !== "string" || json.token === "" || !Number.isFinite(expiresAtMs)) {
			return {
				ok: false,
				error: {
					kind: "http_error",
					detail: "POST /app/installations/:id/access_tokens returned no usable token/expires_at",
				},
			};
		}
		return { ok: true, value: { secret: json.token, expiresAt: expiresAtMs } };
	}
}

function toCached(secret: GitHubCredentialSecret): CachedInstallationToken {
	return { installationToken: secret.secret, expiresAt: secret.expiresAt ?? 0 };
}
