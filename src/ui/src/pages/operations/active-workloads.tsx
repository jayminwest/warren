import { Link } from "react-router-dom";
import type { ProjectRow, RunRow } from "@/api/types.ts";
import {
	CardFigure,
	CardFigureNote,
	InventoryCardList,
	InventoryRowCard,
} from "@/components/ui/inventory-card.tsx";
import { formatCostUsd } from "@/pages/run-detail-format.ts";
import {
	activeWorkloads,
	activityLine,
	formatDurationMs,
	phaseElapsedMs,
	shortRepo,
} from "./operations.helpers.ts";
import { StatePill } from "./state-tone.tsx";

/**
 * Active workloads table (warren-d903): the non-terminal runs from the
 * shared newest-runs window, oldest phase first (the row that has waited
 * longest is the one the operator judges). The ACTIVITY column shows the
 * prompt's first line — the live toolcall feed the canvas sketches needs
 * per-run event tails this page does not open; a one-poll snapshot stays
 * honest with dispatch intent.
 */

const MAX_ROWS = 8;

export function ActiveWorkloads({
	runs,
	projects,
	now,
	loading,
}: {
	runs: readonly RunRow[] | undefined;
	projects: readonly ProjectRow[] | undefined;
	now: number;
	loading: boolean;
}) {
	const active = runs !== undefined ? activeWorkloads(runs, MAX_ROWS) : [];
	const running = runs?.filter((r) => r.state === "running").length ?? null;
	const queued = runs?.filter((r) => r.state === "queued").length ?? null;
	const projectIndex = new Map<string, string>();
	for (const p of projects ?? []) projectIndex.set(p.id, shortRepo(p.gitUrl));
	return (
		<div className="flex min-w-0 flex-[1.8] flex-col">
			<header className="flex h-7 shrink-0 items-center pb-1.25">
				<h2 className="text-[11px] leading-3.5 font-semibold text-(--color-text-2)">
					Active workloads
				</h2>
				<span className="flex-1" />
				<span className="font-mono text-[9px] leading-3 text-(--color-text-3)">
					{running === null || queued === null ? "…" : `${running} RUNNING · ${queued} QUEUED`}
				</span>
			</header>
			<div className="flex flex-col overflow-clip rounded-(--radius-md) border border-(--color-border) bg-(--color-surface)">
				{active.length === 0 ? (
					<p className="px-3 py-3 font-mono text-[10px] leading-3 text-(--color-text-3)">
						{loading ? "loading active workloads…" : "No active workloads — the instance is quiet."}
					</p>
				) : (
					<InventoryCardList>
						{active.map((run) => (
							<ActiveWorkloadCard
								key={run.id}
								run={run}
								projectLabel={
									run.projectId === null
										? "orphaned"
										: (projectIndex.get(run.projectId) ?? run.projectId)
								}
								now={now}
							/>
						))}
					</InventoryCardList>
				)}
				<div className="hidden md:block">
					<div className="flex h-[31px] shrink-0 items-center gap-2.5 border-b border-(--color-border-strong) bg-(--color-thead) px-2.5">
						<span className="w-[82px] shrink-0 font-mono text-[9px] font-semibold tracking-[0.05em] text-(--color-text-3)">
							STATE
						</span>
						<span className="w-[112px] shrink-0 font-mono text-[9px] font-semibold tracking-[0.05em] text-(--color-text-3)">
							RUN
						</span>
						<span className="w-[76px] shrink-0 font-mono text-[9px] font-semibold tracking-[0.05em] text-(--color-text-3)">
							AGENT
						</span>
						<span className="w-[96px] shrink-0 font-mono text-[9px] font-semibold tracking-[0.05em] text-(--color-text-3)">
							PROJECT
						</span>
						<span className="min-w-0 flex-1 font-mono text-[9px] font-semibold tracking-[0.05em] text-(--color-text-3)">
							ACTIVITY
						</span>
						<span className="w-[48px] shrink-0 text-right font-mono text-[9px] font-semibold tracking-[0.05em] text-(--color-text-3)">
							ELAPSED
						</span>
						<span className="w-[52px] shrink-0 text-right font-mono text-[9px] font-semibold tracking-[0.05em] text-(--color-text-3)">
							COST
						</span>
					</div>
					{active.map((run) => (
						<Link
							key={run.id}
							to={`/runs/${run.id}`}
							className="flex h-[38px] items-center gap-2.5 border-b border-(--color-border) px-2.5 last:border-b-0 hover:bg-(--color-surface-hover)"
						>
							<span className="w-[82px] shrink-0">
								<StatePill state={run.state} />
							</span>
							<span className="w-[112px] shrink-0 truncate font-mono text-[10px] leading-3 text-(--color-text)">
								{run.id}
							</span>
							<span className="w-[76px] shrink-0 truncate text-[11px] leading-3.5 text-(--color-text-2)">
								{run.agentName}
							</span>
							<span className="w-[96px] shrink-0 truncate text-[11px] leading-3.5 text-(--color-text-3)">
								{run.projectId === null
									? "orphaned"
									: (projectIndex.get(run.projectId) ?? run.projectId)}
							</span>
							<span className="min-w-0 flex-1 truncate text-[11px] leading-3.5 text-(--color-text-2)">
								{run.state === "queued" ? "awaiting admission" : activityLine(run.prompt)}
							</span>
							<span className="w-[48px] shrink-0 text-right font-mono text-[10px] leading-3 text-(--color-text-2)">
								{formatDurationMs(phaseElapsedMs(run, now))}
							</span>
							<span className="w-[52px] shrink-0 text-right font-mono text-[10px] leading-3 text-(--color-text-2)">
								{run.costUsd === null ? "—" : formatCostUsd(run.costUsd)}
							</span>
						</Link>
					))}
					<div className="flex h-[38px] shrink-0 items-center gap-3 border-t border-(--color-border) px-2.5">
						<span className="font-mono text-[9px] leading-3 text-(--color-text-3)">
							NEWEST-RUNS WINDOW · FALLBACK POLL
						</span>
						<span className="flex-1" />
						<Link
							to="/runs"
							className="text-[11px] leading-3.5 text-(--color-primary) hover:underline"
						>
							View all runs →
						</Link>
					</div>
				</div>
			</div>
		</div>
	);
}

/** Mobile active-workload card (warren-dea8): state, run, agent ·
 *  project, activity line, elapsed · cost figures. */
function ActiveWorkloadCard({
	run,
	projectLabel,
	now,
}: {
	run: RunRow;
	projectLabel: string;
	now: number;
}) {
	const tone = run.state === "running" ? "info" : "warning";
	return (
		<InventoryRowCard
			tone={tone}
			stateLabel={run.state}
			title={run.id}
			titleTo={`/runs/${run.id}`}
			subline={`${run.agentName} · ${projectLabel}`}
			figures={
				<>
					<CardFigure value={formatDurationMs(phaseElapsedMs(run, now))} />
					<CardFigureNote value={run.costUsd === null ? "—" : formatCostUsd(run.costUsd)} />
				</>
			}
			meta={run.state === "queued" ? "awaiting admission" : activityLine(run.prompt)}
		/>
	);
}
