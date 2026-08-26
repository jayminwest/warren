import type { OpsOverviewResponse } from "@/api/ops-types.ts";
import { cn } from "@/lib/utils.ts";
import { priorityEntries } from "./operations.helpers.ts";

/**
 * Operator interventions panel (warren-d903). The snapshot's
 * interventions section (unread steering-inbox rows by priority class)
 * is operator-only — the public projection omits it, so a spectator
 * never sees this panel at all. The canvas's per-run Inspect / Re-run /
 * Steer actions need per-run inbox rows no API serves yet; the counts
 * render without fabricated rows or dead buttons.
 */

const PRIORITY_TONE: Record<string, { dot: string; text: string }> = {
	urgent: { dot: "bg-(--color-danger)", text: "text-(--color-danger)" },
	high: { dot: "bg-(--color-danger)", text: "text-(--color-danger)" },
	normal: { dot: "bg-(--color-warning)", text: "text-(--color-warning)" },
	low: { dot: "bg-(--color-warning)", text: "text-(--color-warning)" },
};

export function InterventionsPanel({ overview }: { overview: OpsOverviewResponse | undefined }) {
	const interventions = overview?.interventions;
	if (interventions === undefined) return null;
	const entries = priorityEntries(interventions.pendingByPriority);
	const open = interventions.pendingTotal > 0;
	return (
		<section className="flex flex-col pt-4">
			<header className="flex h-7 shrink-0 items-center gap-2 pb-1.25">
				<h2 className="text-[11px] leading-3.5 font-semibold text-(--color-text-2)">
					Operator interventions
				</h2>
				{open ? (
					<span className="flex h-5 items-center rounded-(--radius-xs) border border-(--color-danger) px-1.5">
						<span className="font-mono text-[9px] leading-3 text-(--color-danger)">
							{interventions.pendingTotal} OPEN
						</span>
					</span>
				) : null}
				<span className="flex-1" />
				<span className="font-mono text-[9px] leading-3 text-(--color-text-3)">
					ONLY CONDITIONS THAT REQUIRE JUDGMENT
				</span>
			</header>
			<div className="flex flex-col overflow-clip rounded-(--radius-md) border border-(--color-border) bg-(--color-surface)">
				{!open ? (
					<p className="px-3 py-3 font-mono text-[10px] leading-3 text-(--color-text-3)">
						No interventions pending — the steering inbox is fully read.
					</p>
				) : (
					entries.map((entry, i) => {
						const tone = PRIORITY_TONE[entry.priority] ?? {
							dot: "bg-(--color-warning)",
							text: "text-(--color-warning)",
						};
						return (
							<div
								key={entry.priority}
								className={cn(
									"flex min-h-[43px] items-center gap-3 px-3 py-1.5",
									i < entries.length - 1 && "border-b border-(--color-border)",
								)}
							>
								<span className="flex w-[72px] shrink-0 items-center gap-[7px]">
									<span className={cn("h-1.5 w-1.5 shrink-0 rounded-full", tone.dot)} aria-hidden />
									<span className={cn("font-mono text-[10px] leading-3 uppercase", tone.text)}>
										{entry.priority}
									</span>
								</span>
								<span className="min-w-0 flex-1 truncate text-[11px] leading-3.5 text-(--color-text-2)">
									{entry.count} unread steering-inbox row{entry.count === 1 ? "" : "s"} at{" "}
									{entry.priority} priority.
								</span>
							</div>
						);
					})
				)}
			</div>
		</section>
	);
}
