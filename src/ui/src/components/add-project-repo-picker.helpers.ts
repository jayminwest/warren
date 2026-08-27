/**
 * Repo-picker helpers for the Add Project dialog (warren-2601 / pl-26f3
 * step 10).
 *
 * Kept pure so the picker-vs-fallback decision and the client-side filter
 * are testable without a DOM (same pattern as `setup.helpers.ts`). The
 * filter runs over the already-fetched installation list — there is no
 * server-side search; a repo the App cannot see stays reachable through
 * the URL paste, which never goes away.
 */

import type { ForgeRepoRow } from "@/api/client.ts";

/** How the dialog's repository section renders. */
export type RepoPickerMode = "picker" | "paste-only";

/** Cap on rendered rows — a 2000-repo installation must not paint flat. */
export const REPO_PICKER_LIMIT = 50;

/**
 * `picker` only when the forge answered `supported: true` with at least one
 * repository. Everything else — PAT mode, no forge, a listing failure, an
 * in-flight or errored query (response `undefined`) — is `paste-only`.
 */
export function repoPickerMode(
	response: { supported: boolean; repos: unknown[] } | undefined,
): RepoPickerMode {
	if (response === undefined) return "paste-only";
	if (!response.supported) return "paste-only";
	return response.repos.length > 0 ? "picker" : "paste-only";
}

/**
 * Case-insensitive substring filter over `owner/name`, capped at
 * `REPO_PICKER_LIMIT` rows. An empty or blank query shows the first page.
 */
export function filterRepos(repos: readonly ForgeRepoRow[], query: string): ForgeRepoRow[] {
	const q = query.trim().toLowerCase();
	const matches =
		q === "" ? repos : repos.filter((r) => `${r.owner}/${r.name}`.toLowerCase().includes(q));
	return matches.slice(0, REPO_PICKER_LIMIT);
}

/** The label a picker row shows: `owner/name` plus a private marker. */
export function repoLabel(repo: ForgeRepoRow): string {
	return repo.private ? `${repo.owner}/${repo.name} · private` : `${repo.owner}/${repo.name}`;
}
