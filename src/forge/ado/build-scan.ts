/**
 * The Pipelines read side of the Azure DevOps arm: `listChecks` and
 * `fetchJobLogTail`, extracted from the provider so each file stays
 * within the size budget. The provider hands over a ref-bound `request`
 * plus its per-process repository-GUID cache; everything here follows
 * the same never-throws seam discipline.
 */

import type { CheckRun, CheckSummary, ForgeResult } from "../contract.ts";
import { readJson, readText } from "../github/readers.ts";
import {
	branchFilter,
	buildMatches,
	isCommitSha,
	latestPerDefinition,
	parseBuild,
	pickTimelineLogId,
	rollUp,
} from "./checks.ts";
import { type AdoTransportResult, err, ok, toForgeError } from "./http.ts";

/** How many builds one scan page reads, newest first. */
const BUILD_SCAN_TOP = 100;

/** One project-scoped request, with the repository ref already bound. */
export type ScanRequest = (input: {
	path: string;
	area?: "git" | "build" | "project-git";
	query?: Record<string, string>;
	accept?: string;
	context: string;
}) => Promise<AdoTransportResult>;

export interface BuildScanDeps {
	readonly request: ScanRequest;
	/** Repository name, for the client-side match on build rows. */
	readonly repo: string;
	/** The ref's packed key — the GUID cache is keyed on it. */
	readonly refKey: string;
	/** `RepoRef.key` → repository GUID, owned by the provider instance. */
	readonly repoGuids: Map<string, string>;
}

/**
 * Read CI state for `commit` (a SHA or a branch name). The scan is
 * scoped server-side wherever the API allows it: the repository filter
 * (resolved to the GUID the Builds API wants) on every query, and
 * `branchName` for a branch ref, so a busy project cannot age the
 * wanted builds out of the recency window. `sourceVersion` has no
 * server filter, so a SHA still relies on the window — repository-scoped
 * rather than project-wide. PR build-validation policies run on the
 * synthetic merge ref `refs/pull/<id>/merge`, not the source branch —
 * the canonical Azure DevOps CI shape — so a branch scan also covers
 * the branch's active PR, when one exists.
 */
export async function scanChecks(
	deps: BuildScanDeps,
	commit: string,
): Promise<ForgeResult<CheckSummary>> {
	const repositoryId = await repositoryGuid(deps);
	const scanQuery = (branch?: string): Record<string, string> => ({
		$top: String(BUILD_SCAN_TOP),
		queryOrder: "queueTimeDescending",
		...(repositoryId !== null ? { repositoryId, repositoryType: "TfsGit" } : {}),
		...(branch !== undefined ? { branchName: branch } : {}),
	});
	const mergeRef = isCommitSha(commit) ? null : await activePrMergeRef(deps, commit);
	const queries = isCommitSha(commit)
		? [scanQuery()]
		: [scanQuery(branchFilter(commit)), ...(mergeRef !== null ? [scanQuery(mergeRef)] : [])];
	const raw: unknown[] = [];
	for (const query of queries) {
		const result = await deps.request({
			path: "builds",
			area: "build",
			context: "GET /build/builds",
			query,
		});
		if (!result.ok) return err(toForgeError(result.error));
		const body = (await readJson(result.response)) as { value?: unknown } | null;
		if (Array.isArray(body?.value)) raw.push(...body.value);
	}
	const extraRefs = mergeRef !== null ? [mergeRef] : [];
	const runs = latestPerDefinition(raw.filter((b) => buildMatches(b, deps.repo, commit, extraRefs)))
		.map(parseBuild)
		.filter((r): r is CheckRun => r !== null);
	return ok({ conclusion: rollUp(runs), runs });
}

/** Best-effort by contract: any failure degrades to ok with `null`. */
export async function scanJobLogTail(
	deps: BuildScanDeps,
	jobId: string,
	maxBytes: number,
): Promise<ForgeResult<string | null>> {
	if (maxBytes <= 0) return ok(null);
	const timeline = await deps.request({
		path: `builds/${encodeURIComponent(jobId)}/timeline`,
		area: "build",
		context: `GET /build/builds/${jobId}/timeline`,
	});
	if (!timeline.ok) return ok(null);
	const logId = pickTimelineLogId(await readJson(timeline.response));
	if (logId === null) return ok(null);
	const log = await deps.request({
		path: `builds/${encodeURIComponent(jobId)}/logs/${logId}`,
		area: "build",
		accept: "text/plain",
		context: `GET /build/builds/${jobId}/logs/${logId}`,
	});
	if (!log.ok) return ok(null);
	const text = (await readText(log.response)).replace(/\s+$/, "");
	if (text === "") return ok(null);
	return ok(text.length <= maxBytes ? text : text.slice(text.length - maxBytes));
}

/**
 * The repository's GUID, which the Builds API wants for its
 * `repositoryId` filter. Best-effort with the provider's cache: a
 * lookup failure widens the scan to the project instead of failing the
 * check read.
 */
async function repositoryGuid(deps: BuildScanDeps): Promise<string | null> {
	const cached = deps.repoGuids.get(deps.refKey);
	if (cached !== undefined) return cached;
	const result = await deps.request({
		path: `repositories/${encodeURIComponent(deps.repo)}`,
		area: "project-git",
		context: `GET /git/repositories/${deps.repo}`,
	});
	if (!result.ok) return null;
	const body = (await readJson(result.response)) as { id?: unknown } | null;
	const id = typeof body?.id === "string" ? body.id : null;
	if (id !== null) deps.repoGuids.set(deps.refKey, id);
	return id;
}

/** The active PR whose source is `branch`, as its build-validation merge ref; `null` when none. */
async function activePrMergeRef(deps: BuildScanDeps, branch: string): Promise<string | null> {
	const result = await deps.request({
		path: "pullrequests",
		context: "GET /pullrequests (merge-ref probe)",
		query: {
			"searchCriteria.sourceRefName": branchFilter(branch),
			"searchCriteria.status": "active",
			$top: "1",
		},
	});
	if (!result.ok) return null;
	const body = (await readJson(result.response)) as { value?: unknown } | null;
	const first = Array.isArray(body?.value)
		? (body.value[0] as { pullRequestId?: unknown } | undefined)
		: undefined;
	return typeof first?.pullRequestId === "number" ? `refs/pull/${first.pullRequestId}/merge` : null;
}
