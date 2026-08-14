/**
 * The hardest-directory callout (warren-8f1b), split out of
 * `./insights.ts` under the file-size budget once the per-directory
 * difficulty and context-waste (warren-6d41) callouts both landed.
 */

import type { DirectoryDifficulty, DirectoryStat } from "./directory-difficulty.ts";
import type { Insight } from "./insights.ts";

/** Difficulty-score thresholds for the hardest-directory callout. */
const DIRECTORY_WARNING_SCORE = 0.5;
const DIRECTORY_CRITICAL_FAILURE_SHARE = 0.5;

/**
 * The hardest-directory callout (warren-8f1b): the ranked directory with
 * the highest difficulty score, when it clears the warning threshold and
 * shows real struggle evidence (a failed run or a retry — a zero-evidence
 * top scorer is noise). The detail carries the denominators and the
 * confidence qualifier inline, per the plan's insight discipline.
 */
export function hardestDirectory(directories: DirectoryDifficulty): Insight | null {
	let top: DirectoryStat | undefined;
	for (const d of directories.directories) {
		if (d.runsFailed === 0 && d.retries === 0) continue;
		if (top === undefined || d.difficultyScore > top.difficultyScore) top = d;
	}
	if (top === undefined || top.difficultyScore < DIRECTORY_WARNING_SCORE) return null;
	const share = top.failureShare ?? 0;
	return {
		kind: "hardest-directory",
		severity: share >= DIRECTORY_CRITICAL_FAILURE_SHARE ? "critical" : "warning",
		title: "Hardest directory",
		detail: `"${top.directory}" — ${top.runsFailed} of ${top.runsTouching} run(s) touching it failed; ${top.retries} error-retr${
			top.retries === 1 ? "y" : "ies"
		} across ${top.fileTouches} file touch(es), ${top.steeringMessages} steering message(s) (confidence: ${top.confidence}; ${directories.totals.runsWithFilePaths} of ${directories.totals.runsInWindow} run(s) in window have file data).`,
		value: top.difficultyScore,
		subject: top.directory,
	};
}
