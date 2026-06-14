import { useQuery } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { plotsApi, projectsApi } from "@/api/client.ts";
import {
	PLOT_STATUSES,
	type NeedsAttentionReason,
	type PlotStatus,
	type PlotSummary,
} from "@/api/types.ts";
import { NewPlotDialog } from "@/components/NewPlotButton.tsx";
import { RefreshProjectsCTA } from "@/components/RefreshProjectsCTA.tsx";
import { Button } from "@/components/ui/button.tsx";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card.tsx";
import { PageHeader } from "@/components/ui/page-header.tsx";
import { relativeTime } from "@/lib/utils.ts";

const STATUS_FILTERS: { label: string; value: "all" | PlotStatus }[] = [
	{ label: "All", value: "all" },
	...PLOT_STATUSES.map((s) => ({
		label: s.charAt(0).toUpperCase() + s.slice(1),
		value: s,
	})),
];

type SortKey = "last_event_ts" | "name" | "status";
type SortDir = "asc" | "desc";

const NEEDS_ATTENTION_LABELS: Record<NeedsAttentionReason, string> = {
	paused_run: "paused run",
	merged_pr_unreviewed: "PR merged",
	stale_draft: "stale draft",
};

/**
 * /plots — sortable cross-project Plot list (warren-e3e6, pl-9d6a step 5).
 *
 * Default sort is `last_event_ts` desc; clicking column headers toggles
 * direction and switches the key. Status filter chips drive the server
 * `?status=` query (server side does the actual filtering — keeps the
 * UI list query the single source of truth for what's "visible"). The
 * New-Plot dialog filters the project picker to `hasPlot=true` only and
 * surfaces the documented empty-state copy when zero such projects
 * exist (mx-0b5f9c contract).
 */
export function PlotsPage() {
	const [statusFilter, setStatusFilter] = useState<"all" | PlotStatus>("all");
	const [needsAttention, setNeedsAttention] = useState(false);
	const [sortKey, setSortKey] = useState<SortKey>("last_event_ts");
	const [sortDir, setSortDir] = useState<SortDir>("desc");
	const [dialogOpen, setDialogOpen] = useState(false);

	const plots = useQuery({
		queryKey: ["plots", statusFilter, needsAttention ? "needs_attention" : "all"],
		queryFn: ({ signal }) =>
			plotsApi.list(
				{
					...(statusFilter === "all" ? {} : { status: statusFilter }),
					...(needsAttention ? { filter: "needs_attention" as const } : {}),
				},
				signal,
			),
		refetchInterval: 5000,
	});

	const projects = useQuery({
		queryKey: ["projects"],
		queryFn: ({ signal }) => projectsApi.list(signal),
	});

	const hasPlotProjects = useMemo(
		() => (projects.data?.projects ?? []).filter((p) => p.hasPlot),
		[projects.data],
	);

	const projectIndex = useMemo(() => {
		const m = new Map<string, string>();
		for (const p of projects.data?.projects ?? []) m.set(p.id, p.gitUrl);
		return m;
	}, [projects.data]);

	const sortedPlots = useMemo(() => {
		const rows = [...(plots.data?.plots ?? [])];
		const dir = sortDir === "asc" ? 1 : -1;
		rows.sort((a, b) => {
			let cmp = 0;
			if (sortKey === "last_event_ts") cmp = a.last_event_ts.localeCompare(b.last_event_ts);
			else if (sortKey === "name") cmp = a.name.localeCompare(b.name);
			else cmp = a.status.localeCompare(b.status);
			return cmp * dir;
		});
		return rows;
	}, [plots.data, sortKey, sortDir]);

	const handleSort = (key: SortKey): void => {
		if (sortKey === key) {
			setSortDir(sortDir === "asc" ? "desc" : "asc");
		} else {
			setSortKey(key);
			setSortDir(key === "last_event_ts" ? "desc" : "asc");
		}
	};

	const sortIndicator = (key: SortKey): string => {
		if (sortKey !== key) return "";
		return sortDir === "asc" ? " ↑" : " ↓";
	};

	return (
		<div className="space-y-6">
			<PageHeader
				title="Plots"
				description="Shared coordination substrate — humans and agents as peer nodes on a per-Plot event log."
				actions={
					<Button onClick={() => setDialogOpen(true)} disabled={projects.isLoading}>
						New Plot
					</Button>
				}
			/>

			<div className="flex flex-wrap items-center gap-2">
				{/* Needs-you chip is a parallel toggle, separated visually
				    by a divider — it composes on top of the status filter
				    (warren-d693 server contract: ?filter+?status compose). */}
				<button
					type="button"
					onClick={() => setNeedsAttention((v) => !v)}
					aria-pressed={needsAttention}
					className={`rounded-full border px-3 py-1 text-xs transition-colors ${
						needsAttention
							? "bg-(--color-primary) text-(--color-primary-foreground)"
							: "bg-(--color-card) hover:bg-(--color-accent)"
					}`}
				>
					Needs you
				</button>
				<span
					aria-hidden="true"
					className="mx-1 h-4 w-px bg-(--color-border)"
				/>
				{STATUS_FILTERS.map((f) => (
					<button
						key={f.value}
						type="button"
						onClick={() => setStatusFilter(f.value)}
						className={`rounded-full border px-3 py-1 text-xs transition-colors ${
							statusFilter === f.value
								? "bg-(--color-primary) text-(--color-primary-foreground)"
								: "bg-(--color-card) hover:bg-(--color-accent)"
						}`}
					>
						{f.label}
					</button>
				))}
			</div>

			<Card>
				<CardHeader>
					<CardTitle>{sortedPlots.length} plots</CardTitle>
				</CardHeader>
				<CardContent className="p-0">
					{plots.isLoading ? (
						<p className="p-6 text-sm text-(--color-muted-foreground)">Loading…</p>
					) : plots.isError ? (
						<p className="p-6 text-sm text-(--color-destructive)">
							{plots.error instanceof Error
								? plots.error.message
								: String(plots.error)}
						</p>
					) : sortedPlots.length === 0 ? (
						<EmptyState
							hasPlotProjectCount={hasPlotProjects.length}
							statusFiltered={statusFilter !== "all"}
							needsAttention={needsAttention}
						/>
					) : (
						<PlotsTable
							plots={sortedPlots}
							projectLabel={(id) => projectIndex.get(id) ?? id}
							sortIndicator={sortIndicator}
							onSort={handleSort}
						/>
					)}
				</CardContent>
			</Card>

			<NewPlotDialog
				open={dialogOpen}
				onOpenChange={setDialogOpen}
				hasPlotProjects={hasPlotProjects}
			/>
		</div>
	);
}

function EmptyState({
	hasPlotProjectCount,
	statusFiltered,
	needsAttention,
}: {
	hasPlotProjectCount: number;
	statusFiltered: boolean;
	needsAttention: boolean;
}) {
	if (needsAttention) {
		return (
			<p className="p-6 text-sm text-(--color-muted-foreground)">
				Nothing needs your attention right now—every Plot is unblocked.
			</p>
		);
	}
	if (statusFiltered) {
		return (
			<p className="p-6 text-sm text-(--color-muted-foreground)">
				No plots match this status filter.
			</p>
		);
	}
	const headline =
		hasPlotProjectCount === 0
			? "No Plot-enabled projects yet — run plot init in a project clone, commit, then refresh."
			: "No plots yet. Click New Plot to create one, or refresh if you just committed one.";
	return (
		<div className="space-y-3 p-6 text-sm text-(--color-muted-foreground)">
			<p>{headline}</p>
			<RefreshProjectsCTA />
		</div>
	);
}

function PlotsTable({
	plots,
	projectLabel,
	sortIndicator,
	onSort,
}: {
	plots: PlotSummary[];
	projectLabel: (projectId: string) => string;
	sortIndicator: (key: SortKey) => string;
	onSort: (key: SortKey) => void;
}) {
	return (
		<div className="relative w-full overflow-auto">
		<table className="w-full caption-bottom text-sm">
			<thead className="border-b">
				<tr className="text-left text-(--color-muted-foreground)">
					<th className="h-10 whitespace-nowrap px-4 font-medium">
						<button
							type="button"
							onClick={() => onSort("name")}
							className="hover:text-(--color-foreground)"
						>
							Name{sortIndicator("name")}
						</button>
					</th>
					<th className="h-10 whitespace-nowrap px-4 font-medium">
						<button
							type="button"
							onClick={() => onSort("status")}
							className="hover:text-(--color-foreground)"
						>
							Status{sortIndicator("status")}
						</button>
					</th>
					<th className="h-10 whitespace-nowrap px-4 font-medium">Intent</th>
					<th className="h-10 whitespace-nowrap px-4 font-medium">Project</th>
					<th className="h-10 whitespace-nowrap px-4 font-medium text-right">
						Attachments
					</th>
					<th className="h-10 whitespace-nowrap px-4 font-medium">
						<button
							type="button"
							onClick={() => onSort("last_event_ts")}
							className="hover:text-(--color-foreground)"
						>
							Last event{sortIndicator("last_event_ts")}
						</button>
					</th>
				</tr>
			</thead>
			<tbody>
				{plots.map((p) => (
					<tr key={`${p.project_id}::${p.id}`} className="border-b last:border-0">
						<td className="whitespace-nowrap px-4 py-2">
							<Link
								to={`/plots/${encodeURIComponent(p.id)}`}
								className="font-medium underline-offset-2 hover:underline"
							>
								{p.name}
							</Link>
							<div className="font-mono text-xs text-(--color-muted-foreground)">
								{p.id}
							</div>
						</td>
						<td className="whitespace-nowrap px-4 py-2">
							<div className="flex flex-wrap items-center gap-1">
								<span className="rounded-full border px-2 py-0.5 text-xs">
									{p.status}
								</span>
								{p.reasons?.map((r) => (
									<span
										key={r}
										className="rounded-full bg-(--color-primary)/15 px-2 py-0.5 text-xs text-(--color-primary)"
										title={`Needs you: ${r}`}
									>
										{NEEDS_ATTENTION_LABELS[r]}
									</span>
								))}
							</div>
						</td>
						<td className="max-w-[16rem] truncate px-4 py-2 text-(--color-muted-foreground)">
							{p.intent_goal_preview || "—"}
						</td>
						<td className="whitespace-nowrap px-4 py-2 font-mono text-xs">
							{projectLabel(p.project_id)}
						</td>
						<td className="whitespace-nowrap px-4 py-2 text-right font-mono text-xs">
							{p.attachments_count}
						</td>
						<td className="whitespace-nowrap px-4 py-2 text-(--color-muted-foreground)">
							<div>{relativeTime(p.last_event_ts)}</div>
							<div className="font-mono text-xs">{p.last_event_actor}</div>
						</td>
					</tr>
				))}
			</tbody>
		</table>
		</div>
	);
}
