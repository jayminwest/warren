/**
 * Command-mining surface for the Run Analytics dashboard — Phase 2
 * (warren-436a / pl-ad0f step 10).
 *
 * Two views over the `mining` envelope from `GET /analytics/behavior`:
 *
 *   - CommandCategoryChart — bar of command invocations per generalized
 *     category (os-eco, vcs, package, build, test, …), failures overlaid.
 *   - StuckCommandTable — the stuck-command leaderboard (`byStuckScore`,
 *     pre-sorted desc): commands re-run after failing in the same run.
 *     os-eco tooling (`ml`/`sd`/`gh`/`bun run check:*`) is highlighted.
 *
 * Both degrade to a muted "No data in this window." placeholder when
 * their slice of the payload is empty.
 */
import type { CommandCategoryBucket, CommandStat } from "@/api/client.ts";
import { Badge } from "@/components/ui/badge.tsx";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card.tsx";
import {
	Bar,
	BarChart,
	CartesianGrid,
	ChartContainer,
	Legend,
	Tooltip,
	XAxis,
	YAxis,
} from "@/components/ui/chart.tsx";
import {
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from "@/components/ui/table.tsx";
import { formatRate } from "./format.ts";

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

export function CommandCategoryChart({ byCategory }: { byCategory: CommandCategoryBucket[] }) {
	return (
		<Card>
			<CardHeader>
				<CardTitle className="text-base">Commands by category</CardTitle>
				<p className="text-xs text-(--color-muted-foreground)">
					Tool invocations per generalized command category, with failures overlaid
				</p>
			</CardHeader>
			<CardContent>
				{byCategory.length === 0 ? (
					<p className="py-6 text-sm text-(--color-muted-foreground)">
						No data in this window.
					</p>
				) : (
					<ChartContainer>
						<BarChart data={byCategory} margin={{ top: 8, right: 8, bottom: 0, left: -16 }}>
							<CartesianGrid
								strokeDasharray="3 3"
								stroke="var(--color-border)"
								vertical={false}
							/>
							<XAxis dataKey="category" {...AXIS_PROPS} interval={0} />
							<YAxis allowDecimals={false} {...AXIS_PROPS} />
							<Tooltip contentStyle={TOOLTIP_STYLE} />
							<Legend wrapperStyle={{ fontSize: 11 }} />
							<Bar
								dataKey="invocations"
								name="invocations"
								fill="var(--color-info)"
								radius={[3, 3, 0, 0]}
							/>
							<Bar
								dataKey="failures"
								name="failures"
								fill="var(--color-destructive)"
								radius={[3, 3, 0, 0]}
							/>
						</BarChart>
					</ChartContainer>
				)}
			</CardContent>
		</Card>
	);
}

function renderCommand(stat: CommandStat): React.ReactNode {
	return (
		<span className="flex items-center gap-2">
			<span className="font-mono text-xs">{stat.command}</span>
			{stat.osEco ? (
				<Badge variant="active" className="shrink-0">
					os-eco
				</Badge>
			) : null}
		</span>
	);
}

export function StuckCommandTable({ byStuckScore }: { byStuckScore: CommandStat[] }) {
	return (
		<Card>
			<CardHeader>
				<CardTitle className="text-base">Stuck-command leaderboard</CardTitle>
				<p className="text-xs text-(--color-muted-foreground)">
					Commands re-run after failing earlier in the same run — the "stuck in a loop" signal
				</p>
			</CardHeader>
			<CardContent>
				{byStuckScore.length === 0 ? (
					<p className="text-sm text-(--color-muted-foreground)">No stuck commands in this window.</p>
				) : (
					<Table>
						<TableHeader>
							<TableRow>
								<TableHead>Command</TableHead>
								<TableHead className="text-right">Stuck</TableHead>
								<TableHead className="text-right">Retries</TableHead>
								<TableHead className="text-right">Fails</TableHead>
								<TableHead className="text-right">Fail rate</TableHead>
								<TableHead className="text-right">Runs</TableHead>
							</TableRow>
						</TableHeader>
						<TableBody>
							{byStuckScore.map((stat) => (
								<TableRow
									key={stat.command}
									className={stat.osEco ? "bg-(--color-info)/5" : undefined}
								>
									<TableCell className="max-w-[320px] truncate">
										{renderCommand(stat)}
									</TableCell>
									<TableCell className="whitespace-nowrap text-right font-mono text-xs text-(--color-destructive)">
										{stat.stuckScore}
									</TableCell>
									<TableCell className="whitespace-nowrap text-right font-mono text-xs text-(--color-muted-foreground)">
										{stat.retries}
									</TableCell>
									<TableCell className="whitespace-nowrap text-right font-mono text-xs">
										{stat.failures}
									</TableCell>
									<TableCell className="whitespace-nowrap text-right font-mono text-xs">
										{formatRate(stat.failureRate)}
									</TableCell>
									<TableCell className="whitespace-nowrap text-right font-mono text-xs text-(--color-muted-foreground)">
										{stat.runs}
									</TableCell>
								</TableRow>
							))}
						</TableBody>
					</Table>
				)}
			</CardContent>
		</Card>
	);
}
