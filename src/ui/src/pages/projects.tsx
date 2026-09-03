import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { RefreshCw, Trash2 } from "lucide-react";
import { useState } from "react";
import { Link } from "react-router-dom";
import { projectsApi } from "@/api/client.ts";
import type { ProjectRow } from "@/api/types.ts";
import { AddProjectDialog } from "@/components/add-project-dialog.tsx";
import { OperatorOnly, useOperatorHint } from "@/components/operator-only.tsx";
import { RefreshProjectsCTA } from "@/components/refresh-projects-cta.tsx";
import { Alert } from "@/components/ui/alert.tsx";
import { Button } from "@/components/ui/button.tsx";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog.tsx";
import { EmptyState } from "@/components/ui/empty-state.tsx";
import {
	CardFigure,
	CardFigureNote,
	InventoryCardList,
	InventoryRowCard,
} from "@/components/ui/inventory-card.tsx";
import { Spinner } from "@/components/ui/spinner.tsx";
import { formatError } from "@/lib/format-error.ts";
import { relativeTime } from "@/lib/utils.ts";

/**
 * Projects — the repository registry (warren-e228 / pl-7e38 step 9).
 *
 * Direction C design: docs/ui-revamp/screens/projects.jsx. An inventory
 * table, not a dashboard — every repo this instance can materialize into
 * run workspaces, with clone freshness (default branch, last HEAD, last
 * fetched) and queue presence (.seeds). No summary cards. Registration
 * (add / refresh / delete) is `admin`-gated (warren-b875 / warren-f53e):
 * a spectator gets the read-only projection with no broken affordances.
 */
export function ProjectsPage() {
	const qc = useQueryClient();
	const [addOpen, setAddOpen] = useState(false);
	const [confirmDelete, setConfirmDelete] = useState<ProjectRow | null>(null);

	const projects = useQuery({
		queryKey: ["projects"],
		queryFn: ({ signal }) => projectsApi.list(signal),
	});

	const create = useMutation({
		mutationFn: (input: { gitUrl: string; defaultBranch?: string }) => projectsApi.create(input),
		onSuccess: () => {
			qc.invalidateQueries({ queryKey: ["projects"] });
			setAddOpen(false);
		},
	});
	const del = useMutation({
		mutationFn: (id: string) => projectsApi.delete(id),
		onSuccess: () => {
			qc.invalidateQueries({ queryKey: ["projects"] });
			setConfirmDelete(null);
		},
	});
	const refresh = useMutation({
		mutationFn: (id: string) => projectsApi.refresh(id),
		onSuccess: () => qc.invalidateQueries({ queryKey: ["projects"] }),
	});

	// `admin`, not the hook's `dispatch` default: the add control the copy
	// points at is POST /projects, an admin route.
	const emptyHint = useOperatorHint("An operator can add one with a GitHub URL.", "admin");

	const rows = projects.data?.projects ?? [];

	return (
		<div className="flex min-h-full flex-col px-3.5 pt-5 pb-12 md:px-6">
			{/* Page header: title + one-line premise, actions on the right
			    (canvas layout: 20px semibold title, quiet description). */}
			<div className="flex flex-wrap items-start justify-between gap-4 pb-5">
				<div className="flex min-w-0 flex-col gap-1.5">
					<h1 className="text-xl leading-6 font-semibold tracking-[-0.025em] text-(--color-text)">
						Projects
					</h1>
					<p className="text-[12px] leading-4 text-(--color-text-2)">
						Repositories warren can dispatch runs against.
					</p>
				</div>
				<OperatorOnly capability="admin">
					<RefreshProjectsCTA />
				</OperatorOnly>
				<OperatorOnly capability="admin">
					<Button size="sm" onClick={() => setAddOpen(true)}>
						＋ Add project
					</Button>
				</OperatorOnly>
			</div>

			<div className="flex flex-col rounded-[4px] border border-(--color-border) bg-(--color-surface)">
				{projects.isLoading ? (
					<div className="p-6">
						<Spinner label="Loading projects" />
					</div>
				) : projects.isError ? (
					<div className="p-6">
						<Alert variant="danger" title="Failed to load projects">
							{formatError(projects.error)}
						</Alert>
					</div>
				) : rows.length === 0 ? (
					<EmptyState title="No projects yet" description={emptyHint} />
				) : (
					<>
						{/* Mobile arm: compact registry cards (warren-dea8). */}
						<InventoryCardList>
							{rows.map((p) => (
								<ProjectCard
									key={p.id}
									project={p}
									onRefresh={() => refresh.mutate(p.id)}
									refreshPending={refresh.isPending && refresh.variables === p.id}
									onDelete={() => setConfirmDelete(p)}
								/>
							))}
						</InventoryCardList>
						<div className="hidden md:block">
							<table className="w-full table-fixed border-collapse">
								<thead>
									<tr className="h-[31px] rounded-t-[4px] bg-(--color-thead) text-left">
										<Th className="w-[min(250px,35%)]">Project</Th>
										<Th className="w-[110px]">Default branch</Th>
										<Th className="w-[110px]">Last head</Th>
										<Th className="w-[110px]">Last fetched</Th>
										<Th className="w-[110px]">Issue queue</Th>
										<Th className="w-[100px]">Added</Th>
										<Th className="w-[130px] text-right">Actions</Th>
									</tr>
								</thead>
								<tbody>
									{rows.map((p) => (
										<RegistryRow
											key={p.id}
											project={p}
											onRefresh={() => refresh.mutate(p.id)}
											refreshPending={refresh.isPending && refresh.variables === p.id}
											onDelete={() => setConfirmDelete(p)}
										/>
									))}
								</tbody>
							</table>
						</div>
					</>
				)}
			</div>

			<AddProjectDialog
				open={addOpen}
				onOpenChange={setAddOpen}
				onSubmit={(input) => create.mutate(input)}
				pending={create.isPending}
				error={create.error ? formatError(create.error) : null}
			/>

			<Dialog
				open={confirmDelete !== null}
				onOpenChange={(open) => {
					if (!open) setConfirmDelete(null);
				}}
			>
				<DialogContent>
					<DialogHeader>
						<DialogTitle>Delete project?</DialogTitle>
						<DialogDescription>
							{confirmDelete !== null ? (
								<>
									This removes <code>{confirmDelete.localPath ?? confirmDelete.id}</code> from disk
									and the project row. This project's runs and their event transcripts are deleted
									too.
								</>
							) : null}
						</DialogDescription>
					</DialogHeader>
					{del.isError ? (
						<p className="text-sm text-(--color-destructive)">{formatError(del.error)}</p>
					) : null}
					<DialogFooter>
						<Button
							variant="outline"
							onClick={() => setConfirmDelete(null)}
							disabled={del.isPending}
						>
							Cancel
						</Button>
						<Button
							variant="destructive"
							onClick={() => {
								if (confirmDelete !== null) del.mutate(confirmDelete.id);
							}}
							disabled={del.isPending}
						>
							{del.isPending ? "Deleting…" : "Delete"}
						</Button>
					</DialogFooter>
				</DialogContent>
			</Dialog>
		</div>
	);
}

function Th({ className, children }: { className?: string; children: React.ReactNode }) {
	return (
		<th
			className={`border-b border-(--color-border-strong) px-2.5 text-[9px] font-semibold tracking-[0.05em] uppercase text-(--color-text-3) ${className ?? ""}`}
		>
			{children}
		</th>
	);
}

/** Derive the registry display name (owner/name) from the git URL. */
function repoName(project: ProjectRow): string {
	const match = project.gitUrl.match(/github\.com[/:]([^/]+\/[^/#?]+?)(?:\.git)?$/i);
	return match?.[1] ?? project.id;
}

function formatDate(iso: string | null): string {
	if (iso === null) return "—";
	const d = new Date(iso);
	return Number.isNaN(d.getTime()) ? iso : d.toISOString().slice(0, 10);
}

function RegistryRow({
	project,
	onRefresh,
	refreshPending,
	onDelete,
}: {
	project: ProjectRow;
	onRefresh: () => void;
	refreshPending: boolean;
	onDelete: () => void;
}) {
	return (
		<tr className="min-h-[49px] border-b border-(--color-border) last:border-b-0 align-middle">
			<td className="px-2.5 py-1.5">
				<div className="flex flex-col gap-0.5">
					<Link
						to={`/projects/${encodeURIComponent(project.id)}`}
						className="font-mono text-[10px] leading-3 text-(--color-text) underline-offset-4 hover:underline"
					>
						{repoName(project)}
					</Link>
					<span className="truncate font-mono text-[9px] leading-3 text-(--color-text-3)">
						{project.gitUrl}
					</span>
				</div>
			</td>
			<td className="px-2.5 py-1.5 font-mono text-[10px] leading-3 text-(--color-text-2)">
				{project.defaultBranch}
			</td>
			<td
				className="px-2.5 py-1.5 font-mono text-[10px] leading-3 text-(--color-text-2)"
				title={project.lastHeadSha ?? "never fetched"}
			>
				{project.lastHeadSha !== null ? project.lastHeadSha.slice(0, 7) : "—"}
			</td>
			<td
				className="px-2.5 py-1.5 font-mono text-[10px] leading-3 text-(--color-text-3)"
				title={project.lastFetchedAt ?? "never fetched"}
			>
				{project.lastFetchedAt !== null ? relativeTime(project.lastFetchedAt) : "never"}
			</td>
			<td className="px-2.5 py-1.5">
				{project.hasSeeds ? (
					<span className="inline-flex h-5 items-center rounded-(--radius-xs) border border-(--color-border-strong) px-1.5 font-mono text-[9px] leading-3 text-(--color-primary)">
						.seeds
					</span>
				) : (
					<span className="font-mono text-[10px] leading-3 text-(--color-text-3)">—</span>
				)}
			</td>
			<td className="px-2.5 py-1.5 font-mono text-[10px] leading-3 text-(--color-text-3)">
				{formatDate(project.addedAt)}
			</td>
			<td className="px-2.5 py-1.5 text-right">
				{/* Refresh/delete are admin routes; the row actions disappear
				    (not disable) for a spectator, per the OperatorOnly contract. */}
				<OperatorOnly capability="admin">
					<div className="flex justify-end gap-1.5">
						<Button
							variant="outline"
							size="sm"
							className="h-6 px-2.5 text-[10px]"
							onClick={onRefresh}
							disabled={refreshPending}
							title="git fetch + reset --hard origin/<branch>"
						>
							<RefreshCw className={`h-3 w-3 ${refreshPending ? "animate-spin" : ""}`} />
							Refresh
						</Button>
						<Button
							variant="ghost"
							size="sm"
							className="h-6 w-6 p-0"
							onClick={onDelete}
							aria-label={`Delete ${project.id}`}
						>
							<Trash2 className="h-3 w-3" />
						</Button>
					</div>
				</OperatorOnly>
			</td>
		</tr>
	);
}

/** Mobile registry card (warren-dea8): repo, clone freshness, actions. */
function ProjectCard({
	project,
	onRefresh,
	refreshPending,
	onDelete,
}: {
	project: ProjectRow;
	onRefresh: () => void;
	refreshPending: boolean;
	onDelete: () => void;
}) {
	return (
		<InventoryRowCard
			tone="neutral"
			stateLabel={project.hasSeeds ? ".seeds" : "repo"}
			title={repoName(project)}
			titleTo={`/projects/${encodeURIComponent(project.id)}`}
			subline={project.gitUrl}
			figures={
				<>
					<CardFigure value={project.defaultBranch} />
					<CardFigureNote
						value={
							project.lastFetchedAt !== null
								? `fetched ${relativeTime(project.lastFetchedAt)}`
								: "never fetched"
						}
					/>
				</>
			}
			meta={`HEAD ${project.lastHeadSha !== null ? project.lastHeadSha.slice(0, 7) : "—"} · added ${formatDate(project.addedAt)}`}
		>
			{/* Refresh/delete are admin routes; the spectator card drops them,
			    same contract as the desktop row (warren-b875 / warren-f53e). */}
			<OperatorOnly capability="admin">
				<div className="flex gap-1.5">
					<Button
						variant="outline"
						size="sm"
						className="h-6 px-2.5 text-[10px]"
						onClick={onRefresh}
						disabled={refreshPending}
						title="git fetch + reset --hard origin/<branch>"
					>
						<RefreshCw className={`h-3 w-3 ${refreshPending ? "animate-spin" : ""}`} />
						Refresh
					</Button>
					<Button
						variant="ghost"
						size="sm"
						className="h-6 w-6 p-0"
						onClick={onDelete}
						aria-label={`Delete ${project.id}`}
					>
						<Trash2 className="h-3 w-3" />
					</Button>
				</div>
			</OperatorOnly>
		</InventoryRowCard>
	);
}
