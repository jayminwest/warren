/**
 * CI-fixer dispatch decision (warren-05ea).
 *
 * Pure guard-rail logic, separated from the I/O-heavy poller so the
 * eligibility rules are exhaustively testable without a GitHub fixture.
 * Given the project's `ciFixer` config, the check-runs verdict, and the
 * fix-attempt history for a PR, `decideDispatch` returns one of:
 *
 *   - `dispatch`            — fix-eligible: CI failed, not in cooldown, and
 *                             under the per-PR retry cap. Carries the
 *                             dispatch prompt scaffolding the poller fills.
 *   - `skip` (reason …)     — not eligible this tick. Reasons map 1:1 to
 *                             the `ci_fixer.skipped_*` system events:
 *                               * `disabled`        — project hasn't opted in.
 *                               * `not_failing`     — CI isn't in a failing
 *                                                     state (pending/passing/
 *                                                     no_checks).
 *                               * `cooldown`        — last fixer ran too
 *                                                     recently.
 *                               * `max_retries`     — per-PR retry cap hit.
 *
 * The poller composes the dispatch prompt and writes the events; this
 * module only decides.
 */

import type { CheckRunsVerdict } from "./check-runs.ts";

export interface CiFixerSettings {
	readonly enabled: boolean;
	readonly maxRetries: number;
	readonly cooldownMinutes: number;
}

export interface FixAttemptHistory {
	/** How many fixer runs warren has already dispatched for this PR. */
	readonly attempts: number;
	/**
	 * ISO timestamp of the most recent fixer run's completion, or null when
	 * no fixer has run for this PR yet. Used for the cooldown gate.
	 */
	readonly lastAttemptAt: string | null;
}

export type DispatchDecision =
	| { readonly kind: "dispatch" }
	| {
			readonly kind: "skip";
			readonly reason: "disabled" | "not_failing" | "cooldown" | "max_retries";
	  };

export interface DecideDispatchInput {
	readonly settings: CiFixerSettings;
	readonly verdict: CheckRunsVerdict;
	readonly history: FixAttemptHistory;
	/** Current wall clock; injected for deterministic tests. */
	readonly now: Date;
}

const MS_PER_MINUTE = 60_000;

export function decideDispatch(input: DecideDispatchInput): DispatchDecision {
	const { settings, verdict, history, now } = input;

	if (!settings.enabled) {
		return { kind: "skip", reason: "disabled" };
	}
	if (verdict !== "failing") {
		return { kind: "skip", reason: "not_failing" };
	}
	if (history.attempts >= settings.maxRetries) {
		return { kind: "skip", reason: "max_retries" };
	}
	if (isInCooldown(history.lastAttemptAt, settings.cooldownMinutes, now)) {
		return { kind: "skip", reason: "cooldown" };
	}
	return { kind: "dispatch" };
}

/**
 * True when a previous fixer ran within `cooldownMinutes` of `now`. A null
 * `lastAttemptAt` (no prior fixer) is never in cooldown. A zero cooldown
 * disables the gate entirely. A `lastAttemptAt` that doesn't parse is
 * treated as "no prior attempt" rather than throwing — a corrupt timestamp
 * must not strand the PR forever.
 */
function isInCooldown(lastAttemptAt: string | null, cooldownMinutes: number, now: Date): boolean {
	if (lastAttemptAt === null) return false;
	if (cooldownMinutes <= 0) return false;
	const last = Date.parse(lastAttemptAt);
	if (Number.isNaN(last)) return false;
	const elapsedMs = now.getTime() - last;
	return elapsedMs < cooldownMinutes * MS_PER_MINUTE;
}

/**
 * Build the dispatch prompt for a `pr-fixer` run. The poller calls this
 * once `decideDispatch` returns `dispatch`. The CI failure context (check
 * names, conclusions, and the truncated log tail) is injected as a fenced
 * block so the agent can diagnose without re-fetching.
 */
export interface BuildFixerPromptInput {
	readonly prUrl: string;
	readonly failures: readonly {
		name: string;
		conclusion: string | null;
		detailsUrl: string | null;
	}[];
	/** Pre-truncated CI log tail, or null when it couldn't be fetched. */
	readonly logTail: string | null;
}

export function buildFixerPrompt(input: BuildFixerPromptInput): string {
	const lines: string[] = [
		`CI is failing on the pull request at ${input.prUrl}.`,
		"",
		"Failing checks:",
	];
	for (const f of input.failures) {
		const conclusion = f.conclusion ?? "unknown";
		const detail = f.detailsUrl !== null ? ` (${f.detailsUrl})` : "";
		lines.push(`- ${f.name || "(unnamed check)"}: ${conclusion}${detail}`);
	}
	lines.push("");
	if (input.logTail !== null && input.logTail.trim() !== "") {
		lines.push("CI log tail:", "```", input.logTail.trimEnd(), "```", "");
	} else {
		lines.push(
			"No CI log could be fetched for these checks. Diagnose the failure from the codebase and the check names above.",
			"",
		);
	}
	lines.push(
		"Find the root cause, apply the smallest correct fix, run the project's quality gate until it is green, and commit. Do not open a new PR — warren pushes to this PR's branch.",
	);
	return lines.join("\n");
}
