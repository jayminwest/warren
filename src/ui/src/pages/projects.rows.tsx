import { RefreshCw, Trash2 } from "lucide-react";
import { Link } from "react-router-dom";
import type { ProjectRow } from "@/api/types.ts";
import { OperatorOnly } from "@/components/operator-only.tsx";
import { Button } from "@/components/ui/button.tsx";
import { CardFigure, CardFigureNote, InventoryRowCard } from "@/components/ui/inventory-card.tsx";
import { TableCell, TableRow } from "@/components/ui/table.tsx";
import { Tag } from "@/components/ui/tag.tsx";
import { relativeTime } from "@/lib/utils.ts";

/**
 * Registry rows for the Projects page (warren-e228, migrated in
 * warren-9474): the desktop table row and the phone row card. Refresh and
 * delete are admin routes, so both drop their actions for a spectator
 * (warren-b875 / warren-f53e).
 */

/** Derive the registry display name (owner/name) from the git URL. */
export function repoName(project: ProjectRow): string {
	const match = project.gitUrl.match(/github\.com[/:]([^/]+\/[^/#?]+?)(?:\.git)?$/i);
	return match?.[1] ?? project.id;
}

export function formatDate(iso: string | null): string {
	if (iso === null) return "—";
	const d = new Date(iso);
	return Number.isNaN(d.getTime())
		? iso
		: d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

export interface RowActions {
	onRefresh: () => void;
	refreshPending: boolean;
	onDelete: () => void;
}

function Actions({
	project,
	onRefresh,
	refreshPending,
	onDelete,
}: RowActions & { project: ProjectRow }) {
	return (
		<OperatorOnly capability="admin">
			<div className="flex justify-end gap-1">
				<Button
					variant="ghost"
					size="icon"
					className="size-7"
					onClick={onRefresh}
					disabled={refreshPending}
					aria-label={`Refresh ${repoName(project)}`}
					title="Fetch the latest commits and reset the clone to the default branch"
				>
					<RefreshCw aria-hidden className={refreshPending ? "animate-spin" : undefined} />
				</Button>
				<Button
					variant="ghost"
					size="icon"
					className="size-7 hover:text-(--color-danger)"
					onClick={onDelete}
					aria-label={`Delete ${repoName(project)}`}
				>
					<Trash2 aria-hidden />
				</Button>
			</div>
		</OperatorOnly>
	);
}

export function RegistryRow({
	project,
	selected,
	rowRef,
	onOpen,
	...actions
}: RowActions & {
	project: ProjectRow;
	selected: boolean;
	rowRef: (el: HTMLElement | null) => void;
	onOpen: (path: string) => void;
}) {
	const path = `/projects/${encodeURIComponent(project.id)}`;
	return (
		<TableRow
			ref={rowRef}
			data-selected={selected}
			className="cursor-pointer"
			onClick={() => onOpen(path)}
		>
			<TableCell className="max-w-72">
				<Link
					to={path}
					onClick={(e) => e.stopPropagation()}
					title={project.gitUrl}
					className="block truncate font-medium text-(--color-text) hover:underline"
				>
					{repoName(project)}
				</Link>
			</TableCell>
			<TableCell className="font-mono text-xs text-(--color-text-2)">
				{project.defaultBranch}
			</TableCell>
			<TableCell
				className="font-mono text-xs text-(--color-text-2)"
				title={project.lastHeadSha ?? "Never fetched"}
			>
				{project.lastHeadSha !== null ? project.lastHeadSha.slice(0, 7) : "—"}
			</TableCell>
			<TableCell
				className="whitespace-nowrap text-(--color-text-2)"
				title={project.lastFetchedAt ?? "Never fetched"}
			>
				{project.lastFetchedAt !== null ? relativeTime(project.lastFetchedAt) : "Never"}
			</TableCell>
			<TableCell>
				{project.hasSeeds ? <Tag>Seeds</Tag> : <span className="text-(--color-text-3)">—</span>}
			</TableCell>
			<TableCell className="whitespace-nowrap text-(--color-text-3)">
				{formatDate(project.addedAt)}
			</TableCell>
			<TableCell className="text-right" onClick={(e) => e.stopPropagation()}>
				<Actions project={project} {...actions} />
			</TableCell>
		</TableRow>
	);
}

/** Phone registry card (warren-dea8): repo, clone freshness, actions. */
export function ProjectCard({ project, ...actions }: RowActions & { project: ProjectRow }) {
	return (
		<InventoryRowCard
			tone="neutral"
			title={repoName(project)}
			titleTo={`/projects/${encodeURIComponent(project.id)}`}
			subline={project.hasSeeds ? "Seeds issue queue" : "No issue queue"}
			figures={
				<>
					<CardFigure value={<span className="font-mono text-xs">{project.defaultBranch}</span>} />
					<CardFigureNote
						value={
							project.lastFetchedAt !== null
								? `fetched ${relativeTime(project.lastFetchedAt)}`
								: "never fetched"
						}
					/>
				</>
			}
			meta={`Added ${formatDate(project.addedAt)}`}
		>
			<Actions project={project} {...actions} />
		</InventoryRowCard>
	);
}
