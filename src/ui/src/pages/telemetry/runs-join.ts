import { useQuery } from "@tanstack/react-query";
import { runsApi } from "@/api/client.ts";

/**
 * The recent-runs page the Judge and Economics tabs join verdict and
 * cost data against (runId → agent, project, forge PR state). One
 * shared query key so both tabs ride a single round-trip.
 */

const RUNS_JOIN_LIMIT = 200;

export const RUNS_JOIN_QUERY_KEY = ["telemetry", "runs-join", RUNS_JOIN_LIMIT] as const;

/** Recent runs, newest first, bounded for the join. */
export function useRunsJoin() {
	return useQuery({
		queryKey: RUNS_JOIN_QUERY_KEY,
		queryFn: ({ signal }) => runsApi.list({ limit: RUNS_JOIN_LIMIT }, signal),
	});
}
