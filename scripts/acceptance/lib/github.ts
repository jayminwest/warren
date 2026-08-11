/**
 * GitHub REST helper for the acceptance harness (warren-2740, plan pl-d1c9
 * step 5, forge-contract.md §6.1/§6.3).
 *
 * Scenario 35 is the harness's only live-GitHub consumer: it drives the
 * CI-fixer round-trip against a real repo and cleans up the opener PR +
 * branch afterward. Its inline client (header literal + two URL grammars)
 * moved here so the harness rides the consolidated transport core in
 * `src/forge/github/` instead of carrying a fifth copy — the harness
 * imports the seam, so no `api.github.com` literal survives in `scripts/`
 * and the `check:layers` walk-root question (design doc §7 step 2) is moot.
 *
 * The two URL grammars consolidated here are the acceptance-specific ones:
 * `parseRepoSlug` (throws `AcceptanceError`, the harness's failure
 * convention) and the bare `/\/pull\/(\d+)/` PR-number extraction. They are
 * deliberately NOT unified with the production grammars in `src/runs/` —
 * that consolidation is the phase-2 contract's job.
 */

import { buildGitHubHeaders, GITHUB_API_BASE } from "../../../src/forge/github/headers.ts";
import { AcceptanceError } from "./assert.ts";

export interface RepoSlug {
	readonly owner: string;
	readonly repo: string;
}

const USER_AGENT = "warren-ci-fixer-acceptance";

/** Parse `owner/repo` from an `https://github.com/<owner>/<repo>(.git)?` URL. */
export function parseRepoSlug(url: string): RepoSlug {
	const m = /github\.com[/:]([^/]+)\/([^/]+?)(?:\.git)?\/?$/.exec(url);
	if (m?.[1] === undefined || m[2] === undefined) {
		throw new AcceptanceError(`not a GitHub repo url: ${url}`);
	}
	return { owner: m[1], repo: m[2] };
}

/** Extract the PR number from an `html_url`-form PR URL; null when absent. */
export function extractPrNumber(prUrl: string): number | null {
	const num = /\/pull\/(\d+)/.exec(prUrl)?.[1];
	if (num === undefined) return null;
	const parsed = Number.parseInt(num, 10);
	return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Best-effort cleanup for a PR the harness opened: read the head ref, close
 * the PR, delete the head branch. Every step is independently guarded — a
 * leftover PR/branch is the operator's to prune, never a scenario failure.
 * Never throws.
 */
export async function closePullRequestAndBranch(
	token: string,
	slug: RepoSlug,
	prUrl: string | null,
): Promise<void> {
	if (prUrl === null) return;
	const num = extractPrNumber(prUrl);
	if (num === null) return;
	const headers = buildGitHubHeaders(token, { userAgent: USER_AGENT });
	const prApi = `${GITHUB_API_BASE}/repos/${slug.owner}/${slug.repo}/pulls/${num}`;
	try {
		// Read the head ref before closing so we can delete the branch too.
		const prRes = await fetch(prApi, { headers });
		let headRef: string | null = null;
		if (prRes.ok) {
			const body = (await prRes.json()) as { head?: { ref?: unknown } };
			if (typeof body.head?.ref === "string") headRef = body.head.ref;
		}
		await fetch(prApi, {
			method: "PATCH",
			headers,
			body: JSON.stringify({ state: "closed" }),
		});
		if (headRef !== null) {
			await fetch(
				`${GITHUB_API_BASE}/repos/${slug.owner}/${slug.repo}/git/refs/heads/${encodeURIComponent(headRef)}`,
				{ method: "DELETE", headers },
			);
		}
	} catch {
		// Best-effort.
	}
}
