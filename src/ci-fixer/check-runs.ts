/**
 * Check-run classification for the CI-fixer (warren-05ea; migrated onto the
 * Forge seam in warren-0b49, plan pl-d1c9 step 12).
 *
 * Pure domain module. The transport that used to live here (the check-runs
 * GET, the job-log fetch, the `details_url` job-id regex) now lives behind
 * the Forge contract — `forge.listChecks` / `forge.fetchJobLogTail` — with
 * the GitHub parsing inside `src/forge/github/provider.ts`. A check-run id
 * never crosses the seam (forge-contract.md §0); the domain sees only the
 * provider-neutral `CheckRun` DTO with an opaque `jobId`.
 *
 * `CheckRun` is RE-EXPORTED from the contract, not redeclared — one
 * definition, one home (the seam DTO lives in `src/forge/contract.ts`
 * because it never crosses warren's own HTTP wire, §2.1).
 *
 * Classification rules:
 *   - `pending`  — at least one check-run is not `completed`. Wait; don't
 *                  dispatch a fixer mid-CI.
 *   - `passing`  — every check-run completed with a success-ish conclusion
 *                  (`success`, `neutral`, `skipped`). Nothing to fix.
 *   - `failing`  — every check-run completed AND at least one has a
 *                  failure-ish conclusion (`failure`, `timed_out`,
 *                  `action_required`, `cancelled`, `startup_failure`).
 *                  Fix-eligible.
 *   - `no_checks` — the ref has zero check-runs (no CI configured, or
 *                  checks haven't registered yet). Not fix-eligible.
 */

import type { CheckRun } from "../forge/contract.ts";

export type { CheckRun } from "../forge/contract.ts";

/** Conclusions that count as a failure worth dispatching a fixer for. */
const FAILURE_CONCLUSIONS: ReadonlySet<string> = new Set([
	"failure",
	"timed_out",
	"action_required",
	"cancelled",
	"startup_failure",
]);

export type CheckRunsVerdict = "pending" | "passing" | "failing" | "no_checks";

export interface ClassifyCheckRunsResult {
	readonly verdict: CheckRunsVerdict;
	/** The failure-ish check-runs, populated only when verdict is `failing`. */
	readonly failures: readonly CheckRun[];
}

/**
 * Classify the aggregate state of a commit's check-runs. The poller treats
 * `failing` as fix-eligible; everything else is a no-op for this tick. The
 * provider's `CheckSummary.conclusion` rollup deliberately has no
 * `no_checks` arm (it reports `unknown`), so the domain classifies from
 * `runs` directly.
 */
export function classifyCheckRuns(checkRuns: readonly CheckRun[]): ClassifyCheckRunsResult {
	if (checkRuns.length === 0) {
		return { verdict: "no_checks", failures: [] };
	}
	const anyPending = checkRuns.some((c) => c.status !== "completed");
	if (anyPending) {
		return { verdict: "pending", failures: [] };
	}
	const failures = checkRuns.filter(
		(c) => c.conclusion !== null && FAILURE_CONCLUSIONS.has(c.conclusion),
	);
	if (failures.length > 0) {
		return { verdict: "failing", failures };
	}
	return { verdict: "passing", failures: [] };
}

/**
 * Keep the last `tailLines` lines of `text`, trimming trailing whitespace.
 * Returns null for an effectively empty log so the caller skips the block.
 * The forge's `fetchJobLogTail` tails BYTES (its contract unit); the
 * domain's `logTailLines` budget is lines, so the poller fetches a generous
 * byte window and tails to the exact line count here.
 */
export function tailLogLines(text: string, tailLines: number): string | null {
	const trimmed = text.replace(/\s+$/, "");
	if (trimmed === "") return null;
	const lines = trimmed.split("\n");
	if (lines.length <= tailLines) return trimmed;
	return lines.slice(lines.length - tailLines).join("\n");
}
