/**
 * Azure DevOps Pipelines → `CheckSummary` mapping.
 *
 * A pipeline build is the closest thing Azure DevOps has to a check run:
 * one row per definition per commit, with a status (`notStarted`,
 * `inProgress`, `completed`, …) and, once complete, a result
 * (`succeeded`, `partiallySucceeded`, `failed`, `canceled`). The build id
 * is the opaque `jobId` the log tail is fetched by.
 */

import type { CheckRun, CheckSummary } from "../contract.ts";

/** Conclusions the CI rollup counts as `failing`. A partial success still means a task failed. */
const FAILURE_RESULTS: ReadonlySet<string> = new Set(["failure", "cancelled"]);

/**
 * Azure DevOps build results, folded to the check-run conclusion
 * vocabulary the ci-fixer classifier matches on. An unmapped result
 * passes through raw and classifies as non-failing, the same posture the
 * classifier takes toward an unknown GitHub conclusion.
 */
const CONCLUSIONS: Readonly<Record<string, string>> = {
	succeeded: "success",
	partiallySucceeded: "failure",
	failed: "failure",
	canceled: "cancelled",
};

const COMMIT_SHA = /^[0-9a-f]{40}$/i;

interface BuildJson {
	readonly id?: unknown;
	readonly status?: unknown;
	readonly result?: unknown;
	readonly sourceVersion?: unknown;
	readonly sourceBranch?: unknown;
	readonly queueTime?: unknown;
	readonly definition?: unknown;
	readonly repository?: unknown;
	readonly _links?: unknown;
}

/** Map one build row to a check run; `null` when the row is unreadable. */
export function parseBuild(raw: unknown): CheckRun | null {
	if (typeof raw !== "object" || raw === null) return null;
	const build = raw as BuildJson;
	if (typeof build.id !== "number") return null;
	const definition = build.definition as { name?: unknown } | undefined;
	const links = build._links as { web?: { href?: unknown } } | undefined;
	return {
		name: typeof definition?.name === "string" ? definition.name : "",
		status: checkStatus(build.status),
		conclusion:
			typeof build.result === "string" ? (CONCLUSIONS[build.result] ?? build.result) : null,
		jobId: String(build.id),
		detailsUrl: typeof links?.web?.href === "string" ? links.web.href : null,
	};
}

/**
 * True when the build row ran against `ref` in the repository named
 * `repo`. `ref` is a commit SHA or a branch name — the contract passes a
 * commit, but the ci-fixer polls by run branch, and the GitHub arm's
 * endpoint accepts either, so this arm matches both shapes too. For a
 * branch, `extraRefs` names further acceptable `sourceBranch` values —
 * the PR-validation merge ref, whose builds gate the canonical Azure
 * DevOps CI setup. Repository names and commit SHAs compare
 * case-insensitively, matching the service; branch refs are exact, as
 * git refs are.
 */
export function buildMatches(
	raw: unknown,
	repo: string,
	ref: string,
	extraRefs: readonly string[] = [],
): boolean {
	if (typeof raw !== "object" || raw === null) return false;
	const build = raw as BuildJson;
	const wanted = COMMIT_SHA.test(ref)
		? typeof build.sourceVersion === "string" &&
			build.sourceVersion.toLowerCase() === ref.toLowerCase()
		: build.sourceBranch === branchFilter(ref) ||
			extraRefs.some((extra) => build.sourceBranch === extra);
	if (!wanted) return false;
	const repository = build.repository as { name?: unknown } | undefined;
	return typeof repository?.name === "string"
		? repository.name.toLowerCase() === repo.toLowerCase()
		: true;
}

/** The refs/heads/ prefix a branch ref carries on a build row. */
export function branchFilter(branch: string): string {
	return `refs/heads/${branch}`;
}

/**
 * Keep only the newest build per pipeline definition, judged by
 * `queueTime`. The rows may be the concatenation of several
 * newest-first pages (a branch scan plus its PR merge-ref scan), so
 * arrival order alone would let an older branch build hide a newer
 * merge-ref build from the same definition. A row without a readable
 * `queueTime` only wins when nothing dated competes for its definition.
 * Without this, a branch's earlier failed build keeps the rollup
 * `failing` after a later push turns CI green.
 */
export function latestPerDefinition(rows: readonly unknown[]): unknown[] {
	const newest = new Map<string, { raw: unknown; queuedAt: number }>();
	for (const raw of rows) {
		const build = raw as BuildJson | null;
		const definition = build?.definition as { id?: unknown; name?: unknown } | undefined;
		const key = `${String(definition?.id ?? "")}/${String(definition?.name ?? "")}`;
		const queuedAt = queueTimeMs(build?.queueTime);
		const current = newest.get(key);
		if (current === undefined || queuedAt > current.queuedAt) newest.set(key, { raw, queuedAt });
	}
	return [...newest.values()].map((entry) => entry.raw);
}

/** `queueTime` as epoch millis; `-Infinity` when absent or unparsable. */
function queueTimeMs(value: unknown): number {
	if (typeof value !== "string") return Number.NEGATIVE_INFINITY;
	const ms = Date.parse(value);
	return Number.isNaN(ms) ? Number.NEGATIVE_INFINITY : ms;
}

/** True when `ref` is a full commit SHA rather than a branch name. */
export function isCommitSha(ref: string): boolean {
	return COMMIT_SHA.test(ref);
}

function checkStatus(status: unknown): CheckRun["status"] {
	if (status === "notStarted" || status === "postponed") return "queued";
	if (status === "completed") return "completed";
	return "in_progress";
}

/** Roll a commit's builds up to the domain's decision input. */
export function rollUp(runs: CheckRun[]): CheckSummary["conclusion"] {
	if (runs.length === 0) return "unknown";
	if (runs.some((r) => r.status !== "completed")) return "pending";
	if (runs.some((r) => r.conclusion !== null && FAILURE_RESULTS.has(r.conclusion))) {
		return "failing";
	}
	return "passing";
}

/**
 * Pick the log worth tailing out of a build timeline: the first failed
 * task that wrote a log, else the last record with a log. `null` when the
 * timeline carries no log at all.
 */
export function pickTimelineLogId(timeline: unknown): number | null {
	const records = (timeline as { records?: unknown } | null)?.records;
	if (!Array.isArray(records)) return null;
	let last: number | null = null;
	for (const raw of records) {
		const record = raw as { type?: unknown; result?: unknown; log?: { id?: unknown } } | null;
		const logId = record?.log?.id;
		if (typeof logId !== "number") continue;
		if (record?.type === "Task" && record.result === "failed") return logId;
		last = logId;
	}
	return last;
}
