import { Link } from "react-router-dom";
import type { PlanRunListRow } from "@/api/types.ts";
import { StatusText } from "@/components/ui/status.tsx";
import { TableCell, TableRow } from "@/components/ui/table.tsx";
import { Tag } from "@/components/ui/tag.tsx";
import { relativeTime } from "@/lib/utils.ts";
import { formatCostUsd } from "@/pages/run-detail-format.ts";
import { ChildSquares } from "./child-squares.tsx";
import { childSummary, planRunElapsed } from "./walk-state.ts";

/**
 * One walk row in the plan-runs table (warren-23b2, migrated in
 * warren-9474). Child progress comes from the list row's `childStates`
 * (warren-b2d6) — no detail fetch per row.
 */

/** "pl-10db" for a plan walk, "3 issues" for an explicit issue list. */
export function planLabelOf(planRun: PlanRunListRow): string {
	if (planRun.source === "plan") return planRun.planId ?? "—";
	const n = planRun.childStates.length;
	return `${n} ${n === 1 ? "issue" : "issues"}`;
}

/**
 * The spend cap cell. The cap and the dispatcher are redacted for a
 * spectator (warren-17d7), so both treat "absent" like null.
 */
function capLabelOf(planRun: PlanRunListRow): string {
	const cap = planRun.maxCostUsd;
	return cap == null ? "—" : formatCostUsd(cap);
}

export function WalkRow({
	planRun,
	projectLabel,
	now,
	selected,
	rowRef,
	onOpen,
}: {
	planRun: PlanRunListRow;
	projectLabel: string;
	now: number;
	selected: boolean;
	rowRef: (el: HTMLElement | null) => void;
	onOpen: (path: string) => void;
}) {
	const path = `/plan-runs/${encodeURIComponent(planRun.id)}`;
	const by = planRun.dispatcherHandle ?? null;
	return (
		<TableRow
			ref={rowRef}
			data-selected={selected}
			className="cursor-pointer"
			onClick={() => onOpen(path)}
		>
			<TableCell className="w-32">
				<StatusText state={planRun.state} />
			</TableCell>
			<TableCell className="max-w-56">
				<span className="flex min-w-0 flex-col">
					<Link
						to={path}
						onClick={(e) => e.stopPropagation()}
						title={by !== null ? `Dispatched by ${by}` : undefined}
						className="truncate font-mono text-sm text-(--color-text) hover:underline"
					>
						{planRun.id}
					</Link>
					<span className="truncate font-mono text-2xs text-(--color-text-3)">
						{planLabelOf(planRun)}
					</span>
				</span>
			</TableCell>
			<TableCell className="max-w-48">
				<span className="flex min-w-0 flex-col">
					<span className="truncate text-(--color-text-2)">{projectLabel}</span>
					{planRun.ref !== null ? (
						<span className="truncate font-mono text-2xs text-(--color-text-3)">{planRun.ref}</span>
					) : null}
				</span>
			</TableCell>
			<TableCell className="max-w-44">
				<span className="flex min-w-0 flex-col">
					<span className="truncate text-(--color-text)">{planRun.agentName}</span>
					{planRun.modelOverride != null ? (
						<span className="truncate font-mono text-2xs text-(--color-text-3)">
							{planRun.modelOverride}
						</span>
					) : null}
				</span>
			</TableCell>
			<TableCell className="min-w-56">
				<span className="flex min-w-0 flex-col gap-1">
					<ChildSquares states={planRun.childStates} />
					<span className="truncate text-xs text-(--color-text-3)">
						{childSummary(planRun.state, planRun.childStates)}
					</span>
				</span>
			</TableCell>
			<TableCell>
				<Tag>{planRun.trigger}</Tag>
			</TableCell>
			<TableCell
				className="whitespace-nowrap text-(--color-text-2)"
				title={planRun.startedAt ?? undefined}
			>
				{relativeTime(planRun.startedAt)}
			</TableCell>
			<TableCell className="text-right whitespace-nowrap text-(--color-text-2)">
				{planRunElapsed(planRun, now)}
			</TableCell>
			<TableCell
				className="text-right whitespace-nowrap text-(--color-text-2)"
				title="Spend cap per child run"
			>
				{capLabelOf(planRun)}
			</TableCell>
		</TableRow>
	);
}
