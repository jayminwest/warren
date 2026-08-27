import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { runsApi } from "@/api/client.ts";
import type { ProjectRow, RunRow } from "@/api/types.ts";
import { Alert } from "@/components/ui/alert.tsx";
import { Spinner } from "@/components/ui/spinner.tsx";
import { formatError } from "@/lib/format-error.ts";
import { relativeTime } from "@/lib/utils.ts";
import { EmptyRow } from "@/pages/project-detail.panels.tsx";
import { startedAtOf } from "@/pages/runs/runs-format.ts";

/**
 * The project inspector's side rail (warren-8375 / pl-7e38 step 10):
 * clone-state facts and recent runs. Split from the panels module so
 * both stay inside the 500-line budget (check:size).
 */

const PANEL =
	"flex min-w-0 flex-col rounded-[4px] border border-(--color-border) bg-(--color-surface)";
const PANEL_HEAD =
	"flex h-[41px] shrink-0 items-center gap-2.5 border-b border-b-(--color-border) px-3.5";
const PANEL_TITLE = "text-[12px] leading-4 font-semibold text-(--color-text)";
const HEAD_NOTE = "font-mono text-[9px] leading-3 tracking-[0.05em] text-(--color-text-3)";

/* --------------------------------------------------------------------- */
/* Side rail: project facts + recent runs                                 */
/* --------------------------------------------------------------------- */

export function ProjectFactsPanel({ project }: { project: ProjectRow }) {
	const rows: Array<{ label: string; value: React.ReactNode; muted?: boolean; title?: string }> = [
		{ label: "id", value: project.id },
		{ label: "git url", value: project.gitUrl },
		{ label: "default branch", value: project.defaultBranch },
		{
			label: "last head",
			value: project.lastHeadSha !== null ? project.lastHeadSha.slice(0, 7) : "—",
			title: project.lastHeadSha ?? "never fetched",
		},
		{
			label: "last fetched",
			value: project.lastFetchedAt !== null ? relativeTime(project.lastFetchedAt) : "never",
			title: project.lastFetchedAt ?? "never fetched",
		},
		{ label: "added", value: formatDate(project.addedAt) },
		{
			label: "issue queue",
			value: project.hasSeeds ? (
				<span className="text-(--color-primary)">.seeds present</span>
			) : (
				"—"
			),
		},
	];
	// Host-layout disclosure — absent from a spectator's row (warren-4f6c),
	// so render on presence (warren-f53e).
	if (project.localPath !== undefined) {
		rows.push({ label: "local path", value: project.localPath, muted: true });
	}

	return (
		<section className={PANEL} aria-label="Project facts">
			<div className={PANEL_HEAD}>
				<h2 className={PANEL_TITLE}>Project</h2>
				<div className="min-w-0 flex-1" />
				<span className={HEAD_NOTE}>CLONE STATE</span>
			</div>
			<dl className="flex flex-col gap-2.5 px-3.5 py-3">
				{rows.map((row) => (
					<div key={row.label} className="flex items-center gap-2.5">
						<dt className="max-md:w-[110px] md:w-[100px] shrink-0 text-[11px] leading-[14px] text-(--color-text-3)">
							{row.label}
						</dt>
						<dd
							title={row.title}
							className={`min-w-0 truncate font-mono text-[10px] leading-3 max-md:flex-1 max-md:text-right ${
								row.muted ? "text-(--color-text-3)" : "text-(--color-text-2)"
							}`}
						>
							{row.value}
						</dd>
					</div>
				))}
			</dl>
		</section>
	);
}

export function RecentRunsPanel({ projectId }: { projectId: string }) {
	// `GET /runs?project=` serves the public projection — the spectator
	// back-links stay read-only facts.
	const runs = useQuery({
		queryKey: ["runs", "project-recent", projectId],
		queryFn: ({ signal }) => runsApi.list({ project: projectId, limit: 8 }, signal),
		enabled: projectId.length > 0,
	});

	const list = runs.data?.runs ?? [];

	return (
		<section className={PANEL} aria-label="Recent runs">
			<div className={PANEL_HEAD}>
				<h2 className={PANEL_TITLE}>Recent runs</h2>
				<div className="min-w-0 flex-1" />
				<Link
					to="/runs"
					className="text-[10px] leading-3 font-medium text-(--color-primary) underline-offset-2 hover:underline"
				>
					View all →
				</Link>
			</div>
			<div className="flex flex-col gap-2 px-3.5 py-3">
				{runs.isLoading ? (
					<Spinner label="Loading recent runs" />
				) : runs.isError ? (
					<Alert variant="danger" title="Failed to load runs">
						{formatError(runs.error)}
					</Alert>
				) : list.length === 0 ? (
					<EmptyRow text="No runs against this project yet." />
				) : (
					list.map((run) => <RecentRunRow key={run.id} run={run} />)
				)}
			</div>
		</section>
	);
}

function RecentRunRow({ run }: { run: RunRow }) {
	return (
		<div className="flex items-center gap-2">
			<span
				className={`h-1.5 w-1.5 shrink-0 rounded-full ${runDotColor(run)}`}
				aria-hidden="true"
			/>
			<Link
				to={`/runs/${encodeURIComponent(run.id)}`}
				className="min-w-0 truncate font-mono text-[10px] leading-3 text-(--color-text-2) underline-offset-2 hover:underline"
			>
				{run.id}
			</Link>
			<div className="min-w-0 flex-1" />
			<span
				className="shrink-0 font-mono text-[9px] leading-3 text-(--color-text-3)"
				title={startedAtOf(run) ?? undefined}
			>
				{relativeTime(startedAtOf(run))}
			</span>
		</div>
	);
}

/* --------------------------------------------------------------------- */
/* Helpers                                                                */
/* --------------------------------------------------------------------- */

/** State → token dot color. Matches the Runs inventory mapping. */
function runDotColor(run: RunRow): string {
	switch (run.state) {
		case "running":
			return "bg-(--color-info)";
		case "queued":
			return "bg-(--color-warning)";
		case "succeeded":
			return "bg-(--color-success)";
		case "failed":
			return "bg-(--color-danger)";
		default:
			return "bg-(--color-text-3)";
	}
}

function formatDate(iso: string | null): string {
	if (iso === null) return "—";
	const d = new Date(iso);
	return Number.isNaN(d.getTime()) ? iso : d.toISOString().slice(0, 10);
}
