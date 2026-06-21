/**
 * `src/runs/pr-checks.ts` — the PR-merge / URL-parse group split out of
 * `src/runs/pr.ts` (warren-db9a / pl-88bb step 1) to keep both files under
 * the per-file line budget. Houses `checkPullRequestMerged`,
 * `mergePullRequest`, `parsePullRequestUrl`, `parsePullRequestRef`,
 * `isRateLimited`, and the shared GitHub REST helpers
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

/**
 * `parsePullRequestRef` — accept either a full GitHub PR URL
 * (`https://github.com/<owner>/<repo>/pull/<n>`) or the conventional
 * shorthand `<owner>/<repo>#<n>` shape that Plot `gh_pr` attachments
 * use (see `refPlaceholder('gh_pr')` in src/ui/src/pages/PlotDetail.tsx).
 * Returns `null` on mismatch so the merge handler treats it as
 * "cannot resolve" rather than "merged" (warren-8e39 / pl-0344 step 14).
 */
export const PR_SHORT_RE = /^([^/\s]+)\/([^/\s#]+)#(\d+)$/;

export function parsePullRequestRef(
	ref: string,
): { owner: string; repo: string; number: number } | null {
	const trimmed = ref.trim();
	const viaUrl = parsePullRequestUrl(trimmed);
	if (viaUrl !== null) return viaUrl;
	const m = PR_SHORT_RE.exec(trimmed);
	if (m === null) return null;
	const [, owner, repo, num] = m;
	if (owner === undefined || repo === undefined || num === undefined) return null;
	const n = Number.parseInt(num, 10);
	if (!Number.isFinite(n) || n <= 0) return null;
	return { owner, repo, number: n };
}

/* ----------------------------------------------------------------------- */
/* PR merge (warren-8e39 / pl-0344 step 14)                                 */
/* ----------------------------------------------------------------------- */

/**
 * `mergePullRequest` — click-to-merge a GitHub PR attached to a Plot
 * (warren-8e39 / pl-0344 step 14). Mirrors `openPullRequest`'s posture:
 * direct `PUT /repos/:owner/:repo/pulls/:number/merge`, fetch injected
 * as a seam, `GITHUB_TOKEN` auth.
 *
 * The result variants are tuned for what the PlotDetail merge UI cares
 * about:
 *   - `merged`            — 200 with `merged: true`. Caller schedules
 *                            a follow-up `refreshProjectClone` so the
 *                            local clone picks up the new merge commit.
 *   - `already_merged`    — 405/409 with "already merged" body. Same
 *                            net effect as `merged`; caller still
 *                            schedules the refresh (idempotent).
 *   - `not_mergeable`     — 405 (conflict / required reviews missing /
 *                            checks failing) or 409 (base SHA mismatch).
 *   - `missing_token`     — `GITHUB_TOKEN` unset on the server.
 *   - `rate_limited`      — 403 with `x-ratelimit-remaining: 0` or 429.
 *                            Surfaces the reset timestamp so the UI can
 *                            show a countdown.
 *   - `not_found`         — 404 (wrong owner/repo/number).
 *   - `network`           — fetch threw / non-HTTP failure.
 *   - `http_error`        — anything else (5xx etc.).
 */
export interface MergePullRequestInput {
	readonly owner: string;
	readonly repo: string;
	readonly number: number;
	readonly token: string;
	/** Optional commit message override; GitHub defaults are fine for most cases. */
	readonly commitMessage?: string;
	/** Merge method. Defaults to `merge` (matches GitHub's UI default). */
	readonly mergeMethod?: "merge" | "squash" | "rebase";
	readonly fetch?: typeof fetch;
}

export type MergePullRequestResult =
	| { readonly kind: "merged"; readonly sha: string }
	| { readonly kind: "already_merged" }
	| { readonly kind: "not_mergeable"; readonly message: string }
	| { readonly kind: "not_found"; readonly message: string }
	| { readonly kind: "missing_token"; readonly message: string }
	| {
			readonly kind: "rate_limited";
			readonly message: string;
			readonly resetAt: string | null;
	  }
	| { readonly kind: "network"; readonly message: string }
	| { readonly kind: "http_error"; readonly status: number; readonly message: string };

export async function mergePullRequest(
	input: MergePullRequestInput,
): Promise<MergePullRequestResult> {
	if (readGhFetchOverride() === "merged") {
		return { kind: "merged", sha: "0".repeat(40) };
	}
	if (input.token === "") {
		return {
			kind: "missing_token",
			message: "GITHUB_TOKEN unset; cannot merge pull request",
		};
	}

	const fetchImpl = input.fetch ?? globalThis.fetch;
	const url = `${GITHUB_API_BASE}/repos/${input.owner}/${input.repo}/pulls/${input.number}/merge`;
	const body: Record<string, string> = {
		merge_method: input.mergeMethod ?? "merge",
	};
	if (input.commitMessage !== undefined) {
		body.commit_message = input.commitMessage;
	}

	let res: Response;
	try {
		res = await fetchImpl(url, {
			method: "PUT",
			headers: buildHeaders(input.token),
			body: JSON.stringify(body),
		});
	} catch (err) {
		return {
			kind: "network",
			message: err instanceof Error ? err.message : String(err),
		};
	}

	if (res.status === 200) {
		const payload = (await readJson(res)) as {
			merged?: unknown;
			sha?: unknown;
			message?: unknown;
		} | null;
		const merged = payload?.merged === true;
		const sha = typeof payload?.sha === "string" ? payload.sha : "";
		if (merged) {
			return { kind: "merged", sha };
		}
		const message = typeof payload?.message === "string" ? payload.message : "PR not merged";
		return { kind: "not_mergeable", message };
	}

	// Rate limit: GitHub surfaces 403 with x-ratelimit-remaining: 0, or 429.
	if (res.status === 429 || (res.status === 403 && isRateLimited(res))) {
		const reset = res.headers.get("x-ratelimit-reset");
		const resetAt =
			reset !== null && /^\d+$/.test(reset)
				? new Date(Number.parseInt(reset, 10) * 1000).toISOString()
				: null;
		const text = await readText(res);
		return {
			kind: "rate_limited",
			message: truncate(text, 500),
			resetAt,
		};
	}

	if (res.status === 404) {
		const text = await readText(res);
		return { kind: "not_found", message: truncate(text, 500) };
	}

	// 405 "Method Not Allowed" with `message: "Pull Request is not mergeable"`
	// is the standard "can't merge right now" shape. 409 is base SHA mismatch.
	// Both also cover "already merged" — distinguish via the body message.
	if (res.status === 405 || res.status === 409) {
		const payload = (await readJson(res)) as { message?: unknown } | null;
		const message =
			typeof payload?.message === "string" ? payload.message : `${res.status} from PUT /merge`;
		if (/already merged/i.test(message)) {
			return { kind: "already_merged" };
		}
		return { kind: "not_mergeable", message };
	}

	const text = await readText(res);
	return {
		kind: "http_error",
		status: res.status,
		message: `PUT /merge returned ${res.status}: ${truncate(text, 500)}`,
	};
}

export function isRateLimited(res: Response): boolean {
	const remaining = res.headers.get("x-ratelimit-remaining");
	return remaining === "0";
}
