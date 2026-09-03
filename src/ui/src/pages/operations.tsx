import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { opsApi, projectsApi, runsApi } from "@/api/client.ts";
import { useConsoleStats } from "@/components/console/use-console-stats.ts";
import { OperatorOnly } from "@/components/operator-only.tsx";
import { Alert } from "@/components/ui/alert.tsx";
import { Spinner } from "@/components/ui/spinner.tsx";
import { useNow } from "@/hooks/use-now.ts";
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
	// A 1s tick drives the elapsed/oldest figures without re-fetching
	// (warren-b610: now the shared useNow hook).
	const now = useNow(NOW_TICK_MS);

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
		<div className="flex min-w-0 flex-1 flex-col gap-4 px-3.5 pt-4 pb-12 md:px-6 md:pt-5">
			<header className="flex items-center gap-2.5 pb-1 md:flex-wrap md:items-start md:justify-between md:gap-4">
				<div className="flex min-w-0 flex-1 flex-col gap-0.5 md:flex-none md:gap-1.5">
					<h1 className="text-[17px] leading-[22px] font-semibold tracking-[-0.02em] text-(--color-text) md:text-xl md:leading-6 md:tracking-[-0.025em]">
						Operations
					</h1>
					<p className="text-[11px] leading-3.5 text-(--color-text-2) md:text-[12px] md:leading-4">
						Server health and current run activity.
					</p>
				</div>
				<div className="flex shrink-0 items-center gap-2">
					{loading ? <Spinner /> : null}
					<OperatorOnly>
						<Link
							to="/dispatch"
							className="flex items-center gap-1.5 rounded-(--radius-sm) bg-(--color-primary) px-[11px] py-[7px] text-[11px] leading-3.5 font-medium text-(--color-primary-ink) hover:opacity-90 md:h-8 md:px-3 md:py-0"
						>
							<span className="md:hidden">＋ Dispatch</span>
							<span className="hidden md:inline">＋ Dispatch run</span>
						</Link>
					</OperatorOnly>
				</div>
			</header>

			{overview.isError ? <Alert variant="danger">{formatError(overview.error)}</Alert> : null}

			<CapacityStrip overview={overview.data} runs={runs.data?.runs} now={now} />

			{/** md+ only per the mobile artboard — services/lifecycle are dropped at 375px. */}
			<div className="hidden gap-3 pt-1 md:flex md:flex-wrap">
				<ServicesPanel overview={overview.data} health={stats.health} />
				<LifecycleTable overview={overview.data} runs={runs.data?.runs} now={now} />
			</div>

			<InterventionsPanel overview={overview.data} />

			<div className="flex flex-col gap-3 pt-1 md:flex-row md:flex-wrap">
				<ActiveWorkloads
					runs={runs.data?.runs}
					projects={projects.data?.projects}
					now={now}
					loading={runs.isLoading}
					refreshedAt={runs.dataUpdatedAt ? runs.dataUpdatedAt : undefined}
					total={runs.data?.total}
				/>
				<EventsPanel />
			</div>
		</div>
	);
}
