import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { opsApi, projectsApi, runsApi } from "@/api/client.ts";
import { useConsoleStats } from "@/components/console/use-console-stats.ts";
import { OperatorOnly } from "@/components/operator-only.tsx";
import { Alert } from "@/components/ui/alert.tsx";
import { Spinner } from "@/components/ui/spinner.tsx";
import { formatError } from "@/lib/format-error.ts";
import { ActiveWorkloads } from "./operations/active-workloads.tsx";
import { CapacityStrip } from "./operations/capacity-strip.tsx";
import { EventsPanel } from "./operations/events-panel.tsx";
import { InterventionsPanel } from "./operations/interventions-panel.tsx";
import { LifecycleTable } from "./operations/lifecycle-table.tsx";
import { ServicesPanel } from "./operations/services-panel.tsx";

/**
 * Operations — the Direction C instance overview and index route
 * (pl-7e38 step 13 / warren-d903), from the canvas artboard
 * `docs/ui-revamp/screens/operations.jsx`.
 *
 * One `GET /ops/overview` poll feeds the capacity strip, services,
 * lifecycle snapshot, and interventions; the active-workloads table
 * reads the shared newest-runs window (same `["runs"]` query the shell
 * counts from, so the lifecycle stream refreshes it for free). The
 * spectator projection renders on presence: operator sections absent
 * from the reduced body simply don't render — never as zeroed panels
 * or broken affordances.
 */

const NOW_TICK_MS = 1000;

export function OperationsPage() {
	// A 1s tick drives the elapsed/oldest figures without re-fetching.
	const [now, setNow] = useState(() => Date.now());
	useEffect(() => {
		const t = window.setInterval(() => setNow(Date.now()), NOW_TICK_MS);
		return () => window.clearInterval(t);
	}, []);

	const overview = useQuery({
		queryKey: ["ops-overview"],
		queryFn: ({ signal }) => opsApi.overview(signal),
		// The lifecycle stream invalidates list keys, not this aggregate;
		// a 30s poll keeps the snapshot fresh without per-event churn.
		refetchInterval: 30_000,
	});
	const runs = useQuery({
		// Shared ["runs"] prefix: deduped with the shell's query and
		// invalidated by the global lifecycle stream (warren-f566).
		queryKey: ["runs"],
		queryFn: ({ signal }) => runsApi.list({ sort: "started", dir: "desc", limit: 200 }, signal),
		staleTime: 15_000,
		refetchInterval: 45_000,
	});
	const projects = useQuery({
		queryKey: ["projects"],
		queryFn: ({ signal }) => projectsApi.list(signal),
		staleTime: 60_000,
	});
	const stats = useConsoleStats();

	const loading = overview.isLoading || runs.isLoading;

	return (
		<div className="flex min-w-0 flex-1 flex-col gap-4 px-3.5 pt-5 pb-12 md:px-6">
			<header className="flex flex-wrap items-start justify-between gap-4 pb-1">
				<div className="flex min-w-0 flex-col gap-1.5">
					<h1 className="text-xl leading-6 font-semibold tracking-[-0.025em] text-(--color-text)">
						Operations
					</h1>
					<p className="text-[12px] leading-4 text-(--color-text-2)">
						Control-plane state and workload activity across this instance.
					</p>
				</div>
				<div className="flex shrink-0 items-center gap-2">
					{loading ? <Spinner /> : null}
					<OperatorOnly>
						<Link
							to="/dispatch"
							className="flex h-8 items-center gap-1.5 rounded-(--radius-sm) bg-(--color-primary) px-3 text-[11px] leading-3.5 font-medium text-(--color-primary-ink) hover:opacity-90"
						>
							＋ Dispatch run
						</Link>
					</OperatorOnly>
				</div>
			</header>

			{overview.isError ? <Alert variant="danger">{formatError(overview.error)}</Alert> : null}

			<CapacityStrip overview={overview.data} runs={runs.data?.runs} now={now} />

			<div className="flex flex-wrap gap-3 pt-1">
				<ServicesPanel overview={overview.data} health={stats.health} />
				<LifecycleTable overview={overview.data} runs={runs.data?.runs} now={now} />
			</div>

			<InterventionsPanel overview={overview.data} />

			<div className="flex flex-wrap gap-3 pt-1">
				<ActiveWorkloads
					runs={runs.data?.runs}
					projects={projects.data?.projects}
					now={now}
					loading={runs.isLoading}
				/>
				<EventsPanel />
			</div>
		</div>
	);
}
