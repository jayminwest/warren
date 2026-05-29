/**
 * Recharts surface for the Run Analytics dashboard (warren-638a /
 * pl-ad0f step 5).
 *
 * Four charts, each fed straight off the `GET /analytics/runs`
 * envelope and wrapped in the shared `ChartContainer` seam
 * (warren-876c) so recharts stays behind one import boundary:
 *
 *   - RunsOverTimeChart  — stacked area of per-state run counts per day
 *   - AvgContextPerAgentChart — bar of avg context tokens by agent
 *   - TopSeedsByContextChart  — bar of total context tokens by seed
 *   - FailureReasonChart      — pie of failed-run counts by reason
 *
 * Charts render a muted "No data in this window." placeholder rather
 * than an empty axis frame when their slice of the payload is empty.
 */
import type {
	RunDayBucket,
	RunFailureBucket,
	RunGroupBucket,
	SeedContextBucket,
} from "@/api/client.ts";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card.tsx";
import {
	Area,
	AreaChart,
	Bar,
	BarChart,
	CartesianGrid,
	Cell,
	ChartContainer,
	Legend,
	Pie,
	PieChart,
	Tooltip,
	XAxis,
	YAxis,
} from "@/components/ui/chart.tsx";
import { formatTokens } from "./format.ts";

/**
 * recharts Tooltip `formatter` returns `[displayValue, displayName]`. Its
 * `value` arg is the wide `ValueType` (number | string | array), so we
 * coerce to a finite number before running it through `formatTokens`.
 */
function tokenTooltip(label: string) {
	return (
		value: number | string | readonly (number | string)[] | undefined,
	): [string, string] => {
		const n = typeof value === "number" ? value : Number(value);
		return [formatTokens(Number.isFinite(n) ? n : 0), label];
	};
}

const AXIS_PROPS = {
	stroke: "var(--color-muted-foreground)",
	fontSize: 11,
	tickLine: false,
	axisLine: false,
} as const;

const TOOLTIP_STYLE = {
	backgroundColor: "var(--color-card)",
	border: "1px solid var(--color-border)",
	borderRadius: 6,
	fontSize: 12,
} as const;

const STATE_COLORS = {
	succeeded: "var(--color-success)",
	failed: "var(--color-destructive)",
	cancelled: "var(--color-muted-foreground)",
	active: "var(--color-info)",
} as const;

const PIE_PALETTE = [
	"var(--color-destructive)",
	"var(--color-warning)",
	"var(--color-info)",
	"var(--color-primary)",
	"var(--color-neutral)",
	"var(--color-success)",
];

function ChartFrame({
	title,
	subtitle,
	empty,
	children,
}: {
	title: string;
	subtitle: string;
	empty: boolean;
	children: React.ReactElement;
}) {
	return (
		<Card>
			<CardHeader>
				<CardTitle className="text-base">{title}</CardTitle>
				<p className="text-xs text-(--color-muted-foreground)">{subtitle}</p>
			</CardHeader>
			<CardContent>
				{empty ? (
					<p className="py-6 text-sm text-(--color-muted-foreground)">
						No data in this window.
					</p>
				) : (
					<ChartContainer>{children}</ChartContainer>
				)}
			</CardContent>
		</Card>
	);
}

export function RunsOverTimeChart({ timeSeries }: { timeSeries: RunDayBucket[] }) {
	return (
		<ChartFrame
			title="Runs over time"
			subtitle="Daily run counts by terminal state"
			empty={timeSeries.length === 0}
		>
			<AreaChart data={timeSeries} margin={{ top: 8, right: 8, bottom: 0, left: -16 }}>
				<CartesianGrid strokeDasharray="3 3" stroke="var(--color-border)" vertical={false} />
				<XAxis dataKey="key" {...AXIS_PROPS} />
				<YAxis allowDecimals={false} {...AXIS_PROPS} />
				<Tooltip contentStyle={TOOLTIP_STYLE} />
				<Legend wrapperStyle={{ fontSize: 11 }} />
				<Area
					type="monotone"
					dataKey="succeeded"
					stackId="1"
					stroke={STATE_COLORS.succeeded}
					fill={STATE_COLORS.succeeded}
					fillOpacity={0.5}
				/>
				<Area
					type="monotone"
					dataKey="failed"
					stackId="1"
					stroke={STATE_COLORS.failed}
					fill={STATE_COLORS.failed}
					fillOpacity={0.5}
				/>
				<Area
					type="monotone"
					dataKey="cancelled"
					stackId="1"
					stroke={STATE_COLORS.cancelled}
					fill={STATE_COLORS.cancelled}
					fillOpacity={0.4}
				/>
				<Area
					type="monotone"
					dataKey="active"
					stackId="1"
					stroke={STATE_COLORS.active}
					fill={STATE_COLORS.active}
					fillOpacity={0.4}
				/>
			</AreaChart>
		</ChartFrame>
	);
}

export function AvgContextPerAgentChart({ byAgent }: { byAgent: RunGroupBucket[] }) {
	// byAgent is pre-sorted by context desc; cap to the top 12 so the
	// axis labels stay legible.
	const data = byAgent
		.filter((b) => b.avgContextTokens !== null)
		.slice(0, 12)
		.map((b) => ({ key: b.key, avgContextTokens: b.avgContextTokens ?? 0 }));
	return (
		<ChartFrame
			title="Avg context per agent"
			subtitle="Mean context tokens (input + cache-read) per run"
			empty={data.length === 0}
		>
			<BarChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: -8 }}>
				<CartesianGrid strokeDasharray="3 3" stroke="var(--color-border)" vertical={false} />
				<XAxis dataKey="key" {...AXIS_PROPS} interval={0} angle={-20} textAnchor="end" height={50} />
				<YAxis tickFormatter={formatTokens} {...AXIS_PROPS} />
				<Tooltip contentStyle={TOOLTIP_STYLE} formatter={tokenTooltip("avg context")} />
				<Bar dataKey="avgContextTokens" fill="var(--color-info)" radius={[3, 3, 0, 0]} />
			</BarChart>
		</ChartFrame>
	);
}

export function TopSeedsByContextChart({ topSeeds }: { topSeeds: SeedContextBucket[] }) {
	const data = topSeeds
		.slice(0, 12)
		.map((b) => ({ key: b.seedId, contextTokensTotal: b.contextTokensTotal }));
	return (
		<ChartFrame
			title="Top seeds by context"
			subtitle="Total context tokens across seed-originated runs"
			empty={data.length === 0}
		>
			<BarChart
				data={data}
				layout="vertical"
				margin={{ top: 8, right: 8, bottom: 0, left: 8 }}
			>
				<CartesianGrid strokeDasharray="3 3" stroke="var(--color-border)" horizontal={false} />
				<XAxis type="number" tickFormatter={formatTokens} {...AXIS_PROPS} />
				<YAxis type="category" dataKey="key" width={90} {...AXIS_PROPS} />
				<Tooltip contentStyle={TOOLTIP_STYLE} formatter={tokenTooltip("context")} />
				<Bar dataKey="contextTokensTotal" fill="var(--color-primary)" radius={[0, 3, 3, 0]} />
			</BarChart>
		</ChartFrame>
	);
}

export function FailureReasonChart({ byFailureReason }: { byFailureReason: RunFailureBucket[] }) {
	return (
		<ChartFrame
			title="Failure reasons"
			subtitle="Failed runs grouped by recorded reason"
			empty={byFailureReason.length === 0}
		>
			<PieChart>
				<Tooltip contentStyle={TOOLTIP_STYLE} />
				<Legend wrapperStyle={{ fontSize: 11 }} />
				<Pie
					data={byFailureReason}
					dataKey="runs"
					nameKey="key"
					cx="50%"
					cy="50%"
					outerRadius={80}
					label
				>
					{byFailureReason.map((b, i) => (
						<Cell key={b.key} fill={PIE_PALETTE[i % PIE_PALETTE.length]} />
					))}
				</Pie>
			</PieChart>
		</ChartFrame>
	);
}
