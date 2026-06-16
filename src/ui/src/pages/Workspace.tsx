import { useQuery } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { conversationsApi, plotsApi, projectsApi } from "@/api/client.ts";
import {
	PLOT_STATUSES,
	type ConversationRow,
	type NeedsAttentionReason,
	type PlotStatus,
	type PlotSummary,
} from "@/api/types.ts";
import { NewPlotButton } from "@/components/NewPlotButton.tsx";
import { RefreshProjectsCTA } from "@/components/RefreshProjectsCTA.tsx";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card.tsx";
import { PageHeader } from "@/components/ui/page-header.tsx";
import {
	SortableTableHead,
	type SortState,
} from "@/components/ui/sortable-table-head.tsx";
import {
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from "@/components/ui/table.tsx";
import {
	compareStrings,
	type Comparator,
	useClientSort,
} from "@/hooks/use-client-sort.ts";
import { relativeTime } from "@/lib/utils.ts";
import { NewConversationButton } from "./leveret/new-conversation-dialog.tsx";

const STATUS_FILTERS: { label: string; value: "all" | PlotStatus }[] = [
	{ label: "All", value: "all" },
	...PLOT_STATUSES.map((s) => ({
		label: s.charAt(0).toUpperCase() + s.slice(1),
		value: s,
	})),
];

type SortKey = "last_event_ts" | "name" | "status";

const PLOT_COMPARATORS: Record<SortKey, Comparator<PlotSummary>> = {
	name: (a, b) => compareStrings(a.name, b.name),
	status: (a, b) => compareStrings(a.status, b.status),
	last_event_ts: (a, b) => compareStrings(a.last_event_ts, b.last_event_ts),
};

const NEEDS_ATTENTION_LABELS: Record<NeedsAttentionReason, string> = {
	paused_run: "paused run",
	merged_pr_unreviewed: "PR merged",
	stale_draft: "stale draft",
};

/**
 * /workspace — single cross-project list, one row per Plot (warren-dc54 /
 * pl-0008 step 5).
 *
 * The Plot is the durable spine; this view merges what used to live on two
 * pages (the Plots list and the Leveret conversations list) into one. Each
 * row joins a `PlotSummary` (from `plotsApi.list`, the server `?status` /
 * `?filter=needs_attention` contract still the single source of visibility
 * truth) with its active Leveret conversation (resolved client-side from
 * `conversationsApi.list`). Actions: New Plot (shared dialog) and Start
 * conversation (the existing Leveret dialog).
 */
export function WorkspacePage() {
	const [statusFilter, setStatusFilter] = useState<"all" | PlotStatus>("all");
	const [needsAttention, setNeedsAttention] = useState(false);

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

	const conversations = useQuery({
		queryKey: ["conversations", "all"],
		queryFn: ({ signal }) => conversationsApi.list({}, signal),
		refetchInterval: 5000,
	});

	const projects = useQuery({
		queryKey: ["projects"],
		queryFn: ({ signal }) => projectsApi.list(signal),
	});

	const projectIndex = useMemo(() => {
		const m = new Map<string, string>();
		for (const p of projects.data?.projects ?? []) m.set(p.id, p.gitUrl);
		return m;
	}, [projects.data]);

	const hasPlotProjectCount = useMemo(
		() => (projects.data?.projects ?? []).filter((p) => p.hasPlot).length,
		[projects.data],
	);

	// Resolve the most-recent active conversation per Plot. Closed
	// conversations surface in the Plot's Activity tab (step 10), not here.
	const activeConversationByPlot = useMemo(() => {
		const m = new Map<string, ConversationRow>();
		for (const c of conversations.data?.conversations ?? []) {
			if (c.status !== "active" || !c.plotId) continue;
			const prev = m.get(c.plotId);
			if (!prev || c.lastActivityAt > prev.lastActivityAt) m.set(c.plotId, c);
		}
		return m;
	}, [conversations.data]);

	const {
		sorted: sortedPlots,
		sort,
		onSort,
	} = useClientSort(plots.data?.plots ?? [], PLOT_COMPARATORS, {
		initialKey: "last_event_ts",
		initialDirection: "desc",
		defaultDirections: { last_event_ts: "desc" },
	});

	return (
		<div className="space-y-6">
			<PageHeader
				title="Workspace"
				description="One row per Plot — the durable spine. Shape intent in a conversation, then plan and run, all from one place."
				actions={
					<div className="flex items-center gap-2">
						<NewConversationButton />
						<NewPlotButton destination="/workspace" />
					</div>
				}
			/>

			<div className="flex flex-wrap items-center gap-2">
				{/* Needs-you chip composes on top of the status filter
				    (server contract: ?filter+?status compose). */}
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
				<span aria-hidden="true" className="mx-1 h-4 w-px bg-(--color-border)" />
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
							{plots.error instanceof Error ? plots.error.message : String(plots.error)}
						</p>
					) : sortedPlots.length === 0 ? (
						<EmptyState
							hasPlotProjectCount={hasPlotProjectCount}
							statusFiltered={statusFilter !== "all"}
							needsAttention={needsAttention}
						/>
					) : (
						<WorkspaceTable
							plots={sortedPlots}
							projectLabel={(id) => projectIndex.get(id) ?? id}
							activeConversation={(id) => activeConversationByPlot.get(id)}
							sort={sort}
							onSort={onSort}
						/>
					)}
				</CardContent>
			</Card>
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

function WorkspaceTable({
	plots,
	projectLabel,
	activeConversation,
	sort,
	onSort,
}: {
	plots: PlotSummary[];
	projectLabel: (projectId: string) => string;
	activeConversation: (plotId: string) => ConversationRow | undefined;
	sort: SortState<SortKey>;
	onSort: (key: SortKey) => void;
}) {
	return (
		<Table>
			<TableHeader>
				<TableRow>
					<SortableTableHead columnKey="name" sort={sort} onSort={onSort}>
						Name
					</SortableTableHead>
					<TableHead className="whitespace-nowrap">Project</TableHead>
					<SortableTableHead columnKey="status" sort={sort} onSort={onSort}>
						Status
					</SortableTableHead>
					<TableHead className="whitespace-nowrap">Intent</TableHead>
					<TableHead className="whitespace-nowrap">Conversation</TableHead>
					<SortableTableHead columnKey="last_event_ts" sort={sort} onSort={onSort}>
						Last activity
					</SortableTableHead>
				</TableRow>
			</TableHeader>
			<TableBody>
				{plots.map((p) => {
					const convo = activeConversation(p.id);
					return (
						<TableRow key={`${p.project_id}::${p.id}`}>
							<TableCell className="whitespace-nowrap">
								<Link
									to={`/workspace/${encodeURIComponent(p.id)}`}
									className="font-medium underline-offset-2 hover:underline"
								>
									{p.name}
								</Link>
								<div className="font-mono text-xs text-(--color-muted-foreground)">
									{p.id}
								</div>
							</TableCell>
							<TableCell className="whitespace-nowrap font-mono text-xs">
								{projectLabel(p.project_id)}
							</TableCell>
							<TableCell className="whitespace-nowrap">
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
							</TableCell>
							<TableCell className="max-w-[16rem] truncate text-(--color-muted-foreground)">
								{p.intent_goal_preview || "—"}
							</TableCell>
							<TableCell className="whitespace-nowrap">
								{convo ? (
									<Link
										to={`/workspace/${encodeURIComponent(p.id)}?tab=shape`}
										className="inline-flex items-center gap-1.5 text-xs underline-offset-2 hover:underline"
										title={convo.title ?? "Active conversation"}
									>
										<span
											aria-hidden="true"
											className="inline-block h-2 w-2 rounded-full bg-(--color-primary)"
										/>
										{convo.title || "Active"}
									</Link>
								) : (
									<span className="text-xs text-(--color-muted-foreground)">—</span>
								)}
							</TableCell>
							<TableCell className="whitespace-nowrap text-(--color-muted-foreground)">
								<div>{relativeTime(p.last_event_ts)}</div>
								<div className="font-mono text-xs">{p.last_event_actor}</div>
							</TableCell>
						</TableRow>
					);
				})}
			</TableBody>
		</Table>
	);
}
