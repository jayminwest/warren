import * as React from "react";
import { ResponsiveContainer } from "recharts";
import { cn } from "@/lib/utils.ts";

/*
 * recharts chart primitive (warren-876c / pl-ad0f step 3).
 *
 * The Run Analytics dashboard (pl-ad0f) is the first consumer of a
 * chart library in this UI. recharts is the operator-approved
 * dependency; this thin wrapper is the seam every analytics chart
 * renders through so the recharts surface stays in one place and the
 * page-level code (warren-638a / warren-436a) only deals with data.
 *
 * `ChartContainer` gives every chart a consistent fixed-aspect,
 * full-width frame via recharts' `ResponsiveContainer`. The raw
 * recharts primitives (LineChart, BarChart, axes, Tooltip, …) are
 * re-exported from here so consumers import charts from a single
 * module rather than reaching into `recharts` directly — keeping the
 * bundle-size impact attributable and the theming centralized.
 *
 * Adding recharts bumps the bundle-size ratchet exactly once with this
 * tracker reference (warren-876c); see scripts/bundle-size-budgets.json.
 */

export interface ChartContainerProps extends React.HTMLAttributes<HTMLDivElement> {
	/** Fixed pixel height for the chart frame. Defaults to 240. */
	height?: number;
	/** recharts content — a single chart element (LineChart, BarChart, …). */
	children: React.ReactElement;
}

export const ChartContainer = React.forwardRef<HTMLDivElement, ChartContainerProps>(
	({ className, height = 240, children, ...props }, ref) => (
		<div
			ref={ref}
			className={cn("w-full text-(--color-muted-foreground)", className)}
			style={{ height }}
			{...props}
		>
			<ResponsiveContainer width="100%" height="100%">
				{children}
			</ResponsiveContainer>
		</div>
	),
);
ChartContainer.displayName = "ChartContainer";

export {
	Area,
	AreaChart,
	Bar,
	BarChart,
	CartesianGrid,
	Cell,
	Legend,
	Line,
	LineChart,
	Pie,
	PieChart,
	ResponsiveContainer,
	Tooltip,
	XAxis,
	YAxis,
} from "recharts";
