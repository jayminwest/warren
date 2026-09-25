import { useMemo } from "react";
import type { RunAnalyticsTotals, RunDayBucket, RunDeliveryMetrics } from "@/api/client.ts";
import { Skeleton } from "@/components/ui/skeleton.tsx";
import { cn } from "@/lib/utils.ts";
import { formatDuration } from "@/pages/telemetry/format.ts";
import {
	outcomeBuckets,
	segmentPercent,
	WEEKLY_THRESHOLD_DAYS,
} from "@/pages/telemetry/loop-tab.buckets.ts";
import { MeterBar, meterWidth } from "@/pages/telemetry/meter-bar.tsx";
import { PanelError, TelemetryPanel } from "@/pages/telemetry/telemetry-panel.tsx";
import { useTelemetryWindow } from "@/pages/telemetry/use-telemetry-window.tsx";

/**
 * Telemetry · Delivery (warren-7197, migrated in warren-9474): how runs
 * end, and where the time inside them goes. The outcome chart draws one
 * column per day in the window — one per week at 90 days — zero-run days
 * included, so columns, widths, and the axis always agree (warren-e9cd).
 * Stages without a measured figure show a quiet row, never an invented one.
 */

const SEGMENTS = [
	{ key: "failed", label: "Failed", color: "bg-(--color-danger)" },
	{ key: "cancelled", label: "Cancelled", color: "bg-(--color-text-3)" },
	{ key: "succeeded", label: "Succeeded", color: "bg-(--color-success)" },
] as const;

/** One stacked column; segment heights share the tallest column's scale. */
function OutcomeColumn({ bucket, maxRuns }: { bucket: RunDayBucket; maxRuns: number }) {
	return (
		<div
			className="flex h-full min-w-0 flex-1 flex-col justify-end overflow-hidden"
			title={`${shortDay(bucket.key)}: ${bucket.succeeded} succeeded · ${bucket.cancelled} cancelled · ${bucket.failed} failed`}
		>
			{bucket.runs === 0 ? (
				<div className="h-0.5 rounded-xs bg-(--color-border)" />
			) : (
				SEGMENTS.map((seg) => {
					const count = bucket[seg.key];
					if (count <= 0) return null;
					return (
						<div
							key={seg.key}
							className={cn("first:rounded-t-xs", seg.color)}
							style={{ height: `max(2px, ${segmentPercent(count, maxRuns)}%)` }}
						/>
					);
				})
			)}
		</div>
	);
}

/** "Sep 13" from a YYYY-MM-DD bucket key. */
function shortDay(key: string): string {
	const d = new Date(`${key}T00:00:00Z`);
	if (Number.isNaN(d.getTime())) return key;
	return d.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
}

function OutcomesChart({
	totals,
	series,
	weekly,
}: {
	totals: RunAnalyticsTotals | undefined;
	series: readonly RunDayBucket[];
	weekly: boolean;
}) {
	const maxRuns = series.reduce((m, b) => Math.max(m, b.runs), 0);
	const first = series[0]?.key;
	const last = series[series.length - 1]?.key;
	return (
		<>
			<div className="flex h-32 w-full items-end gap-0.5" role="img" aria-label="Run outcomes">
				{series.map((b) => (
					<OutcomeColumn key={b.key} bucket={b} maxRuns={maxRuns} />
				))}
			</div>
			<div className="flex w-full items-center justify-between text-xs text-(--color-text-3)">
				<span>{first === undefined ? "" : `${weekly ? "Week of " : ""}${shortDay(first)}`}</span>
				<span>{last === undefined ? "" : `${weekly ? "Week of " : ""}${shortDay(last)}`}</span>
			</div>
			<div className="flex flex-wrap items-center gap-x-4 gap-y-1">
				{[...SEGMENTS].reverse().map((seg) => (
					<span key={seg.key} className="flex items-center gap-1.5 text-sm text-(--color-text-2)">
						<span className={cn("size-2 shrink-0 rounded-xs", seg.color)} aria-hidden />
						{seg.label}
						<span className="text-(--color-text) tabular-nums">
							{(totals?.[seg.key] ?? 0).toLocaleString()}
						</span>
					</span>
				))}
			</div>
		</>
	);
}

function OutcomesPanel() {
	const { runs, days, from, to } = useTelemetryWindow();
	const totals = runs.data?.totals;
	const weekly = days >= WEEKLY_THRESHOLD_DAYS;
	const timeSeries = runs.data?.timeSeries;
	const series = useMemo(
		() => outcomeBuckets(timeSeries ?? [], days, from, to),
		[timeSeries, days, from, to],
	);

	return (
		<TelemetryPanel
			title="Run outcomes"
			meta={
				totals === undefined
					? undefined
					: `${totals.runs.toLocaleString()} runs · ${weekly ? "by week" : "by day"}`
			}
		>
			{runs.isError ? (
				<PanelError what="run outcomes" error={runs.error} onRetry={() => void runs.refetch()} />
			) : runs.isLoading ? (
				<Skeleton className="h-40 w-full" />
			) : (
				<OutcomesChart totals={totals} series={series} weekly={weekly} />
			)}
		</TelemetryPanel>
	);
}

interface StageSpec {
	label: string;
	medianMs: number | null;
	highlight: boolean;
}

/** Known medians from the totals and the delivery block (warren-bc9c). */
function buildStages(
	totals: RunAnalyticsTotals | undefined,
	delivery: RunDeliveryMetrics | undefined,
): StageSpec[] {
	const queueWait = totals?.queueWaitMs.median ?? null;
	const duration = totals?.durationMs.median ?? null;
	return [
		{ label: "Queue wait", medianMs: queueWait, highlight: (queueWait ?? 0) > (duration ?? 0) },
		{ label: "Agent work", medianMs: duration, highlight: (duration ?? 0) >= (queueWait ?? 0) },
		{
			label: "Push to PR",
			medianMs: delivery?.branchPushToPrOpenMs.median ?? null,
			highlight: false,
		},
		{ label: "PR to merge", medianMs: delivery?.prOpenToMergeMs.median ?? null, highlight: false },
	];
}

function StagesPanel() {
	const { runs } = useTelemetryWindow();
	const stages = buildStages(runs.data?.totals, runs.data?.delivery);
	const max = stages.reduce((m, s) => Math.max(m, s.medianMs ?? 0), 0);
	return (
		<TelemetryPanel title="Where the time goes" meta="Median per run">
			{runs.isLoading
				? stages.map((s) => <Skeleton key={s.label} className="h-4 w-full" />)
				: stages.map((s) => (
						<MeterBar
							key={s.label}
							label={s.label}
							labelClass={cn("w-24", s.highlight && "text-(--color-text)")}
							width={s.medianMs === null ? "0%" : meterWidth(s.medianMs, max)}
							markClass={cn(
								"h-2.5",
								s.highlight ? "bg-(--color-primary)" : "bg-(--color-text-3) opacity-60",
							)}
							title={s.medianMs === null ? "Not measured in this window" : undefined}
							value={formatDuration(s.medianMs)}
							valueClass={cn("w-16", s.highlight && "font-medium text-(--color-primary)")}
						/>
					))}
		</TelemetryPanel>
	);
}

export function TelemetryLoopTab() {
	return (
		<div className="grid items-start gap-4 lg:grid-cols-2">
			<OutcomesPanel />
			<StagesPanel />
		</div>
	);
}
