import { Link } from "react-router-dom";
import type { RunRow } from "@/api/types.ts";
import { relativeTime } from "@/lib/utils.ts";
import {
	type JudgeStoreRow,
	type JudgeVerdictsAbsent,
	summarizeJudgeVerdicts,
	useJudgeVerdicts,
} from "@/pages/telemetry/judge-verdicts.ts";
import { useRunsJoin } from "@/pages/telemetry/runs-join.ts";
import { TelemetryPanel } from "@/pages/telemetry/telemetry-panel.tsx";

/**
 * Telemetry · Judge (warren-7197 / pl-7e38 step 14): rubric-v1 verdicts
 * from the judge extension, joined with run records + forge PR state.
 * The extension is optional: when `/verdicts.jsonl` is absent (not
 * deployed, or this browser holds no credential it accepts) the whole
 * tab degrades to one quiet panel — never an error state, never a
 * fabricated figure.
 */

/** How many failed verdicts the "review these first" table renders. */
const FAILED_ROWS = 8;

const UNJUDGED_REASON_LABELS: Record<string, string> = {
	malformed_verdict: "malformed verdict",
	budget_exceeded: "judge budget",
	judge_error: "judge error",
};

function AbsentPanel({ state }: { state: JudgeVerdictsAbsent }) {
	const line =
		state.reason === "unauthorized"
			? "The judge extension is deployed but did not accept this browser's credential. Operators can open the verdict export with a token the extension accepts."
			: "The judge extension is not deployed against this instance. Deploy extensions/judge and its verdict export (/verdicts.jsonl) becomes this tab's evidence.";
	return (
		<TelemetryPanel title="Judge verdicts" meta="EXTENSION ABSENT">
			<p className="max-w-prose text-[12px] leading-[17px] text-(--color-text-2)">{line}</p>
		</TelemetryPanel>
	);
}

function prStateLabel(run: RunRow | undefined): string {
	const state = run?.prState;
	if (state === null || state === undefined) return "—";
	return state;
}

function FailedVerdictRow({ row, run }: { row: JudgeStoreRow; run: RunRow | undefined }) {
	const classes = (row.verdict?.assignments ?? []).filter((a) => a.class !== "clean");
	const label = UNJUDGED_REASON_LABELS[row.reason ?? ""] ?? classes.map((a) => a.class).join(", ");
	return (
		<tr className="border-b border-(--color-border) last:border-b-0">
			<td className="py-1.5 pr-3">
				<Link
					to={`/runs/${encodeURIComponent(row.runId)}`}
					className="font-mono text-[11px] leading-[14px] text-(--color-text-2) underline-offset-2 hover:underline"
				>
					{row.runId}
				</Link>
			</td>
			<td className="py-1.5 pr-3 font-mono text-[11px] leading-[14px] text-(--color-text-3)">
				{run?.agentName ?? "—"}
			</td>
			<td className="py-1.5 pr-3 font-mono text-[11px] leading-[14px] text-(--color-danger)">
				{label}
			</td>
			<td className="py-1.5 pr-3 font-mono text-[11px] leading-[14px] text-(--color-text-2)">
				{prStateLabel(run)}
			</td>
			<td className="py-1.5 text-right font-mono text-[11px] leading-[14px] text-(--color-text-3)">
				{row.verdict?.provenance.judgedAt !== undefined
					? relativeTime(row.verdict.provenance.judgedAt)
					: "—"}
			</td>
		</tr>
	);
}

export function TelemetryJudgeTab() {
	const verdicts = useJudgeVerdicts();
	const runsJoin = useRunsJoin();

	if (verdicts.isLoading) {
		return (
			<TelemetryPanel title="Judge verdicts" meta="LOADING">
				<p className="text-[12px] leading-4 text-(--color-text-3)">Loading verdicts…</p>
			</TelemetryPanel>
		);
	}

	const state = verdicts.data ?? { available: false as const, reason: "absent" as const };
	if (!state.available) {
		return <AbsentPanel state={state} />;
	}

	const summary = summarizeJudgeVerdicts(state.rows);
	const runById = new Map((runsJoin.data?.runs ?? []).map((r) => [r.id, r]));

	const failing = state.rows
		.filter(
			(r) =>
				r.kind === "unjudged" || (r.verdict?.assignments ?? []).some((a) => a.class !== "clean"),
		)
		.sort((a, b) => b.id - a.id);

	return (
		<div className="flex flex-col gap-4">
			<TelemetryPanel title="Merged, then failed the judge" meta="REVIEW THESE FIRST">
				{failing.length === 0 ? (
					<p className="text-[12px] leading-4 text-(--color-text-3)">
						No failed verdicts in the export — every judged run is clean.
					</p>
				) : (
					<table className="w-full">
						<thead>
							<tr>
								{["RUN", "AGENT", "FAILING CLASS", "PR", "JUDGED"].map((h, i) => (
									<th
										key={h}
										className={`pb-2 pr-3 text-left font-mono text-[10px] tracking-[0.06em] text-(--color-text-3) ${i === 4 ? "text-right" : ""}`}
									>
										{h}
									</th>
								))}
							</tr>
						</thead>
						<tbody>
							{failing.slice(0, FAILED_ROWS).map((row) => (
								<FailedVerdictRow key={row.id} row={row} run={runById.get(row.runId)} />
							))}
						</tbody>
					</table>
				)}
				<p className="text-[12px] leading-4 text-(--color-text-2)">
					Failed verdicts and unjudged markers from the extension's append-only export, joined with
					run records and forge PR state.
				</p>
			</TelemetryPanel>

			<TelemetryPanel title="Judge verdicts" meta="RUBRIC V1 · 15 CLASSES">
				<div className="flex flex-wrap items-center gap-4">
					<span className="font-mono text-[11px] leading-[14px] text-(--color-success)">
						pass {String(summary.pass)}
					</span>
					<span className="font-mono text-[11px] leading-[14px] text-(--color-danger)">
						fail {String(summary.fail)}
					</span>
					<span className="font-mono text-[11px] leading-[14px] text-(--color-text-3)">
						unjudged {String(summary.unjudged)}
					</span>
				</div>

				{summary.failingClasses.length > 0 ? (
					<div className="flex flex-col gap-2">
						<span className="font-mono text-[10px] tracking-[0.06em] leading-3 text-(--color-text-3)">
							FAILING CLASSES · WORST 5 OF 15
						</span>
						{summary.failingClasses.slice(0, 5).map((c) => {
							const max = summary.failingClasses[0]?.count ?? 1;
							const width = `${Math.max(4, Math.round((c.count / max) * 100))}%`;
							return (
								<div key={c.name} className="flex w-full items-center gap-2.5">
									<span className="w-36 shrink-0 font-mono text-[11px] leading-[14px] text-(--color-text-2)">
										{c.name}
									</span>
									<div
										className="h-2.5 shrink-0 rounded-[1px] bg-(--color-danger)"
										style={{ width }}
									/>
									<span className="font-mono text-[11px] leading-[14px] text-(--color-text-3)">
										{String(c.count)}
									</span>
								</div>
							);
						})}
					</div>
				) : (
					<p className="text-[12px] leading-4 text-(--color-text-3)">
						No failing classes in the export.
					</p>
				)}
				<p className="text-[12px] leading-4 text-(--color-text-2)">
					Unjudged runs carry a marker until the judge catches up. Figures cover the newest{" "}
					{String(state.rows.length)} exported rows.
				</p>
			</TelemetryPanel>
		</div>
	);
}
