import { useQuery } from "@tanstack/react-query";
import { Plus } from "lucide-react";
import { useState } from "react";
import { Link } from "react-router-dom";
import { opsApi, projectsApi, runsApi } from "@/api/client.ts";
import { useConsoleStats } from "@/components/console/use-console-stats.ts";
import { OperatorOnly } from "@/components/operator-only.tsx";
import { Alert } from "@/components/ui/alert.tsx";
import { Button } from "@/components/ui/button.tsx";
import { PageHeader } from "@/components/ui/page-header.tsx";
import { Segmented } from "@/components/ui/segmented.tsx";
import { useNow } from "@/hooks/use-now.ts";
import { formatError } from "@/lib/format-error.ts";
import type { OpsWindow } from "../../../core/wire.ts";
import { ActiveWorkloads } from "./operations/active-workloads.tsx";
import { CapacityStrip } from "./operations/capacity-strip.tsx";
import { EventsPanel } from "./operations/events-panel.tsx";
import { LifecycleTable } from "./operations/lifecycle-table.tsx";
import { ServicesPanel } from "./operations/services-panel.tsx";

/**
 * Operations — the instance overview and index route (warren-d903,
 * migrated to the polished console language in warren-9474).
 *
 * One ops overview feeds the headline figures, services, and runs by
 * state; the active-workloads table reads the shared newest-runs list
 * (the same `["runs"]` query the shell counts from, so the lifecycle
 * stream refreshes it). The spectator projection renders on presence:
 * operator sections absent from the reduced body don't render — never
 * as zeroed panels or broken affordances.
 */

const NOW_TICK_MS = 1000;

const WINDOW_OPTIONS: ReadonlyArray<{ value: OpsWindow; label: string }> = [
	{ value: "24h", label: "24h" },
	{ value: "7d", label: "7d" },
	{ value: "30d", label: "30d" },
];

export function OperationsPage() {
	// A 1s tick drives the elapsed/longest-wait figures without a refetch.
	const now = useNow(NOW_TICK_MS);

	// The window rides the query key, so switching refetches; the shared
	// "ops-overview" prefix dedupes with the shell's 24h figure (warren-7194).
	const [window, setWindow] = useState<OpsWindow>("24h");
	const overview = useQuery({
		queryKey: ["ops-overview", window],
		queryFn: ({ signal }) => opsApi.overview(window, signal),
		// The lifecycle stream invalidates list keys, not this aggregate; a
		// one-minute poll keeps it current without per-event churn.
		refetchInterval: 60_000,
		refetchIntervalInBackground: false,
	});
	const runs = useQuery({
		// Shared ["runs"] prefix: deduped with the shell's query and
		// invalidated by the global lifecycle stream (warren-f566), so the
		// timer is only the public-mode fallback.
		queryKey: ["runs"],
		queryFn: ({ signal }) => runsApi.list({ sort: "started", dir: "desc", limit: 200 }, signal),
		staleTime: 15_000,
		refetchInterval: 60_000,
		refetchIntervalInBackground: false,
	});
	const projects = useQuery({
		queryKey: ["projects"],
		queryFn: ({ signal }) => projectsApi.list(signal),
		staleTime: 60_000,
	});
	const stats = useConsoleStats();

	return (
		<div className="flex min-w-0 flex-1 flex-col gap-5 px-4 pt-5 pb-12 md:px-6">
			<PageHeader
				title="Operations"
				description="Server health and what is running now."
				actions={
					<>
						<Segmented
							label="Time window"
							options={WINDOW_OPTIONS}
							value={window}
							onChange={setWindow}
						/>
						<OperatorOnly>
							<Button asChild>
								<Link to="/dispatch">
									<Plus aria-hidden />
									Dispatch run
								</Link>
							</Button>
						</OperatorOnly>
					</>
				}
			/>

			{overview.isError ? (
				<Alert variant="danger" title="Couldn't load the overview">
					{formatError(overview.error)}
				</Alert>
			) : null}

			<CapacityStrip overview={overview.data} runs={runs.data?.runs} now={now} window={window} />

			<div className="grid items-start gap-4 lg:grid-cols-5">
				<div className="grid min-w-0 content-start gap-4 lg:col-span-3">
					<ActiveWorkloads
						runs={runs.data?.runs}
						projects={projects.data?.projects}
						now={now}
						loading={runs.isLoading}
					/>
					<EventsPanel />
				</div>
				<div className="grid min-w-0 content-start gap-4 lg:col-span-2">
					<ServicesPanel overview={overview.data} health={stats.health} />
					<LifecycleTable overview={overview.data} runs={runs.data?.runs} now={now} />
				</div>
			</div>
		</div>
	);
}
