/**
 * Terminal PR classification (warren-7cd1, plan pl-096b step 12).
 *
 * Pure and deterministic: one upstream PR snapshot in, one terminal outcome
 * out — or null while the PR is still open. Merged means `mergedAt` is set;
 * anything closed without `mergedAt` is `closed_unmerged`. No payload text
 * is inspected, so untrusted upstream content can never steer the outcome.
 */

import type { GithubPullRequestSnapshot } from "../github/types.ts";
import type { WorkItemOutcome } from "../store/types.ts";

/** Classify one PR snapshot into a terminal outcome, or null while open. */
export function classifyTerminalOutcome(
	pr: GithubPullRequestSnapshot | null,
): WorkItemOutcome | null {
	if (pr === null) return null;
	if (pr.mergedAt !== null) return "merged";
	if (pr.closedAt !== null) return "closed_unmerged";
	return null;
}
