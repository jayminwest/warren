import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import {
	analyticsApi,
	COST_ANALYTICS_NONE_KEY,
	type CostBucket,
	RUN_ANALYTICS_NONE_KEY,
	RUN_ANALYTICS_OTHER_KEY,
	runAnalyticsApi,
} from "@/api/client.ts";
import type { CostPerMergedPrBucket } from "@/api/run-analytics-types.ts";
import { formatCostUsd } from "@/pages/run-detail-format.ts";
import {
	cacheHitShare,
	dateBucketLabel,
	dateSpendSeries,
	sortBucketsDesc,
	topCostBuckets,
} from "@/pages/telemetry/economics-helpers.ts";
import { TelemetryPanel } from "@/pages/telemetry/telemetry-panel.tsx";
import { useTelemetryWindow } from "@/pages/telemetry/use-telemetry-window.tsx";

/**
 * Secondary economics panels (warren-cc6c): every slice the
 * /analytics/cost and /analytics/runs bodies already serve — spend over
 * time, spend by model/provider/agent, top runs, token totals with the
 * cache-hit share, and cost per merged PR by model/provider. Render
 * only what the wire carries; every absent field renders an honest
 * empty state (spectators get redacted bodies).
 */

function PanelError({ error }: { error: Error | null }) {
	return (
		<p className="text-sm text-(--color-danger)">
			Failed to load analytics. {error?.message ?? ""}
		</p>
	);
}

function PanelEmpty({ text }: { text: string }) {
	return <p className="text-[12px] leading-4 text-(--color-text-3)">{text}</p>;
}

/** One name + cost line. `href` turns the name into a router link. */
export function SpendRow({
	name,
	costUsd,
	href,
}: {
	name: string;
	costUsd: string;
	href?: string;
}) {
	const label =
		href === undefined ? (
			<span className="min-w-0 truncate font-mono text-[11px] leading-[14px] text-(--color-text-2)">
				{name}
			</span>
		) : (
			<Link
				to={href}
				className="min-w-0 truncate font-mono text-[11px] leading-[14px] text-(--color-text-2) underline-offset-2 hover:underline"
			>
				{name}
			</Link>
		);
	return (
		<div className="flex w-full items-center justify-between gap-3">
			{label}
			<span className="shrink-0 font-mono text-[11px] leading-[14px] text-(--color-text)">
				{costUsd}
			</span>
		</div>
	);
}

/** Top spend rows with the tail folded into one "N more" line. */
function TopSpendRows({
	buckets,
	hrefFor,
	limit = 5,
}: {
	buckets: readonly CostBucket[];
	hrefFor?: (key: string) => string | undefined;
	limit?: number;
}) {
	const sorted = sortBucketsDesc(buckets);
	const visible = sorted.slice(0, limit);
	const hidden = sorted.slice(limit);
	const hiddenCost = hidden.reduce((sum, b) => sum + b.costUsd, 0);
	return (
		<>
			{visible.map((b) => (
				<SpendRow
					key={b.key}
					name={b.key === COST_ANALYTICS_NONE_KEY ? "(unattributed)" : b.key}
					costUsd={formatCostUsd(b.costUsd)}
					href={hrefFor?.(b.key)}
				/>
			))}
			{hidden.length > 0 ? (
				<SpendRow name={`${String(hidden.length)} more`} costUsd={formatCostUsd(hiddenCost)} />
			) : null}
		</>
	);
}

function useCostAnalytics(from: string, to: string) {
	return useQuery({
		queryKey: ["analytics", "cost", { projectId: null, from, to }],
		queryFn: ({ signal }) => analyticsApi.cost({ from, to }, signal),
	});
}

function useRunAnalytics(from: string, to: string) {
	return useQuery({
		queryKey: ["analytics", "runs", { projectId: null, from, to }],
		queryFn: ({ signal }) => runAnalyticsApi.runs({ from, to }, signal),
	});
}

const ECONOMICS_FILL_RAMP = ["opacity-80", "opacity-60", "opacity-50", "opacity-45"] as const;

/**
 * Spend over time: one meter row per calendar day from
 * /analytics/cost breakdowns.date, oldest first, honoring the tab's
 * range selector via from/to.
 */
function SpendOverTimePanel({ from, to }: { from: string; to: string }) {
	const cost = useCostAnalytics(from, to);
	const series = dateSpendSeries(cost.data?.breakdowns?.date ?? []);
	const max = series.reduce((m, b) => Math.max(m, b.costUsd), 0);

	return (
		<TelemetryPanel title="Spend over time" meta="COST USD BY DAY">
			{cost.isError ? (
				<PanelError error={cost.error as Error | null} />
			) : series.length === 0 && !cost.isLoading ? (
				<PanelEmpty text="No dated spend in this window." />
			) : (
				series.map((b, i) => (
					<div key={b.key} className="flex w-full min-w-0 items-center justify-between gap-2.5">
						<span className="w-[46px] shrink-0 font-mono text-[11px] leading-[14px] text-(--color-text-2)">
							{dateBucketLabel(b.key)}
						</span>
						<div className="min-w-0 flex-1">
							<div
								className={cnRamp(i)}
								style={{
									width: max > 0 ? `${Math.max(4, Math.round((b.costUsd / max) * 100))}%` : "4px",
								}}
								title={dateBucketLabel(b.key)}
							/>
						</div>
						<span className="w-[52px] shrink-0 text-right font-mono text-[11px] leading-[14px] text-(--color-text)">
							{formatCostUsd(b.costUsd)}
						</span>
					</div>
				))
			)}
		</TelemetryPanel>
	);
}

/** Meter-mark color ramp, same shape as the agent economics rows. */
function cnRamp(i: number): string {
	return `h-2 rounded-[1px] bg-(--color-success) ${ECONOMICS_FILL_RAMP[i] ?? "opacity-45"}`;
}

/**
 * Spend by one dimension (model / provider / agent) from
 * /analytics/cost breakdowns — top 5 rows + folded remainder.
 */
function SpendByPanel({
	from,
	to,
	dimension,
	title,
	emptyText,
	hrefFor,
}: {
	from: string;
	to: string;
	dimension: "model" | "provider" | "agent";
	title: string;
	emptyText: string;
	hrefFor?: (key: string) => string | undefined;
}) {
	const cost = useCostAnalytics(from, to);
	const buckets: readonly CostBucket[] | undefined = cost.data?.breakdowns?.[dimension];

	return (
		<TelemetryPanel title={title} meta="COST USD">
			{cost.isError ? (
				<PanelError error={cost.error as Error | null} />
			) : buckets === undefined ? (
				<PanelEmpty text="Cost analytics unavailable for this view." />
			) : buckets.length === 0 ? (
				<PanelEmpty text={emptyText} />
			) : (
				<TopSpendRows buckets={buckets} hrefFor={hrefFor} />
			)}
		</TelemetryPanel>
	);
}

/**
 * Top-10 most expensive runs from /analytics/cost breakdowns.run —
 * bucket keys are run ids, linked to /runs/:id.
 */
function TopRunsPanel({ from, to }: { from: string; to: string }) {
	const cost = useCostAnalytics(from, to);
	const buckets = topCostBuckets(cost.data?.breakdowns.run ?? [], 10);

	return (
		<TelemetryPanel title="Top 10 most expensive runs" meta="COST USD PER RUN">
			{cost.isError ? (
				<PanelError error={cost.error as Error | null} />
			) : buckets.length === 0 && !cost.isLoading ? (
				<PanelEmpty text="No priced runs in this window." />
			) : (
				buckets.map((b) => (
					<SpendRow
						key={b.key}
						name={b.key === COST_ANALYTICS_NONE_KEY ? "(unattributed)" : b.key}
						costUsd={formatCostUsd(b.costUsd)}
						href={
							b.key === COST_ANALYTICS_NONE_KEY ? undefined : `/runs/${encodeURIComponent(b.key)}`
						}
					/>
				))
			)}
		</TelemetryPanel>
	);
}

/**
 * Token totals from /analytics/runs tokens.totals plus the cache-hit
 * share cacheRead / (input + cacheRead). The section is public, but the
 * guard stays: an absent breakdown renders an honest empty state.
 */
function TokenTotalsPanel() {
	const { from, to } = useTelemetryWindow();
	const runs = useRunAnalytics(from, to);
	const totals = runs.data?.tokens?.totals;

	return (
		<TelemetryPanel title="Token totals" meta="WINDOW TOTALS">
			{runs.isError ? (
				<PanelError error={runs.error as Error | null} />
			) : totals === undefined && !runs.isLoading ? (
				<PanelEmpty text="Token usage unavailable for this view." />
			) : totals === undefined ? null : (
				<>
					<SpendRow name="Input" costUsd={String(totals.input)} />
					<SpendRow name="Output" costUsd={String(totals.output)} />
					<SpendRow name="Cache read" costUsd={String(totals.cacheRead)} />
					<SpendRow name="Cache write" costUsd={String(totals.cacheWrite)} />
					<SpendRow name="Total" costUsd={String(totals.total)} />
					<p className="text-[12px] leading-4 text-(--color-text-2)">
						{cacheHitShare(totals) === null
							? "No prompt tokens recorded, so no cache-hit share."
							: `Cache-hit share: ${Math.round((cacheHitShare(totals) ?? 0) * 100)}% of prompt tokens served from cache.`}
					</p>
				</>
			)}
		</TelemetryPanel>
	);
}

/** Human label for a cost-per-merged-PR bucket key (sentinels fold). */
function mergedPrBucketLabel(key: string): string {
	if (key === RUN_ANALYTICS_NONE_KEY) return "(unattributed)";
	if (key === RUN_ANALYTICS_OTHER_KEY) return "(other)";
	return key;
}

/** Cost per merged PR for one dimension (byModel / byProvider). */
function CostPerMergedPrPanel({
	from,
	to,
	dimension,
	title,
	emptyText,
}: {
	from: string;
	to: string;
	dimension: "byModel" | "byProvider";
	title: string;
	emptyText: string;
}) {
	const runs = useRunAnalytics(from, to);
	const buckets: readonly CostPerMergedPrBucket[] | undefined =
		runs.data?.outcomes?.costPerMergedPr?.[dimension];

	return (
		<TelemetryPanel title={title} meta="COST USD PER MERGED PR">
			{runs.isError ? (
				<PanelError error={runs.error as Error | null} />
			) : buckets === undefined ? (
				<PanelEmpty text="Outcome rollup unavailable for this view." />
			) : buckets.length === 0 ? (
				<PanelEmpty text={emptyText} />
			) : (
				buckets.map((b) => (
					<SpendRow
						key={b.key}
						name={mergedPrBucketLabel(b.key)}
						costUsd={b.costPerMergedPrUsd == null ? "—" : formatCostUsd(b.costPerMergedPrUsd)}
					/>
				))
			)}
		</TelemetryPanel>
	);
}

export function TelemetryEconomicsSidePanels() {
	const { from, to } = useTelemetryWindow();
	return (
		<>
			<SpendOverTimePanel from={from} to={to} />
			<SpendByPanel
				from={from}
				to={to}
				dimension="model"
				title="Spend by model"
				emptyText="No model spend in this window."
			/>
			<SpendByPanel
				from={from}
				to={to}
				dimension="provider"
				title="Spend by provider"
				emptyText="No provider spend in this window."
			/>
			<SpendByPanel
				from={from}
				to={to}
				dimension="agent"
				title="Spend by agent"
				emptyText="No agent spend in this window."
				hrefFor={(key) =>
					key === COST_ANALYTICS_NONE_KEY ? undefined : `/agents/${encodeURIComponent(key)}`
				}
			/>
			<TopRunsPanel from={from} to={to} />
			<TokenTotalsPanel />
			<CostPerMergedPrPanel
				from={from}
				to={to}
				dimension="byModel"
				title="Cost per merged PR · model"
				emptyText="No merged-PR outcome in this window."
			/>
			<CostPerMergedPrPanel
				from={from}
				to={to}
				dimension="byProvider"
				title="Cost per merged PR · provider"
				emptyText="No merged-PR outcome in this window."
			/>
		</>
	);
}
