/**
 * KPI cards row for the Run Analytics dashboard (warren-638a /
 * pl-ad0f step 5).
 *
 * Renders the `totals` envelope from `GET /analytics/runs` as a grid of
 * compact stat cards: total runs (with terminal-state breakdown),
 * success rate, median + p95 duration, median + total context tokens,
 * and total + avg cost. Each card degrades to an em-dash while the
 * query is loading or when the metric's sample is empty (null), so the
 * grid never collapses.
 */
import type { RunAnalyticsTotals } from "@/api/client.ts";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card.tsx";
import {
	formatCostUsd,
	formatCount,
	formatDurationMs,
	formatRate,
	formatTokensOrDash,
} from "./format.ts";

function KpiCard({
	title,
	value,
	hint,
}: {
	title: string;
	value: React.ReactNode;
	hint?: React.ReactNode;
}) {
	return (
		<Card>
			<CardHeader className="pb-3">
				<CardTitle className="text-xs font-medium text-(--color-muted-foreground)">
					{title}
				</CardTitle>
			</CardHeader>
			<CardContent>
				<div className="font-mono text-2xl">{value}</div>
				{hint !== undefined ? (
					<p className="mt-1 text-xs text-(--color-muted-foreground)">{hint}</p>
				) : null}
			</CardContent>
		</Card>
	);
}

export function KpiCards({ totals }: { totals: RunAnalyticsTotals | undefined }) {
	const loading = totals === undefined;
	const dash = "—";

	return (
		<div className="grid grid-cols-2 gap-4 md:grid-cols-3 lg:grid-cols-4">
			<KpiCard
				title="Runs"
				value={loading ? dash : totals.runs.toLocaleString()}
				hint={
					loading
						? undefined
						: `${totals.succeeded} ok · ${totals.failed} fail · ${totals.cancelled} cxl · ${totals.active} active`
				}
			/>
			<KpiCard
				title="Success rate"
				value={loading ? dash : formatRate(totals.successRate)}
				hint={loading ? undefined : `${totals.succeeded} of terminal runs`}
			/>
			<KpiCard
				title="Median duration"
				value={loading ? dash : formatDurationMs(totals.durationMs.median)}
				hint={loading ? undefined : `p95 ${formatDurationMs(totals.durationMs.p95)}`}
			/>
			<KpiCard
				title="Median context"
				value={loading ? dash : formatTokensOrDash(totals.contextTokens.median)}
				hint={
					loading
						? undefined
						: `avg ${formatTokensOrDash(totals.contextTokens.avg)} · ${totals.contextTokens.count} priced`
				}
			/>
			<KpiCard
				title="Total cost"
				value={loading ? dash : formatCostUsd(totals.cost.total)}
				hint={
					loading
						? undefined
						: `avg ${totals.cost.avg === null ? dash : formatCostUsd(totals.cost.avg)} · ${totals.cost.priced} priced`
				}
			/>
			<KpiCard
				title="Active runs"
				value={loading ? dash : formatCount(totals.active)}
				hint={loading ? undefined : "currently non-terminal"}
			/>
		</div>
	);
}
