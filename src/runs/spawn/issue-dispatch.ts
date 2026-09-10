import { ValidationError } from "../../core/errors.ts";
import type { Issue } from "../../core/wire.ts";
import type { RunRow } from "../../db/schema.ts";
import { withProjectCloneLock } from "../../projects/clone-lock.ts";
import type { IssueTracker } from "../../tracker/contract.ts";
import { resolveIssueTracker } from "../../tracker/resolve.ts";
import type { SpawnRunInput, SpawnRunResult } from "./types.ts";

function normalizeRepository(value: string): string {
	return value
		.replace(/^git@([^:]+):/, "https://$1/")
		.replace(/\.git\/?$/, "")
		.replace(/\/$/, "")
		.toLowerCase();
}

export function assertExecutableIssue(issue: Issue, gitUrl: string): void {
	if (issue.status !== "open" || issue.ready === false)
		throw new ValidationError("Issue is no longer ready to execute");
	if (
		issue.repositoryUrl &&
		normalizeRepository(issue.repositoryUrl) !== normalizeRepository(gitUrl)
	) {
		throw new ValidationError("Issue repository does not match this Warren project");
	}
}

export async function readExecutableIssue(
	tracker: IssueTracker,
	project: { id: string; localPath: string; gitUrl: string },
	id: string,
): Promise<Issue> {
	const ctx = { projectId: project.id, localPath: project.localPath };
	const resolved = await resolveIssueTracker(tracker, ctx);
	const issue = await resolved.getIssue(ctx, id);
	if (issue.id !== id) throw new ValidationError("Tracker returned a different issue id");
	assertExecutableIssue(issue, project.gitUrl);
	return issue;
}

export interface IssueDispatchResult {
	readonly run: RunRow;
	readonly spawned?: SpawnRunResult;
}

/**
 * Shared manual/automatic queue dispatch. The persisted run row is the receipt;
 * restart and response-loss retries return it rather than creating paid work again.
 * The same project lock as ordinary spawn serializes the lookup and row creation.
 */
export function dispatchIssueOnce(
	input: SpawnRunInput,
	spawn: (input: SpawnRunInput) => Promise<SpawnRunResult>,
): Promise<IssueDispatchResult> {
	return withProjectCloneLock(input.projectId, async () => {
		if (!input.seedId || !input.issueTracker)
			throw new ValidationError("Issue dispatch requires a configured tracker and issue id");
		const prior = await input.repos.runs.findByIssue(input.projectId, input.seedId);
		if (prior) return { run: prior };
		const project = await input.repos.projects.require(input.projectId);
		const issue = await readExecutableIssue(input.issueTracker, project, input.seedId);
		const prompt = [
			`Implement the following tracked issue.`,
			issue.url ?? issue.id,
			issue.title ?? issue.id,
			issue.description ?? "",
			input.prompt,
		]
			.filter(Boolean)
			.join("\n\n");
		const spawned = await spawn({ ...input, prompt });
		return { run: spawned.run, spawned };
	});
}
