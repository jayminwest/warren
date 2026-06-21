/**
 * CI-fixer poller orchestration (warren-0b75).
 *
 * Ties the pure helpers landed by warren-05ea into one per-project pass the
 * scheduler tick (`src/triggers/tick.ts`) drives every cycle for projects
 * with `ciFixer.enabled`:
 *
 *   1. For each PR candidate (one open-PR per `runs.pr_url`, surfaced by
 *      `RunsRepo.listPrCandidatesByProject`), reconstruct the PR head ref
 *      from the opener run's branch (`${prefix}/${runId}` via
 *      `composeRunBranch`) — no extra GitHub round-trip to resolve the head.
 *   2. `fetchCheckRuns` + `classifyCheckRuns` decide whether CI is failing.
 *   3. `fixAttemptHistoryByPrUrl` feeds `decideDispatch`'s cooldown +
 *      max-retries gates.
 *   4. On `dispatch`, `buildFixerPrompt` composes the prompt and the
 *      injected `spawn` seam fires a `ci-fixer` run against the PR branch,
 *      back-linked to the opener via `parentRunId`.
 *
 * Pure-ish: all I/O (GitHub fetch, attempt-history read, spawn) is injected,
 * so the orchestration is unit-testable without a live stack. The CI log tail
 * is `null` for now — log extraction and the spawn/reap `targetBranch`
 * honoring land in warren-a993. The poller carries the intended `targetBranch`
 * on the spawn input so that wiring is a drop-in.
 */

import { composeRunBranch } from "../runs/branch.ts";
import { parsePullRequestUrl } from "../runs/pr.ts";
import {
	type CheckRun,
	classifyCheckRuns,
	extractJobId,
	type FetchJobLogTailFn,
	fetchCheckRuns,
	fetchJobLogTail,
} from "./check-runs.ts";
import { buildFixerPrompt, type CiFixerSettings, decideDispatch } from "./dispatch.ts";

/** Trigger string stamped on poller-dispatched runs — the discriminator
 * `RunsRepo.fixAttemptHistoryByPrUrl` filters on to count prior attempts. */
export const CI_FIXER_TRIGGER = "ci-fixer";

/** System-event kind appended to the opener run when a fixer is dispatched. */
export const CI_FIXER_DISPATCHED_EVENT = "ci_fixer.dispatched";

export interface CiFixerCandidate {
	/** The run that opened the PR; its branch is the PR head ref + the
	 * `parentRunId` the dispatched fixer back-links to. */
	readonly runId: string;
	readonly prUrl: string;
}

export interface CiFixerAttemptHistory {
	readonly attempts: number;
	readonly lastAttemptAt: string | null;
}

export type FixAttemptHistoryFn = (prUrl: string) => Promise<CiFixerAttemptHistory>;

export interface CiFixerSpawnInput {
	readonly prompt: string;
	/** Opener run the PR belongs to; the fixer continues from its branch. */
	readonly parentRunId: string;
	/** PR head branch the fixer must push to so the PR's CI re-runs
	 * (honored by spawn/reap in warren-a993). */
	readonly targetBranch: string;
	readonly prUrl: string;
}

export type CiFixerSpawnFn = (input: CiFixerSpawnInput) => Promise<{ runId: string }>;

export type CiFixerSkipReason = "disabled" | "not_failing" | "cooldown" | "max_retries";

export type CiFixerPollResult =
	| {
			readonly kind: "dispatched";
			readonly prUrl: string;
			readonly runId: string;
			readonly parentRunId: string;
	  }
	| { readonly kind: "skipped"; readonly prUrl: string; readonly reason: CiFixerSkipReason }
	| { readonly kind: "error"; readonly prUrl: string; readonly reason: string };

export interface PollProjectCiFixerInput {
	readonly candidates: readonly CiFixerCandidate[];
	readonly settings: CiFixerSettings;
	/** Resolved run-branch prefix for this project (project default > env >
	 * built-in), used to reconstruct each PR's head ref. */
	readonly branchPrefix: string;
	readonly token: string;
	readonly fetch?: typeof fetch;
	readonly history: FixAttemptHistoryFn;
	readonly spawn: CiFixerSpawnFn;
	readonly now: Date;
	/** Max CI-log lines to splice into the fixer prompt (warren-a993).
	 * `ciFixer.logTailLines` from project config. `<= 0` disables the fetch. */
	readonly logTailLines: number;
	/** Test seam for the Actions job-log fetch; defaults to the live
	 * `fetchJobLogTail`. */
	readonly fetchLog?: FetchJobLogTailFn;
}

/**
 * Run one CI-fixer pass over a project's PR candidates. Returns one result
 * per candidate (the tick logs them; dispatches additionally get a durable
 * system event). Never throws on a per-candidate failure — a bad PR url or
 * a GitHub error is captured as an `error` result so one PR can't derail the
 * project's pass.
 */
export async function pollProjectCiFixer(
	input: PollProjectCiFixerInput,
): Promise<CiFixerPollResult[]> {
	const results: CiFixerPollResult[] = [];
	for (const candidate of input.candidates) {
		results.push(await pollCandidate(input, candidate));
	}
	return results;
}

async function pollCandidate(
	input: PollProjectCiFixerInput,
	candidate: CiFixerCandidate,
): Promise<CiFixerPollResult> {
	const parsed = parsePullRequestUrl(candidate.prUrl);
	if (parsed === null) {
		return { kind: "error", prUrl: candidate.prUrl, reason: "unparseable PR url" };
	}

	const ref = composeRunBranch(input.branchPrefix, candidate.runId);
	const fetched = await fetchCheckRuns({
		owner: parsed.owner,
		repo: parsed.repo,
		ref,
		token: input.token,
		...(input.fetch !== undefined ? { fetch: input.fetch } : {}),
	});
	if (fetched.kind !== "ok") {
		return { kind: "error", prUrl: candidate.prUrl, reason: fetched.message };
	}

	const { verdict, failures } = classifyCheckRuns(fetched.checkRuns);
	const history = await input.history(candidate.prUrl);
	const decision = decideDispatch({
		settings: input.settings,
		verdict,
		history,
		now: input.now,
	});
	if (decision.kind === "skip") {
		return { kind: "skipped", prUrl: candidate.prUrl, reason: decision.reason };
	}

	const logTail = await resolveLogTail(input, { owner: parsed.owner, repo: parsed.repo }, failures);
	const prompt = buildFixerPrompt({ prUrl: candidate.prUrl, failures, logTail });
	const spawned = await input.spawn({
		prompt,
		parentRunId: candidate.runId,
		targetBranch: ref,
		prUrl: candidate.prUrl,
	});
	return {
		kind: "dispatched",
		prUrl: candidate.prUrl,
		runId: spawned.runId,
		parentRunId: candidate.runId,
	};
}

/**
 * Resolve the CI log tail to splice into the fixer prompt (warren-a993).
 * Walks the failing check-runs, resolving each one's Actions job id from its
 * `details_url` (check-run id fallback), and returns the first non-empty log
 * tail. A null result (logging disabled, no Actions job, or every fetch
 * failed) leaves `buildFixerPrompt` to fall back to the check-name-only
 * prompt — log extraction never blocks a dispatch.
 */
async function resolveLogTail(
	input: PollProjectCiFixerInput,
	repo: { owner: string; repo: string },
	failures: readonly CheckRun[],
): Promise<string | null> {
	if (input.logTailLines <= 0) return null;
	const fetchLog = input.fetchLog ?? fetchJobLogTail;
	for (const failure of failures) {
		const tail = await fetchLog(
			{
				owner: repo.owner,
				repo: repo.repo,
				jobId: extractJobId(failure.detailsUrl, failure.id),
				token: input.token,
				...(input.fetch !== undefined ? { fetch: input.fetch } : {}),
			},
			input.logTailLines,
		);
		if (tail !== null) return tail;
	}
	return null;
}
