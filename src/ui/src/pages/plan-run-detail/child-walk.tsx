import { useMemo } from "react";
import { Link } from "react-router-dom";
import type { PlanRunChildRow, PlanRunRow, RunRow } from "@/api/types.ts";
import {
	CardFigure,
	CardFigureNote,
	InventoryCardList,
	type InventoryCardTone,
	InventoryRowCard,
} from "@/components/ui/inventory-card.tsx";
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
				<>
					{/* No mobile artboard for plan-run-detail (warren-89aa): the
					 * child rows degrade to the shared InventoryRowCard pattern
					 * below md; the table above md is untouched. */}
					<InventoryCardList>
						{childRows.map((c) => (
							<ChildCard
								key={`${c.planRunId}-${c.seq}`}
								child={c}
								run={c.runId !== null ? runIndex.get(c.runId) : undefined}
								gateSeq={gateSeq}
								isGate={c.seq === gateSeq && !isTerminalWalk(planRun)}
							/>
						))}
					</InventoryCardList>
					<div className="hidden md:block">
						{childRows.map((c) => {
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
						})}
					</div>
				</>
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

/* --------------------------------------------------------------------- */
/* Mobile arm (warren-89aa): shared InventoryRowCard degradation        */
/* --------------------------------------------------------------------- */

/** Status line shared by the desktop row and the mobile card arm:
 * failed reason (danger tint) or merge/gate timing, or null when the
 * desktop row fills its spacer instead. */
function childStatusLine(
	child: PlanRunChildRow,
	gateSeq: number | null,
): { text: string; danger: boolean } | null {
	if (child.state === "failed") {
		return {
			text:
				child.failureReason == null ? "failed" : formatPlanRunFailureReason(child.failureReason),
			danger: true,
		};
	}
	if (child.state === "merged") {
		const at = child.prMergedAt ?? child.endedAt;
		return { text: at !== null ? `merged ${relativeTime(at)}` : "merged", danger: false };
	}
	if (child.state === "pr_open") {
		return {
			text: `open ${relativeTime(child.updatedAt)} · waiting for merge`,
			danger: false,
		};
	}
	if (child.state === "pending" && gateSeq !== null && gateSeq < child.seq) {
		return { text: `waits on child ${gateSeq}`, danger: false };
	}
	return null;
}

/** Child state → card tone (mirrors CHILD_SQUARE_COLOR). */
function childTone(state: PlanRunChildRow["state"]): InventoryCardTone {
	switch (state) {
		case "merged":
			return "success";
		case "failed":
			return "danger";
		case "pr_open":
			return "warning";
		case "dispatched":
		case "running":
			return "info";
		default:
			return "muted";
	}
}

/** Trailing figure column of the mobile child card: gate marker, PR
 * label, retry budget note — each only when present. */
function childCardFigures(child: PlanRunChildRow, prLabel: string | null, isGate: boolean) {
	return (
		<>
			{isGate ? <CardFigure value="GATE" /> : null}
			{prLabel !== null ? <CardFigure className="text-(--color-primary)" value={prLabel} /> : null}
			{child.retryCount > 0 ? (
				<CardFigureNote value={`${child.retryCount} retry${child.retryCount === 1 ? "" : "s"}`} />
			) : null}
		</>
	);
}

/** The card's meta line, danger-tinted for a failed child. */
function ChildCardMeta({
	status,
	title,
}: {
	status: { text: string; danger: boolean };
	title: string | null;
}) {
	return (
		<span
			className={status.danger ? "text-(--color-danger)" : undefined}
			title={title ?? undefined}
		>
			{status.text}
		</span>
	);
}

function ChildCard({
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
	const prLabel =
		run?.prUrl !== undefined && run.prUrl !== null ? prNumberFromUrl(run.prUrl) : null;
	const status = childStatusLine(child, gateSeq);
	const prUrl = run?.prUrl ?? null;
	return (
		<InventoryRowCard
			tone={childTone(child.state)}
			stateLabel={child.state}
			title={`${String(child.seq).padStart(2, "0")} ${child.seedId}`}
			titleTo={child.runId !== null ? `/runs/${encodeURIComponent(child.runId)}` : undefined}
			subline={child.runId !== null ? child.runId : "not dispatched"}
			figures={childCardFigures(child, prLabel, isGate)}
			meta={
				status !== null ? (
					<ChildCardMeta status={status} title={child.failureReason ?? null} />
				) : undefined
			}
		>
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
		</InventoryRowCard>
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
			className={`flex min-h-[49px] flex-wrap items-center gap-3 border-b border-(--color-border) px-3.5 py-1.5 ${
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
	const status = childStatusLine(child, gateSeq);
	const prUrl = run?.prUrl ?? null;
	return (
		<>
			{status !== null ? (
				<span
					className={`min-w-0 flex-1 truncate font-mono text-[9px] leading-3 ${
						status.danger ? "text-(--color-danger)" : "text-(--color-text-3)"
					}`}
					title={child.failureReason ?? undefined}
				>
					{status.text}
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
