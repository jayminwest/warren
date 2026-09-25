import { Check, X } from "lucide-react";
import { useMemo } from "react";
import type { RunEvent, RunRow } from "@/api/types.ts";
import { Card } from "@/components/ui/card.tsx";
import { StatusDot } from "@/components/ui/status.tsx";
import { cn } from "@/lib/utils.ts";
import { formatElapsedMs } from "@/pages/runs/runs-format.ts";
import {
	connectorSpan,
	deriveStages,
	type Stage,
	type StageStatus,
} from "./stage-timeline-logic.ts";

/**
 * Horizontal stage stepper (warren-7d17): a node per lifecycle moment,
 * with the time spent between moments on the connectors. The live stage
 * pulses and its connector ticks with `now`; a failed run marks the
 * stage where it stopped; stages the runtime never reported are dimmed.
 * Scrolls sideways inside its card on a phone.
 */

const NODE: Record<StageStatus, string> = {
	done: "border-(--color-success) bg-(--color-success)/15 text-(--color-success)",
	live: "border-(--color-info) bg-(--color-info)/10",
	failed: "border-(--color-danger) bg-(--color-danger)/15 text-(--color-danger)",
	skipped: "border-dashed border-(--color-border-strong) opacity-60",
	pending: "border-(--color-border-strong)",
};

function clock(at: number): string {
	return new Date(at).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
}

function Node({ stage }: { stage: Stage }) {
	const merged = stage.status === "done" && stage.label === "Merged";
	return (
		<span
			className={cn(
				"flex size-5 shrink-0 items-center justify-center rounded-full border",
				NODE[stage.status],
				merged && "border-(--color-merge) bg-(--color-merge)/15 text-(--color-merge)",
			)}
		>
			{stage.status === "done" ? <Check aria-hidden className="size-3" strokeWidth={3} /> : null}
			{stage.status === "failed" ? <X aria-hidden className="size-3" strokeWidth={3} /> : null}
			{stage.status === "live" ? <StatusDot state="running" size="sm" /> : null}
		</span>
	);
}

function StageNode({ stage }: { stage: Stage }) {
	const quiet = stage.status === "skipped" || stage.status === "pending";
	const caption = stage.at !== null ? clock(stage.at) : (stage.note ?? "");
	return (
		<div
			className="flex shrink-0 flex-col items-start"
			title={stage.at !== null ? new Date(stage.at).toLocaleString() : undefined}
		>
			<div className="flex items-center gap-2">
				<Node stage={stage} />
				<span
					className={cn(
						"text-sm font-medium whitespace-nowrap",
						quiet ? "text-(--color-text-3)" : "text-(--color-text)",
					)}
				>
					{stage.label}
				</span>
			</div>
			<span
				className={cn(
					"mt-0.5 pl-7 text-xs whitespace-nowrap tabular-nums",
					stage.status === "failed" ? "text-(--color-danger)" : "text-(--color-text-3)",
					stage.status === "live" && "text-(--color-info)",
				)}
			>
				{caption}
			</span>
		</div>
	);
}

function Connector({
	span,
	status,
}: {
	span: { ms: number | null; live: boolean };
	status: string;
}) {
	return (
		<div className="mx-3 mt-2.5 flex min-w-10 flex-1 flex-col items-center">
			<span
				aria-hidden
				className={cn(
					"h-px w-full",
					span.live
						? "bg-(--color-info)/50"
						: span.ms !== null && status !== "skipped"
							? "bg-(--color-success)/40"
							: "bg-(--color-border)",
				)}
			/>
			<span
				className={cn(
					"mt-1 text-xs tabular-nums",
					span.live ? "text-(--color-info)" : "text-(--color-text-3)",
				)}
			>
				{span.ms !== null ? formatElapsedMs(span.ms) : ""}
			</span>
		</div>
	);
}

export function StageTimeline({
	run,
	events,
	now,
}: {
	run: RunRow;
	events: RunEvent[];
	now: number;
}) {
	const stages = useMemo(() => deriveStages(run, events), [run, events]);
	return (
		<Card className="self-stretch">
			<div className="overflow-x-auto px-4 py-3.5">
				<ol aria-label="Run stages" className="flex min-w-xl items-start">
					{stages.map((s, i) => (
						<li key={s.key} className="flex flex-1 items-start last:flex-none">
							<StageNode stage={s} />
							{i < stages.length - 1 ? (
								<Connector
									span={connectorSpan(stages, i, now)}
									status={stages[i + 1]?.status ?? ""}
								/>
							) : null}
						</li>
					))}
				</ol>
			</div>
		</Card>
	);
}
