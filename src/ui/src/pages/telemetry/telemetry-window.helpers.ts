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

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * The window a "N days" selection covers (warren-e9cd): today plus the
 * N-1 calendar days before it, in UTC — the same days the run-outcomes
 * chart draws one column for. `from` is the UTC midnight that opens the
 * first day, `to` is now.
 */
export function telemetryWindowBounds(days: number, now: number): { from: string; to: string } {
	const today = new Date(now);
	const startOfToday = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate());
	return {
		from: new Date(startOfToday - (days - 1) * DAY_MS).toISOString(),
		to: new Date(now).toISOString(),
	};
}
