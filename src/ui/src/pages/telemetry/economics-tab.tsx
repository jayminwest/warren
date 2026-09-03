import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import {
	analyticsApi,
	COST_ANALYTICS_NONE_KEY,
	type CostBucket,
	projectsApi,
	runAnalyticsApi,
} from "@/api/client.ts";
import type { RunRow } from "@/api/types.ts";
import { cn } from "@/lib/utils.ts";
import { formatCostUsd } from "@/pages/run-detail-format.ts";
import { ECONOMICS_FILL_RAMP } from "@/pages/telemetry/economics-helpers.ts";
import { SpendRow, TelemetryEconomicsSidePanels } from "@/pages/telemetry/economics-panels.tsx";
import { formatDuration } from "@/pages/telemetry/format.ts";
import { type JudgeStoreRow, useJudgeVerdicts } from "@/pages/telemetry/judge-verdicts.ts";
import { MeterBar } from "@/pages/telemetry/meter-bar.tsx";
import { useRunsJoin } from "@/pages/telemetry/runs-join.ts";
import { TelemetryPanel } from "@/pages/telemetry/telemetry-panel.tsx";
import { useTelemetryWindow } from "@/pages/telemetry/use-telemetry-window.tsx";

/**
 * Telemetry · Economics (warren-7197 / pl-7e38 step 14): spend over
 * runs.cost_usd plus the agent economics table — success from run
 * state, judge pass from the extension's verdicts, cost per merged PR
 * from the outcome-joined rollup. The route is operator-gated (GET
 * /analytics/cost is readOperator), so USD figures are always present
 * here.
 */

/** Project rows the spend list renders before folding the tail. */
const PROJECT_ROWS = 5;

function projectLabel(bucket: CostBucket, urls: Map<string, string>): string {
	if (bucket.key === COST_ANALYTICS_NONE_KEY) return "(unattributed)";
	const url = urls.get(bucket.key);
	if (url === undefined) return bucket.key;
	return url.replace(/^https:\/\/github\.com\//, "");
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

	return (
		<TelemetryPanel
			title="Spend"
			meta={
				totals === undefined
					? "LOADING"
					: `${formatCostUsd(totals.costUsd)} · ${String(totals.priced)} OF ${String(totals.runs)} RUNS PRICED`
			}
		>
			{cost.isError ? (
				<p className="text-sm text-(--color-danger)">
					Failed to load cost analytics. {(cost.error as Error | null)?.message ?? ""}
				</p>
			) : visible.length === 0 && !cost.isLoading ? (
				<p className="text-[12px] leading-4 text-(--color-text-3)">
					No spend recorded in this window.
				</p>
			) : (
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
						<SpendRow name={`${String(hidden.length)} more`} costUsd={formatCostUsd(hiddenCost)} />
					) : null}
					<p className="text-[12px] leading-4 text-(--color-text-2)">
						{totals !== undefined && totals.runs > totals.priced
							? `${String(totals.runs - totals.priced)} runs carry no recorded cost. They are counted, not priced.`
							: "Spend over runs.cost_usd in the selected window."}
					</p>
				</>
			)}
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
		if (row.kind === "verdict" && (row.verdict?.assignments ?? []).length > 0) {
			const clean = (row.verdict?.assignments ?? []).every((a) => a.class === "clean");
			if (clean) counts.pass += 1;
		}
		agentPass.set(agent, counts);
	}
	return agentPass;
}

function EconomicsAgentRow({
	row,
	pass,
}: {
	row: AgentEconomicsRow;
	pass?: { pass: number; total: number };
}) {
	return (
		<tr className="border-b border-(--color-border) last:border-b-0">
			<td className="py-1.5 pr-3">
				<Link
					to={`/agents/${encodeURIComponent(row.agent)}`}
					className="font-mono text-[11px] leading-[14px] text-(--color-text-2) underline-offset-2 hover:underline"
				>
					{row.agent}
				</Link>
			</td>
			<td className="py-1.5 pr-3 text-right font-mono text-[11px] leading-[14px] text-(--color-text-2)">
				{String(row.runs)}
			</td>
			<td className="py-1.5 pr-3 text-right font-mono text-[11px] leading-[14px] text-(--color-text-2)">
				{row.successRate === null ? "—" : `${Math.round(row.successRate * 100)}%`}
			</td>
			<td className="py-1.5 pr-3 text-right font-mono text-[11px] leading-[14px] text-(--color-text-3)">
				{pass === undefined || pass.total === 0
					? "—"
					: `${Math.round((pass.pass / pass.total) * 100)}%`}
			</td>
			<td className="py-1.5 pr-3 text-right font-mono text-[11px] leading-[14px] text-(--color-text-3)">
				{formatDuration(row.avgDurationMs)}
			</td>
			<td className="py-1.5 text-right font-mono text-[11px] leading-[14px] text-(--color-text)">
				{row.costPerMergedPrUsd === null || row.costPerMergedPrUsd === undefined
					? "—"
					: formatCostUsd(row.costPerMergedPrUsd)}
			</td>
		</tr>
	);
}

/**
 * Below-md arm (warren-756e): one meter row per agent — 80px label,
 * track filled by cost-per-merged-PR share (bar width relative to the
 * window max; agents without a denominator render the quiet stub),
 * 42px value. Runs/success/duration stay in the title tooltip.
 */
function AgentEconomicsMeterRow({
	row,
	pass,
	rank,
	maxCost,
}: {
	row: AgentEconomicsRow;
	pass?: { pass: number; total: number };
	rank: number;
	maxCost: number;
}) {
	const known = row.costPerMergedPrUsd !== null && row.costPerMergedPrUsd !== undefined;
	const width =
		known && maxCost > 0
			? `${Math.max(4, Math.round(((row.costPerMergedPrUsd ?? 0) / maxCost) * 100))}%`
			: "4px";
	const judgePass =
		pass === undefined || pass.total === 0 ? "—" : `${Math.round((pass.pass / pass.total) * 100)}%`;
	return (
		<MeterBar
			label={row.agent}
			labelClass="w-[80px] overflow-clip max-md:text-[9px] max-md:leading-[11px] text-(--color-text-2)"
			width={width}
			markClass={cn("h-2 bg-(--color-success)", ECONOMICS_FILL_RAMP[rank] ?? "opacity-45")}
			title={`${row.agent} · ${String(row.runs)} runs · ${
				row.successRate === null ? "—" : `${Math.round(row.successRate * 100)}%`
			} success · ${judgePass} judge pass · ${formatDuration(row.avgDurationMs)} avg`}
			value={known ? formatCostUsd(row.costPerMergedPrUsd ?? 0) : "—"}
			valueClass="w-[42px] text-right text-(--color-text)"
		/>
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

	const byAgent = [...(runs.data?.byAgent ?? [])].sort((a, b) => b.runs - a.runs);
	const costByAgent = new Map(
		(runs.data?.outcomes.costPerMergedPr.byAgent ?? []).map((b) => [b.key, b]),
	);
	const agentPass =
		verdicts.data?.available === true
			? computeAgentPass(verdicts.data.rows, runsJoin.data?.runs ?? [])
			: undefined;
	const rows: AgentEconomicsRow[] = byAgent.map((b) => ({
		agent: b.key,
		runs: b.runs,
		successRate: b.successRate,
		avgDurationMs: b.avgDurationMs,
		costPerMergedPrUsd: costByAgent.get(b.key)?.costPerMergedPrUsd ?? null,
	}));

	const maxCostPerPr = rows.reduce((m, r) => Math.max(m, r.costPerMergedPrUsd ?? 0), 0);

	return (
		<TelemetryPanel title="Agent economics" meta="COST AND OUTCOMES PER AGENT">
			{runs.isError ? (
				<p className="text-sm text-(--color-danger)">
					Failed to load run analytics. {(runs.error as Error | null)?.message ?? ""}
				</p>
			) : rows.length === 0 && !runs.isLoading ? (
				<p className="text-[12px] leading-4 text-(--color-text-3)">No runs in this window.</p>
			) : (
				<>
					{/* Below md: meter-row list (warren-756e, mock :272-315) —
				    no horizontally-scrolling 6-column table at 375px. */}
					<div className="flex flex-col gap-[9px] md:hidden">
						{rows.map((r, i) => (
							<AgentEconomicsMeterRow
								key={r.agent}
								row={r}
								pass={agentPass?.get(r.agent)}
								rank={i}
								maxCost={maxCostPerPr}
							/>
						))}
					</div>
					<div className="hidden overflow-x-auto md:block">
						<table className="w-full">
							<thead>
								<tr>
									{["AGENT", "RUNS", "SUCCESS", "JUDGE PASS", "AVG DUR", "COST / MERGED PR"].map(
										(h, i) => (
											<th
												key={h}
												className={`pb-2 pr-3 text-left font-mono text-[10px] tracking-[0.06em] text-(--color-text-3) ${i >= 1 ? "text-right" : ""}`}
											>
												{h}
											</th>
										),
									)}
								</tr>
							</thead>
							<tbody>
								{rows.map((r) => (
									<EconomicsAgentRow key={r.agent} row={r} pass={agentPass?.get(r.agent)} />
								))}
							</tbody>
						</table>
					</div>
				</>
			)}
		</TelemetryPanel>
	);
}

export function TelemetryEconomicsTab() {
	const { from, to } = useTelemetryWindow();
	return (
		<div className="flex flex-col gap-4">
			<SpendPanel from={from} to={to} />
			<AgentEconomicsTable />
			{/* warren-cc6c: the slices /analytics/cost + /analytics/runs already serve. */}
			<TelemetryEconomicsSidePanels />
		</div>
	);
}
