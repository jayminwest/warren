import { useQuery } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import {
	analyticsApi,
	COST_ANALYTICS_NONE_KEY,
	type CostBucket,
	RUN_ANALYTICS_NONE_KEY,
	RUN_ANALYTICS_OTHER_KEY,
	runAnalyticsApi,
} from "@/api/client.ts";
import type { CostPerMergedPrBucket, RunStatSummary } from "@/api/run-analytics-types.ts";
import { cn } from "@/lib/utils.ts";
import { formatCostUsd } from "@/pages/run-detail-format.ts";
import {
	cacheHitShare,
	dateBucketLabel,
	dateSpendSeries,
	sortBucketsDesc,
	topCostBuckets,
} from "@/pages/telemetry/economics-helpers.ts";
import { MeterBar, meterWidth } from "@/pages/telemetry/meter-bar.tsx";
import {
	PanelEmpty,
	PanelError,
	PanelLoading,
	TelemetryPanel,
} from "@/pages/telemetry/telemetry-panel.tsx";
import { useTelemetryWindow } from "@/pages/telemetry/use-telemetry-window.tsx";

/**
 * Secondary economics panels (warren-cc6c, migrated in warren-9474):
 * every slice the cost and run analytics already serve — spend over
 * time, spend by model/provider/agent, top runs, token totals with the
 * cache-hit share, and cost per merged PR by model/provider. Each renders
 * only what the response carries; an absent field gets a quiet note.
 */

/** One name + figure line. `href` links the name; `mono` for machine ids. */
export function SpendRow({
	name,
	costUsd,
	href,
	mono = false,
}: {
	name: string;
	costUsd: string;
	href?: string;
	mono?: boolean;
}) {
	const nameClass = cn(
		"min-w-0 truncate text-(--color-text-2)",
		mono ? "font-mono text-xs" : "text-sm",
	);
	return (
		<div className="flex w-full items-baseline justify-between gap-3">
			{href === undefined ? (
				<span className={nameClass}>{name}</span>
			) : (
				<Link to={href} className={cn(nameClass, "hover:text-(--color-primary) hover:underline")}>
					{name}
				</Link>
			)}
			<span className="shrink-0 text-sm text-(--color-text) tabular-nums">{costUsd}</span>
		</div>
	);
}

function useCostAnalytics() {
	const { from, to } = useTelemetryWindow();
	return useQuery({
		queryKey: ["analytics", "cost", { projectId: null, from, to }],
		queryFn: ({ signal }) => analyticsApi.cost({ from, to }, signal),
	});
}

function useRunAnalytics() {
	const { from, to } = useTelemetryWindow();
	return useQuery({
		queryKey: ["analytics", "runs", { projectId: null, from, to }],
		queryFn: ({ signal }) => runAnalyticsApi.runs({ from, to }, signal),
	});
}

type AnalyticsQuery = ReturnType<typeof useCostAnalytics> | ReturnType<typeof useRunAnalytics>;

/**
 * The shared body-state ladder: error → loading → absent → content.
 * `content` returns null when the slice is missing from the response.
 */
function PanelBody({
	query,
	what,
	absent,
	content,
}: {
	query: AnalyticsQuery;
	what: string;
	absent: string;
	content: () => ReactNode | null;
}) {
	if (query.isError) {
		return <PanelError what={what} error={query.error} onRetry={() => void query.refetch()} />;
	}
	if (query.isLoading) return <PanelLoading rows={3} />;
	return content() ?? <PanelEmpty>{absent}</PanelEmpty>;
}

function bucketName(key: string): string {
	if (key === COST_ANALYTICS_NONE_KEY || key === RUN_ANALYTICS_NONE_KEY) return "Unattributed";
	if (key === RUN_ANALYTICS_OTHER_KEY) return "Other";
	return key;
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
	const hidden = sorted.slice(limit);
	return (
		<>
			{sorted.slice(0, limit).map((b) => (
				<SpendRow
					key={b.key}
					name={bucketName(b.key)}
					costUsd={formatCostUsd(b.costUsd)}
					href={hrefFor?.(b.key)}
				/>
			))}
			{hidden.length > 0 ? (
				<SpendRow
					name={`${hidden.length} more`}
					costUsd={formatCostUsd(hidden.reduce((sum, b) => sum + b.costUsd, 0))}
				/>
			) : null}
		</>
	);
}

function SpendOverTimePanel() {
	const cost = useCostAnalytics();
	return (
		<TelemetryPanel title="Spend by day">
			<PanelBody
				query={cost}
				what="daily spend"
				absent="No dated spend in this window."
				content={() => {
					const series = dateSpendSeries(cost.data?.breakdowns?.date ?? []);
					if (series.length === 0) return null;
					const max = series.reduce((m, b) => Math.max(m, b.costUsd), 0);
					return series.map((b) => (
						<MeterBar
							key={b.key}
							label={dateBucketLabel(b.key)}
							labelClass="w-14"
							width={meterWidth(b.costUsd, max)}
							markClass="h-2 bg-(--color-success) opacity-70"
							value={formatCostUsd(b.costUsd)}
							valueClass="w-16"
						/>
					));
				}}
			/>
		</TelemetryPanel>
	);
}

function SpendByPanel({
	dimension,
	title,
	hrefFor,
}: {
	dimension: "model" | "provider" | "agent";
	title: string;
	hrefFor?: (key: string) => string | undefined;
}) {
	const cost = useCostAnalytics();
	return (
		<TelemetryPanel title={title}>
			<PanelBody
				query={cost}
				what={title.toLowerCase()}
				absent={`No ${dimension} spend in this window.`}
				content={() => {
					const buckets = cost.data?.breakdowns?.[dimension];
					if (buckets === undefined || buckets.length === 0) return null;
					return <TopSpendRows buckets={buckets} hrefFor={hrefFor} />;
				}}
			/>
		</TelemetryPanel>
	);
}

function TopRunsPanel() {
	const cost = useCostAnalytics();
	return (
		<TelemetryPanel title="Most expensive runs" meta="Top 10">
			<PanelBody
				query={cost}
				what="run costs"
				absent="No priced runs in this window."
				content={() => {
					const buckets = topCostBuckets(cost.data?.breakdowns.run ?? [], 10);
					if (buckets.length === 0) return null;
					return buckets.map((b) => (
						<SpendRow
							key={b.key}
							mono={b.key !== COST_ANALYTICS_NONE_KEY}
							name={bucketName(b.key)}
							costUsd={formatCostUsd(b.costUsd)}
							href={
								b.key === COST_ANALYTICS_NONE_KEY ? undefined : `/runs/${encodeURIComponent(b.key)}`
							}
						/>
					));
				}}
			/>
		</TelemetryPanel>
	);
}

function TokenTotalsPanel() {
	const runs = useRunAnalytics();
	return (
		<TelemetryPanel title="Tokens">
			<PanelBody
				query={runs}
				what="token totals"
				absent="Token usage isn't available here."
				content={() => {
					const totals = runs.data?.tokens?.totals;
					if (totals === undefined) return null;
					const share = cacheHitShare(totals);
					return (
						<>
							<SpendRow name="Input" costUsd={totals.input.toLocaleString()} />
							<SpendRow name="Output" costUsd={totals.output.toLocaleString()} />
							<SpendRow name="Cache read" costUsd={totals.cacheRead.toLocaleString()} />
							<SpendRow name="Cache write" costUsd={totals.cacheWrite.toLocaleString()} />
							<SpendRow name="Total" costUsd={totals.total.toLocaleString()} />
							<p className="text-xs text-(--color-text-3)">
								{share === null
									? "No prompt tokens recorded, so no cache-hit share."
									: `${Math.round(share * 100)}% of prompt tokens came from cache.`}
							</p>
						</>
					);
				}}
			/>
		</TelemetryPanel>
	);
}

function CostPerRunContent({ costUsd }: { costUsd: RunStatSummary }) {
	if (costUsd.count === 0) return <PanelEmpty>No priced runs in this window.</PanelEmpty>;
	return (
		<>
			<SpendRow name="Median" costUsd={formatCostUsd(costUsd.median ?? 0)} />
			<SpendRow name="95th percentile" costUsd={formatCostUsd(costUsd.p95 ?? 0)} />
			<p className="text-xs text-(--color-text-3)">
				{`Across ${costUsd.count.toLocaleString()} priced ${costUsd.count === 1 ? "run" : "runs"}.`}
			</p>
		</>
	);
}

function CostPerRunPanel() {
	const runs = useRunAnalytics();
	const capHits = runs.data?.capHits;
	return (
		<TelemetryPanel title="Cost per run">
			<PanelBody
				query={runs}
				what="run costs"
				absent="Cost figures aren't available here."
				content={() => {
					const costUsd = runs.data?.totals?.costUsd;
					if (costUsd === undefined) return null;
					return (
						<>
							<CostPerRunContent costUsd={costUsd} />
							{capHits !== undefined ? (
								<p className="text-xs text-(--color-text-3)">
									{capHits === 0
										? "No run hit its spend cap."
										: `${capHits.toLocaleString()} ${capHits === 1 ? "run" : "runs"} stopped at the spend cap.`}
								</p>
							) : null}
						</>
					);
				}}
			/>
		</TelemetryPanel>
	);
}

function costBasisLabel(key: string): string {
	if (key === "api") return "Billed by API";
	if (key === "subscription_estimate") return "Subscription (estimated)";
	return "Unpriced";
}

function CostBasisPanel() {
	const cost = useCostAnalytics();
	return (
		<TelemetryPanel title="Spend by billing">
			<PanelBody
				query={cost}
				what="billing basis"
				absent="No spend recorded in this window."
				content={() => {
					const buckets = cost.data?.byCostBasis;
					if (buckets === undefined || buckets.length === 0) return null;
					return buckets.map((b) => (
						<SpendRow
							key={b.key}
							name={`${costBasisLabel(b.key)} · ${b.runs.toLocaleString()} runs`}
							costUsd={formatCostUsd(b.costUsd)}
						/>
					));
				}}
			/>
		</TelemetryPanel>
	);
}

function CostPerMergedPrPanel({
	dimension,
	title,
}: {
	dimension: "byModel" | "byProvider";
	title: string;
}) {
	const runs = useRunAnalytics();
	return (
		<TelemetryPanel title={title}>
			<PanelBody
				query={runs}
				what={title.toLowerCase()}
				absent="No merged pull requests in this window."
				content={() => {
					const buckets: readonly CostPerMergedPrBucket[] | undefined =
						runs.data?.outcomes?.costPerMergedPr?.[dimension];
					if (buckets === undefined || buckets.length === 0) return null;
					return buckets.map((b) => (
						<SpendRow
							key={b.key}
							name={bucketName(b.key)}
							costUsd={b.costPerMergedPrUsd == null ? "—" : formatCostUsd(b.costPerMergedPrUsd)}
						/>
					));
				}}
			/>
		</TelemetryPanel>
	);
}

export function TelemetryEconomicsSidePanels() {
	return (
		<>
			<CostPerRunPanel />
			<CostBasisPanel />
			<SpendOverTimePanel />
			<TopRunsPanel />
			<SpendByPanel dimension="model" title="Spend by model" />
			<SpendByPanel dimension="provider" title="Spend by provider" />
			<SpendByPanel
				dimension="agent"
				title="Spend by agent"
				hrefFor={(key) =>
					key === COST_ANALYTICS_NONE_KEY ? undefined : `/agents/${encodeURIComponent(key)}`
				}
			/>
			<TokenTotalsPanel />
			<CostPerMergedPrPanel dimension="byModel" title="Cost per merged PR by model" />
			<CostPerMergedPrPanel dimension="byProvider" title="Cost per merged PR by provider" />
		</>
	);
}
