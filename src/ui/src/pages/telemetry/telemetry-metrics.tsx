import { type StatCell, StatStrip } from "@/pages/operations/stat-strip.tsx";
import { formatCostUsd } from "@/pages/run-detail-format.ts";
import { formatDuration } from "@/pages/telemetry/format.ts";
import { summarizeJudgeVerdicts, useJudgeVerdicts } from "@/pages/telemetry/judge-verdicts.ts";
import { useTelemetryWindow } from "@/pages/telemetry/use-telemetry-window.tsx";

/**
 * The Telemetry headline figures (warren-7197, migrated in warren-9474):
 * cost per merged PR, autonomy, dispatch-to-merge time, and judge pass.
 * Cost per merged PR is public (warren-97ae); judge pass comes from the
 * judge extension and reads "—" when it is absent. A figure is never
 * invented.
 */

type RunAnalytics = NonNullable<ReturnType<typeof useTelemetryWindow>["runs"]["data"]>;

function costCell(outcomes: RunAnalytics["outcomes"] | undefined): StatCell {
	const costPerMergedPr = outcomes?.costPerMergedPr.overall.costPerMergedPrUsd;
	const unknown = costPerMergedPr === null || costPerMergedPr === undefined;
	return {
		key: "cost",
		label: "Cost per merged PR",
		value: outcomes === undefined ? null : unknown ? "—" : formatCostUsd(costPerMergedPr),
		detail: unknown ? "No priced runs in this window" : "All spend, failed runs included",
		title: "Spend in the window divided by pull requests merged",
	};
}

function autonomyCell(autonomy: RunAnalytics["outcomes"]["autonomy"] | undefined): StatCell {
	const rate = autonomy?.rate ?? null;
	return {
		key: "autonomy",
		label: "Autonomy",
		value: autonomy === undefined ? null : rate === null ? "—" : `${Math.round(rate * 100)}%`,
		detail:
			autonomy === undefined || rate === null
				? "No merged runs in this window"
				: `${autonomy.autonomous} of ${autonomy.merged} merges with no steering or retry`,
	};
}

function leadTimeCell(delivery: RunAnalytics["delivery"] | undefined): StatCell {
	const median = delivery?.dispatchToMergeMs.median ?? null;
	return {
		key: "lead",
		label: "Dispatch to merge",
		value: delivery === undefined ? null : median === null ? "—" : formatDuration(median),
		detail: median === null ? "No merged runs in this window" : "Median lead time",
	};
}

function judgeCell(verdicts: ReturnType<typeof useJudgeVerdicts>): StatCell {
	const base = { key: "judge", label: "Judge pass" } as const;
	if (verdicts.isLoading) return { ...base, value: null };
	if (verdicts.data?.available !== true) {
		return {
			...base,
			value: "—",
			valueClassName: "text-(--color-text-3)",
			detail: "Judge not connected",
		};
	}
	const summary = summarizeJudgeVerdicts(verdicts.data.rows);
	if (summary.passRate === null) {
		return {
			...base,
			value: "—",
			valueClassName: "text-(--color-text-3)",
			detail: "No verdicts yet",
		};
	}
	const judged = summary.pass + summary.fail;
	// Coloured only once coverage is strong enough to trust (warren-f282).
	const strong = summary.judgedRate !== null && summary.judgedRate >= 0.8;
	return {
		...base,
		value: `${Math.round(summary.passRate * 100)}%`,
		valueClassName: strong ? "text-(--color-success)" : undefined,
		detail: `${judged} of ${judged + summary.unjudged} runs judged`,
	};
}

export function TelemetryMetricStrip() {
	const { runs } = useTelemetryWindow();
	const verdicts = useJudgeVerdicts();
	const data = runs.data;
	const cells = [
		costCell(data?.outcomes),
		autonomyCell(data?.outcomes.autonomy),
		leadTimeCell(data?.delivery),
		judgeCell(verdicts),
	];
	// A failed load must not leave skeletons shimmering forever.
	const settled = runs.isError
		? cells.map((c) => (c.value === null ? { ...c, value: "—", detail: "Couldn't load" } : c))
		: cells;
	return <StatStrip cells={settled} />;
}
