/**
 * GitHub-specific errors for the read-only client (warren-33aa).
 *
 * Every error that can carry request context stores only *redacted* header
 * maps: an Authorization value never survives into an error message or its
 * JSON form. Rate-limit failures get their own class so callers can
 * distinguish a bounded wait (primary limit with a reset time) from an
 * abuse-detection backoff (secondary limit with Retry-After).
 */

import { CampaignControllerError, type CampaignControllerErrorCode } from "../errors.ts";

/** A GitHub REST call failed (non-2xx, or transport-level failure). */
export class GithubApiError extends CampaignControllerError {
	readonly status: number | null;
	readonly path: string;
	/** Request headers with the credential redacted. */
	readonly requestHeaders: Record<string, string>;

	constructor(
		message: string,
		options: {
			status?: number | null;
			path: string;
			requestHeaders?: Record<string, string>;
			cause?: unknown;
		},
	) {
		super("upstream_error", message, { cause: options.cause });
		this.name = "GithubApiError";
		this.status = options.status ?? null;
		this.path = options.path;
		this.requestHeaders = options.requestHeaders ?? {};
	}

	override toJson(): {
		error: string;
		code: CampaignControllerErrorCode;
		message: string;
		status: number | null;
		path: string;
	} {
		return {
			error: this.name,
			code: this.code,
			message: this.message,
			status: this.status,
			path: this.path,
		};
	}
}

/** Which kind of rate limit GitHub applied. */
export type GithubRateLimitKind = "primary" | "secondary";

/**
 * GitHub refused the read because of a rate limit (403/429 with
 * x-ratelimit-remaining: 0, or an abuse-detection Retry-After).
 */
export class GithubRateLimitError extends CampaignControllerError {
	readonly kind: GithubRateLimitKind;
	readonly limit: number | null;
	readonly remaining: number | null;
	readonly resetEpochSeconds: number | null;
	readonly retryAfterSeconds: number | null;
	readonly path: string;

	constructor(
		message: string,
		options: {
			kind: GithubRateLimitKind;
			path: string;
			limit?: number | null;
			remaining?: number | null;
			resetEpochSeconds?: number | null;
			retryAfterSeconds?: number | null;
		},
	) {
		super("rate_limited", message);
		this.name = "GithubRateLimitError";
		this.kind = options.kind;
		this.limit = options.limit ?? null;
		this.remaining = options.remaining ?? null;
		this.resetEpochSeconds = options.resetEpochSeconds ?? null;
		this.retryAfterSeconds = options.retryAfterSeconds ?? null;
		this.path = options.path;
	}

	/** Machine-readable shape for the CLI / journal. No secrets by construction. */
	override toJson(): {
		error: string;
		code: CampaignControllerErrorCode;
		message: string;
		kind: GithubRateLimitKind;
		limit: number | null;
		remaining: number | null;
		resetEpochSeconds: number | null;
		retryAfterSeconds: number | null;
		path: string;
	} {
		return {
			error: this.name,
			code: this.code,
			message: this.message,
			kind: this.kind,
			limit: this.limit,
			remaining: this.remaining,
			resetEpochSeconds: this.resetEpochSeconds,
			retryAfterSeconds: this.retryAfterSeconds,
			path: this.path,
		};
	}
}
