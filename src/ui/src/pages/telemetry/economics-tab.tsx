import { useQuery } from "@tanstack/react-query";
import { type ReactNode, useMemo } from "react";
import { Link } from "react-router-dom";
import {
	analyticsApi,
	COST_ANALYTICS_NONE_KEY,
	type CostBucket,
	projectsApi,
	runAnalyticsApi,
} from "@/api/client.ts";
import type { RunRow } from "@/api/types.ts";
import { EmptyState } from "@/components/ui/empty-state.tsx";
import { SkeletonRows } from "@/components/ui/skeleton.tsx";
import {
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from "@/components/ui/table.tsx";
import { formatCostUsd } from "@/pages/run-detail-format.ts";
import { SpendRow, TelemetryEconomicsSidePanels } from "@/pages/telemetry/economics-panels.tsx";
import { formatDuration } from "@/pages/telemetry/format.ts";
import { type JudgeStoreRow, useJudgeVerdicts } from "@/pages/telemetry/judge-verdicts.ts";
import { useRunsJoin } from "@/pages/telemetry/runs-join.ts";
import {
	PanelEmpty,
	PanelError,
	PanelLoading,
	TelemetryPanel,
} from "@/pages/telemetry/telemetry-panel.tsx";
import { useTelemetryWindow } from "@/pages/telemetry/use-telemetry-window.tsx";

/**
 * Telemetry · Economics (warren-7197, migrated in warren-9474): spend by
 * project plus the agent economics table — success from run state, judge
 * pass from the extension's verdicts, cost per merged PR from the
 * outcome-joined rollup. The route is operator-gated, so USD figures are
 * present here.
 */

/** Project rows the spend list renders before folding the tail. */
const PROJECT_ROWS = 5;

function projectLabel(bucket: CostBucket, urls: Map<string, string>): string {
	if (bucket.key === COST_ANALYTICS_NONE_KEY) return "No project";
	const url = urls.get(bucket.key);
	if (url === undefined) return bucket.key;
	return url.replace(/^https:\/\/github\.com\//, "").replace(/\.git$/, "");
}

function SpendPanel({ from, to }: { from: string; to: string }) {
	const cost = useQuery({
		queryKey: ["analytics", "cost", { projectId: null, from, to }],
		queryFn: ({ signal }) => analyticsApi.cost({ from, to }, signal),
	});
	const projects = useQuery({
		queryKey: ["projects"],
		queryFn: ({ signal }) => projectsApi.list(signal),
	});

	const totals = cost.data?.totals;
	const buckets = [...(cost.data?.breakdowns.project ?? [])].sort((a, b) => b.costUsd - a.costUsd);
	const visible = buckets.slice(0, PROJECT_ROWS);
	const hidden = buckets.slice(PROJECT_ROWS);
	const hiddenCost = hidden.reduce((sum, b) => sum + b.costUsd, 0);
	const urls = new Map((projects.data?.projects ?? []).map((p) => [p.id, p.gitUrl]));

	let body: ReactNode;
	if (cost.isError) {
		body = <PanelError what="spend" error={cost.error} onRetry={() => void cost.refetch()} />;
	} else if (cost.isLoading) {
		body = <PanelLoading rows={4} />;
	} else if (visible.length === 0) {
		body = <PanelEmpty>No spend recorded in this window.</PanelEmpty>;
	} else {
		body = (
			<>
				{visible.map((b) => (
					<SpendRow
						key={b.key}
						name={projectLabel(b, urls)}
						costUsd={formatCostUsd(b.costUsd)}
						href={
							b.key === COST_ANALYTICS_NONE_KEY
								? undefined
								: `/projects/${encodeURIComponent(b.key)}`
						}
					/>
				))}
				{hidden.length > 0 ? (
					<SpendRow name={`${hidden.length} more projects`} costUsd={formatCostUsd(hiddenCost)} />
				) : null}
				{totals !== undefined && totals.runs > totals.priced ? (
					<p className="text-xs text-(--color-text-3)">
						{(totals.runs - totals.priced).toLocaleString()} runs recorded no cost; they count
						toward runs but not spend.
					</p>
				) : null}
			</>
		);
	}

	return (
		<TelemetryPanel
			title="Spend by project"
			meta={
				totals === undefined
					? undefined
					: `${formatCostUsd(totals.costUsd)} across ${totals.priced.toLocaleString()} priced runs`
			}
		>
			{body}
		</TelemetryPanel>
	);
}

interface AgentEconomicsRow {
	readonly agent: string;
	readonly runs: number;
	readonly successRate: number | null;
	readonly avgDurationMs: number | null;
	readonly costPerMergedPrUsd: number | null;
}

/**
 * Judge pass per agent: verdict rows joined with recent runs for the
 * agent name. Absent extension → undefined → every agent renders "—".
 */
function computeAgentPass(
	verdicts: readonly JudgeStoreRow[],
	runsJoin: readonly RunRow[],
): Map<string, { pass: number; total: number }> {
	const agentPass = new Map<string, { pass: number; total: number }>();
	const runAgent = new Map(runsJoin.map((r) => [r.id, r.agentName]));
	for (const row of verdicts) {
		const agent = runAgent.get(row.runId);
		if (agent === undefined) continue;
		const counts = agentPass.get(agent) ?? { pass: 0, total: 0 };
		counts.total += 1;
		const assignments = row.verdict?.assignments ?? [];
		if (row.kind === "verdict" && assignments.length > 0) {
			if (assignments.every((a) => a.class === "clean")) counts.pass += 1;
		}
		agentPass.set(agent, counts);
	}
	return agentPass;
}

function percent(rate: number | null): string {
	return rate === null ? "—" : `${Math.round(rate * 100)}%`;
}

function EconomicsAgentRow({
	row,
	pass,
}: {
	row: AgentEconomicsRow;
	pass?: { pass: number; total: number };
}) {
	return (
		<TableRow>
			<TableCell>
				<Link
					to={`/agents/${encodeURIComponent(row.agent)}`}
					className="text-(--color-text) hover:text-(--color-primary) hover:underline"
				>
					{row.agent}
				</Link>
			</TableCell>
			<TableCell className="text-right text-(--color-text-2)">
				{row.runs.toLocaleString()}
			</TableCell>
			<TableCell className="text-right text-(--color-text-2)">{percent(row.successRate)}</TableCell>
			<TableCell className="text-right text-(--color-text-2)">
				{pass === undefined || pass.total === 0 ? "—" : percent(pass.pass / pass.total)}
			</TableCell>
			<TableCell className="text-right text-(--color-text-2)">
				{formatDuration(row.avgDurationMs)}
			</TableCell>
			<TableCell className="text-right text-(--color-text)">
				{row.costPerMergedPrUsd === null || row.costPerMergedPrUsd === undefined
					? "—"
					: formatCostUsd(row.costPerMergedPrUsd)}
			</TableCell>
		</TableRow>
	);
}

function AgentEconomicsTable() {
	const { from, to } = useTelemetryWindow();
	const runs = useQuery({
		queryKey: ["analytics", "runs", { projectId: null, from, to }],
		queryFn: ({ signal }) => runAnalyticsApi.runs({ from, to }, signal),
	});
	const verdicts = useJudgeVerdicts();
	const runsJoin = useRunsJoin();

	const rows = useMemo<AgentEconomicsRow[]>(() => {
		const costByAgent = new Map(
			(runs.data?.outcomes.costPerMergedPr.byAgent ?? []).map((b) => [b.key, b]),
		);
		return [...(runs.data?.byAgent ?? [])]
			.sort((a, b) => b.runs - a.runs)
			.map((b) => ({
				agent: b.key,
				runs: b.runs,
				successRate: b.successRate,
				avgDurationMs: b.avgDurationMs,
				costPerMergedPrUsd: costByAgent.get(b.key)?.costPerMergedPrUsd ?? null,
			}));
	}, [runs.data]);
	const agentPass = useMemo(
		() =>
			verdicts.data?.available === true
				? computeAgentPass(verdicts.data.rows, runsJoin.data?.runs ?? [])
				: undefined,
		[verdicts.data, runsJoin.data?.runs],
	);

	let body: ReactNode;
	if (runs.isError) {
		body = (
			<div className="p-4">
				<PanelError what="agent figures" error={runs.error} onRetry={() => void runs.refetch()} />
			</div>
		);
	} else if (runs.isLoading) {
		body = <SkeletonRows rows={4} />;
	} else if (rows.length === 0) {
		body = <EmptyState compact title="No runs in this window" />;
	} else {
		body = (
			<Table>
				<TableHeader>
					<TableRow>
						<TableHead>Agent</TableHead>
						<TableHead className="text-right">Runs</TableHead>
						<TableHead className="text-right">Succeeded</TableHead>
						<TableHead className="text-right">Judge pass</TableHead>
						<TableHead className="text-right">Avg duration</TableHead>
						<TableHead className="text-right">Cost per merged PR</TableHead>
					</TableRow>
				</TableHeader>
				<TableBody>
					{rows.map((r) => (
						<EconomicsAgentRow key={r.agent} row={r} pass={agentPass?.get(r.agent)} />
					))}
				</TableBody>
			</Table>
		);
	}

	return (
		<TelemetryPanel title="Agent economics" meta="Cost and outcomes per agent" flush>
			{body}
		</TelemetryPanel>
	);
}

export function TelemetryEconomicsTab() {
	const { from, to } = useTelemetryWindow();
	return (
		<div className="grid min-w-0 content-start gap-4">
			<AgentEconomicsTable />
			<div className="grid items-start gap-4 md:grid-cols-2">
				<SpendPanel from={from} to={to} />
				<TelemetryEconomicsSidePanels />
			</div>
		</div>
	);
}
