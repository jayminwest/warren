import { useMemo } from "react";
import { Link } from "react-router-dom";
import type { PlanRunChildRow, RunRow } from "@/api/types.ts";
import { PlanRunChildStateBadge } from "@/components/PlanRunStateBadge.tsx";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card.tsx";
import {
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from "@/components/ui/table.tsx";
import { relativeTime } from "@/lib/utils.ts";

/**
 * Per-child execution table for a plan-run: one row per child seed with its
 * coordinator state, linked run, start/end timestamps, PR-merge status, and
 * failure reason. Extracted from PlanRunDetail (warren-d17f / pl-0008 step 9)
 * so the Workspace Run tab can embed the same surface instead of forking a
 * second renderer.
 */
export function PlanRunChildTable({
	children,
	runs,
}: {
	children: PlanRunChildRow[];
	runs: RunRow[];
}) {
	const runIndex = useMemo(() => {
		const m = new Map<string, RunRow>();
		for (const r of runs) m.set(r.id, r);
		return m;
	}, [runs]);
	return (
		<Card>
			<CardHeader>
				<CardTitle>Children ({children.length})</CardTitle>
			</CardHeader>
			<CardContent className="p-0">
				{children.length === 0 ? (
					<p className="p-6 text-sm text-(--color-muted-foreground)">
						No children — plan has no open child seeds.
					</p>
				) : (
					<Table>
						<TableHeader>
							<TableRow>
								<TableHead>Seq</TableHead>
								<TableHead>State</TableHead>
								<TableHead>Seed</TableHead>
								<TableHead>Repo</TableHead>
								<TableHead>Run</TableHead>
								<TableHead>Started</TableHead>
								<TableHead>Ended</TableHead>
								<TableHead>PR</TableHead>
								<TableHead>Failure</TableHead>
							</TableRow>
						</TableHeader>
						<TableBody>
							{children.map((c) => {
								const linkedRun = c.runId !== null ? runIndex.get(c.runId) : undefined;
								const prUrl = linkedRun?.prUrl ?? null;
								return (
									<TableRow key={`${c.planRunId}-${c.seq}`}>
										<TableCell className="font-mono text-xs">{c.seq}</TableCell>
										<TableCell>
											<PlanRunChildStateBadge state={c.state} />
										</TableCell>
										<TableCell className="font-mono text-xs">{c.seedId}</TableCell>
										<TableCell className="font-mono text-xs">
											{c.executionProjectId !== null ? (
												<span title="execution repo">{c.executionProjectId}</span>
											) : (
												<span className="text-(--color-muted-foreground)">—</span>
											)}
										</TableCell>
										<TableCell className="font-mono text-xs">
											{c.runId !== null ? (
												<Link
													to={`/runs/${encodeURIComponent(c.runId)}`}
													className="underline-offset-2 hover:underline"
												>
													{c.runId}
												</Link>
											) : (
												<span className="text-(--color-muted-foreground)">—</span>
											)}
										</TableCell>
										<TableCell className="text-(--color-muted-foreground)">
											{c.startedAt !== null ? relativeTime(c.startedAt) : "—"}
										</TableCell>
										<TableCell className="text-(--color-muted-foreground)">
											{c.endedAt !== null ? relativeTime(c.endedAt) : "—"}
										</TableCell>
										<TableCell className="font-mono text-xs">
											{prUrl !== null ? (
												<a
													href={prUrl}
													target="_blank"
													rel="noreferrer noopener"
													className="underline underline-offset-2 hover:text-(--color-primary)"
													title={
														c.prMergedAt !== null
															? `merged ${c.prMergedAt}`
															: "PR open"
													}
												>
													PR ↗
												</a>
											) : (
												<span className="text-(--color-muted-foreground)">—</span>
											)}
										</TableCell>
										<TableCell className="text-xs text-(--color-destructive)">
											{c.failureReason ?? ""}
										</TableCell>
									</TableRow>
								);
							})}
						</TableBody>
					</Table>
				)}
			</CardContent>
		</Card>
	);
}
