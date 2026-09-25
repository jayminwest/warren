import { Inbox, Layers } from "lucide-react";
import { useMemo, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import type { PlanRunRow, RunRow } from "@/api/types.ts";
import { Card, CardHeader } from "@/components/ui/card.tsx";
import { EmptyState } from "@/components/ui/empty-state.tsx";
import { Segmented } from "@/components/ui/segmented.tsx";
import { SkeletonRows } from "@/components/ui/skeleton.tsx";
import { PrChip, StatusDot, StatusText } from "@/components/ui/status.tsx";
import { useListKeys } from "@/hooks/use-list-keys.ts";
import { cn } from "@/lib/utils.ts";
import {
	buildFeed,
	clockTime,
	type FeedFilter,
	type FeedItem,
	isLiveRun,
	runElapsedMs,
	shortDuration,
} from "./home.helpers.ts";
import { runTitle } from "./now-cards.tsx";

/**
 * Home's activity feed (warren-44a2): the newest runs and plan runs,
 * grouped by day, with J/K selection and Enter to open.
 */

const FILTERS: readonly { value: FeedFilter; label: string }[] = [
	{ value: "all", label: "All" },
	{ value: "live", label: "Live" },
	{ value: "attention", label: "Attention" },
	{ value: "shipped", label: "Shipped" },
];

function itemPath(item: FeedItem): string {
	return item.kind === "run" ? `/runs/${item.run.id}` : `/plan-runs/${item.plan.id}`;
}

function RunLine({ run, now, repo }: { run: RunRow; now: number; repo: string | null }) {
	return (
		<>
			<StatusDot state={run.state} className="mt-0.5" />
			<Link to={`/runs/${run.id}`} className="flex min-w-0 flex-1 flex-col sm:flex-row sm:gap-3">
				<span className="min-w-0 flex-1 truncate text-sm text-(--color-text)">{runTitle(run)}</span>
				<span className="flex min-w-0 shrink-0 items-center gap-2 text-xs text-(--color-text-3) sm:ml-auto">
					{repo ? <span className="truncate">{repo}</span> : null}
					{run.seedId ? <span className="font-mono">{run.seedId}</span> : null}
				</span>
			</Link>
			<span className="hidden w-24 shrink-0 sm:block">
				<StatusText state={run.state} reason={run.failureReason} className="text-xs" />
			</span>
			<span
				className={cn(
					"w-14 shrink-0 text-right text-xs tabular-nums",
					isLiveRun(run) ? "text-(--color-info)" : "text-(--color-text-3)",
				)}
			>
				{shortDuration(runElapsedMs(run, now))}
			</span>
			<span className="hidden w-20 shrink-0 justify-end md:flex">
				{run.prUrl ? <PrChip url={run.prUrl} lifecycle={run.prState} compact /> : null}
			</span>
		</>
	);
}

function PlanLine({ plan, repo }: { plan: PlanRunRow; repo: string | null }) {
	return (
		<>
			<StatusDot state={plan.state} className="mt-0.5" />
			<Link
				to={`/plan-runs/${plan.id}`}
				className="flex min-w-0 flex-1 items-center gap-2 text-sm text-(--color-text)"
			>
				<Layers aria-hidden className="size-3.5 shrink-0 text-(--color-text-3)" />
				<span className="truncate">Plan {plan.planId ?? "(issue list)"}</span>
				{repo ? <span className="truncate text-xs text-(--color-text-3)">{repo}</span> : null}
			</Link>
			<span className="hidden w-24 shrink-0 sm:block">
				<StatusText state={plan.state} className="text-xs" />
			</span>
			<span className="w-14 shrink-0" />
			<span className="hidden w-20 shrink-0 md:block" />
		</>
	);
}

export function ActivityFeed({
	runs,
	planRuns,
	now,
	loading,
	isLong,
	repoOf,
}: {
	runs: readonly RunRow[];
	planRuns: readonly PlanRunRow[];
	now: number;
	loading: boolean;
	isLong: (run: RunRow) => boolean;
	repoOf: (projectId: string | null) => string | null;
}) {
	const navigate = useNavigate();
	const [filter, setFilter] = useState<FeedFilter>("all");
	// Regroup at most once a minute; the rows themselves tick with `now`.
	const minute = Math.floor(now / 60_000);
	const groups = useMemo(
		() => buildFeed({ runs, planRuns, filter, now: minute * 60_000, isLong }),
		[runs, planRuns, filter, minute, isLong],
	);
	const flat = groups.flatMap((g) => g.items);
	const { selected, setRef } = useListKeys(flat.length, (i) => {
		const item = flat[i];
		if (item) navigate(itemPath(item));
	});

	let index = -1;
	return (
		<Card className="self-stretch">
			<CardHeader
				title="Activity"
				meta="J / K to move, Enter to open"
				actions={
					<Segmented
						label="Filter activity"
						size="sm"
						options={FILTERS}
						value={filter}
						onChange={setFilter}
					/>
				}
				className="flex-wrap"
			/>
			{loading ? (
				<SkeletonRows rows={6} className="p-4" />
			) : flat.length === 0 ? (
				<EmptyState
					icon={Inbox}
					title="Nothing here"
					description="No activity matches this filter."
					compact
				/>
			) : (
				<div className="flex flex-col pb-1.5">
					{groups.map((group) => (
						<section key={group.label} aria-label={group.label}>
							<h3 className="sticky top-0 z-[1] bg-(--color-surface) px-4 pt-3 pb-1 text-xs font-medium text-(--color-text-3)">
								{group.label}
							</h3>
							{group.items.map((item) => {
								index += 1;
								const i = index;
								const key = item.kind === "run" ? item.run.id : item.plan.id;
								const repo = repoOf(item.kind === "run" ? item.run.projectId : item.plan.projectId);
								return (
									<div
										key={key}
										ref={setRef(i)}
										data-selected={selected === i}
										className="mx-1.5 flex h-11 items-center gap-3 rounded-sm px-2.5 hover:bg-(--color-surface-raised) data-[selected=true]:bg-(--color-surface-raised) data-[selected=true]:ring-1 data-[selected=true]:ring-(--color-border-strong)"
									>
										<span className="hidden w-16 shrink-0 whitespace-nowrap text-xs tabular-nums text-(--color-text-3) sm:block">
											{clockTime(item.at)}
										</span>
										{item.kind === "run" ? (
											<RunLine run={item.run} now={now} repo={repo} />
										) : (
											<PlanLine plan={item.plan} repo={repo} />
										)}
									</div>
								);
							})}
						</section>
					))}
				</div>
			)}
		</Card>
	);
}
