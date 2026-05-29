/**
 * Derived-insights callout cards for the Run Analytics dashboard —
 * Phase 2 (warren-436a / pl-ad0f step 10).
 *
 * Renders the ranked, severity-coded `Insight[]` from
 * `GET /analytics/behavior` as a row of callout cards at the top of the
 * behavior section. Each card colors its left border + severity badge
 * by `severity` (critical → destructive, warning → warning, info →
 * info). The list is pre-sorted server-side (severity, then kind), so
 * the UI just maps it. Renders nothing when there are no insights so the
 * section collapses cleanly on a quiet window.
 */
import type { Insight, InsightSeverity } from "@/api/client.ts";
import { Card, CardContent } from "@/components/ui/card.tsx";

const SEVERITY_STYLE: Record<
	InsightSeverity,
	{ border: string; badge: string; label: string }
> = {
	critical: {
		border: "border-l-(--color-destructive)",
		badge: "bg-(--color-destructive) text-(--color-destructive-foreground)",
		label: "Critical",
	},
	warning: {
		border: "border-l-(--color-warning)",
		badge: "bg-(--color-warning) text-(--color-warning-foreground)",
		label: "Warning",
	},
	info: {
		border: "border-l-(--color-info)",
		badge: "bg-(--color-info) text-(--color-info-foreground)",
		label: "Info",
	},
};

function InsightCard({ insight }: { insight: Insight }) {
	const style = SEVERITY_STYLE[insight.severity];
	return (
		<Card className={`border-l-4 ${style.border}`}>
			<CardContent className="space-y-2 py-4">
				<div className="flex items-start justify-between gap-2">
					<h3 className="text-sm font-medium">{insight.title}</h3>
					<span
						className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${style.badge}`}
					>
						{style.label}
					</span>
				</div>
				<p className="text-xs text-(--color-muted-foreground)">{insight.detail}</p>
				{insight.subject !== null ? (
					<p className="font-mono text-[11px] text-(--color-muted-foreground)">
						{insight.subject}
					</p>
				) : null}
			</CardContent>
		</Card>
	);
}

export function InsightCallouts({ insights }: { insights: Insight[] }) {
	if (insights.length === 0) return null;
	return (
		<div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3">
			{insights.map((insight) => (
				<InsightCard key={`${insight.kind}:${insight.subject ?? ""}`} insight={insight} />
			))}
		</div>
	);
}
