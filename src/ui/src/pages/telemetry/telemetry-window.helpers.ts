import type { RunAnalyticsFilter } from "../../api/run-analytics-types.ts";

/** The analytics filter both tab queries share, scoped to the selected project. */
export function telemetryAnalyticsFilter(
	projectId: string | null,
	from: string,
	to: string,
): RunAnalyticsFilter {
	return projectId ? { projectId, from, to } : { from, to };
}

/** The react-query cache key for one of the tab queries, project-scoped. */
export function telemetryQueryKey(
	kind: "runs" | "behavior",
	projectId: string | null,
	from: string,
	to: string,
): readonly [
	"analytics",
	"runs" | "behavior",
	{ projectId: string | null; from: string; to: string },
] {
	return ["analytics", kind, { projectId, from, to }];
}
