import { type DirectoryStat, RUN_ANALYTICS_NONE_KEY } from "@/api/client.ts";
import { formatRunFailureReason } from "@/lib/labels.ts";
import { cn } from "@/lib/utils.ts";
import { formatScore } from "@/pages/telemetry/format.ts";
import { MeterBar } from "@/pages/telemetry/meter-bar.tsx";
import { TelemetryPanel } from "@/pages/telemetry/telemetry-panel.tsx";
import { useTelemetryWindow } from "@/pages/telemetry/use-telemetry-window.tsx";

/**
 * Telemetry · Behavior (warren-7197 / pl-7e38 step 14): where agents
 * struggle, and where runs die. The struggle table reads the
 * operator-only `GET /analytics/behavior` directory-difficulty rollup
 * (directory names are repo layout, so it never renders for a
 * spectator); the failure causes read the public
 * `byFailureReason` from `GET /analytics/runs` — the failure-cause
 * discriminator.
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
			<td className="w-full py-1.5 pr-3">
				<MeterBar
					width={width}
					markClass="h-2.5 bg-(--color-warning)"
					title={`difficulty score ${formatScore(dir.difficultyScore)}`}
					value={formatScore(dir.difficultyScore)}
				/>
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

/** Mock mobile/telemetry.jsx :167-205 fill ramp for the top struggle rows. */
const STRUGGLE_FILL_RAMP = ["opacity-80", "opacity-60", "opacity-45"] as const;

/** Below-md arm (warren-756e): meter row per directory, no scroll. */
function DifficultyMeterRow({
	dir,
	maxScore,
	rank,
}: {
	dir: DirectoryStat;
	maxScore: number;
	rank: number;
}) {
	const width =
		maxScore > 0 ? `${Math.max(4, Math.round((dir.difficultyScore / maxScore) * 100))}%` : "4px";
	const failShare = dir.failureShare === null ? null : `${Math.round(dir.failureShare * 100)}%`;
	return (
		<MeterBar
			label={dir.directory}
			labelClass="w-[118px] overflow-clip max-md:text-[9px] max-md:leading-[11px] text-(--color-text-2)"
			width={width}
			markClass={cn("h-2 bg-(--color-danger)", STRUGGLE_FILL_RAMP[rank] ?? "opacity-45")}
			title={`difficulty ${formatScore(dir.difficultyScore)} · fail share ${failShare ?? "—"} · touches ${String(dir.runsTouching)} · retries ${String(dir.retries)}`}
			value={failShare ?? "—"}
			valueClass={cn(
				"w-[30px] text-right",
				rank === 0 ? "text-(--color-danger)" : "text-(--color-text-2)",
			)}
		/>
	);
}

function StruggleTable({ directories }: { directories: readonly DirectoryStat[] }) {
	const top = [...directories]
		.sort((a, b) => b.difficultyScore - a.difficultyScore)
		.slice(0, DIRECTORY_ROWS);
	const maxScore = top.reduce((m, d) => Math.max(m, d.difficultyScore), 0);
	return (
		<>
			{/* md+: the full 5-column table, unchanged. */}
			<div className="hidden overflow-x-auto md:block">
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
			{/* Below md: meter-row list (warren-756e, mock :167-205) — no
		    horizontally-scrolling table at 375px. */}
			<div className="flex flex-col gap-[9px] md:hidden">
				{top.map((d, i) => (
					<DifficultyMeterRow key={d.directory} dir={d} maxScore={maxScore} rank={i} />
				))}
			</div>
		</>
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
		<MeterBar
			label={label}
			labelClass="w-32 text-(--color-text-2)"
			width={width}
			markClass="h-2.5 bg-(--color-danger)"
			title={`${String(count)} failed runs`}
			value={String(count)}
		/>
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
			</TelemetryPanel>
		</div>
	);
}
