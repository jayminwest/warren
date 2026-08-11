/**
 * GitHub REST transport — error classifier.
 *
 * One taxonomy for every GitHub HTTP failure (plan pl-d1c9 step 1,
 * docs/design/forge-contract.md §6.4). The three pre-consolidation
 * copies disagreed on the same `GET /pulls/:n` endpoint: one classified
 * 429, one did not, one handled nothing. Every call site now gets the
 * full classification.
 *
 * Kind vocabulary mirrors the seam-level `ForgeErrorKind` the Forge
 * contract will define in phase 2 (§2); keeping the transport vocabulary
 * aligned now means phase 2's mapping is a rename, not a re-derivation.
 */

/** Discriminator for a classified GitHub transport failure. */
export type GitHubErrorKind =
	/** fetch threw or returned no HTTP response (status 0). */
	| "network"
	/** 401 — expired or wrong credential. */
	| "unauthorized"
	/** 403 that is not a rate limit. */
	| "forbidden"
	/** 404/410 — the resource is gone. */
	| "not_found"
	/** 409/422 — the request conflicted with server state. */
	| "conflict"
	/** 429, or a 403 carrying rate-limit semantics. */
	| "rate_limited"
	/** Any other non-2xx status. */
	| "http_error";

export interface GitHubHttpError {
	readonly kind: GitHubErrorKind;
	/** Transport status; 0 when fetch threw before any response arrived. */
	readonly status: number;
	/** Parsed `Retry-After` hint in ms, when GitHub sent one (rate_limited only). */
	readonly retryAfterMs: number | null;
	/** Human-readable detail; body text already truncated by the caller. */
	readonly message: string;
}

/**
 * Parse a `Retry-After` header value into milliseconds. Only the
 * delta-seconds form is honored (the HTTP-date form would need a clock);
 * absent or unparseable values return `null` so the caller falls back to
 * its own delay. Promoted from `src/runs/pr-checks.ts`, the only one of
 * the four clients that carried it.
 */
export function parseRetryAfterMs(header: string | null): number | null {
	if (header === null) return null;
	const seconds = Number.parseInt(header.trim(), 10);
	if (!Number.isFinite(seconds) || seconds < 0 || String(seconds) !== header.trim()) return null;
	return seconds * 1000;
}

/**
 * True when a 403 response is actually a rate limit rather than a real
 * permissions failure. GitHub signals this via `Retry-After` (secondary
 * limits) or `X-RateLimit-Remaining: 0` (primary limits).
 */
export function isRateLimitedForbidden(headers: Headers): boolean {
	if (headers.get("retry-after") !== null) return true;
	return headers.get("x-ratelimit-remaining") === "0";
}

/**
 * Classify a non-2xx GitHub response. `context` is a short call-site
 * label (e.g. `GET /pulls/7`) folded into the message; `bodyText` should
 * already be truncated by the caller.
 */
export function classifyGitHubHttpError(
	status: number,
	headers: Headers,
	bodyText: string,
	context: string,
): GitHubHttpError {
	const message = `${context} returned ${status}: ${bodyText}`;
	if (status === 429 || (status === 403 && isRateLimitedForbidden(headers))) {
		return {
			kind: "rate_limited",
			status,
			retryAfterMs: parseRetryAfterMs(headers.get("retry-after")),
			message,
		};
	}
	if (status === 401) {
		return { kind: "unauthorized", status, retryAfterMs: null, message };
	}
	if (status === 403) {
		return { kind: "forbidden", status, retryAfterMs: null, message };
	}
	if (status === 404 || status === 410) {
		return { kind: "not_found", status, retryAfterMs: null, message };
	}
	if (status === 409 || status === 422) {
		return { kind: "conflict", status, retryAfterMs: null, message };
	}
	return { kind: "http_error", status, retryAfterMs: null, message };
}

/** Wrap a thrown fetch error as a `network`-kind transport error. */
export function networkError(err: unknown, context: string): GitHubHttpError {
	return {
		kind: "network",
		status: 0,
		retryAfterMs: null,
		message: `${context} failed: ${err instanceof Error ? err.message : String(err)}`,
	};
}
