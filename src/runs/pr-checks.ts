/**
 * `src/runs/pr-checks.ts` — the PR merge-check / URL-parse group split out of
 * `src/runs/pr.ts` (warren-db9a / pl-88bb step 1) to keep both files under
 * the per-file line budget. Houses `checkPullRequestMerged`,
 * `parsePullRequestUrl`, and the shared GitHub REST helpers
 * (`buildHeaders`/`readJson`/`readText`/`truncate`) that both this module
 * and `pr.ts` use. `pr.ts` re-exports the public symbols so existing
 * `../runs/pr.ts` import paths keep resolving.
 */

export const GITHUB_API_BASE = "https://api.github.com";
const USER_AGENT = "warren-reap-pr-open";

/**
 * Acceptance test seam (warren-ae00 / scenario 26). When
 * `WARREN_GH_FETCH_OVERRIDE` is set, every GitHub REST call short-circuits
 * to a canned positive response — `openPullRequest` returns a synthetic
 * `pull/1` URL and `checkPullRequestMerged` returns `merged` immediately.
 * Lets the in-proc plan-run roundtrip exercise reap's PR open + the
 * coordinator's pr_open → merged transition without standing up a real
 * GitHub fixture. Unset in production deployments.
 */
export const GH_FETCH_OVERRIDE_ENV = "WARREN_GH_FETCH_OVERRIDE";

export function readGhFetchOverride(): "merged" | null {
	const v = process.env[GH_FETCH_OVERRIDE_ENV];
	if (typeof v !== "string") return null;
	return v.trim() === "merged" ? "merged" : null;
}

export function buildHeaders(token: string): Record<string, string> {
	return {
		accept: "application/vnd.github+json",
		authorization: `Bearer ${token}`,
		"content-type": "application/json",
		"user-agent": USER_AGENT,
		"x-github-api-version": "2022-11-28",
	};
}

export async function readJson(res: Response): Promise<unknown> {
	try {
		return await res.json();
	} catch {
		return null;
	}
}

export async function readText(res: Response): Promise<string> {
	try {
		return await res.text();
	} catch {
		return "";
	}
}

export function truncate(input: string, max: number): string {
	return input.length <= max ? input : `${input.slice(0, max)}…`;
}

/**
 * Parse a `Retry-After` header value into milliseconds. Only the
 * delta-seconds form is honored (the HTTP-date form would need a clock);
 * absent or unparseable values return `null` so the caller falls back to
 * its own delay.
 */
export function parseRetryAfterMs(header: string | null): number | null {
	if (header === null) return null;
	const seconds = Number.parseInt(header.trim(), 10);
	if (!Number.isFinite(seconds) || seconds < 0 || String(seconds) !== header.trim()) return null;
	return seconds * 1000;
}

/* ----------------------------------------------------------------------- */
/* PR-merge polling                                                         */
/* ----------------------------------------------------------------------- */

/**
 * `checkPullRequestMerged` — poll a GitHub PR's merge state for the PlanRun
 * coordinator (warren-9e4c). Pure helper: the caller decides what each
 * non-merged shape means (`open` = wait, `closed_unmerged` = fail the plan).
 *
 * Mirrors `openPullRequest`'s posture: direct REST call against
 * `GET /repos/:owner/:repo/pulls/:number`, `Authorization: Bearer <token>`
 * from `GITHUB_TOKEN`, fetch injected as a seam.
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

	const fetchImpl = input.fetch ?? globalThis.fetch;
	const url = `${GITHUB_API_BASE}/repos/${input.owner}/${input.repo}/pulls/${input.number}`;

	let res: Response;
	try {
		res = await fetchImpl(url, { method: "GET", headers: buildHeaders(input.token) });
	} catch (err) {
		return {
			kind: "http_error",
			status: 0,
			message: err instanceof Error ? err.message : String(err),
		};
	}

	if (res.status === 429) {
		// warren-9bbc: rate limiting is its own retryable class, not a generic
		// `http_error`. The poller (src/plan-runs/pr-merge.ts) retries it and
		// honors `Retry-After` when GitHub sends one; lumping it into the 4xx
		// bucket made a transient throttle indistinguishable from a dead PR.
		const text = await readText(res);
		return {
			kind: "rate_limited",
			retryAfterMs: parseRetryAfterMs(res.headers.get("retry-after")),
			message: `GET /pulls/${input.number} returned 429 (rate limited): ${truncate(text, 500)}`,
		};
	}

	if (res.status !== 200) {
		const text = await readText(res);
		return {
			kind: "http_error",
			status: res.status,
			message: `GET /pulls/${input.number} returned ${res.status}: ${truncate(text, 500)}`,
		};
	}

	const body = (await readJson(res)) as { merged_at?: unknown; state?: unknown } | null;
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
