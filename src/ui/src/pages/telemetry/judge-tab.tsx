import { Scale } from "lucide-react";
import { useMemo } from "react";
import { EmptyState } from "@/components/ui/empty-state.tsx";
import { SkeletonRows } from "@/components/ui/skeleton.tsx";
import { cn } from "@/lib/utils.ts";
import { FailedVerdictsTable, UnjudgedTable } from "@/pages/telemetry/judge-tab.tables.tsx";
import {
	type JudgeStoreRow,
	type JudgeSummary,
	type JudgeVerdictsAbsent,
	summarizeJudgeVerdicts,
	useJudgeVerdicts,
} from "@/pages/telemetry/judge-verdicts.ts";
import { MeterBar, meterWidth } from "@/pages/telemetry/meter-bar.tsx";
import { useRunsJoin } from "@/pages/telemetry/runs-join.ts";
import { PanelEmpty, TelemetryPanel } from "@/pages/telemetry/telemetry-panel.tsx";

/**
 * Telemetry · Judge (warren-7197, migrated in warren-9474): rubric-v1
 * verdicts from the judge extension, joined with run records and PR
 * state. The extension is optional: when its export is absent the tab
 * degrades to one quiet panel — never an error, never an invented figure.
 */

/** How many rows each review table renders. */
const TABLE_ROWS = 8;

/** Distinct copy per absence reason (warren-f927): "not deployed" only
 * when warren itself reports the extension as unconfigured. */
const ABSENT_COPY: Record<JudgeVerdictsAbsent["reason"], { title: string; line: string }> = {
	absent: {
		title: "The judge isn't set up",
		line: "Deploy the judge extension on this instance and its verdicts on finished runs show here.",
	},
	unauthorized: {
		title: "The judge didn't accept this session",
		line: "The judge is deployed but refused this browser's credential. Sign in with a token the judge accepts.",
	},
	misconfigured: {
		title: "The judge export is misrouted",
		line: "Something in front of warren answered the verdict export with a web page. Check the proxy routing for the judge.",
	},
	error: {
		title: "The judge can't be reached",
		line: "The verdict export didn't answer. Check that the judge service is running and that WARREN_JUDGE_BASE_URL points at it.",
	},
};

function AbsentPanel({ state }: { state: JudgeVerdictsAbsent }) {
	const copy = ABSENT_COPY[state.reason];
	return (
		<TelemetryPanel title="Judge verdicts" flush>
			<EmptyState compact icon={Scale} title={copy.title} description={copy.line} />
		</TelemetryPanel>
	);
}

function pct(count: number, total: number): number {
	return total === 0 ? 0 : Math.round((count / total) * 100);
}

function Distribution({ summary, total }: { summary: JudgeSummary; total: number }) {
	const segments = [
		{ key: "pass", label: "Pass", count: summary.pass, color: "bg-(--color-success)" },
		{ key: "fail", label: "Fail", count: summary.fail, color: "bg-(--color-danger)" },
		{
			key: "unjudged",
			label: "Not judged",
			count: summary.unjudged,
			color: "bg-(--color-text-3) opacity-50",
		},
	];
	const strongCoverage = summary.judgedRate !== null && summary.judgedRate >= 0.8;
	return (
		<div className="flex flex-col gap-2.5">
			<div className="flex items-baseline gap-2">
				<span
					className={cn(
						"text-2xl font-semibold tabular-nums",
						summary.passRate === null
							? "text-(--color-text-3)"
							: strongCoverage
								? "text-(--color-success)"
								: "text-(--color-text)",
					)}
				>
					{summary.passRate === null ? "—" : `${Math.round(summary.passRate * 100)}%`}
				</span>
				<span className="text-sm text-(--color-text-2)">
					pass rate · {(summary.pass + summary.fail).toLocaleString()} of {total.toLocaleString()}{" "}
					judged
				</span>
			</div>
			<div className="flex h-2 overflow-hidden rounded-xs bg-(--color-surface-hover)">
				{segments.map((seg) => (
					<div key={seg.key} className={seg.color} style={{ width: `${pct(seg.count, total)}%` }} />
				))}
			</div>
			<div className="flex flex-wrap items-center gap-x-4 gap-y-1">
				{segments.map((seg) => (
					<span key={seg.key} className="flex items-center gap-1.5 text-sm text-(--color-text-2)">
						<span className={cn("size-2 shrink-0 rounded-xs", seg.color)} aria-hidden />
						{seg.label}
						<span className="text-(--color-text) tabular-nums">{seg.count.toLocaleString()}</span>
					</span>
				))}
			</div>
		</div>
	);
}

function FailingClasses({ summary }: { summary: JudgeSummary }) {
	if (summary.failingClasses.length === 0) {
		return <PanelEmpty>No failing classes in the export.</PanelEmpty>;
	}
	const max = summary.failingClasses[0]?.count ?? 1;
	return (
		<div className="flex flex-col gap-2 border-t border-(--color-border) pt-3">
			<span className="text-xs text-(--color-text-3)">Most frequent failing classes</span>
			{summary.failingClasses.slice(0, 5).map((c) => (
				<MeterBar
					key={c.name}
					label={c.name}
					mono
					labelClass="w-40"
					width={meterWidth(c.count, max)}
					markClass="h-2 bg-(--color-danger)"
					value={c.count.toLocaleString()}
					valueClass="w-10"
				/>
			))}
		</div>
	);
}

function isFailing(r: JudgeStoreRow): boolean {
	return r.kind === "verdict" && (r.verdict?.assignments ?? []).some((a) => a.class !== "clean");
}

function JudgeVerdictPanels({ rows }: { rows: readonly JudgeStoreRow[] }) {
	const runsJoin = useRunsJoin();
	const summary = useMemo(() => summarizeJudgeVerdicts(rows), [rows]);
	const runById = useMemo(
		() => new Map((runsJoin.data?.runs ?? []).map((r) => [r.id, r])),
		[runsJoin.data?.runs],
	);
	const failing = useMemo(() => rows.filter(isFailing).sort((a, b) => b.id - a.id), [rows]);
	const unjudged = useMemo(
		() => rows.filter((r) => r.kind === "unjudged").sort((a, b) => b.id - a.id),
		[rows],
	);

	return (
		<div className="grid min-w-0 content-start gap-4">
			<TelemetryPanel
				title="Judge verdicts"
				meta={`Latest ${rows.length.toLocaleString()} · rubric v1`}
			>
				<Distribution summary={summary} total={rows.length} />
				<FailingClasses summary={summary} />
			</TelemetryPanel>

			<TelemetryPanel
				title="Merged, then failed the judge"
				meta={failing.length > 0 ? "Review these first" : undefined}
				flush
			>
				{failing.length === 0 ? (
					<EmptyState
						compact
						title="Nothing to review"
						description="Every judged run in the export came back clean."
					/>
				) : (
					<FailedVerdictsTable rows={failing.slice(0, TABLE_ROWS)} runById={runById} />
				)}
			</TelemetryPanel>

			{unjudged.length > 0 ? (
				<TelemetryPanel
					title="Not judged"
					meta={
						unjudged.length > TABLE_ROWS
							? `Newest ${TABLE_ROWS} of ${unjudged.length.toLocaleString()}`
							: `${unjudged.length.toLocaleString()} runs`
					}
					flush
				>
					<UnjudgedTable rows={unjudged.slice(0, TABLE_ROWS)} runById={runById} />
				</TelemetryPanel>
			) : null}
		</div>
	);
}

export function TelemetryJudgeTab() {
	const verdicts = useJudgeVerdicts();

	if (verdicts.isLoading) {
		return (
			<TelemetryPanel title="Judge verdicts" flush>
				<SkeletonRows rows={4} />
			</TelemetryPanel>
		);
	}

	const state = verdicts.data ?? { available: false as const, reason: "error" as const };
	if (!state.available) return <AbsentPanel state={state} />;

	// A healthy judge with zero verdicts is a normal state (warren-f927).
	if (state.rows.length === 0) {
		return (
			<TelemetryPanel title="Judge verdicts" flush>
				<EmptyState
					compact
					icon={Scale}
					title="No verdicts yet"
					description="The judge is connected. Its verdicts show here as it finishes reviewing runs."
				/>
			</TelemetryPanel>
		);
	}

	return <JudgeVerdictPanels rows={state.rows} />;
}
