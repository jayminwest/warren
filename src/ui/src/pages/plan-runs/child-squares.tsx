import type { PlanRunChildState } from "@/api/types.ts";
import { stateLabel, stateTone, toneDot } from "@/components/ui/status.tsx";
import { cn } from "@/lib/utils.ts";

/**
 * One small square per plan-run child, in seq order (warren-23b2): the
 * walk's progress at a glance. Colour comes from the shared status
 * vocabulary; a pending child is an empty outline.
 */
export function ChildSquares({ states }: { states: readonly PlanRunChildState[] }) {
	return (
		<span
			className="flex shrink-0 flex-wrap gap-0.5"
			role="img"
			aria-label={states.map((s, i) => `Child ${i + 1}: ${stateLabel(s)}`).join(", ")}
		>
			{states.map((s, i) => (
				<span
					// biome-ignore lint/suspicious/noArrayIndexKey: children are a fixed seq-ordered list
					key={i}
					className={cn(
						"size-2 rounded-xs",
						s === "pending" ? "border border-(--color-border-strong)" : toneDot(stateTone(s)),
					)}
				/>
			))}
		</span>
	);
}
