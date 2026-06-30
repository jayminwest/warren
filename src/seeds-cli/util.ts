/**
 * Shared constants + helpers for the seeds CLI shell-out facade
 * (`extensions.ts`, `list.ts`, `show.ts`). Pulled out so the three modules
 * stop carrying byte-identical copies (warren-56a0 / pl-4d2e step 6, #539).
 */

/** Default timeout for `sd` shell-outs when a caller doesn't override it. */
export const DEFAULT_SD_TIMEOUT_MS = 30_000;

/**
 * Trim and cap a shell-out's stderr/stdout to a sane length before it
 * lands in an error message. Defaults to 500 chars, matching the
 * historical per-file copies.
 */
export function truncate(raw: string, limit = 500): string {
	const trimmed = raw.trim();
	if (trimmed.length <= limit) return trimmed;
	return `${trimmed.slice(0, limit)}… [truncated]`;
}
