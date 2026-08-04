import type { RunRow } from "@/api/types.ts";
import { Card, CardContent } from "@/components/ui/card.tsx";
import { formatCostUsd, formatTokenBreakdown } from "@/pages/run-detail-format.ts";

/**
 * Cost + token breakdown card for /runs/:id (warren-a7ec). Promoted out
 * of a header badge with a hover-only tooltip so the token totals are
 * visible without interaction. Renders "—" when the run has no recorded
 * cost (pre-pi-extraction runs or non-pi runtimes); the breakdown line
 * is omitted when no token counters are populated.
 */
export function CostCard({ run }: { run: RunRow }) {
	const tokens = formatTokenBreakdown(run);
	return (
		<Card>
			<CardContent className="space-y-1 p-4">
				<div className="text-xs uppercase tracking-wide text-(--color-muted-foreground)">Cost</div>
				<div className="font-mono text-lg">
					{run.costUsd !== null ? (
						formatCostUsd(run.costUsd)
					) : (
						<span className="text-(--color-muted-foreground)">—</span>
					)}
				</div>
				{tokens !== null ? (
					<div className="font-mono text-xs text-(--color-muted-foreground)">{tokens}</div>
				) : null}
			</CardContent>
		</Card>
	);
}
