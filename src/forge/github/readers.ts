/**
 * GitHub REST transport — response readers.
 *
 * Fail-soft body readers shared by every GitHub call (plan pl-d1c9 step 1,
 * docs/design/forge-contract.md §6.1). Reading a response body must never
 * throw: a truncated or non-JSON error body degrades to `null`/`""` and the
 * caller classifies from the status line instead. `truncate` caps user- and
 * GitHub-controlled text before it lands in an error message that may be
 * persisted on a run row.
 */

import type { PullRequestAutoMergeState } from "../contract.ts";

/** Parse a response body as JSON, returning `null` on any parse failure. */
export async function readJson(res: Response): Promise<unknown> {
	try {
		return await res.json();
	} catch {
		return null;
	}
}

/** Read a response body as text, returning `""` on any failure. */
export async function readText(res: Response): Promise<string> {
	try {
		return await res.text();
	} catch {
		return "";
	}
}

/** Cap `input` at `max` chars, appending an ellipsis when truncated. */
export function truncate(input: string, max: number): string {
	return input.length <= max ? input : `${input.slice(0, max)}…`;
}

/**
 * Map the REST `auto_merge` field onto the seam's auto-merge state
 * (pl-92a3): a non-null request object means armed, null means unarmed —
 * GitHub sends the field on every pull-request read, null when nothing is
 * armed. `unknown` stays the honest answer of forges that cannot tell; this
 * reader is why the GitHub arm no longer says it.
 */
export function readAutoMergeState(autoMerge: unknown): PullRequestAutoMergeState {
	return autoMerge !== null && autoMerge !== undefined ? "armed" : "unarmed";
}
