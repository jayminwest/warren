import { useMemo } from "react";
import { Link } from "react-router-dom";
import type { PlanRunChildRow, PlanRunRow, RunRow } from "@/api/types.ts";
import { formatPlanRunFailureReason } from "@/lib/labels.ts";
import { relativeTime } from "@/lib/utils.ts";
import { CHILD_SQUARE_COLOR } from "../plan-runs/walk-state.ts";

/**
 * The Child walk panel of the walk inspector (warren-2520): one row per
 * child seed, in dispatch order, with the gate state the coordinator
 * tracks — merged / pr_open / failed / pending — plus the linked run,
 * PR chip, and merge timing. Everything renders from the
 * `GET /plan-runs/:id` payload; nothing is derived that the API doesn't
 * carry.
 */

/** PR short label (`PR #612`) from the forge URL tail — null when unparseable. */
function prNumberFromUrl(url: string): string | null {
	const m = url.match(/\/pull\/(\d+)$/);
	return m === null ? null : `PR #${m[1]}`;
}

export function ChildWalkPanel({
	planRun,
	childRows,
	runs,
}: {
	planRun: PlanRunRow;
	childRows: PlanRunChildRow[];
	runs: RunRow[];
}) {
	const runIndex = useMemo(() => {
		const m = new Map<string, RunRow>();
		for (const r of runs) m.set(r.id, r);
		return m;
	}, [runs]);

	// The gate child: the first child that hasn't cleared its PR merge
	// (or been skipped). Pending children after it wait on it.
	const gateSeq = useMemo(() => {
		const gate = childRows.find((c) => c.state !== "merged" && c.state !== "skipped");
		return gate === undefined ? null : gate.seq;
	}, [childRows]);

	const mergedCount = childRows.filter((c) => c.state === "merged").length;

	return (
		<section className="flex min-w-0 flex-1 flex-col rounded border border-(--color-border) bg-(--color-surface)">
			<header className="flex h-[41px] shrink-0 items-center gap-2.5 border-b border-(--color-border) px-3.5">
				<h2 className="text-[12px] leading-4 font-semibold text-(--color-text)">Child walk</h2>
				<span className="flex h-5 items-center rounded-(--radius-xs) border border-(--color-border-strong) px-1.5 font-mono text-[9px] leading-3 text-(--color-text-2)">
					{childRows.length} CHILD{childRows.length === 1 ? "" : "REN"}
				</span>
				<div className="min-w-0 flex-1" />
				<span className="font-mono text-[9px] leading-3 tracking-[0.05em] text-(--color-text-3)">
					ONE AT A TIME · GATED ON PR MERGE
				</span>
			</header>

			{childRows.length === 0 ? (
				<p className="px-3.5 py-6 text-[11px] leading-4 text-(--color-text-3)">
					No children — the plan had no open child seeds at dispatch.
				</p>
			) : (
				childRows.map((c) => {
					const run = c.runId !== null ? runIndex.get(c.runId) : undefined;
					return (
						<ChildRow
							key={`${c.planRunId}-${c.seq}`}
							child={c}
							run={run}
							gateSeq={gateSeq}
							isGate={c.seq === gateSeq && !isTerminalWalk(planRun)}
						/>
					);
				})
			)}

			<footer className="flex h-[37px] shrink-0 items-center gap-2.5 px-3.5">
				<span className="font-mono text-[9px] leading-3 tracking-[0.05em] text-(--color-text-3)">
					RE-DISPATCHING THIS PLAN RESUMES FROM THE NEXT OPEN CHILD
				</span>
				<div className="min-w-0 flex-1" />
				<span className="font-mono text-[9px] leading-3 text-(--color-text-3)">
					{mergedCount} / {childRows.length} merged
				</span>
			</footer>
		</section>
	);
}

function isTerminalWalk(planRun: PlanRunRow): boolean {
	return (
		planRun.state === "succeeded" || planRun.state === "failed" || planRun.state === "cancelled"
	);
}

function ChildRow({
	child,
	run,
	gateSeq,
	isGate,
}: {
	child: PlanRunChildRow;
	run: RunRow | undefined;
	gateSeq: number | null;
	isGate: boolean;
}) {
	const color = CHILD_SQUARE_COLOR[child.state];
	const prLabel =
		run?.prUrl !== undefined && run.prUrl !== null ? prNumberFromUrl(run.prUrl) : null;

	return (
		<div
			className={`flex min-h-[49px] items-center gap-3 border-b border-(--color-border) px-3.5 py-1.5 ${
				isGate ? "bg-(--color-surface-raised)" : ""
			}`}
		>
			<span
				className={`w-[22px] shrink-0 font-mono text-[10px] leading-3 ${
					isGate ? "text-(--color-text-2)" : "text-(--color-text-3)"
				}`}
			>
				{String(child.seq).padStart(2, "0")}
			</span>
			<div className="flex w-[150px] shrink-0 flex-col gap-0.5">
				<span className="font-mono text-[10px] leading-3 text-(--color-text)">{child.seedId}</span>
				<span className="font-mono text-[9px] leading-3 text-(--color-text-3)">
					{child.runId !== null ? (
						<Link
							to={`/runs/${encodeURIComponent(child.runId)}`}
							className="underline-offset-2 hover:underline"
						>
							{child.runId}
						</Link>
					) : (
						"not dispatched"
					)}
				</span>
			</div>
			<span className="flex w-[88px] shrink-0 items-center gap-[7px]">
				<span
					className="h-1.5 w-1.5 shrink-0 rounded-full"
					style={{ backgroundColor: color }}
					aria-hidden
				/>
				<span className="font-mono text-[10px] leading-3" style={{ color }}>
					{child.state}
				</span>
			</span>
			{prLabel !== null ? (
				<span className="flex h-5 shrink-0 items-center rounded-(--radius-xs) border border-(--color-border-strong) px-1.5 font-mono text-[9px] leading-3 text-(--color-primary)">
					{prLabel}
				</span>
			) : null}
			{child.retryCount > 0 ? (
				<span
					className="flex h-5 shrink-0 items-center rounded-(--radius-xs) border border-(--color-border-strong) px-1.5 font-mono text-[9px] leading-3 text-(--color-text-2)"
					title={`Automatic re-dispatch used ${child.retryCount} of its budget (warren-6de9)`}
				>
					{child.retryCount} retry{child.retryCount === 1 ? "" : "s"}
				</span>
			) : null}
			<ChildStatus child={child} run={run} gateSeq={gateSeq} />
		</div>
	);
}

function ChildStatus({
	child,
	run,
	gateSeq,
}: {
	child: PlanRunChildRow;
	run: RunRow | undefined;
	gateSeq: number | null;
}) {
	// A failed child outranks the timing line: the reason is the evidence
	// an operator reads first. Raw coordinator text rides the tooltip.
	if (child.state === "failed") {
		return (
			<span
				className="min-w-0 flex-1 truncate font-mono text-[9px] leading-3 text-(--color-danger)"
				title={child.failureReason ?? undefined}
			>
				{child.failureReason === null ? "failed" : formatPlanRunFailureReason(child.failureReason)}
			</span>
		);
	}

	let status: string | null = null;
	if (child.state === "merged") {
		const at = child.prMergedAt ?? child.endedAt;
		status = at !== null ? `merged ${relativeTime(at)}` : "merged";
	} else if (child.state === "pr_open") {
		status = `open ${relativeTime(child.updatedAt)} · waiting for merge`;
	} else if (child.state === "pending" && gateSeq !== null && gateSeq < child.seq) {
		status = `waits on child ${gateSeq}`;
	}

	const prUrl = run?.prUrl ?? null;
	return (
		<>
			{status !== null ? (
				<span className="min-w-0 flex-1 truncate font-mono text-[9px] leading-3 text-(--color-text-3)">
					{status}
				</span>
			) : (
				<div className="min-w-0 flex-1" />
			)}
			{child.state === "pr_open" && prUrl !== null ? (
				<a
					href={prUrl}
					target="_blank"
					rel="noreferrer noopener"
					className="flex h-6 shrink-0 items-center rounded-(--radius-sm) border border-(--color-border-strong) bg-(--color-surface) px-[9px] text-[10px] leading-3 font-medium text-(--color-text-2)"
				>
					Open PR ↗
				</a>
			) : null}
		</>
	);
}
