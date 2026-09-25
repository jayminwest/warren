import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { runsApi } from "@/api/client.ts";
import type { ProjectRow, RunRow } from "@/api/types.ts";
import { Card, CardHeader } from "@/components/ui/card.tsx";
import { SkeletonRows } from "@/components/ui/skeleton.tsx";
import { StatusDot, stateLabel } from "@/components/ui/status.tsx";
import { relativeTime } from "@/lib/utils.ts";
import { EmptyRow } from "@/pages/project-detail.panels.tsx";
import { formatDate } from "@/pages/projects.rows.tsx";
import { ListError } from "@/pages/runs/list-error.tsx";
import { startedAtOf } from "@/pages/runs/runs-format.ts";

/**
 * The project inspector's side rail (warren-8375, migrated in
 * warren-9474): clone facts and recent runs.
 */

interface Fact {
	label: string;
	value: React.ReactNode;
	/** Machine identifier — rendered mono. */
	mono?: boolean;
	title?: string;
}

function factsOf(project: ProjectRow): Fact[] {
	const rows: Fact[] = [
		{ label: "ID", value: project.id, mono: true },
		{ label: "Default branch", value: project.defaultBranch, mono: true },
		{
			label: "Last head",
			value: project.lastHeadSha !== null ? project.lastHeadSha.slice(0, 7) : "—",
			mono: project.lastHeadSha !== null,
			title: project.lastHeadSha ?? "Never fetched",
		},
		{
			label: "Last fetched",
			value: project.lastFetchedAt !== null ? relativeTime(project.lastFetchedAt) : "Never",
			title: project.lastFetchedAt ?? "Never fetched",
		},
		{ label: "Added", value: formatDate(project.addedAt) },
		{ label: "Issue queue", value: project.hasSeeds ? "Seeds" : "None" },
	];
	// Host-layout disclosure — absent from a spectator's row (warren-4f6c),
	// so render on presence (warren-f53e).
	if (project.localPath !== undefined) {
		rows.push({
			label: "Local path",
			value: project.localPath,
			mono: true,
			title: project.localPath,
		});
	}
	return rows;
}

export function ProjectFactsPanel({ project }: { project: ProjectRow }) {
	return (
		<Card className="self-stretch" aria-label="Project facts">
			<CardHeader title="Clone" />
			<dl className="divide-y divide-(--color-border)">
				{factsOf(project).map((row) => (
					<div key={row.label} className="flex items-center justify-between gap-4 px-4 py-2">
						<dt className="shrink-0 text-sm text-(--color-text-3)">{row.label}</dt>
						<dd
							title={row.title}
							className={
								row.mono
									? "min-w-0 truncate font-mono text-xs text-(--color-text-2)"
									: "min-w-0 truncate text-sm text-(--color-text-2) tabular-nums"
							}
						>
							{row.value}
						</dd>
					</div>
				))}
			</dl>
		</Card>
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
		<Card className="self-stretch" aria-label="Recent runs">
			<CardHeader
				title="Recent runs"
				actions={
					<Link
						to="/runs"
						className="text-xs font-medium text-(--color-primary) underline-offset-2 hover:underline"
					>
						View all
					</Link>
				}
			/>
			{runs.isLoading ? (
				<SkeletonRows rows={4} />
			) : runs.isError ? (
				<ListError what="recent runs" error={runs.error} onRetry={() => void runs.refetch()} />
			) : list.length === 0 ? (
				<EmptyRow text="No runs against this project yet." />
			) : (
				<ul className="divide-y divide-(--color-border)">
					{list.map((run) => (
						<RecentRunRow key={run.id} run={run} />
					))}
				</ul>
			)}
		</Card>
	);
}

function RecentRunRow({ run }: { run: RunRow }) {
	const started = startedAtOf(run);
	return (
		<li>
			<Link
				to={`/runs/${encodeURIComponent(run.id)}`}
				title={stateLabel(run.state)}
				className="flex items-center gap-2.5 px-4 py-2 transition-colors hover:bg-(--color-surface-hover)"
			>
				<StatusDot state={run.state} size="sm" />
				<span className="min-w-0 truncate font-mono text-xs text-(--color-text)">{run.id}</span>
				{run.seedId !== null ? (
					<span className="min-w-0 truncate font-mono text-2xs text-(--color-text-3)">
						{run.seedId}
					</span>
				) : null}
				<span
					className="ml-auto shrink-0 text-xs text-(--color-text-3)"
					title={started ?? undefined}
				>
					{relativeTime(started)}
				</span>
			</Link>
		</li>
	);
}
