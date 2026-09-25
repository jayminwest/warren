import { type ReactNode, useMemo } from "react";
import { type DirectoryStat, RUN_ANALYTICS_NONE_KEY } from "@/api/client.ts";
import { EmptyState } from "@/components/ui/empty-state.tsx";
import { SkeletonRows } from "@/components/ui/skeleton.tsx";
import {
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from "@/components/ui/table.tsx";
import { formatRunFailureReason } from "@/lib/labels.ts";
import { formatScore } from "@/pages/telemetry/format.ts";
import { MeterBar, meterWidth } from "@/pages/telemetry/meter-bar.tsx";
import { PanelEmpty, PanelError, TelemetryPanel } from "@/pages/telemetry/telemetry-panel.tsx";
import { useTelemetryWindow } from "@/pages/telemetry/use-telemetry-window.tsx";

/**
 * Telemetry · Behavior (warren-7197, migrated in warren-9474): where
 * agents struggle, and where runs fail. The directory table reads the
 * operator-only behavior rollup (directory names are repo layout, so a
 * spectator never sees it); failure causes read the public run record.
 */

/** How many directories the struggle table renders. */
const DIRECTORY_ROWS = 8;

function DifficultyRow({ dir, maxScore }: { dir: DirectoryStat; maxScore: number }) {
	return (
		<TableRow>
			<TableCell className="max-w-72 truncate font-mono text-xs text-(--color-text)">
				{dir.directory}
			</TableCell>
			<TableCell className="w-full min-w-40">
				<MeterBar
					width={meterWidth(dir.difficultyScore, maxScore)}
					markClass="h-2 bg-(--color-warning)"
					title={`Difficulty ${formatScore(dir.difficultyScore)}`}
					value={formatScore(dir.difficultyScore)}
					valueClass="w-10"
				/>
			</TableCell>
			<TableCell className="text-right text-(--color-text-2)">
				{dir.failureShare === null ? "—" : `${Math.round(dir.failureShare * 100)}%`}
			</TableCell>
			<TableCell className="text-right text-(--color-text-2)">
				{dir.runsTouching.toLocaleString()}
			</TableCell>
			<TableCell className="text-right text-(--color-text-2)">
				{dir.retries.toLocaleString()}
			</TableCell>
		</TableRow>
	);
}

function StruggleTable({ directories }: { directories: readonly DirectoryStat[] }) {
	const top = useMemo(
		() =>
			[...directories]
				.sort((a, b) => b.difficultyScore - a.difficultyScore)
				.slice(0, DIRECTORY_ROWS),
		[directories],
	);
	const maxScore = top.reduce((m, d) => Math.max(m, d.difficultyScore), 0);
	return (
		<Table>
			<TableHeader>
				<TableRow>
					<TableHead>Directory</TableHead>
					<TableHead>Difficulty</TableHead>
					<TableHead className="text-right">Failed</TableHead>
					<TableHead className="text-right">Runs</TableHead>
					<TableHead className="text-right">Retries</TableHead>
				</TableRow>
			</TableHeader>
			<TableBody>
				{top.map((d) => (
					<DifficultyRow key={d.directory} dir={d} maxScore={maxScore} />
				))}
			</TableBody>
		</Table>
	);
}

function StrugglePanel() {
	const { behavior } = useTelemetryWindow();
	const directories = behavior.data?.directories.directories ?? [];
	let body: ReactNode;
	if (behavior.isError) {
		body = (
			<div className="p-4">
				<PanelError
					what="directory evidence"
					error={behavior.error}
					onRetry={() => void behavior.refetch()}
				/>
			</div>
		);
	} else if (behavior.isLoading) {
		body = <SkeletonRows rows={5} />;
	} else if (directories.length === 0) {
		body = (
			<EmptyState
				compact
				title="No directory evidence"
				description="Directories show here once runs in this window touch files."
			/>
		);
	} else {
		body = <StruggleTable directories={directories} />;
	}
	return (
		<TelemetryPanel title="Where agents struggle" meta="Hardest directories first" flush>
			{body}
		</TelemetryPanel>
	);
}

function failureLabel(key: string): string {
	return key === RUN_ANALYTICS_NONE_KEY ? "No reason recorded" : formatRunFailureReason(key);
}

function FailureCausesPanel() {
	const { runs } = useTelemetryWindow();
	const failed = runs.data?.totals.failed;
	const causes = useMemo(
		() => [...(runs.data?.byFailureReason ?? [])].sort((a, b) => b.runs - a.runs),
		[runs.data?.byFailureReason],
	);
	const maxCause = causes.reduce((m, c) => Math.max(m, c.runs), 0);
	let body: ReactNode;
	if (runs.isError) {
		body = (
			<PanelError what="failure causes" error={runs.error} onRetry={() => void runs.refetch()} />
		);
	} else if (runs.isLoading) {
		body = <SkeletonRows rows={3} className="-mx-4 -my-2" />;
	} else if (causes.length === 0) {
		body = <PanelEmpty>No failed runs in this window.</PanelEmpty>;
	} else {
		body = causes.map((c) => (
			<MeterBar
				key={c.key}
				label={failureLabel(c.key)}
				labelClass="w-40"
				width={meterWidth(c.runs, maxCause)}
				markClass="h-2 bg-(--color-danger)"
				value={c.runs.toLocaleString()}
				valueClass="w-10"
			/>
		));
	}
	return (
		<TelemetryPanel
			title="Why runs fail"
			meta={failed === undefined ? undefined : `${failed.toLocaleString()} failed`}
		>
			{body}
		</TelemetryPanel>
	);
}

export function TelemetryBehaviorTab() {
	const { isOperator } = useTelemetryWindow();
	return (
		<div className="grid min-w-0 content-start gap-4">
			{isOperator ? <StrugglePanel /> : null}
			<FailureCausesPanel />
		</div>
	);
}
