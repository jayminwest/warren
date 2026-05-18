import { Badge } from "@/components/ui/badge.tsx";
import type { PlotStatus } from "@/api/types.ts";

/**
 * Status pill for a Plot — mirrors StateBadge.tsx's shape (warren-6336,
 * pl-9d6a step 16). The five SPEC §6.5 statuses map to dedicated
 * `Badge` variants in `components/ui/badge.tsx`; the variant union is
 * a strict superset so RunState/PlotStatus don't collide.
 */
export function PlotStatusBadge({ status }: { status: PlotStatus }) {
	return <Badge variant={status}>{status}</Badge>;
}
