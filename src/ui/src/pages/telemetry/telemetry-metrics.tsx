import { cn } from "@/lib/utils.ts";
import { formatCostUsd } from "@/pages/run-detail-format.ts";
import { formatDuration } from "@/pages/telemetry/format.ts";
import { summarizeJudgeVerdicts, useJudgeVerdicts } from "@/pages/telemetry/judge-verdicts.ts";
import { useTelemetryWindow } from "@/pages/telemetry/use-telemetry-window.tsx";

/**
 * The shared metric strip (warren-7197): four joined figures above the
 * tab content, from the Paper artboards. Cost per merged PR comes from
 * `GET /analytics/runs` outcomes (spectator-redacted → "—"); judge pass
 * comes from the judge extension's verdict export (absent → "—").
 * Autonomy and dispatch→merge come from `GET /analytics/runs` (warren-bc9c).
 */
function MetricCell({
	label,
	value,
	valueClassName,
	note,
	title,
	mobileBottom,
	mobileRight,
	hasRightBorder,
}: {
	label: string;
	value: string;
	valueClassName?: string;
	note: string;
	title?: string;
	/** Below-md 2x2 grid hairlines: bottom (row 1) and/or right (column 1). */
	mobileBottom?: boolean;
	mobileRight?: boolean;
	hasRightBorder: boolean;
}) {
	return (
		<div
			{...(title ? { title } : {})}
			className={cn(
				"flex min-w-0 flex-1 flex-col gap-1 border-(--color-border) p-3 md:gap-2 md:px-5 md:py-4",
				mobileBottom ? "border-b md:border-b-0" : undefined,
				mobileRight ? "border-r" : undefined,
				hasRightBorder ? "md:border-r md:border-r-(--color-border)" : undefined,
			)}
		>
			<span className="font-mono text-[9px] tracking-[0.08em] leading-[11px] text-(--color-text-3) md:text-[10px] md:leading-3">
				{label}
			</span>
			<span
				className={cn(
					"font-mono text-[18px] font-semibold leading-[22px] md:text-[24px] md:font-medium md:leading-7",
					valueClassName ?? "text-(--color-text)",
				)}
			>
				{value}
			</span>
			<span className="hidden font-mono text-[10px] leading-[14px] text-(--color-text-3) md:inline">
				{note}
			</span>
		</div>
	);
}

interface AutonomyShape {
	merged: number;
	autonomous: number;
	rate: number | null;
}

function autonomyCell(autonomy: AutonomyShape | undefined) {
	return (
		<MetricCell
			label="AUTONOMY"
			value={
				autonomy === undefined || autonomy.rate === null
					? "—"
					: `${Math.round(autonomy.rate * 100)}%`
			}
			note={
				autonomy === undefined
					? "loading run outcomes…"
					: autonomy.rate === null
						? "no merged runs in this window"
						: `${String(autonomy.autonomous)} of ${String(autonomy.merged)} merges unsteered, first attempt`
			}
			title="GET /analytics/runs outcomes.autonomy — merged runs with no steering and no retry/continuation"
			mobileBottom
			hasRightBorder
		/>
	);
}

function dispatchMergeCell(medianMs: number | undefined | null) {
	return (
		<MetricCell
			label="DISPATCH → MERGE"
			value={medianMs == null ? "—" : formatDuration(medianMs)}
			note={
				medianMs === undefined
					? "loading delivery timings…"
					: medianMs === null
						? "no merged runs in this window"
						: "median dispatch-to-merge lead time"
			}
			title="GET /analytics/runs delivery.dispatchToMergeMs (median)"
			mobileRight
			hasRightBorder
		/>
	);
}

/** Copy + tone for the JUDGE PASS cell (warren-f282): the pass rate is
 * neutral (default text colour) when judged coverage is below 80%, and
 * the note carries the 'N of M judged' denominator honestly. */
function judgePassCell(judgeSummary: ReturnType<typeof summarizeJudgeVerdicts> | null): {
	value: string;
	valueClassName?: string;
	note: string;
} {
	if (judgeSummary === null) {
		return { value: "—", note: "judge extension not deployed" };
	}
	const judged = judgeSummary.pass + judgeSummary.fail;
	if (judgeSummary.passRate === null) {
		return { value: "—", note: "no verdicts recorded yet" };
	}
	return {
		value: `${String(Math.round(judgeSummary.passRate * 100))}%`,
		valueClassName:
			judgeSummary.judgedRate !== null && judgeSummary.judgedRate >= 0.8
				? "text-(--color-primary)"
				: undefined,
		note: `${String(judged)} of ${String(judged + judgeSummary.unjudged)} judged against rubric v1`,
	};
}

export function TelemetryMetricStrip() {
	const { runs } = useTelemetryWindow();
	const verdicts = useJudgeVerdicts();

	const outcomes = runs.data?.outcomes;
	const costPerMergedPr = outcomes?.costPerMergedPr.overall.costPerMergedPrUsd;

	const judgeSummary =
		verdicts.data?.available === true ? summarizeJudgeVerdicts(verdicts.data.rows) : null;
	const judgeCell = judgePassCell(judgeSummary);

	return (
		<div className="grid w-full grid-cols-2 overflow-hidden rounded-(--radius-md) border border-(--color-border) bg-(--color-surface) md:flex">
			<MetricCell
				label="COST / MERGED PR"
				value={
					outcomes === undefined
						? "—"
						: costPerMergedPr === null || costPerMergedPr === undefined
							? "—"
							: formatCostUsd(costPerMergedPr)
				}
				note={
					outcomes === undefined
						? "loading run outcomes…"
						: costPerMergedPr === undefined
							? "redacted for spectators"
							: "all spend over merges · failed runs included"
				}
				title="Windowed USD rollup divided by merged PRs (GET /analytics/runs outcomes)"
				mobileBottom
				mobileRight
				hasRightBorder
			/>
			{autonomyCell(outcomes?.autonomy)}
			{dispatchMergeCell(runs.data?.delivery.dispatchToMergeMs.median)}
			<MetricCell
				label="JUDGE PASS"
				value={judgeCell.value}
				valueClassName={judgeCell.valueClassName}
				note={judgeCell.note}
				title="Verdict export GET /verdicts.jsonl (judge extension)"
				hasRightBorder={false}
			/>
		</div>
	);
}
