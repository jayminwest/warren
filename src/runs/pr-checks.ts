/**
 * `src/runs/pr-checks.ts` — the PR merge-check / URL-parse group split out of
 * `src/runs/pr.ts` (warren-db9a / pl-88bb step 1) to keep both files under
 * the per-file line budget. Houses `checkPullRequestMerged` and
 * `parsePullRequestUrl`. `pr.ts` re-exports the public symbols so existing
 * `../runs/pr.ts` import paths keep resolving.
 *
 * Transport lives in `src/forge/github/` (plan pl-d1c9 step 2, warren-51ae):
 * headers, readers, the error classifier (including the `Retry-After`
 * parser this module used to own), and the retry policy all come from the
 * consolidated core. This file holds only the domain meaning of the
 * responses (forge-contract.md §3).
 */

import { parseRetryAfterMs } from "../forge/github/errors.ts";
import { GITHUB_API_BASE } from "../forge/github/headers.ts";
import { requestGitHub } from "../forge/github/http.ts";
import { GH_FETCH_OVERRIDE_ENV, readGhFetchOverride } from "../forge/github/override.ts";
import { readJson } from "../forge/github/readers.ts";

// warren-45e6: the acceptance-seam reader moved into the forge's GitHub
// transport (`src/forge/github/override.ts`) so `GitHubForge` can honor it
// without importing domain code. Re-exported here for the pre-migration
// consumers that still import it from this module.
export { GH_FETCH_OVERRIDE_ENV, parseRetryAfterMs, readGhFetchOverride };

const USER_AGENT = "warren-reap-pr-open";

/* ----------------------------------------------------------------------- */
/* PR-merge polling                                                         */
/* ----------------------------------------------------------------------- */

/**
 * `checkPullRequestMerged` — poll a GitHub PR's merge state for the PlanRun
 * coordinator (warren-9e4c). Pure helper: the caller decides what each
 * non-merged shape means (`open` = wait, `closed_unmerged` = fail the plan).
 *
 * Transport is `requestGitHub` (plan pl-d1c9 step 2). Retry stays OFF here
 * on purpose: the caller (`src/plan-runs/pr-merge.ts`) is a tick-driven
 * poller that is already this call site's retry — it backs off and honors
 * `Retry-After` per forge-contract.md §6.5 ("the poller's tick and the
 * caller's outer budget are the real bound"). Stacking the transport
 * policy's in-band sleeps on top would double-wait every throttle.
 */
export interface CheckPullRequestMergedInput {
	readonly owner: string;
	readonly repo: string;
	readonly number: number;
	readonly token: string;
	readonly fetch?: typeof fetch;
}

export type CheckPrMergedResult =
	| { readonly kind: "merged"; readonly mergedAt: string }
	| { readonly kind: "open" }
	| { readonly kind: "closed_unmerged" }
	| { readonly kind: "missing_token"; readonly message: string }
	| {
			readonly kind: "rate_limited";
			/** Parsed `Retry-After` seconds as ms, when GitHub sent the header. */
			readonly retryAfterMs: number | null;
			readonly message: string;
	  }
	| { readonly kind: "http_error"; readonly status: number; readonly message: string };

export async function checkPullRequestMerged(
	input: CheckPullRequestMergedInput,
): Promise<CheckPrMergedResult> {
	if (readGhFetchOverride() === "merged") {
		return { kind: "merged", mergedAt: new Date().toISOString() };
	}
	if (input.token === "") {
		return {
			kind: "missing_token",
			message: "GITHUB_TOKEN unset; cannot check pull request merge state",
		};
	}

	const result = await requestGitHub({
		url: `${GITHUB_API_BASE}/repos/${input.owner}/${input.repo}/pulls/${input.number}`,
		method: "GET",
		token: input.token,
		userAgent: USER_AGENT,
		context: `GET /pulls/${input.number}`,
		...(input.fetch !== undefined ? { fetch: input.fetch } : {}),
		retry: { maxRetries: 0 },
	});

	if (!result.ok) {
		const error = result.error;
		if (error.kind === "rate_limited") {
			// warren-9bbc: rate limiting is its own retryable class, not a
			// generic `http_error`. The poller (src/plan-runs/pr-merge.ts)
			// retries it and honors `Retry-After`; lumping it into the 4xx
			// bucket made a transient throttle indistinguishable from a dead PR.
			return {
				kind: "rate_limited",
				retryAfterMs: error.retryAfterMs,
				message: error.message,
			};
		}
		return { kind: "http_error", status: error.status, message: error.message };
	}

	const body = (await readJson(result.response)) as {
		merged_at?: unknown;
		state?: unknown;
	} | null;
	const mergedAt = typeof body?.merged_at === "string" ? body.merged_at : null;
	if (mergedAt !== null) {
		return { kind: "merged", mergedAt };
	}
	const state = typeof body?.state === "string" ? body.state : "";
	if (state === "closed") {
		return { kind: "closed_unmerged" };
	}
	return { kind: "open" };
}

/**
 * `parsePullRequestUrl` — regex-parse `https://github.com/<owner>/<repo>/pull/<n>`.
 * Returns `null` on mismatch (e.g. GHE-hosted shapes) so the coordinator
 * treats them as "cannot verify merge" rather than "merged".
 *
 * Grammar note (plan pl-d1c9 step 2): this regex is one of the five URL
 * grammars catalogued in forge-contract.md §6.3. It is preserved verbatim
 * here — unification with the other grammars is a later plan step.
 */
export const PR_URL_RE = /^https:\/\/github\.com\/([^/\s]+)\/([^/\s]+)\/pull\/(\d+)(?:[/?#].*)?$/;

export function parsePullRequestUrl(
	prUrl: string,
): { owner: string; repo: string; number: number } | null {
	const m = PR_URL_RE.exec(prUrl.trim());
	if (m === null) return null;
	const [, owner, repo, num] = m;
	if (owner === undefined || repo === undefined || num === undefined) return null;
	const n = Number.parseInt(num, 10);
	if (!Number.isFinite(n) || n <= 0) return null;
	return { owner, repo, number: n };
}
