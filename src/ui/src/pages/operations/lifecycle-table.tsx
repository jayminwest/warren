import type { OpsOverviewResponse } from "@/api/ops-types.ts";
import type { RunRow } from "@/api/types.ts";
import { Card, CardHeader } from "@/components/ui/card.tsx";
import { Skeleton } from "@/components/ui/skeleton.tsx";
import { StatusText } from "@/components/ui/status.tsx";
import {
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from "@/components/ui/table.tsx";
import { formatAgeMs, LIFECYCLE_ORDER, oldestPhaseInstant } from "./operations.helpers.ts";

/**
 * Runs by state (warren-d903, warren-9474): the ops overview's per-state
 * counts, with the longest wait for the two active states (from the
 * newest-runs list — the overview carries no per-state age). Finished
 * states show no age rather than an invented one.
 */

export function LifecycleTable({
	overview,
	runs,
	now,
}: {
	overview: OpsOverviewResponse | undefined;
	runs: readonly RunRow[] | undefined;
	now: number;
}) {
	return (
		<Card>
			<CardHeader title="Runs by state" />
			<Table>
				<TableHeader>
					<TableRow>
						<TableHead>State</TableHead>
						<TableHead className="text-right">Runs</TableHead>
						<TableHead className="text-right">Longest</TableHead>
					</TableRow>
				</TableHeader>
				<TableBody>
					{LIFECYCLE_ORDER.map((state) => {
						const count = overview?.runs.byState[state];
						const active = state === "queued" || state === "running";
						const oldest = runs !== undefined && active ? oldestPhaseInstant(runs, state) : null;
						return (
							<TableRow key={state}>
								<TableCell>
									<StatusText state={state} />
								</TableCell>
								<TableCell className="text-right text-(--color-text)">
									{overview === undefined ? (
										<Skeleton className="ml-auto w-8" />
									) : (
										(count ?? 0).toLocaleString()
									)}
								</TableCell>
								<TableCell className="text-right text-(--color-text-3)">
									{oldest === null ? "" : formatAgeMs(now - oldest)}
								</TableCell>
							</TableRow>
						);
					})}
				</TableBody>
			</Table>
		</Card>
	);
}
