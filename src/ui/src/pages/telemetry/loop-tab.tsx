import type { RunAnalyticsTotals, RunDayBucket, RunDeliveryMetrics } from "@/api/client.ts";
import { cn } from "@/lib/utils.ts";
import { formatDuration } from "@/pages/telemetry/format.ts";
import { MeterBar } from "@/pages/telemetry/meter-bar.tsx";
import { TelemetryPanel } from "@/pages/telemetry/telemetry-panel.tsx";
import { useIsDesktop } from "@/pages/telemetry/use-is-desktop.ts";
import { useTelemetryWindow } from "@/pages/telemetry/use-telemetry-window.tsx";

/**
 * Telemetry · the Loop (warren-7197 / pl-7e38 step 14): how runs end,
 * and where the time inside them goes. Everything comes from
 * `GET /analytics/runs` over the shared window. The stage breakdown reads
 * the `totals` queue-wait/duration medians plus the `delivery` timing block
 * (warren-bc9c); stages without a computed figure render as quiet "—" rows
 * rather than invented numbers.
 */

/** One stacked column: succeeded (green) / cancelled (neutral) / failed (red). */
function OutcomeColumn({ bucket, maxRuns }: { bucket: RunDayBucket; maxRuns: number }) {
	const scale = maxRuns === 0 ? 0 : 120 / maxRuns;
	const h = (n: number) => `${Math.max(n === 0 ? 0 : 2, Math.round(n * scale))}px`;
	return (
		<div
			className="flex h-[120px] w-full min-w-0 flex-1 basis-0 flex-col justify-end gap-px"
			title={`${bucket.key}: ${String(bucket.succeeded)} succeeded · ${String(bucket.cancelled)} cancelled · ${String(bucket.failed)} failed`}
		>
			{bucket.failed > 0 ? (
				<div className="rounded-[1px] bg-(--color-danger)" style={{ height: h(bucket.failed) }} />
			) : null}
			{bucket.cancelled > 0 ? (
				<div
					className="rounded-[1px] bg-(--color-neutral)"
					style={{ height: h(bucket.cancelled) }}
				/>
			) : null}
			{bucket.succeeded > 0 ? (
				<div
					className="rounded-[1px] bg-(--color-success)"
					style={{ height: h(bucket.succeeded) }}
				/>
			) : null}
			{bucket.runs === 0 ? <div className="h-[2px] rounded-[1px] bg-(--color-border)" /> : null}
		</div>
	);
}

function Legend({ color, label }: { color: string; label: string }) {
	return (
		<span className="flex items-center gap-1.5">
			<span className={cn("h-2 w-2 shrink-0 rounded-[1px]", color)} aria-hidden />
			<span className="font-mono text-[11px] leading-[14px] text-(--color-text-2)">{label}</span>
		</span>
	);
}

/** Short month + day of a YYYY-MM-DD bucket key ("AUG 13"). */
function shortDay(key: string): string {
	const d = new Date(`${key}T00:00:00Z`);
	if (Number.isNaN(d.getTime())) return key;
	return d
		.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" })
		.toUpperCase();
}

/**
 * Mock mobile/telemetry.jsx :114-157 fill ramp for the below-md stage
 * rows: primary fill at .55/.7/.85/1.0 over the known rows.
 */
const STAGE_FILL_RAMP = ["opacity-55", "opacity-70", "opacity-85", "opacity-100"] as const;

/** One "where the time goes" row; bar width is relative to the known max. */
function StageRow({
	label,
	medianMs,
	maxMs,
	highlight,
	knownIndex,
}: {
	label: string;
	medianMs: number | null;
	maxMs: number;
	highlight: boolean;
	/** Position among known-median rows, for the below-md fill ramp. */
	knownIndex: number;
}) {
	const known = medianMs !== null;
	const width =
		known && maxMs > 0 ? `${Math.max(4, Math.round((medianMs / maxMs) * 100))}%` : "4px";
	return (
		<MeterBar
			label={label}
			labelClass={cn(
				// Below md: mock :114-157 fixed 74px label / 26px value.
				"w-[74px] md:w-24",
				highlight ? "text-(--color-text)" : "text-(--color-text-2)",
			)}
			width={width}
			markClass={cn(
				"h-3 max-md:h-2",
				!known
					? "bg-(--color-border)"
					: highlight
						? "bg-(--color-primary)"
						: cn(
								"bg-(--color-neutral) max-md:bg-(--color-primary)",
								STAGE_FILL_RAMP[knownIndex] ?? "opacity-100",
							),
			)}
			title={known ? formatDuration(medianMs) : "no API surface for this stage yet"}
			value={formatDuration(medianMs)}
			valueClass={cn(
				"max-md:w-[26px] max-md:flex max-md:flex-wrap max-md:justify-end max-md:text-right max-md:text-[10px] max-md:leading-3",
				highlight && known ? "font-semibold text-(--color-primary)" : undefined,
			)}
		/>
	);
}

/** One stage row in the "where the time goes" panel. */
interface StageSpec {
	label: string;
	medianMs: number | null;
	highlight: boolean;
}

/**
 * The stage rows: known medians from the totals + the delivery block
 * (warren-bc9c), quiet rows elsewhere.
 */
function buildStages(
	totals: RunAnalyticsTotals | undefined,
	delivery: RunDeliveryMetrics | undefined,
): StageSpec[] {
	const queueWait = totals?.queueWaitMs.median ?? null;
	const duration = totals?.durationMs.median ?? null;
	const pushToPrOpen = delivery?.branchPushToPrOpenMs.median ?? null;
	const prOpenToMerge = delivery?.prOpenToMergeMs.median ?? null;
	return [
		{ label: "queue wait", medianMs: queueWait, highlight: (queueWait ?? 0) > (duration ?? 0) },
		{ label: "agent work", medianMs: duration, highlight: (duration ?? 0) >= (queueWait ?? 0) },
		{ label: "branch push → PR open", medianMs: pushToPrOpen, highlight: false },
		{ label: "PR open → merge", medianMs: prOpenToMerge, highlight: false },
	];
}

interface OutcomesData {
	readonly totals: RunAnalyticsTotals | undefined;
	readonly series: readonly RunDayBucket[];
}

/** Axis labels + stacked columns + legend, once data exists. */
function OutcomesChart({ totals, series }: OutcomesData) {
	const maxRuns = series.reduce((m, b) => Math.max(m, b.runs), 0);
	const first = series[0]?.key;
	const last = series[series.length - 1]?.key;
	const axis = (key: string | undefined) => (key === undefined ? "" : shortDay(key));

	return (
		<>
			<div className="flex h-[120px] w-full items-end gap-0.5">
				{series.map((b) => (
					<OutcomeColumn key={b.key} bucket={b} maxRuns={maxRuns} />
				))}
			</div>
			<div className="flex w-full items-center justify-between">
				<span className="font-mono text-[10px] leading-3 text-(--color-text-3)">{axis(first)}</span>
				<span className="font-mono text-[10px] leading-3 text-(--color-text-3)">{axis(last)}</span>
			</div>
			<div className="flex flex-wrap items-center gap-4">
				<Legend
					color="bg-(--color-success)"
					label={`succeeded ${String(totals?.succeeded ?? 0)}`}
				/>
				<Legend
					color="bg-(--color-neutral)"
					label={`cancelled ${String(totals?.cancelled ?? 0)}`}
				/>
				<Legend color="bg-(--color-danger)" label={`failed ${String(totals?.failed ?? 0)}`} />
			</div>
		</>
	);
}

/**
 * Collapse daily buckets into Monday-keyed weekly buckets (warren-756e
 * choice): 90D forces ~626px of min-width-[3px] columns into a 347px
 * box below md, so the below-md arm renders one column per week —
 * the daily detail stays a desktop affordance, like the mock (no
 * daily chart at 375px).
 */
function collapseToWeeks(series: readonly RunDayBucket[]): RunDayBucket[] {
	const weeks = new Map<string, RunDayBucket>();
	for (const b of series) {
		const d = new Date(`${b.key}T00:00:00Z`);
		if (Number.isNaN(d.getTime())) continue;
		const day = d.getUTCDay();
		const monday = new Date(d);
		monday.setUTCDate(d.getUTCDate() - ((day + 6) % 7));
		const key = monday.toISOString().slice(0, 10);
		const acc = weeks.get(key);
		if (acc === undefined) {
			weeks.set(key, { ...b, key });
		} else {
			weeks.set(key, {
				...acc,
				succeeded: acc.succeeded + b.succeeded,
				cancelled: acc.cancelled + b.cancelled,
				failed: acc.failed + b.failed,
				runs: acc.runs + b.runs,
			});
		}
	}
	return [...weeks.values()].sort((a, b) => a.key.localeCompare(b.key));
}

function OutcomesPanel({
	runs,
	days,
	weekly,
}: {
	runs: ReturnType<typeof useTelemetryWindow>["runs"];
	days: number;
	weekly: boolean;
}) {
	const totals = runs.data?.totals;
	const daily = [...(runs.data?.timeSeries ?? [])].sort((a, b) => a.key.localeCompare(b.key));
	const series = weekly ? collapseToWeeks(daily) : daily;

	return (
		<TelemetryPanel
			title="Run outcomes"
			meta={totals === undefined ? "LOADING" : `${String(totals.runs)} RUNS · ${String(days)} DAYS`}
			className="flex-1"
		>
			{runs.isError ? (
				<p className="text-sm text-(--color-danger)">
					Failed to load run analytics. {(runs.error as Error | null)?.message ?? ""}
				</p>
			) : series.length === 0 && !runs.isLoading ? (
				<p className="text-[12px] leading-4 text-(--color-text-3)">No runs ended in this window.</p>
			) : (
				<OutcomesChart totals={totals} series={series} />
			)}
		</TelemetryPanel>
	);
}

export function TelemetryLoopTab() {
	const { runs, days } = useTelemetryWindow();
	const isDesktop = useIsDesktop();
	const totals = runs.data?.totals;
	const stages = buildStages(totals, runs.data?.delivery);
	const knownMax = stages.reduce((m, s) => Math.max(m, s.medianMs ?? 0), 0);
	// Position among known-median rows, for the below-md fill ramp.
	const knownIndices: number[] = [];
	for (const s of stages) {
		if (s.medianMs !== null) knownIndices.push(knownIndices.length);
		else knownIndices.push(-1);
	}

	return (
		<div className="flex flex-col gap-4 lg:flex-row">
			<OutcomesPanel runs={runs} days={days} weekly={!isDesktop} />

			<TelemetryPanel title="Stage timings" meta="MEDIAN PER RUN" className="flex-1">
				{stages.map((s, i) => (
					<StageRow
						key={s.label}
						label={s.label}
						medianMs={s.medianMs}
						maxMs={knownMax}
						highlight={s.highlight}
						knownIndex={knownIndices[i] ?? -1}
					/>
				))}
			</TelemetryPanel>
		</div>
	);
}
