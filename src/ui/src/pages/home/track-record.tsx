import { Link } from "react-router-dom";
import type { RunAnalyticsResponse, RunDayBucket } from "@/api/client.ts";
import { Card, CardHeader } from "@/components/ui/card.tsx";
import { Skeleton } from "@/components/ui/skeleton.tsx";
import { fillDays, shortDuration } from "./home.helpers.ts";

/**
 * Home's track record (warren-44a2): four headline figures for the
 * selected window, and a 30-day stacked bar chart of run outcomes. Spend
 * shows only when the caller's projection carries it (operators).
 */

function Metric({ label, value, sub }: { label: string; value: string; sub?: string }) {
	return (
		<div className="flex min-w-0 flex-col gap-0.5">
			<span className="text-xs text-(--color-text-3)">{label}</span>
			<span className="text-xl font-semibold tracking-tight tabular-nums text-(--color-text)">
				{value}
			</span>
			{sub ? <span className="truncate text-xs text-(--color-text-3)">{sub}</span> : null}
		</div>
	);
}

function pct(rate: number | null): string {
	return rate === null ? "—" : `${Math.round(rate * 100)}%`;
}

const CHART_H = 88;

function DailyChart({ days }: { days: readonly RunDayBucket[] }) {
	const max = Math.max(1, ...days.map((d) => d.runs));
	const barW = 100 / Math.max(days.length, 1);
	const first = days[0]?.key;
	const last = days[days.length - 1]?.key;
	return (
		<div className="flex flex-col gap-1.5">
			<svg
				viewBox={`0 0 100 ${CHART_H}`}
				preserveAspectRatio="none"
				className="h-22 w-full"
				role="img"
				aria-label="Runs per day over the last 30 days, split by outcome"
			>
				{days.map((d, i) => {
					const x = i * barW + barW * 0.15;
					const w = barW * 0.7;
					const scale = (n: number) => (n / max) * (CHART_H - 2);
					const ok = scale(d.succeeded);
					const err = scale(d.failed);
					const other = scale(Math.max(0, d.runs - d.succeeded - d.failed));
					return (
						<g key={d.key}>
							<title>{`${d.key}: ${d.runs} runs, ${d.succeeded} succeeded, ${d.failed} failed`}</title>
							<rect
								x={x}
								y={CHART_H - ok}
								width={w}
								height={ok}
								className="fill-(--color-success)/80"
							/>
							<rect
								x={x}
								y={CHART_H - ok - err}
								width={w}
								height={err}
								className="fill-(--color-danger)/80"
							/>
							<rect
								x={x}
								y={CHART_H - ok - err - other}
								width={w}
								height={other}
								className="fill-(--color-text-3)/40"
							/>
							{d.runs === 0 ? (
								<rect
									x={x}
									y={CHART_H - 1}
									width={w}
									height={1}
									className="fill-(--color-border)"
								/>
							) : null}
						</g>
					);
				})}
			</svg>
			<div className="flex justify-between text-2xs text-(--color-text-3)">
				<span>{first ?? ""}</span>
				<span className="flex gap-3">
					<Legend className="bg-(--color-success)" label="Succeeded" />
					<Legend className="bg-(--color-danger)" label="Failed" />
					<Legend className="bg-(--color-text-3)/50" label="Other" />
				</span>
				<span>{last ?? ""}</span>
			</div>
		</div>
	);
}

function Legend({ className, label }: { className: string; label: string }) {
	return (
		<span className="flex items-center gap-1">
			<span aria-hidden className={`size-2 rounded-xs ${className}`} />
			{label}
		</span>
	);
}

export function TrackRecord({
	windowData,
	chartData,
	windowLabel,
}: {
	windowData: RunAnalyticsResponse | undefined;
	chartData: RunAnalyticsResponse | undefined;
	windowLabel: string;
}) {
	const t = windowData?.totals;
	const mergeMedian = windowData?.delivery.dispatchToMergeMs.median ?? null;
	return (
		<Card className="self-stretch">
			<CardHeader
				title="Track record"
				meta={`Last ${windowLabel}`}
				actions={
					<Link to="/telemetry" className="text-xs text-(--color-text-3) hover:text-(--color-text)">
						Telemetry
					</Link>
				}
			/>
			<div className="grid grid-cols-2 gap-x-6 gap-y-4 p-4 sm:grid-cols-4">
				{t ? (
					<>
						<Metric
							label="Success rate"
							value={pct(t.successRate)}
							sub={`${t.succeeded} of ${t.runs} runs`}
						/>
						<Metric
							label="Merged PRs"
							value={String(t.prsMerged)}
							sub={t.mergedPrRate === null ? undefined : `${pct(t.mergedPrRate)} of known PRs`}
						/>
						<Metric label="Dispatch to merge" value={shortDuration(mergeMedian)} sub="Median" />
						{t.cost ? (
							<Metric
								label="Spend"
								value={`$${t.cost.total.toFixed(2)}`}
								sub={t.cost.avg === null ? undefined : `$${t.cost.avg.toFixed(2)} per run`}
							/>
						) : (
							<Metric
								label="Median duration"
								value={shortDuration(t.durationMs.median)}
								sub="Per run"
							/>
						)}
					</>
				) : (
					[0, 1, 2, 3].map((i) => (
						<div key={i} className="flex flex-col gap-1.5">
							<Skeleton className="h-3 w-16" />
							<Skeleton className="h-6 w-12" />
						</div>
					))
				)}
			</div>
			<div className="border-t border-(--color-border) px-4 pt-3 pb-3">
				{chartData ? (
					<DailyChart days={fillDays(chartData.timeSeries, 30, Date.now())} />
				) : (
					<Skeleton className="h-22 w-full" />
				)}
			</div>
		</Card>
	);
}
