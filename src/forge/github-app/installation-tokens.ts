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
 * never logged. Per §4 the mint is NOT down-scoped to a repository — the
 * single installation id already bounds the blast radius.
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
		const cached = this.cached;
		if (cached !== null && this.now() < cached.expiresAt - this.marginMs) {
			return { ok: true, value: { secret: cached.installationToken, expiresAt: cached.expiresAt } };
		}
		return this.reMint();
	}

	private async reMint(): Promise<ForgeResult<GitHubCredentialSecret>> {
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
			body: {},
			fetch: this.fetch,
		});
		if (!result.ok) return { ok: false, error: toForgeError(result.error) };
		const body = (await readJson(result.response)) as AccessTokenResponseJson | null;
		const expiresAtMs = typeof body?.expires_at === "string" ? Date.parse(body.expires_at) : NaN;
		if (typeof body?.token !== "string" || body.token === "" || !Number.isFinite(expiresAtMs)) {
			return {
				ok: false,
				error: {
					kind: "http_error",
					detail: "POST /app/installations/:id/access_tokens returned no usable token/expires_at",
				},
			};
		}
		this.cached = { installationToken: body.token, expiresAt: expiresAtMs };
		return { ok: true, value: { secret: body.token, expiresAt: expiresAtMs } };
	}
}
