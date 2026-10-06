/**
 * GitLab CI → `CheckSummary` mapping.
 *
 * A GitLab pipeline is a set of jobs, and a job is the closest thing
 * GitLab has to a check run: a name, a status and a trace (the log). The
 * arm reads the NEWEST pipeline for the commit, so a re-run supersedes the
 * failed one, and maps each of its jobs to a check run whose `jobId` is
 * the GitLab job id the log tail is fetched by.
 */

import type { CheckRun, CheckSummary } from "../contract.ts";

/** Conclusions the CI rollup counts as `failing`. */
const FAILURE_CONCLUSIONS: ReadonlySet<string> = new Set(["failure", "cancelled"]);

/** A SHA-1 or SHA-256 object id, as GitLab reports commits. */
const COMMIT_SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i;

/** Job statuses that have not started yet. */
const QUEUED: ReadonlySet<string> = new Set([
	"created",
	"pending",
	"preparing",
	"waiting_for_resource",
	"scheduled",
]);

interface JobJson {
	readonly id?: unknown;
	readonly name?: unknown;
	readonly status?: unknown;
	readonly allow_failure?: unknown;
	readonly web_url?: unknown;
}

/** True when `ref` is a full commit SHA rather than a branch name. */
export function isCommitSha(ref: string): boolean {
	return COMMIT_SHA.test(ref);
}

/** Map one job row to a check run; `null` when the row is unreadable. */
export function parseJob(raw: unknown): CheckRun | null {
	if (typeof raw !== "object" || raw === null) return null;
	const job = raw as JobJson;
	if (typeof job.id !== "number" || typeof job.status !== "string") return null;
	const { status, conclusion } = jobOutcome(job.status, job.allow_failure === true);
	return {
		name: typeof job.name === "string" ? job.name : "",
		status,
		conclusion,
		jobId: String(job.id),
		detailsUrl: typeof job.web_url === "string" ? job.web_url : null,
	};
}

/**
 * Fold a job status onto the check-run vocabulary the ci-fixer classifier
 * matches on. A failed job marked `allow_failure` is `neutral`, because
 * GitLab itself passes the pipeline with a warning. A `manual` job has not
 * run and may never run; it reads as `skipped`, since counting it as
 * pending would hold the rollup open until someone clicks it. An unmapped
 * status passes through as a completed, non-failing conclusion.
 */
function jobOutcome(
	status: string,
	allowFailure: boolean,
): { status: CheckRun["status"]; conclusion: string | null } {
	if (QUEUED.has(status)) return { status: "queued", conclusion: null };
	if (status === "running" || status === "canceling") {
		return { status: "in_progress", conclusion: null };
	}
	if (status === "failed") {
		return { status: "completed", conclusion: allowFailure ? "neutral" : "failure" };
	}
	if (status === "canceled") return { status: "completed", conclusion: "cancelled" };
	if (status === "manual") return { status: "completed", conclusion: "skipped" };
	return { status: "completed", conclusion: status };
}

/** Roll a pipeline's jobs up to the domain's decision input. */
export function rollUpJobs(runs: readonly CheckRun[]): CheckSummary["conclusion"] {
	if (runs.length === 0) return "unknown";
	if (runs.some((r) => r.status !== "completed")) return "pending";
	const failed = runs.some((r) => r.conclusion !== null && FAILURE_CONCLUSIONS.has(r.conclusion));
	return failed ? "failing" : "passing";
}
