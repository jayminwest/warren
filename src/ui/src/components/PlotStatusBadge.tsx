import type { PlotStatus } from "@/api/types.ts";
import { StatusIndicator } from "@/components/StatusIndicator.tsx";

/**
 * Thin wrapper over `<StatusIndicator kind="plot">` kept for
 * backwards compatibility. The five SPEC §6.5 statuses and their
 * label/colour/icon/pulse mapping live in `StatusIndicator.tsx`
 * (warren-3849, formerly warren-6336 / pl-9d6a step 16).
 */
export function PlotStatusBadge({ status }: { status: PlotStatus }) {
	return <StatusIndicator kind="plot" status={status} />;
}
