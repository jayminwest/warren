import type { RunState } from "@/api/types.ts";
import { cn } from "@/lib/utils.ts";

/**
 * Shared state → token-tone map for the Operations page (warren-d903).
 * Tokens only — no literal colors, so light/dark both hold.
 */

export const STATE_TONE: Record<RunState, string> = {
	queued: "text-(--color-warning)",
	running: "text-(--color-info)",
	succeeded: "text-(--color-success)",
	failed: "text-(--color-danger)",
	cancelled: "text-(--color-text-3)",
};

export const STATE_DOT: Record<RunState, string> = {
	queued: "bg-(--color-warning)",
	running: "bg-(--color-info)",
	succeeded: "bg-(--color-success)",
	failed: "bg-(--color-danger)",
	cancelled: "bg-(--color-text-3)",
};

/** Phase dot + mono label, the canvas row idiom. */
export function StatePill({ state }: { state: RunState }) {
	return (
		<span className="flex min-w-0 items-center gap-[7px]">
			<span className={cn("h-1.5 w-1.5 shrink-0 rounded-full", STATE_DOT[state])} aria-hidden />
			<span className={cn("font-mono text-[10px] leading-3", STATE_TONE[state])}>{state}</span>
		</span>
	);
}
