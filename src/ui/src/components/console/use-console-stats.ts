import { useQuery } from "@tanstack/react-query";
import { agentsApi, metaApi, planRunsApi, projectsApi, runsApi } from "@/api/client.ts";
import type { RunRow } from "@/api/types.ts";

/**
 * Shell status figures (warren-4ed7). Sidebar counts and the topbar
 * RUNNING/QUEUE figures bind to data the existing API already serves —
 * the shared list queries, so the lifecycle stream's invalidation
 * refreshes them for free. Figures whose API lands later (BURN, the
 * ops-overview service health, the runtime kind) stay placeholders; the
 * shell never fabricates a number.
 */

export interface ConsoleStats {
	/** `/healthz` liveness: `ok` green, `down` red, `unknown` neutral. */
	readonly health: "ok" | "down" | "unknown";
	/** Runs in `running` state within the recent window; null = loading. */
	readonly runningCount: number | null;
	/** Runs in `queued` state within the recent window; null = loading. */
	readonly queuedCount: number | null;
	/** Total runs matching the unfiltered list; null = loading. */
	readonly runsTotal: number | null;
	readonly planRunsCount: number | null;
	readonly projectsCount: number | null;
	readonly agentsCount: number | null;
}

/**
 * Running/queued counts over the newest runs window. Non-terminal runs
 * stay at the head of a `started desc` list, so a bounded window is
 * representative without fetching the whole history.
 */
export function countRunsByState(runs: readonly Pick<RunRow, "state">[]): {
	running: number;
	queued: number;
} {
	let running = 0;
	let queued = 0;
	for (const run of runs) {
		if (run.state === "running") running += 1;
		else if (run.state === "queued") queued += 1;
	}
	return { running, queued };
}

/** Newest-runs window the shell counts over. */
export const RUNS_WINDOW = 200;

export function useConsoleStats(): ConsoleStats {
	const healthz = useQuery({
		queryKey: ["meta", "healthz"],
		queryFn: () => metaApi.healthz(),
		refetchInterval: 30_000,
		retry: 1,
	});
	const runs = useQuery({
		// Plain ["runs"] key: prefix-shared with the Runs page queries, so
		// the lifecycle stream invalidation (["runs"]) refreshes this too.
		queryKey: ["runs"],
		queryFn: ({ signal }) =>
			runsApi.list({ sort: "started", dir: "desc", limit: RUNS_WINDOW }, signal),
		staleTime: 15_000,
	});
	const planRuns = useQuery({
		queryKey: ["plan-runs"],
		queryFn: ({ signal }) => planRunsApi.list({}, signal),
		staleTime: 15_000,
	});
	const projects = useQuery({
		queryKey: ["projects"],
		queryFn: ({ signal }) => projectsApi.list(signal),
		staleTime: 60_000,
	});
	const agents = useQuery({
		queryKey: ["agents"],
		queryFn: ({ signal }) => agentsApi.list({}, signal),
		staleTime: 60_000,
	});

	const counts = runs.data ? countRunsByState(runs.data.runs) : null;

	return {
		health: healthz.data ? (healthz.data.ok ? "ok" : "down") : "unknown",
		runningCount: counts ? counts.running : null,
		queuedCount: counts ? counts.queued : null,
		runsTotal: runs.data ? runs.data.total : null,
		planRunsCount: planRuns.data ? planRuns.data.planRuns.length : null,
		projectsCount: projects.data ? projects.data.projects.length : null,
		agentsCount: agents.data ? agents.data.agents.length : null,
	};
}
