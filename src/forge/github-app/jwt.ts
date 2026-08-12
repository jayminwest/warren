/**
 * GitHub App RS256 JWT mint (forge-contract.md §4 — the App provider signs
 * a JWT from the deployment's private key to authenticate as the App
 * itself, then trades it for an installation token).
 *
 * Uses `node:crypto` only — no JWT dependency. The token shape is the one
 * GitHub documents for App authentication: RS256, `iat` backdated 60s to
 * absorb clock skew, `exp` 10 minutes out (GitHub's documented maximum),
 * `iss` set to the App id.
 *
 * The private key is parsed ONCE at provider construction
 * (`parseGitHubAppPrivateKey`), so a malformed PEM fails at boot rather
 * than on the first minted credential. `mintGitHubAppJwt` itself may still
 * throw from `node:crypto` (e.g. a non-RSA key); the callers wrap that
 * into a seam-level `ForgeResult`.
 */

import { createPrivateKey, createSign, type KeyObject } from "node:crypto";

/** JWT lifetime: GitHub's documented maximum for App JWTs is 10 minutes. */
export const GITHUB_APP_JWT_TTL_SECONDS = 600;

/** `iat` is backdated to tolerate clock skew between warren and GitHub. */
export const GITHUB_APP_JWT_IAT_BACKDATE_SECONDS = 60;

export interface GitHubAppJwtInput {
	/** The App id (GitHub's `iss` claim). */
	readonly appId: string;
	/** Pre-parsed private key (see `parseGitHubAppPrivateKey`). */
	readonly privateKey: KeyObject;
	/** Clock seam for tests; epoch ms. Defaults to `Date.now`. */
	readonly now?: () => number;
}

/**
 * Env-injected PEMs routinely arrive with literal `\n` sequences (the
 * common secret-store encoding); unfold them before parsing.
 */
export function normalizePrivateKeyPem(raw: string): string {
	return raw.replace(/\\n/g, "\n");
}

/**
 * Parse the App's PEM private key into a `KeyObject`. THROWS on malformed
 * input — call at boot (provider construction) so a bad key fails loudly,
 * per the §4 "misconfigured short-lived backend fails loud" rule.
 */
export function parseGitHubAppPrivateKey(rawPem: string): KeyObject {
	return createPrivateKey({ key: normalizePrivateKeyPem(rawPem), format: "pem" });
}

/**
 * Mint one RS256 App JWT. Throws only when `node:crypto` cannot sign with
 * the key (e.g. a non-RSA key) — callers wrap that into a `ForgeResult`
 * rather than letting it cross the seam.
 */
export function mintGitHubAppJwt(input: GitHubAppJwtInput): string {
	const nowSec = Math.floor((input.now?.() ?? Date.now()) / 1000);
	const header = base64urlJson({ alg: "RS256", typ: "JWT" });
	const payload = base64urlJson({
		iat: nowSec - GITHUB_APP_JWT_IAT_BACKDATE_SECONDS,
		exp: nowSec + GITHUB_APP_JWT_TTL_SECONDS,
		iss: input.appId,
	});
	const signer = createSign("RSA-SHA256");
	signer.update(`${header}.${payload}`);
	signer.end();
	const signature = signer.sign(input.privateKey).toString("base64url");
	return `${header}.${payload}.${signature}`;
}

function base64urlJson(value: unknown): string {
	return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}
