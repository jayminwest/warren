/**
 * Per-agent / per-model rollup tables for the Run Analytics dashboard
 * (warren-638a / pl-ad0f step 5).
 *
 * Both dimensions share the `RunGroupBucket` wire shape, so one
 * `GroupTable` renders either. Buckets are pre-sorted server-side by
 * context desc; the null group key (`RUN_ANALYTICS_NONE_KEY`) renders
 * as an em-dash. Agent rows deep-link to `/agents/:name`; model rows
 * are plain monospace (no agents-by-model route in the UI).
 */
import { Link } from "react-router-dom";
import { RUN_ANALYTICS_NONE_KEY, type RunGroupBucket } from "@/api/client.ts";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card.tsx";
import {
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from "@/components/ui/table.tsx";
import { formatCostUsd, formatDurationMs, formatRate, formatTokensOrDash } from "./format.ts";

function renderKey(dimension: "agent" | "model", key: string): React.ReactNode {
	if (key === RUN_ANALYTICS_NONE_KEY) {
		return <span className="text-(--color-muted-foreground)">—</span>;
	}
	if (dimension === "agent") {
		return (
			<Link
				to={`/agents/${encodeURIComponent(key)}`}
				className="underline-offset-2 hover:underline"
			>
				{key}
			</Link>
		);
	}
	return <span className="font-mono text-xs">{key}</span>;
}

export function GroupTable({
	title,
	subtitle,
	dimension,
	buckets,
	loading,
}: {
	title: string;
	subtitle: string;
	dimension: "agent" | "model";
	buckets: RunGroupBucket[];
	loading: boolean;
}) {
	return (
		<Card>
			<CardHeader>
				<CardTitle className="text-base">{title}</CardTitle>
				<p className="text-xs text-(--color-muted-foreground)">{subtitle}</p>
			</CardHeader>
			<CardContent>
				{loading ? (
					<p className="text-sm text-(--color-muted-foreground)">Loading…</p>
				) : buckets.length === 0 ? (
					<p className="text-sm text-(--color-muted-foreground)">No data in this window.</p>
				) : (
					<Table>
						<TableHeader>
							<TableRow>
								<TableHead>{dimension === "agent" ? "Agent" : "Model"}</TableHead>
								<TableHead className="text-right">Runs</TableHead>
								<TableHead className="text-right">Success</TableHead>
								<TableHead className="text-right">Avg ctx</TableHead>
								<TableHead className="text-right">Avg dur</TableHead>
								<TableHead className="text-right">Cost</TableHead>
							</TableRow>
						</TableHeader>
						<TableBody>
							{buckets.map((b) => (
								<TableRow key={b.key}>
									<TableCell className="max-w-[260px] truncate">
										{renderKey(dimension, b.key)}
									</TableCell>
									<TableCell className="whitespace-nowrap text-right font-mono text-xs text-(--color-muted-foreground)">
										{b.runs}
									</TableCell>
									<TableCell className="whitespace-nowrap text-right font-mono text-xs">
										{formatRate(b.successRate)}
									</TableCell>
									<TableCell className="whitespace-nowrap text-right font-mono text-xs">
										{formatTokensOrDash(b.avgContextTokens)}
									</TableCell>
									<TableCell className="whitespace-nowrap text-right font-mono text-xs text-(--color-muted-foreground)">
										{formatDurationMs(b.avgDurationMs)}
									</TableCell>
									<TableCell className="whitespace-nowrap text-right font-mono text-xs">
										{formatCostUsd(b.costUsd)}
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
