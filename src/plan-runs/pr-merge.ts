/**
 * Retry-aware wrapper around `checkPullRequestMerged` (src/runs/pr.ts,
 * warren-9e4c). The coordinator (warren-2623) calls this every tick for
 * each child whose state is `pr_open`; transient GitHub 5xx or network
 * blips must not flip the plan to `failed`.
 *
 * Retry policy:
 *   - `http_error` with status 0 (fetch threw) OR status 5xx → retry up
 *     to `maxRetries` times with a short fixed delay.
 *   - `http_error` with status 4xx → return immediately (not retried).
 *     The coordinator treats only 404/410 as a fatal "PR is gone" signal
 *     (warren-eccd); 401/403/429 fall through to keep-waiting, bounded
 *     by the merge-wait budget (warren-3937).
 *   - any other shape (`merged`, `open`, `closed_unmerged`,
 *     `missing_token`) returns immediately.
 *
 * `parsePullRequestUrl` rejections (GHE-hosted shapes, malformed URLs)
 * surface as a synthetic `{kind:'http_error', status:0,
 * message:'unparseable...'}` so the coordinator treats them as
 * "cannot verify merge" (waiting) rather than "merged".
 */

import {
	type CheckPrMergedResult,
	checkPullRequestMerged,
	parsePullRequestUrl,
} from "../runs/pr.ts";

export type PrMergeChecker = (prUrl: string) => Promise<CheckPrMergedResult>;

export interface CreatePrMergeCheckerInput {
	readonly token: string;
	readonly fetch?: typeof fetch;
	/** Default 2 retries (3 total attempts). */
	readonly maxRetries?: number;
	/** Default 500ms between retries. Tests set this to 0. */
	readonly retryDelayMs?: number;
	/** Test seam to inject the underlying helper. */
	readonly check?: typeof checkPullRequestMerged;
	/** Test seam for the delay. */
	readonly sleep?: (ms: number) => Promise<void>;
}

const DEFAULT_MAX_RETRIES = 2;
const DEFAULT_RETRY_DELAY_MS = 500;

export function createPrMergeChecker(input: CreatePrMergeCheckerInput): PrMergeChecker {
	const check = input.check ?? checkPullRequestMerged;
	const sleep = input.sleep ?? defaultSleep;
	const maxRetries = input.maxRetries ?? DEFAULT_MAX_RETRIES;
	const retryDelayMs = input.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;

	return async function poll(prUrl: string): Promise<CheckPrMergedResult> {
		const parsed = parsePullRequestUrl(prUrl);
		if (parsed === null) {
			return {
				kind: "http_error",
				status: 0,
				message: `unparseable pull request url: ${prUrl}`,
			};
		}

		let last: CheckPrMergedResult | null = null;
		for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
			const result = await check({
				owner: parsed.owner,
				repo: parsed.repo,
				number: parsed.number,
				token: input.token,
				...(input.fetch !== undefined ? { fetch: input.fetch } : {}),
			});
			last = result;
			if (!isTransient(result)) return result;
			if (attempt < maxRetries && retryDelayMs > 0) {
				await sleep(retryDelayMs);
			}
		}
		return last ?? { kind: "http_error", status: 0, message: "no result" };
	};
}

function isTransient(result: CheckPrMergedResult): boolean {
	if (result.kind !== "http_error") return false;
	if (result.status === 0) return true;
	return result.status >= 500;
}

function defaultSleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}
