/**
 * GitHub REST transport — the one retry policy.
 *
 * Plan pl-d1c9 step 1, docs/design/forge-contract.md §6.5. The four
 * pre-consolidation policies disagreed in *direction*:
 * `src/plan-runs/pr-merge.ts` retried network/0/5xx/429 and treated 4xx
 * as fatal, while `src/runs/reap/pr-open.ts` retried any http_error
 * (including 4xx) but never network errors.
 *
 * DECISION: this module adopts the pr-merge direction — network errors,
 * 5xx, and 429 are transient and retried; other 4xx are fatal and return
 * immediately. Rationale: §3 assigns semantic retry to the domain and
 * transport retry to the forge, and retrying a 4xx inside transport hides
 * exactly the expired-credential 401/403 signal the credential campaign
 * (§4) needs to surface loudly. The one nuance worth preserving from the
 * pr-open side — a 422 whose body matches a known-permanent shape — is a
 * *domain* concern (it requires reading meaning into the body) and stays
 * with the caller via the returned error, not in this policy.
 *
 * Delays default to pr-merge's short fixed 500ms with a `Retry-After`
 * override capped at 60s, since the primary transient caller is a
 * tick-driven poller whose outer budget is the real bound. Callers tune
 * via `GitHubRetryOptions` (pr-open's 1s/2s/4s ladder can be expressed
 * as `delayMs` + linear attempts when it migrates in plan step 4).
 */

import type { GitHubHttpError } from "./errors.ts";

export interface GitHubRetryOptions {
	/** Retries after the initial attempt (default 2 → 3 total attempts). */
	readonly maxRetries?: number;
	/** Fixed delay between attempts in ms (default 500). */
	readonly delayMs?: number;
	/** Test seam for the delay. */
	readonly sleep?: (ms: number) => Promise<void>;
}

const DEFAULT_MAX_RETRIES = 2;
const DEFAULT_RETRY_DELAY_MS = 500;

/**
 * A `Retry-After` hint above this is treated as broken, not patient —
 * carried over from pr-merge, where the poller's tick and the caller's
 * outer budget are the real bound.
 */
export const MAX_RETRY_AFTER_MS = 60_000;

/** True when the failure is worth a transport-level retry. */
export function isTransientGitHubError(error: GitHubHttpError): boolean {
	if (error.kind === "rate_limited") return true;
	if (error.kind === "network") return true;
	return error.status >= 500;
}

/** Delay before the next attempt: the `Retry-After` hint when present and sane. */
export function retryDelayFor(error: GitHubHttpError, fallbackMs: number): number {
	if (error.kind !== "rate_limited" || error.retryAfterMs === null) return fallbackMs;
	return Math.min(error.retryAfterMs, MAX_RETRY_AFTER_MS);
}

/**
 * Run `attempt` up to `maxRetries + 1` times, retrying transient
 * failures. `attempt` returns the classified error instead of throwing,
 * so the policy composes with the result-union convention the callers
 * already use.
 */
export async function withGitHubRetry<T>(
	attempt: () => Promise<{ ok: true; value: T } | { ok: false; error: GitHubHttpError }>,
	options: GitHubRetryOptions = {},
): Promise<{ ok: true; value: T } | { ok: false; error: GitHubHttpError }> {
	const maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
	const delayMs = options.delayMs ?? DEFAULT_RETRY_DELAY_MS;
	const sleep = options.sleep ?? defaultSleep;

	let last: GitHubHttpError | null = null;
	for (let i = 0; i <= maxRetries; i += 1) {
		const result = await attempt();
		if (result.ok) return result;
		last = result.error;
		if (!isTransientGitHubError(last)) return { ok: false, error: last };
		const waitMs = retryDelayFor(last, delayMs);
		if (i < maxRetries && waitMs > 0) {
			await sleep(waitMs);
		}
	}
	return {
		ok: false,
		error: last ?? { kind: "network", status: 0, retryAfterMs: null, message: "no result" },
	};
}

function defaultSleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}
