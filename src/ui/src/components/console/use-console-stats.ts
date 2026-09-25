import { useQuery } from "@tanstack/react-query";
import { agentsApi, instanceApi, metaApi, opsApi, planRunsApi, projectsApi } from "@/api/client.ts";
import { deriveBurnUsdPerHour } from "./console-topbar.helpers.ts";

/**
 * Shell status figures (warren-4ed7, warren-b2d6). Run counts come from
 * the shared ["ops-overview", "24h"] query — one aggregate read instead
 * of the 200-row runs list the shell used to fetch on every page. The
 * lifecycle stream invalidates the overview key, so the counts stay
 * live. A spectator's reduced projection leaves the operator sections
 * undefined — the figure renders "—", never a fabricated zero.
 */

export interface ConsoleStats {
	/** `/healthz` liveness: `ok` green, `down` red, `unknown` neutral. */
	readonly health: "ok" | "down" | "unknown";
	/** Runs in `running` state; null = loading or database unreachable. */
	readonly runningCount: number | null;
	/** Runs in `queued` state; null = loading or database unreachable. */
	readonly queuedCount: number | null;
	/** All runs on the instance; null = loading or database unreachable. */
	readonly runsTotal: number | null;
	readonly planRunsCount: number | null;
	readonly projectsCount: number | null;
	readonly agentsCount: number | null;
	/** Ops-overview spend rate, USD per hour; null while loading or spectator. */
	readonly burnUsdPerHour: number | null;
	/** Boot-resolved runtime kind off `GET /instance`; null while loading. */
	readonly runtime: "local" | "docker" | "k8s" | null;
	/** Operator-chosen instance name (`WARREN_INSTANCE_NAME`); null when unset. */
	readonly instanceName: string | null;
}

export function useConsoleStats(): ConsoleStats {
	const healthz = useQuery({
		queryKey: ["meta", "healthz"],
		queryFn: () => metaApi.healthz(),
		refetchInterval: 30_000,
		retry: 1,
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
	// Shared key with the Operations page's default window, so the shell
	// adds no request there.
	const opsOverview = useQuery({
		queryKey: ["ops-overview", "24h"],
		queryFn: ({ signal }) => opsApi.overview("24h", signal),
		refetchInterval: 30_000,
	});
	// Shared ["instance", "facts"] key: deduped with use-dispatch-state.ts.
	const facts = useQuery({
		queryKey: ["instance", "facts"],
		queryFn: ({ signal }) => instanceApi.facts(signal),
		staleTime: 60_000,
	});

	const overview = opsOverview.data;
	const runs = overview && overview.services?.dbReachable !== false ? overview.runs : null;

	return {
		health: healthz.data ? (healthz.data.ok ? "ok" : "down") : "unknown",
		runningCount: runs ? (runs.byState.running ?? 0) : null,
		queuedCount: runs ? (runs.byState.queued ?? 0) : null,
		runsTotal: runs ? runs.total : null,
		planRunsCount: planRuns.data ? planRuns.data.planRuns.length : null,
		projectsCount: projects.data ? projects.data.projects.length : null,
		agentsCount: agents.data ? agents.data.agents.length : null,
		burnUsdPerHour: deriveBurnUsdPerHour(overview?.spend, overview?.services?.dbReachable),
		runtime: facts.data ? facts.data.runtime : null,
		instanceName: facts.data?.name ?? null,
	};
}
