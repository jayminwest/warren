import { useQuery } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useState } from "react";
import { instanceApi, planRunsApi, projectsApi, runAnalyticsApi, runsApi } from "@/api/client.ts";
import type { RunRow } from "@/api/types.ts";
import { Segmented } from "@/components/ui/segmented.tsx";
import { Skeleton } from "@/components/ui/skeleton.tsx";
import { useNow } from "@/hooks/use-now.ts";
import { shortRepo } from "@/pages/operations/operations.helpers.ts";
import { ActivityFeed } from "./activity-feed.tsx";
import {
	greeting,
	HOME_WINDOWS,
	type HomeWindow,
	headline,
	isLivePlan,
	isLiveRun,
	isLongRun,
	toMs,
	WINDOW_LABELS,
	windowStartIso,
} from "./home.helpers.ts";
import { NowCards } from "./now-cards.tsx";
import { TrackRecord } from "./track-record.tsx";

/**
 * Home (warren-44a2, plan pl-fae9): the work-centric landing. What is
 * running, what needs a human, what shipped, the track record, and the
 * activity feed — one screen that answers "what are my agents doing".
 * Operations stays the dense live console at /operations.
 */

const FEED_LIMIT = 50;

export function HomePage() {
	const [win, setWin] = useState<HomeWindow>("7");
	const runs = useQuery({
		queryKey: ["runs", "home", FEED_LIMIT],
		queryFn: ({ signal }) =>
			runsApi.list({ sort: "started", dir: "desc", limit: FEED_LIMIT }, signal),
		staleTime: 10_000,
		refetchInterval: 45_000,
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
	const facts = useQuery({
		queryKey: ["instance", "facts"],
		queryFn: ({ signal }) => instanceApi.facts(signal),
		staleTime: 60_000,
	});

	const runRows = runs.data?.runs ?? [];
	const planRows = planRuns.data?.planRuns ?? [];
	const live = runRows.filter(isLiveRun);
	const livePlans = planRows.filter(isLivePlan);
	// Tick every second only while something is live.
	const now = useNow(1000, live.length > 0);

	// The window start moves once an hour, so these keys stay stable.
	const from = windowStartIso(win, now);
	const windowStats = useQuery({
		queryKey: ["run-analytics", "home", from],
		queryFn: ({ signal }) => runAnalyticsApi.runs({ from }, signal),
		staleTime: 60_000,
	});
	const chartFrom = windowStartIso("30", now);
	const chartStats = useQuery({
		queryKey: ["run-analytics", "home", chartFrom],
		queryFn: ({ signal }) => runAnalyticsApi.runs({ from: chartFrom }, signal),
		staleTime: 5 * 60_000,
	});

	useEffect(() => {
		document.title = "Home · Warren";
	}, []);

	const repoNames = useMemo(
		() => new Map((projects.data?.projects ?? []).map((p) => [p.id, shortRepo(p.gitUrl)])),
		[projects.data],
	);
	const repoOf = useCallback(
		(projectId: string | null) => (projectId ? (repoNames.get(projectId) ?? null) : null),
		[repoNames],
	);

	const p95 = windowStats.data?.totals.durationMs.p95 ?? null;
	const isLong = useCallback((r: RunRow) => isLongRun(r, now, p95), [now, p95]);
	const windowStart = new Date(from).getTime();
	const failed = runRows.filter(
		(r) => r.state === "failed" && (toMs(r.endedAt) ?? 0) >= windowStart,
	);
	const attention = [...runRows.filter(isLong), ...failed];
	const shipped = runRows
		.filter((r) => r.prState === "merged" && (toMs(r.prMergedAt) ?? 0) >= windowStart)
		.sort((a, b) => (toMs(b.prMergedAt) ?? 0) - (toMs(a.prMergedAt) ?? 0));

	const t = windowStats.data?.totals;
	const name = facts.data?.name;

	return (
		<div className="mx-auto flex w-full max-w-6xl flex-col gap-6 px-4 py-6 md:px-8 md:py-8">
			<header className="flex flex-wrap items-end justify-between gap-x-6 gap-y-3">
				<div className="flex min-w-0 flex-col gap-1">
					<span className="text-sm text-(--color-text-3)">
						{greeting(new Date(now).getHours())}
						{name ? ` · ${name}` : ""}
					</span>
					<h1 className="text-2xl font-semibold tracking-tight text-(--color-text)">
						{headline(live.length, runs.isLoading)}
					</h1>
					<p className="text-sm text-(--color-text-2)">
						{t ? (
							<>
								In the last {WINDOW_LABELS[win]}:{" "}
								<span className="font-medium text-(--color-text)">{t.runs} runs</span>,{" "}
								<span className="font-medium text-(--color-merge)">
									{t.prsMerged} pull requests merged
								</span>
								{t.failed > 0 ? (
									<>
										, <span className="font-medium text-(--color-danger)">{t.failed} failed</span>
									</>
								) : null}
								.
							</>
						) : (
							<Skeleton className="inline-block h-4 w-72 align-middle" />
						)}
					</p>
				</div>
				<Segmented label="Time window" options={HOME_WINDOWS} value={win} onChange={setWin} />
			</header>

			<NowCards
				runs={live}
				livePlans={livePlans}
				attention={attention}
				shipped={shipped}
				now={now}
				p95Ms={p95}
				loading={runs.isLoading}
				repoOf={repoOf}
			/>

			<TrackRecord
				windowData={windowStats.data}
				chartData={chartStats.data}
				windowLabel={WINDOW_LABELS[win]}
			/>

			<ActivityFeed
				runs={runRows}
				planRuns={planRows}
				now={now}
				loading={runs.isLoading}
				isLong={isLong}
				repoOf={repoOf}
			/>
		</div>
	);
}
