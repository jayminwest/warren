import type { RunAnalyticsTotals, RunDayBucket } from "@/api/client.ts";
import { cn } from "@/lib/utils.ts";
import { MeterBar } from "@/pages/telemetry/meter-bar.tsx";
import { TelemetryPanel } from "@/pages/telemetry/telemetry-panel.tsx";
import { useTelemetryWindow } from "@/pages/telemetry/use-telemetry-window.tsx";

/**
 * Telemetry · the Loop (warren-7197 / pl-7e38 step 14): how runs end,
 * and where the time inside them goes. Everything comes from
 * `GET /analytics/runs` over the shared window; the stage breakdown
 * beyond queue wait and run duration has no API surface yet, so those
 * stages render as quiet "—" rows rather than invented figures.
 */

/** Milliseconds → compact human duration ("54s", "11m 24s", "16.8h"). */
function formatDuration(ms: number | null): string {
	if (ms === null) return "—";
	const s = Math.round(ms / 1000);
	if (s < 90) return `${s}s`;
	const m = Math.floor(s / 60);
	if (m < 90) return s % 60 === 0 ? `${m}m` : `${m}m ${String(s % 60).padStart(2, "0")}s`;
	return `${(m / 60).toFixed(1)}h`;
}

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

/** One "where the time goes" row; bar width is relative to the known max. */
function StageRow({
	label,
	medianMs,
	maxMs,
	highlight,
}: {
	label: string;
	medianMs: number | null;
	maxMs: number;
	highlight: boolean;
}) {
	const known = medianMs !== null;
	const width =
		known && maxMs > 0 ? `${Math.max(4, Math.round((medianMs / maxMs) * 100))}%` : "4px";
	return (
		<MeterBar
			label={label}
			labelClass={cn("w-24", highlight ? "text-(--color-text)" : "text-(--color-text-2)")}
			width={width}
			markClass={cn(
				"h-3",
				!known
					? "bg-(--color-border)"
					: highlight
						? "bg-(--color-primary)"
						: "bg-(--color-neutral)",
			)}
			title={known ? formatDuration(medianMs) : "no API surface for this stage yet"}
			value={formatDuration(medianMs)}
			valueClass={highlight && known ? "font-semibold text-(--color-primary)" : undefined}
		/>
	);
}

/** The stage rows: known medians from the totals, quiet rows elsewhere. */
function buildStages(totals: RunAnalyticsTotals | undefined) {
	const queueWait = totals?.queueWaitMs.median ?? null;
	const duration = totals?.durationMs.median ?? null;
	return [
		{ label: "queue wait", medianMs: queueWait, highlight: (queueWait ?? 0) > (duration ?? 0) },
		{ label: "agent work", medianMs: duration, highlight: (duration ?? 0) >= (queueWait ?? 0) },
		{ label: "branch push", medianMs: null, highlight: false },
		{ label: "PR open", medianMs: null, highlight: false },
		{ label: "review wait", medianMs: null, highlight: false },
		{ label: "merge", medianMs: null, highlight: false },
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

function OutcomesPanel({
	runs,
	days,
}: {
	runs: ReturnType<typeof useTelemetryWindow>["runs"];
	days: number;
}) {
	const totals = runs.data?.totals;
	const series = [...(runs.data?.timeSeries ?? [])].sort((a, b) => a.key.localeCompare(b.key));

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
	const totals = runs.data?.totals;
	const stages = buildStages(totals);
	const knownMax = stages.reduce((m, s) => Math.max(m, s.medianMs ?? 0), 0);

	return (
		<div className="flex flex-col gap-4 lg:flex-row">
			<OutcomesPanel runs={runs} days={days} />

			<TelemetryPanel title="Where the time goes" meta="MEDIAN PER RUN" className="flex-1">
				{stages.map((s) => (
					<StageRow
						key={s.label}
						label={s.label}
						medianMs={s.medianMs}
						maxMs={knownMax}
						highlight={s.highlight}
					/>
				))}
				<p className="mt-1 text-[12px] leading-4 text-(--color-text-2)">
					Queue wait and run duration come from the run record. Per-stage delivery timings — branch
					push, PR open, review wait, merge — have no API surface yet, so those rows stay quiet
					rather than invented.
				</p>
			</TelemetryPanel>
		</div>
	);
}
