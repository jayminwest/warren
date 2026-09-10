import type { IssueTracker, TrackerContext } from "./contract.ts";

/** Resolve the project before inspecting capabilities; a mixed instance has no global tracker. */
export async function resolveIssueTracker<T extends IssueTracker>(
	tracker: T,
	ctx: TrackerContext,
): Promise<T> {
	return (tracker.resolveForProject ? await tracker.resolveForProject(ctx) : tracker) as T;
}
