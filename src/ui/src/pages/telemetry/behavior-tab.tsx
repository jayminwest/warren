import { type DirectoryStat, RUN_ANALYTICS_NONE_KEY } from "@/api/client.ts";
import { formatRunFailureReason } from "@/lib/labels.ts";
import { cn } from "@/lib/utils.ts";
import { TelemetryPanel } from "@/pages/telemetry/telemetry-panel.tsx";
import { useTelemetryWindow } from "@/pages/telemetry/use-telemetry-window.tsx";

/**
 * Telemetry · Behavior (warren-7197 / pl-7e38 step 14): where agents
 * struggle, and where runs die. The struggle table reads the
 * operator-only `GET /analytics/behavior` directory-difficulty rollup
 * (directory names are repo layout, so it never renders for a
 * spectator); the failure causes read the public
 * `byFailureReason` from `GET /analytics/runs` — the failure-cause
 * discriminator, not log spelunking.
 */

/** How many directories the struggle table renders. */
const DIRECTORY_ROWS = 8;

function DifficultyRow({ dir, maxScore }: { dir: DirectoryStat; maxScore: number }) {
	const width =
		maxScore > 0 ? `${Math.max(4, Math.round((dir.difficultyScore / maxScore) * 100))}%` : "4px";
	return (
		<tr className="border-b border-(--color-border) last:border-b-0">
			<td className="py-1.5 pr-3 font-mono text-[11px] leading-[14px] text-(--color-text-2)">
				{dir.directory}
			</td>
			<td className="py-1.5 pr-3">
				<div className="flex items-center gap-2">
					<div
						className="h-2.5 shrink-0 rounded-[1px] bg-(--color-warning)"
						style={{ width }}
						title={`difficulty score ${String(dir.difficultyScore)}`}
					/>
					<span className="font-mono text-[11px] leading-[14px] text-(--color-text-3)">
						{String(dir.difficultyScore)}
					</span>
				</div>
			</td>
			<td className="py-1.5 pr-3 text-right font-mono text-[11px] leading-[14px] text-(--color-text-2)">
				{dir.failureShare === null ? "—" : `${Math.round(dir.failureShare * 100)}%`}
			</td>
			<td className="py-1.5 pr-3 text-right font-mono text-[11px] leading-[14px] text-(--color-text-3)">
				{String(dir.runsTouching)}
			</td>
			<td className="py-1.5 text-right font-mono text-[11px] leading-[14px] text-(--color-text-3)">
				{String(dir.retries)}
			</td>
		</tr>
	);
}

function StruggleTable({ directories }: { directories: readonly DirectoryStat[] }) {
	const top = [...directories]
		.sort((a, b) => b.difficultyScore - a.difficultyScore)
		.slice(0, DIRECTORY_ROWS);
	const maxScore = top.reduce((m, d) => Math.max(m, d.difficultyScore), 0);
	return (
		<div className="overflow-x-auto">
			<table className="w-full">
				<thead>
					<tr>
						{["DIRECTORY", "DIFFICULTY", "FAIL SHARE", "TOUCHES", "RETRIES"].map((h, i) => (
							<th
								key={h}
								className={cn(
									"pb-2 pr-3 text-left font-mono text-[10px] tracking-[0.06em] text-(--color-text-3)",
									i >= 2 && "text-right",
								)}
							>
								{h}
							</th>
						))}
					</tr>
				</thead>
				<tbody>
					{top.map((d) => (
						<DifficultyRow key={d.directory} dir={d} maxScore={maxScore} />
					))}
				</tbody>
			</table>
		</div>
	);
}

function failureLabel(key: string): string {
	return key === RUN_ANALYTICS_NONE_KEY ? "Unrecorded" : formatRunFailureReason(key);
}

function FailureCauseRow({
	label,
	runs: count,
	max,
}: {
	label: string;
	runs: number;
	max: number;
}) {
	const width = max > 0 ? `${Math.max(4, Math.round((count / max) * 100))}%` : "4px";
	return (
		<div className="flex w-full items-center gap-2.5">
			<span className="w-32 shrink-0 font-mono text-[11px] leading-[14px] text-(--color-text-2)">
				{label}
			</span>
			<div
				className="h-2.5 shrink-0 rounded-[1px] bg-(--color-danger)"
				style={{ width }}
				title={`${String(count)} failed runs`}
			/>
			<span className="font-mono text-[11px] leading-[14px] text-(--color-text-3)">
				{String(count)}
			</span>
		</div>
	);
}

function StrugglePanel() {
	const { behavior } = useTelemetryWindow();
	const directories = behavior.data?.directories.directories ?? [];
	return (
		<TelemetryPanel title="Where agents struggle" meta="RANKED BY EVIDENCE">
			{behavior.isError ? (
				<p className="text-sm text-(--color-danger)">
					Failed to load behavior analytics. {(behavior.error as Error | null)?.message ?? ""}
				</p>
			) : behavior.isLoading ? (
				<p className="text-[12px] leading-4 text-(--color-text-3)">Loading…</p>
			) : directories.length === 0 ? (
				<p className="text-[12px] leading-4 text-(--color-text-3)">
					No directory evidence in this window.
				</p>
			) : (
				<StruggleTable directories={directories} />
			)}
			<p className="text-[12px] leading-4 text-(--color-text-2)">
				Failure share + path-level retry loops per directory, with denominators. No insight without
				evidence.
			</p>
		</TelemetryPanel>
	);
}

export function TelemetryBehaviorTab() {
	const { runs, isOperator } = useTelemetryWindow();
	const failed = runs.data?.totals.failed ?? 0;
	const causes = [...(runs.data?.byFailureReason ?? [])].sort((a, b) => b.runs - a.runs);
	const maxCause = causes.reduce((m, c) => Math.max(m, c.runs), 0);

	return (
		<div className="flex flex-col gap-4">
			{isOperator ? <StrugglePanel /> : null}

			<TelemetryPanel
				title="Where runs die"
				meta={`${String(failed)} FAILED · FROM THE RUN RECORD`}
			>
				{runs.isError ? (
					<p className="text-sm text-(--color-danger)">
						Failed to load run analytics. {(runs.error as Error | null)?.message ?? ""}
					</p>
				) : causes.length === 0 && !runs.isLoading ? (
					<p className="text-[12px] leading-4 text-(--color-text-3)">
						No failed runs in this window.
					</p>
				) : (
					causes.map((c) => (
						<FailureCauseRow key={c.key} label={failureLabel(c.key)} runs={c.runs} max={maxCause} />
					))
				)}
				<p className="text-[12px] leading-4 text-(--color-text-2)">
					Failure causes from the failure-cause discriminator, not log spelunking.
				</p>
			</TelemetryPanel>
		</div>
	);
}
