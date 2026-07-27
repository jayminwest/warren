/**
 * Signed-cookie auth for the preview reverse proxy (R-19 / SPEC §11.L,
 * warren-8a10; path-mode scope addendum warren-edff / pl-f4ea; per-run
 * name + `Path=/` revision warren-63e1).
 *
 * Bearer-in-header is impossible for a browser hitting a preview origin
 * directly — the cookie scope is the only way to keep a private-code
 * preview private. `createPreviewAuth(token, …)` derives an HMAC-SHA256
 * key from `WARREN_API_TOKEN` (label-scoped so a future preview-secret
 * rotation can be decoupled from the API token) and exposes two methods:
 *
 *   - `signCookie(runId, now)` — produces a `<runId>.<expiresMs>.<sig>`
 *     payload and a `Set-Cookie` header value scoped per the
 *     `CreatePreviewAuthOptions.scope` discriminator:
 *       - `subdomain`: cookie name is `warren_preview`, `Path=/; Domain=.<host>`
 *         so the same cookie is presented on every `run-*.<host>` subdomain.
 *       - `path`: cookie name is `warren_preview_<runId>` (per-run literal
 *         suffix), `Path=/`, no `Domain` (cookie stays host-only). The
 *         per-run name + `Path=/` is what makes referer-based asset
 *         routing (warren-63e1) work: the browser ships the cookie on
 *         every same-origin request (including `/_next/static/...` asset
 *         loads with a `/p/<id>/...` Referer), and the per-run name keeps
 *         sibling preview sessions isolated on the same browser
 *         (SPEC §11.L risk 4 mitigation). Earlier revisions scoped
 *         `Path=/p/<runId>/` but that blocked the cookie on the asset
 *         requests referer routing needs to authenticate.
 *     Both modes set `HttpOnly`, `Secure` (unless overridden), `SameSite=Lax`,
 *     and a `Max-Age` matching the embedded `expiresMs`.
 *
 *   - `verifyCookie(cookieHeader, runId, now)` — extracts the mode-scoped
 *     cookie (`warren_preview` in subdomain mode, `warren_preview_<runId>`
 *     in path mode) from a `Cookie:` header, verifies the HMAC in
 *     constant time, checks the runId matches and expiry hasn't elapsed.
 *     Returns true iff every check passes.
 *
 * No state lives in this module beyond the derived key. Cookies are
 * self-describing (runId + expiresMs inside the signed payload) so the
 * proxy preamble doesn't need a server-side session store — restart
 * survives, and a future multi-worker proxy share-nothing-but-secret.
 *
 * Cookie payload format: `v1.<runId>.<expiresMs>.<sigBase64Url>`.
 * Version prefix keeps the door open for a future schema change (e.g.
 * adding a user identity claim post-R-09) without invalidating live
 * sessions overnight.
 */

import { createHash, createHmac, timingSafeEqual } from "node:crypto";

/** Default cookie lifetime (24 hours). Matches the SPEC §11.L expectation
 *  that a reviewer's session covers an entire workday without re-login. */
export const DEFAULT_COOKIE_TTL_MS = 24 * 3_600_000;

export const COOKIE_NAME = "warren_preview";
export const COOKIE_VERSION = "v1";

/**
 * Path-mode cookie name. Concatenates `warren_preview_` with the runId
 * (warren-63e1) so each preview gets its own cookie addressed to a
 * distinct browser slot, independent of `Path` scope. The proxy preamble
 * picks the cookie by name once it has the runId from `/p/<id>/` or
 * from the `Referer` header.
 */
export function previewCookieName(runId: string, mode: "subdomain" | "path"): string {
	return mode === "path" ? `${COOKIE_NAME}_${runId}` : COOKIE_NAME;
}

/** Label mixed into the HMAC key derivation so a future rotation can be
 *  decoupled from `WARREN_API_TOKEN`. */
const KEY_DERIVATION_LABEL = "::preview-cookie-v1";

export interface PreviewAuth {
	/**
	 * Issue a signed cookie attesting access to `runId`. Returns a
	 * `Set-Cookie` header value plus the parsed envelope so handlers can
	 * surface diagnostics without re-parsing.
	 */
	signCookie(runId: string, now: Date, ttlMs?: number): SignedCookie;
	/**
	 * Verify a `Cookie:` header against `runId`. Returns true iff the
	 * `warren_preview` cookie is present, the HMAC matches in
	 * constant-time, the embedded runId matches, and the embedded
	 * expiry is in the future relative to `now`.
	 */
	verifyCookie(cookieHeader: string | null | undefined, runId: string, now: Date): boolean;
}

export interface SignedCookie {
	/** The cookie's name as emitted on the wire. In path mode this carries
	 *  the runId suffix (`warren_preview_<runId>`); subdomain mode keeps
	 *  the bare `warren_preview`. Tests that build a `Cookie:` header from
	 *  a `signCookie` result should read this rather than hard-coding
	 *  `COOKIE_NAME`. */
	readonly name: string;
	readonly value: string;
	readonly expiresAt: Date;
	readonly setCookieHeader: string;
}

/**
 * Cookie-scope discriminator (warren-edff / pl-f4ea step 5; per-run name
 * + `Path=/` revision warren-63e1).
 *
 *  - `subdomain` — cookie name `warren_preview`, `Path=/` with an optional
 *    `Domain=<cookieDomain>` so the browser presents the cookie across
 *    every `run-*.<host>` preview origin.
 *
 *  - `path` — cookie name `warren_preview_<runId>`, `Path=/` with no
 *    `Domain`. Per-run name keeps sibling preview sessions isolated on
 *    the same browser (SPEC §11.L risk 4 mitigation); `Path=/` ships the
 *    cookie on every same-origin request so referer-based asset routing
 *    in the proxy preamble can authenticate `/_next/static/...`-style
 *    sub-resource loads.
 */
export type PreviewCookieScope =
	| {
			readonly mode: "subdomain";
			/** `Domain=<value>` attribute. Null omits the attribute (host-only
			 *  cookie); rarely useful in production but lets tests avoid pinning
			 *  a specific domain. */
			readonly cookieDomain: string | null;
	  }
	| {
			readonly mode: "path";
	  };

/** Default scope when `CreatePreviewAuthOptions.scope` is omitted — host-only
 *  subdomain mode. Backwards-compatible with the original API. */
const DEFAULT_SCOPE: PreviewCookieScope = { mode: "subdomain", cookieDomain: null };

export interface CreatePreviewAuthOptions {
	/** Cookie scope (subdomain vs path). Defaults to host-only subdomain mode. */
	readonly scope?: PreviewCookieScope;
	/** Whether to emit the `Secure` attribute. Defaults to true; set false
	 *  only in tests against an http loopback. */
	readonly secure?: boolean;
}

/**
 * Build a `PreviewAuth` rooted in `token` (typically the WARREN_API_TOKEN).
 * The cookie HMAC key is `SHA-256(token || label)` — a label-scoped digest
 * so the same token can drive distinct keys for future signed-cookie
 * surfaces without collision.
 */
export function createPreviewAuth(token: string, opts: CreatePreviewAuthOptions = {}): PreviewAuth {
	if (token.length === 0) {
		throw new Error("createPreviewAuth: token must be a non-empty string");
	}
	const scope = opts.scope ?? DEFAULT_SCOPE;
	const secure = opts.secure ?? true;
	const cookieKey = deriveCookieKey(new TextEncoder().encode(token));

	return {
		signCookie(runId: string, now: Date, ttlMs: number = DEFAULT_COOKIE_TTL_MS): SignedCookie {
			if (runId.length === 0) {
				throw new Error("signCookie: runId must be non-empty");
			}
			if (!Number.isFinite(ttlMs) || ttlMs <= 0) {
				throw new Error("signCookie: ttlMs must be a positive number");
			}
			const expiresMs = now.getTime() + ttlMs;
			const payload = `${COOKIE_VERSION}.${runId}.${expiresMs}`;
			const sig = sign(cookieKey, payload);
			const value = `${payload}.${sig}`;
			const maxAgeSec = Math.max(1, Math.floor(ttlMs / 1_000));
			const name = previewCookieName(runId, scope.mode);
			const attrs: string[] = [`${name}=${value}`, "Path=/"];
			if (scope.mode === "subdomain" && scope.cookieDomain !== null) {
				attrs.push(`Domain=${scope.cookieDomain}`);
			}
			attrs.push(`Max-Age=${maxAgeSec}`, "HttpOnly", "SameSite=Lax");
			if (secure) attrs.push("Secure");
			return {
				name,
				value,
				expiresAt: new Date(expiresMs),
				setCookieHeader: attrs.join("; "),
			};
		},

		verifyCookie(cookieHeader: string | null | undefined, runId: string, now: Date): boolean {
			if (cookieHeader === null || cookieHeader === undefined || cookieHeader.length === 0) {
				return false;
			}
			const raw = extractCookieValue(cookieHeader, previewCookieName(runId, scope.mode));
			if (raw === null) return false;
			const parts = raw.split(".");
			if (parts.length !== 4) return false;
			const [version, cookieRunId, expiresRaw, sigB64] = parts as [string, string, string, string];
			if (version !== COOKIE_VERSION) return false;
			if (cookieRunId !== runId) return false;
			const expiresMs = Number.parseInt(expiresRaw, 10);
			if (!Number.isFinite(expiresMs) || String(expiresMs) !== expiresRaw) return false;
			if (expiresMs <= now.getTime()) return false;
			const expected = sign(cookieKey, `${version}.${cookieRunId}.${expiresRaw}`);
			return constantTimeEqualStringB64(sigB64, expected);
		},
	};
}

/**
 * Extract a cookie value by name from a `Cookie:` header. Tolerates
 * leading whitespace and the `=` ambiguity in cookie names with no
 * value. Returns null when the cookie is absent.
 */
export function extractCookieValue(header: string, name: string): string | null {
	for (const part of header.split(";")) {
		const trimmed = part.trim();
		if (trimmed.length === 0) continue;
		const eq = trimmed.indexOf("=");
		if (eq === -1) continue;
		const key = trimmed.slice(0, eq);
		if (key === name) return trimmed.slice(eq + 1);
	}
	return null;
}

function sign(key: Uint8Array, payload: string): string {
	const hmac = createHmac("sha256", key);
	hmac.update(payload);
	return base64Url(hmac.digest());
}

function deriveCookieKey(tokenBytes: Uint8Array): Uint8Array {
	const hash = createHash("sha256");
	hash.update(tokenBytes);
	hash.update(KEY_DERIVATION_LABEL);
	return new Uint8Array(hash.digest());
}

function base64Url(buf: Buffer): string {
	return buf.toString("base64").replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

function constantTimeEqualBytes(a: Uint8Array, b: Uint8Array): boolean {
	if (a.length !== b.length) return false;
	return timingSafeEqual(a, b);
}

function constantTimeEqualStringB64(a: string, b: string): boolean {
	const aBytes = new TextEncoder().encode(a);
	const bBytes = new TextEncoder().encode(b);
	return constantTimeEqualBytes(aBytes, bBytes);
}
