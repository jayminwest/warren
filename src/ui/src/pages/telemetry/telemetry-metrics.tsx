import { formatCostUsd } from "@/pages/run-detail-format.ts";
import { summarizeJudgeVerdicts, useJudgeVerdicts } from "@/pages/telemetry/judge-verdicts.ts";
import { useTelemetryWindow } from "@/pages/telemetry/use-telemetry-window.tsx";

/**
 * The shared metric strip (warren-7197): four joined figures above the
 * tab content, from the Paper artboards. Cost per merged PR comes from
 * `GET /analytics/runs` outcomes (spectator-redacted → "—"); judge pass
 * comes from the judge extension's verdict export (absent → "—").
 * Autonomy and issue→merge have no API surface yet — quiet placeholders,
 * never fabricated numbers.
 */
function MetricCell({
	label,
	value,
	valueClassName,
	note,
	title,
	hasRightBorder,
}: {
	label: string;
	value: string;
	valueClassName?: string;
	note: string;
	title?: string;
	hasRightBorder: boolean;
}) {
	return (
		<div
			{...(title ? { title } : {})}
			className={`flex min-w-0 flex-1 flex-col gap-2 border-b border-(--color-border) px-5 py-4 last:border-b-0 sm:border-b-0 ${
				hasRightBorder ? "sm:border-r sm:border-r-(--color-border)" : ""
			}`}
		>
			<span className="font-mono text-[10px] tracking-[0.08em] leading-3 text-(--color-text-3)">
				{label}
			</span>
			<span
				className={`font-mono text-[24px] font-medium leading-7 ${valueClassName ?? "text-(--color-text)"}`}
			>
				{value}
			</span>
			<span className="font-mono text-[10px] leading-[14px] text-(--color-text-3)">{note}</span>
		</div>
	);
}

export function TelemetryMetricStrip() {
	const { runs } = useTelemetryWindow();
	const verdicts = useJudgeVerdicts();

	const outcomes = runs.data?.outcomes;
	const costPerMergedPr = outcomes?.costPerMergedPr.overall.costPerMergedPrUsd;

	const judgeSummary =
		verdicts.data?.available === true ? summarizeJudgeVerdicts(verdicts.data.rows) : null;

	return (
		<div className="flex w-full flex-col overflow-hidden rounded-(--radius-md) border border-(--color-border) bg-(--color-surface) sm:flex-row">
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
				hasRightBorder
			/>
			<MetricCell
				label="AUTONOMY"
				value="—"
				note="merged with no steer, no re-run, no human commit"
				title="No API surface computes this figure yet"
				hasRightBorder
			/>
			<MetricCell
				label="ISSUE → MERGE"
				value="—"
				note="median issue-to-merge lead time"
				title="No API surface computes this figure yet"
				hasRightBorder
			/>
			<MetricCell
				label="JUDGE PASS"
				value={
					judgeSummary === null || judgeSummary.passRate === null
						? "—"
						: `${Math.round(judgeSummary.passRate * 100)}%`
				}
				valueClassName={
					judgeSummary?.passRate !== null && judgeSummary !== null
						? "text-(--color-primary)"
						: undefined
				}
				note={
					judgeSummary === null
						? "judge extension not deployed"
						: judgeSummary.passRate === null
							? "no verdicts recorded yet"
							: `${judgeSummary.pass + judgeSummary.fail} verdicts against rubric v1`
				}
				title="Verdict export GET /verdicts.jsonl (judge extension)"
				hasRightBorder={false}
			/>
		</div>
	);
}
