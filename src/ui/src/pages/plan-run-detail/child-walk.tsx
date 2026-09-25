import { useCallback, useMemo } from "react";
import { Link, useNavigate } from "react-router-dom";
import type { PlanRunChildRow, PlanRunRow, RunRow } from "@/api/types.ts";
import { isTerminalPlanRunState } from "@/api/types.ts";
import { Card, CardFooter, CardHeader } from "@/components/ui/card.tsx";
import { EmptyState } from "@/components/ui/empty-state.tsx";
import { PrChip, StatusText } from "@/components/ui/status.tsx";
import { Tag } from "@/components/ui/tag.tsx";
import { useListKeys } from "@/hooks/use-list-keys.ts";
import { formatPlanRunFailureReason } from "@/lib/labels.ts";
import { cn, relativeTime } from "@/lib/utils.ts";

/**
 * The Child walk card of the plan run inspector (warren-2520, migrated in
 * warren-9474 / warren-0690): one row per child, in dispatch order, with
 * the gate state the coordinator tracks, the linked run, its PR, and a
 * one-line status. The row's seed cell links to the child's run; J/K
 * moves a highlight and Enter opens it. The card sizes to its rows — it
 * never stretches to the rail's height (warren-dac1).
 */

/** Status line for a child: a failed reason, merge timing, or the gate it waits on. */
export function childStatusLine(
	child: PlanRunChildRow,
	gateSeq: number | null,
): { text: string; danger: boolean } | null {
	if (child.state === "failed") {
		return {
			text:
				child.failureReason == null ? "Failed" : formatPlanRunFailureReason(child.failureReason),
			danger: true,
		};
	}
	if (child.state === "merged") {
		const at = child.prMergedAt ?? child.endedAt;
		return { text: at !== null ? `Merged ${relativeTime(at)}` : "Merged", danger: false };
	}
	if (child.state === "pr_open") {
		return { text: `Waiting for merge · opened ${relativeTime(child.updatedAt)}`, danger: false };
	}
	if (child.state === "pending" && gateSeq !== null && gateSeq < child.seq) {
		return { text: `Waits on child ${gateSeq}`, danger: false };
	}
	if (child.state === "skipped") return { text: "Already closed at dispatch", danger: false };
	return null;
}

function runHref(runId: string): string {
	return `/runs/${encodeURIComponent(runId)}`;
}

function ChildRow({
	child,
	run,
	gateSeq,
	isGate,
	selected,
	rowRef,
}: {
	child: PlanRunChildRow;
	run: RunRow | undefined;
	gateSeq: number | null;
	isGate: boolean;
	selected: boolean;
	rowRef: (el: HTMLElement | null) => void;
}) {
	const status = childStatusLine(child, gateSeq);
	const prUrl = run?.prUrl ?? null;
	const prLifecycle = child.state === "merged" ? "merged" : (run?.prState ?? null);
	return (
		<li
			ref={rowRef}
			data-selected={selected}
			className={cn(
				"flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-(--color-border) px-4 py-2.5 transition-colors last:border-b-0 hover:bg-(--color-surface-hover) data-[selected=true]:bg-(--color-surface-hover)",
				isGate && "bg-(--color-surface-raised)",
			)}
		>
			<span className="w-6 shrink-0 text-xs text-(--color-text-3) tabular-nums">{child.seq}</span>
			<div className="flex min-w-0 flex-1 flex-col gap-0.5 sm:w-44 sm:flex-none">
				<span className="truncate font-mono text-xs text-(--color-text)">{child.seedId}</span>
				{child.runId !== null ? (
					<Link
						to={runHref(child.runId)}
						className="truncate font-mono text-xs text-(--color-text-3) underline-offset-2 hover:text-(--color-primary) hover:underline"
					>
						{child.runId}
					</Link>
				) : (
					<span className="text-xs text-(--color-text-3)">Not dispatched</span>
				)}
			</div>
			<StatusText state={child.state} className="w-28 shrink-0" />
			<div className="flex min-w-0 flex-1 basis-full items-center gap-2 pl-9 sm:basis-auto sm:pl-0">
				{prUrl !== null ? <PrChip url={prUrl} lifecycle={prLifecycle} /> : null}
				{child.retryCount > 0 ? (
					<Tag
						className="tabular-nums"
						title="Warren re-dispatched this child automatically after a failure"
					>
						{child.retryCount} {child.retryCount === 1 ? "retry" : "retries"}
					</Tag>
				) : null}
				{isGate ? <Tag>Gate</Tag> : null}
				{status !== null ? (
					<span
						className={cn(
							"min-w-0 truncate text-xs",
							status.danger ? "text-(--color-danger)" : "text-(--color-text-3)",
						)}
						title={child.failureReason ?? undefined}
					>
						{status.text}
					</span>
				) : null}
			</div>
		</li>
	);
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
	const navigate = useNavigate();
	const runIndex = useMemo(() => new Map(runs.map((r) => [r.id, r])), [runs]);

	// The gate child: the first child that hasn't cleared its PR merge
	// (or been skipped). Pending children after it wait on it.
	const gateSeq = useMemo(
		() => childRows.find((c) => c.state !== "merged" && c.state !== "skipped")?.seq ?? null,
		[childRows],
	);
	const walkLive = !isTerminalPlanRunState(planRun.state);
	const mergedCount = useMemo(
		() => childRows.filter((c) => c.state === "merged").length,
		[childRows],
	);

	const open = useCallback(
		(i: number) => {
			const runId = childRows[i]?.runId;
			if (runId != null) navigate(runHref(runId));
		},
		[childRows, navigate],
	);
	const { selected, setRef } = useListKeys(childRows.length, open);

	return (
		<Card className="w-full lg:flex-1">
			<CardHeader
				title="Child walk"
				meta={`${childRows.length} ${childRows.length === 1 ? "child" : "children"}`}
			/>
			{childRows.length === 0 ? (
				<EmptyState
					compact
					title="No children"
					description="The plan had no open child issues when it was dispatched."
				/>
			) : (
				<ol aria-label="Children">
					{childRows.map((c, i) => (
						<ChildRow
							key={`${c.planRunId}-${c.seq}`}
							child={c}
							run={c.runId !== null ? runIndex.get(c.runId) : undefined}
							gateSeq={gateSeq}
							isGate={walkLive && c.seq === gateSeq}
							selected={selected === i}
							rowRef={setRef(i)}
						/>
					))}
				</ol>
			)}
			<CardFooter>
				<span className="min-w-0">
					Children run one at a time; each waits for the previous PR to merge. Re-dispatching this
					plan resumes from the next open child.
				</span>
				<span className="shrink-0 tabular-nums">
					{mergedCount} of {childRows.length} merged
				</span>
			</CardFooter>
		</Card>
	);
}
