/**
 * `parseRepoRef` support — the five audited clone/PR URL grammars
 * (forge-contract.md §6.3) and the packed `RepoRef.key` shape, split out of
 * `provider.ts` to keep both files under the per-file line budget.
 *
 * The `[A-Za-z0-9._-]+` per-segment validation is preserved verbatim from
 * `src/projects/url.ts`: it guards `/data/projects/<owner>/<name>` path
 * safety (mx-e741b0), so `.`, `..`, leading-dash, and off-charset segments
 * reject the URL outright. Everything here NEVER throws — a URL this forge
 * does not own returns `null` so the registry can try the next forge (§1.1).
 */

import type { RepoRef } from "../contract.ts";

/** Registry key this forge answers to (`FORGE_KINDS`). */
export const GITHUB_FORGE_KIND = "github";

/** Path-safety rule preserved from `src/projects/url.ts` (mx-e741b0). */
const SAFE_SEGMENT = /^[A-Za-z0-9._-]+$/;

function isSafeSegment(segment: string): boolean {
	return (
		SAFE_SEGMENT.test(segment) && segment !== "." && segment !== ".." && !segment.startsWith("-")
	);
}

/**
 * Parse a clone/PR URL into this forge's opaque ref. NEVER throws; foreign
 * hosts and unsafe segments return `null`. The packed key is
 * `github.com/<owner>/<repo>` — only this provider ever destructures it.
 */
export function parseGitHubRepoRef(cloneUrl: string): RepoRef | null {
	const pair = extractOwnerRepo(cloneUrl.trim());
	if (pair === null) return null;
	return { forge: GITHUB_FORGE_KIND, key: `github.com/${pair.owner}/${pair.repo}` };
}

/** Extract `{owner, repo}` from any of the five audited grammars. */
function extractOwnerRepo(input: string): { owner: string; repo: string } | null {
	// Grammar: scp-style `git@github.com:owner/repo[.git]`.
	const scp = /^git@github\.com:([^/]+)\/([^/]+?)(?:\.git)?\/?$/.exec(input);
	if (scp !== null) {
		return finish(scp[1] as string, scp[2] as string);
	}

	let parsed: URL;
	try {
		parsed = new URL(input);
	} catch {
		return null;
	}
	const host = parsed.hostname.toLowerCase();
	const protocol = parsed.protocol;
	if (protocol !== "https:" && protocol !== "http:" && protocol !== "ssh:") return null;
	const parts = parsed.pathname.split("/").filter((p) => p !== "");

	if (host === "github.com") return fromWebHost(parts);
	if (host === "api.github.com") return fromApiHost(parts);
	return null;
}

/** github.com grammars: clone URL and PR web URL (query/fragment already dropped). */
function fromWebHost(parts: string[]): { owner: string; repo: string } | null {
	// Clone URL `https://github.com/owner/repo[.git]` (also ssh://).
	if (parts.length === 2) {
		return finish(parts[0] as string, stripGitSuffix(parts[1] as string));
	}
	// PR web URL `https://github.com/owner/repo/pull/<n>`.
	if (parts.length === 4 && parts[2] === "pull" && /^\d+$/.test(parts[3] as string)) {
		return finish(parts[0] as string, parts[1] as string);
	}
	return null;
}

/** api.github.com grammar: `repos/owner/repo[/pulls/<n>]`. */
function fromApiHost(parts: string[]): { owner: string; repo: string } | null {
	if (
		parts.length === 5 &&
		parts[0] === "repos" &&
		parts[3] === "pulls" &&
		/^\d+$/.test(parts[4] as string)
	) {
		return finish(parts[1] as string, parts[2] as string);
	}
	if (parts.length === 3 && parts[0] === "repos") {
		return finish(parts[1] as string, parts[2] as string);
	}
	return null;
}

function stripGitSuffix(segment: string): string {
	return segment.endsWith(".git") ? segment.slice(0, -4) : segment;
}

/** Apply the path-safety segment validation; unsafe pairs reject to null. */
function finish(owner: string, repo: string): { owner: string; repo: string } | null {
	if (!isSafeSegment(owner) || !isSafeSegment(repo)) return null;
	return { owner, repo };
}
