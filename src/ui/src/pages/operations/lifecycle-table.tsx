import type { OpsOverviewResponse } from "@/api/ops-types.ts";
import type { RunRow } from "@/api/types.ts";
import { formatDurationMs, LIFECYCLE_ORDER, oldestPhaseInstant } from "./operations.helpers.ts";
import { StatePill } from "./state-tone.tsx";

/**
 * Lifecycle snapshot (warren-d903): phase → count from the ops
 * overview's dense `byState` roll-up, with the oldest phase age for the
 * two active phases (computed from the newest-runs window — the
 * snapshot carries no per-state age). Terminal-phase ages stay "—"
 * rather than fabricating a figure.
 */

export function LifecycleTable({
	overview,
	runs,
	now,
}: {
	overview: OpsOverviewResponse | undefined;
	runs: readonly RunRow[] | undefined;
	now: number;
}) {
	return (
		<div className="flex min-w-0 flex-1 flex-col overflow-clip rounded-(--radius-md) border border-(--color-border) bg-(--color-surface)">
			<div className="flex h-[39px] shrink-0 items-center gap-2 border-b border-(--color-border) px-3">
				<span className="text-[11px] leading-3.5 font-semibold text-(--color-text)">
					Lifecycle snapshot
				</span>
			</div>
			<div className="flex items-center gap-2 border-b border-(--color-border) px-2.5 py-2">
				<span className="flex-1 font-mono text-[9px] font-semibold tracking-[0.05em] text-(--color-text-3)">
					PHASE
				</span>
				<span className="w-[60px] shrink-0 text-right font-mono text-[9px] font-semibold tracking-[0.05em] text-(--color-text-3)">
					COUNT
				</span>
				<span className="w-[80px] shrink-0 text-right font-mono text-[9px] font-semibold tracking-[0.05em] text-(--color-text-3)">
					OLDEST
				</span>
			</div>
			{LIFECYCLE_ORDER.map((state, i) => {
				const count = overview?.runs.byState[state];
				const active = state === "queued" || state === "running";
				const oldest = runs !== undefined && active ? oldestPhaseInstant(runs, state) : null;
				return (
					<div
						key={state}
						className={
							i < LIFECYCLE_ORDER.length - 1
								? "flex items-center gap-2 border-b border-(--color-border) px-2.5 py-2.5"
								: "flex items-center gap-2 px-2.5 py-2.5"
						}
					>
						<span className="flex-1">
							<StatePill state={state} />
						</span>
						<span className="w-[60px] shrink-0 text-right font-mono text-[11px] leading-3.5 text-(--color-text-2)">
							{count === undefined ? "—" : count}
						</span>
						<span className="w-[80px] shrink-0 text-right font-mono text-[10px] leading-3 text-(--color-text-3)">
							{oldest === null ? "—" : formatDurationMs(now - oldest)}
						</span>
					</div>
				);
			})}
		</div>
	);
}
