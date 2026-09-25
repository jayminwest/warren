import { Link } from "react-router-dom";
import type { RunRow } from "@/api/types.ts";
import { PrChip } from "@/components/ui/status.tsx";
import {
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from "@/components/ui/table.tsx";
import { relativeTime } from "@/lib/utils.ts";
import type { JudgeStoreRow } from "@/pages/telemetry/judge-verdicts.ts";

/**
 * The Judge tab's two run tables (warren-9474): failed verdicts to
 * review, and runs the judge could not reach a verdict on. Each row
 * links its run; the PR chip opens the pull request. On a phone the
 * tables scroll inside their card.
 */

const UNJUDGED_REASON_LABELS: Record<string, string> = {
	malformed_verdict: "Malformed verdict",
	budget_exceeded: "Judge budget spent",
	judge_error: "Judge error",
};

function unjudgedReason(row: JudgeStoreRow): string {
	const reason = row.reason ?? "";
	return UNJUDGED_REASON_LABELS[reason] ?? (reason || "Unknown");
}

/** The failing-class names a judged-failed row carries. */
function failedClassLabel(row: JudgeStoreRow): string {
	return (row.verdict?.assignments ?? [])
		.filter((a) => a.class !== "clean")
		.map((a) => a.class)
		.join(", ");
}

function RunCell({ runId }: { runId: string }) {
	return (
		<TableCell>
			<Link
				to={`/runs/${encodeURIComponent(runId)}`}
				className="font-mono text-xs text-(--color-text) hover:text-(--color-primary) hover:underline"
			>
				{runId}
			</Link>
		</TableCell>
	);
}

function PrCell({ run }: { run: RunRow | undefined }) {
	return (
		<TableCell>
			{run?.prUrl ? (
				<PrChip url={run.prUrl} lifecycle={run.prState} />
			) : (
				<span className="text-(--color-text-3)">—</span>
			)}
		</TableCell>
	);
}

export function FailedVerdictsTable({
	rows,
	runById,
}: {
	rows: readonly JudgeStoreRow[];
	runById: ReadonlyMap<string, RunRow>;
}) {
	return (
		<Table>
			<TableHeader>
				<TableRow>
					<TableHead>Run</TableHead>
					<TableHead>Agent</TableHead>
					<TableHead>Failing class</TableHead>
					<TableHead>Pull request</TableHead>
					<TableHead className="text-right">Judged</TableHead>
				</TableRow>
			</TableHeader>
			<TableBody>
				{rows.map((row) => {
					const run = runById.get(row.runId);
					const judgedAt = row.verdict?.provenance.judgedAt;
					return (
						<TableRow key={row.id}>
							<RunCell runId={row.runId} />
							<TableCell className="text-(--color-text-2)">{run?.agentName ?? "—"}</TableCell>
							<TableCell className="font-mono text-xs text-(--color-danger)">
								{failedClassLabel(row)}
							</TableCell>
							<PrCell run={run} />
							<TableCell className="text-right whitespace-nowrap text-(--color-text-3)">
								{judgedAt === undefined ? "—" : relativeTime(judgedAt)}
							</TableCell>
						</TableRow>
					);
				})}
			</TableBody>
		</Table>
	);
}

export function UnjudgedTable({
	rows,
	runById,
}: {
	rows: readonly JudgeStoreRow[];
	runById: ReadonlyMap<string, RunRow>;
}) {
	return (
		<Table>
			<TableHeader>
				<TableRow>
					<TableHead>Run</TableHead>
					<TableHead>Agent</TableHead>
					<TableHead>Reason</TableHead>
					<TableHead>Detail</TableHead>
					<TableHead>Pull request</TableHead>
				</TableRow>
			</TableHeader>
			<TableBody>
				{rows.map((row) => {
					const run = runById.get(row.runId);
					return (
						<TableRow key={row.id}>
							<RunCell runId={row.runId} />
							<TableCell className="text-(--color-text-2)">{run?.agentName ?? "—"}</TableCell>
							<TableCell className="whitespace-nowrap text-(--color-text-2)">
								{unjudgedReason(row)}
							</TableCell>
							<TableCell
								className="max-w-72 truncate text-(--color-text-3)"
								title={row.detail ?? undefined}
							>
								{row.detail ?? "—"}
							</TableCell>
							<PrCell run={run} />
						</TableRow>
					);
				})}
			</TableBody>
		</Table>
	);
}
