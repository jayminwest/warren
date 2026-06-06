/**
 * Token-consumption over-time chart for the Run Analytics dashboard
 * (warren-4dc9 / pl-d1a2 step 4).
 *
 * Stacked AreaChart of daily token counts with a segmented toggle
 * switching the stacking dimension:
 *   - "kind"     → stack by token kind (input/output/cacheRead/cacheWrite)
 *   - "model"    → stack one Area per model key
 *   - "provider" → stack one Area per provider key
 *
 * All recharts primitives come from the shared chart.tsx seam (warren-876c).
 * Y-axis and tooltip use formatTokens from format.ts.
 * Empty window shows the page's standard "No data in this window." text.
 */
import * as React from "react";
import type { DimensionTokenSeries, TokenDayBucket } from "@/api/client.ts";
import { RUN_ANALYTICS_NONE_KEY, RUN_ANALYTICS_OTHER_KEY } from "@/api/client.ts";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card.tsx";
import {
	Area,
	AreaChart,
	CartesianGrid,
	ChartContainer,
	Legend,
	Tooltip,
	XAxis,
	YAxis,
} from "@/components/ui/chart.tsx";
import { formatTokens } from "./format.ts";

// ---------------------------------------------------------------------------
// Palette
// ---------------------------------------------------------------------------

const KIND_COLORS = {
	input: "var(--color-info)",
	output: "var(--color-success)",
	cacheRead: "var(--color-primary)",
	cacheWrite: "var(--color-warning)",
} as const;

/** A simple deterministic palette for model/provider series. */
const DIM_PALETTE = [
	"var(--color-info)",
	"var(--color-success)",
	"var(--color-primary)",
	"var(--color-warning)",
	"var(--color-destructive)",
	"var(--color-neutral)",
	"var(--color-muted-foreground)",
];

/** Visual de-emphasis for "other" and "unknown" roll-up series. */
const DE_EMPHASISED = new Set([RUN_ANALYTICS_OTHER_KEY, RUN_ANALYTICS_NONE_KEY]);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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

type Dimension = "kind" | "model" | "provider";

/**
 * Merge a `DimensionTokenSeries[]` into an array of flat chart objects keyed
 * by `date`, with one numeric entry per series key holding the series' daily
 * *total* tokens. Missing dates for a given key are filled with 0.
 */
function mergeDimensionSeries(
	dimSeries: readonly DimensionTokenSeries[],
): Record<string, number | string>[] {
	// Collect the union of all dates in insertion order of the first series.
	const dateSet = new Set<string>();
	for (const s of dimSeries) {
		for (const b of s.series) {
			dateSet.add(b.date);
		}
	}
	const dates = Array.from(dateSet).sort();
	if (dates.length === 0) return [];

	const rows: Record<string, number | string>[] = dates.map((d) => ({ date: d }));
	const dateIndex = new Map(dates.map((d, i) => [d, i]));

	for (const s of dimSeries) {
		for (const b of s.series) {
			const idx = dateIndex.get(b.date);
			if (idx !== undefined) {
				const row = rows[idx];
				if (row !== undefined) {
					row[s.key] = b.total;
				}
			}
		}
		// Fill zeros for dates this series is missing.
		for (const row of rows) {
			if (!(s.key in row)) row[s.key] = 0;
		}
	}
	return rows;
}

// ---------------------------------------------------------------------------
// Chart
// ---------------------------------------------------------------------------

export function TokenConsumptionChart({
	timeSeries,
	byModelTimeSeries,
	byProviderTimeSeries,
}: {
	timeSeries: readonly TokenDayBucket[];
	byModelTimeSeries: readonly DimensionTokenSeries[];
	byProviderTimeSeries: readonly DimensionTokenSeries[];
}) {
	// Default dimension is "kind".
	const [dim, setDim] = React.useState<Dimension>("kind");

	// Determine emptiness per dimension so the toggle still works even if
	// one dimension has no data.
	const empty =
		dim === "kind"
			? timeSeries.length === 0
			: dim === "model"
				? byModelTimeSeries.length === 0
				: byProviderTimeSeries.length === 0;

	return (
		<Card>
			<CardHeader>
				<div className="flex flex-wrap items-start justify-between gap-2">
					<div>
						<CardTitle className="text-base">Token consumption over time</CardTitle>
						<p className="text-xs text-(--color-muted-foreground)">
							Daily token counts — stacked by{" "}
							{dim === "kind" ? "token kind" : dim === "model" ? "model" : "provider"}
						</p>
					</div>
					<DimensionToggle value={dim} onChange={setDim} />
				</div>
			</CardHeader>
			<CardContent>
				{empty ? (
					<p className="py-6 text-sm text-(--color-muted-foreground)">No data in this window.</p>
				) : dim === "kind" ? (
					<KindChart timeSeries={timeSeries} />
				) : dim === "model" ? (
					<DimChart dimSeries={byModelTimeSeries} />
				) : (
					<DimChart dimSeries={byProviderTimeSeries} />
				)}
			</CardContent>
		</Card>
	);
}

// ---------------------------------------------------------------------------
// Segmented toggle
// ---------------------------------------------------------------------------

const DIMS: { value: Dimension; label: string }[] = [
	{ value: "kind", label: "By kind" },
	{ value: "model", label: "By model" },
	{ value: "provider", label: "By provider" },
];

function DimensionToggle({
	value,
	onChange,
}: {
	value: Dimension;
	onChange: (d: Dimension) => void;
}) {
	return (
		<div className="inline-flex rounded border border-(--color-border) text-xs">
			{DIMS.map((d) => (
				<button
					key={d.value}
					type="button"
					onClick={() => onChange(d.value)}
					className={[
						"px-2 py-1 transition-colors first:rounded-l last:rounded-r",
						value === d.value
							? "bg-(--color-primary) text-(--color-primary-foreground) font-medium"
							: "text-(--color-muted-foreground) hover:text-(--color-foreground)",
					].join(" ")}
				>
					{d.label}
				</button>
			))}
		</div>
	);
}

// ---------------------------------------------------------------------------
// Sub-charts
// ---------------------------------------------------------------------------

/**
 * recharts Tooltip `formatter`. Name comes from each `<Area name={…}>`
 * attribute; we only touch the value, returning a recharts tuple.
 * Omitting the `name` param entirely avoids NameType generics incompatibility
 * NameType in recharts 3.x is `string | number`, so we accept that union.
 */
function tokenFormatter(
	v: number | string | readonly (number | string)[] | undefined,
	name: string | number | undefined,
): [string, string] {
	const n = typeof v === "number" ? v : Number(v);
	return [formatTokens(Number.isFinite(n) ? n : 0), name == null ? "" : String(name)];
}

function KindChart({ timeSeries }: { timeSeries: readonly TokenDayBucket[] }) {
	return (
		<ChartContainer>
			<AreaChart data={timeSeries as TokenDayBucket[]} margin={{ top: 8, right: 8, bottom: 0, left: -16 }}>
				<CartesianGrid strokeDasharray="3 3" stroke="var(--color-border)" vertical={false} />
				<XAxis dataKey="date" {...AXIS_PROPS} />
				<YAxis tickFormatter={formatTokens} {...AXIS_PROPS} />
				<Tooltip contentStyle={TOOLTIP_STYLE} formatter={tokenFormatter} />
				<Legend wrapperStyle={{ fontSize: 11 }} />
				<Area
					type="monotone"
					dataKey="input"
					stackId="1"
					stroke={KIND_COLORS.input}
					fill={KIND_COLORS.input}
					fillOpacity={0.5}
					name="Input"
				/>
				<Area
					type="monotone"
					dataKey="output"
					stackId="1"
					stroke={KIND_COLORS.output}
					fill={KIND_COLORS.output}
					fillOpacity={0.5}
					name="Output"
				/>
				<Area
					type="monotone"
					dataKey="cacheRead"
					stackId="1"
					stroke={KIND_COLORS.cacheRead}
					fill={KIND_COLORS.cacheRead}
					fillOpacity={0.5}
					name="Cache read"
				/>
				<Area
					type="monotone"
					dataKey="cacheWrite"
					stackId="1"
					stroke={KIND_COLORS.cacheWrite}
					fill={KIND_COLORS.cacheWrite}
					fillOpacity={0.4}
					name="Cache write"
				/>
			</AreaChart>
		</ChartContainer>
	);
}

function DimChart({ dimSeries }: { dimSeries: readonly DimensionTokenSeries[] }) {
	const data = mergeDimensionSeries(dimSeries);
	const keys = dimSeries.map((s) => s.key);

	return (
		<ChartContainer>
			<AreaChart
				data={data}
				margin={{ top: 8, right: 8, bottom: 0, left: -16 }}
			>
				<CartesianGrid strokeDasharray="3 3" stroke="var(--color-border)" vertical={false} />
				<XAxis dataKey="date" {...AXIS_PROPS} />
				<YAxis tickFormatter={formatTokens} {...AXIS_PROPS} />
				<Tooltip contentStyle={TOOLTIP_STYLE} formatter={tokenFormatter} />
				<Legend wrapperStyle={{ fontSize: 11 }} />
				{keys.map((key, i) => {
					const color = DIM_PALETTE[i % DIM_PALETTE.length] ?? "var(--color-neutral)";
					const deEmphasised = DE_EMPHASISED.has(key);
					return (
						<Area
							key={key}
							type="monotone"
							dataKey={key}
							stackId="1"
							stroke={color}
							fill={color}
							fillOpacity={deEmphasised ? 0.2 : 0.5}
							strokeOpacity={deEmphasised ? 0.4 : 1}
							name={key === RUN_ANALYTICS_NONE_KEY ? "unknown" : key === RUN_ANALYTICS_OTHER_KEY ? "other" : key}
						/>
					);
				})}
			</AreaChart>
		</ChartContainer>
	);
}

