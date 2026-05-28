import type { PlanRunChildState, PlanRunState } from "@/api/types.ts";
import { StatusIndicator } from "@/components/StatusIndicator.tsx";

/**
 * Thin wrappers over `<StatusIndicator>` for plan-run / plan-run
 * child states. Label/colour/icon/pulse mapping lives in
 * `StatusIndicator.tsx` (warren-3849).
 */
export function PlanRunStateBadge({ state }: { state: PlanRunState }) {
	return <StatusIndicator kind="planRun" status={state} />;
}

export function PlanRunChildStateBadge({ state }: { state: PlanRunChildState }) {
	return <StatusIndicator kind="planRunChild" status={state} />;
}
