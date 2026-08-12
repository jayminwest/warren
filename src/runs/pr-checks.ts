/**
 * `src/runs/pr-checks.ts` — the PR URL-parse group split out of
 * `src/runs/pr.ts` (warren-db9a / pl-88bb step 1) to keep both files under
 * the per-file line budget. `pr.ts` re-exports the public symbols so
 * existing `../runs/pr.ts` import paths keep resolving.
 *
 * warren-63e7 (plan pl-d1c9 step 11): `checkPullRequestMerged` is DELETED —
 * the plan-run merge gate now polls through the Forge seam
 * (`forge.getPullRequest`, driven by `src/plan-runs/pr-merge.ts`), so this
 * module no longer imports any `src/forge/github/` transport internals and
 * its check:layers allow-list entry went with the deletion. What remains is
 * the PR web-URL grammar the CI-fixer still reads (warren-0b49 migrates
 * that consumer next).
 */

/**
 * `parsePullRequestUrl` — regex-parse `https://github.com/<owner>/<repo>/pull/<n>`.
 * Returns `null` on mismatch (e.g. GHE-hosted shapes) so the caller treats
 * them as "cannot verify merge" rather than "merged".
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
