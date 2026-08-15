/**
 * Per-directory struggle view for the Run Analytics dashboard
 * (warren-25b7 / pl-103e step 13).
 *
 * Renders the `directories` rollup from `GET /analytics/behavior`
 * (warren-8f1b): the ranked per-directory difficulty table — the
 * "agents struggle with this section of the codebase" surface. Each row
 * carries its denominators (runs touching / file touches) and the
 * confidence qualifier derived from the denominator size, matching the
 * insight discipline the callouts follow.
 *
 * Operator-only: `/analytics/behavior` is `readOperator`, so directory
 * names (repo layout) never reach a spectator — the page gates this
 * component behind the same `isOperator` check as the other behavior
 * sections. Degrades to a muted placeholder on an empty window, and
 * reports the withheld sub-minimum-N directories in the footer line.
 */
import type { DirectoryDifficulty } from "@/api/client.ts";
import { Badge } from "@/components/ui/badge.tsx";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card.tsx";
import {
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from "@/components/ui/table.tsx";
import { formatPercent } from "./format.ts";

const CONFIDENCE_VARIANT: Record<string, "succeeded" | "queued" | "cancelled"> = {
	high: "succeeded",
	medium: "queued",
	low: "cancelled",
};

export function DirectoryStruggleTable({ directories }: { directories: DirectoryDifficulty }) {
	const { directories: rows, totals } = directories;
	return (
		<Card>
			<CardHeader>
				<CardTitle className="text-base">Directory difficulty</CardTitle>
				<p className="text-xs text-(--color-muted-foreground)">
					Where agents struggle — failure share + path-level retry loops per directory, ranked by
					evidence volume
				</p>
			</CardHeader>
			<CardContent>
				{rows.length === 0 ? (
					<p className="py-6 text-sm text-(--color-muted-foreground)">No data in this window.</p>
				) : (
					<>
						<Table>
							<TableHeader>
								<TableRow>
									<TableHead>Directory</TableHead>
									<TableHead className="text-right">Difficulty</TableHead>
									<TableHead className="text-right">Fail share</TableHead>
									<TableHead className="text-right">Runs</TableHead>
									<TableHead className="text-right">Touches</TableHead>
									<TableHead className="text-right">Retries</TableHead>
									<TableHead className="text-right">Steered</TableHead>
									<TableHead className="text-right">Confidence</TableHead>
								</TableRow>
							</TableHeader>
							<TableBody>
								{rows.map((stat) => (
									<TableRow key={stat.directory}>
										<TableCell className="max-w-[320px] truncate font-mono text-xs">
											{stat.directory}
										</TableCell>
										<TableCell className="whitespace-nowrap text-right font-mono text-xs text-(--color-destructive)">
											{stat.difficultyScore.toFixed(2)}
										</TableCell>
										<TableCell className="whitespace-nowrap text-right font-mono text-xs">
											{formatPercent(stat.failureShare)}
										</TableCell>
										<TableCell className="whitespace-nowrap text-right font-mono text-xs text-(--color-muted-foreground)">
											{stat.runsFailed}/{stat.runsTouching}
										</TableCell>
										<TableCell className="whitespace-nowrap text-right font-mono text-xs text-(--color-muted-foreground)">
											{stat.errorTouches}/{stat.fileTouches}
										</TableCell>
										<TableCell className="whitespace-nowrap text-right font-mono text-xs">
											{stat.retries}
										</TableCell>
										<TableCell className="whitespace-nowrap text-right font-mono text-xs text-(--color-muted-foreground)">
											{stat.steeringMessages}
										</TableCell>
										<TableCell className="whitespace-nowrap text-right">
											<Badge variant={CONFIDENCE_VARIANT[stat.confidence] ?? "cancelled"}>
												{stat.confidence}
											</Badge>
										</TableCell>
									</TableRow>
								))}
							</TableBody>
						</Table>
						<p className="pt-3 text-[11px] text-(--color-muted-foreground)">
							{totals.runsWithFilePaths} of {totals.runsInWindow} runs carry file-path evidence
							(pre-rollup runs are unknown, never clean)
							{totals.directoriesBelowMinN > 0
								? ` — ${totals.directoriesBelowMinN} director${totals.directoriesBelowMinN === 1 ? "y" : "ies"} withheld below the minimum-run guard`
								: ""}
							.
						</p>
					</>
				)}
			</CardContent>
		</Card>
	);
}
