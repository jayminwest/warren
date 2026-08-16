import type { RunState } from "@/api/types.ts";
import { StatusIndicator } from "@/components/StatusIndicator.tsx";

/**
 * Thin wrapper over `<StatusIndicator kind="run">` kept for
 * backwards compatibility. Centralised label/colour/icon/pulse
 * mapping lives in `StatusIndicator.tsx` (warren-3849).
 */
export function StateBadge({ state }: { state: RunState }) {
	return <StatusIndicator kind="run" status={state} />;
}
