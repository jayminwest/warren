import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { FolderX, RefreshCw, Trash2 } from "lucide-react";
import { useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { projectsApi } from "@/api/client.ts";
import type { ProjectRow } from "@/api/types.ts";
import { OperatorOnly } from "@/components/operator-only.tsx";
import { Button, buttonVariants } from "@/components/ui/button.tsx";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog.tsx";
import { EmptyState } from "@/components/ui/empty-state.tsx";
import { PageHeader } from "@/components/ui/page-header.tsx";
import { Skeleton } from "@/components/ui/skeleton.tsx";
import { Tag } from "@/components/ui/tag.tsx";
import { formatError } from "@/lib/format-error.ts";
import {
	DispatchDefaultsPanel,
	ReadyPlansPanel,
	TriggersPanel,
} from "@/pages/project-detail.panels.tsx";
import { ProjectFactsPanel, RecentRunsPanel } from "@/pages/project-detail.side-rail.tsx";
import { mainColumnClasses, sideRailClasses } from "@/pages/project-detail-layout.ts";
import { repoName } from "@/pages/projects.rows.tsx";
import { ListError } from "@/pages/runs/list-error.tsx";

/**
 * Project detail — the project inspector (warren-8375, migrated in
 * warren-9474). Main column: dispatch defaults (`.warren/config.yaml`),
 * cron triggers (`.warren/triggers.yaml`) and ready plans. Side rail:
 * clone facts and recent runs. The config and ready-plan reads are
 * `readPublic`; the triggers panel (prompt text) and every mutation
 * control stay operator-only (warren-f53e / warren-b754).
 */
export function ProjectDetailPage() {
	const { id = "" } = useParams<{ id: string }>();

	const project = useQuery({
		queryKey: ["projects", id],
		queryFn: ({ signal }) => projectsApi.get(id, signal),
		enabled: id.length > 0,
	});

	// `GET /projects/:id/warren-config` is `readPublic` (warren-b754):
	// spectators get the narrowed envelope (no triggers, no errors),
	// so the defaults panel renders for every audience.
	const warrenConfig = useQuery({
		queryKey: ["projects", id, "warren-config"],
		queryFn: ({ signal }) => projectsApi.warrenConfig(id, signal),
		enabled: id.length > 0,
	});

	const eyebrow = (
		<Link to="/projects" className="hover:text-(--color-text-2) hover:underline">
			Projects
		</Link>
	);

	return (
		<div className="flex flex-col gap-5 px-4 pt-6 pb-12 md:px-6">
			{project.isLoading ? (
				<div className="space-y-2" role="status" aria-label="Loading project">
					<Skeleton className="h-3 w-16" />
					<Skeleton className="h-6 w-64" />
					<Skeleton className="h-3.5 w-80 max-w-full" />
				</div>
			) : project.isError ? (
				<>
					<PageHeader eyebrow={eyebrow} title="Project" />
					<ListError
						what="this project"
						error={project.error}
						onRetry={() => void project.refetch()}
					/>
				</>
			) : project.data === undefined ? (
				<EmptyState
					icon={FolderX}
					title="Project not found"
					description="It may have been deleted."
					action={
						<Link to="/projects" className={buttonVariants({ variant: "outline", size: "sm" })}>
							Back to projects
						</Link>
					}
				/>
			) : (
				<>
					<ProjectHeader project={project.data} eyebrow={eyebrow} />
					<div className="flex min-w-0 flex-col gap-4 lg:flex-row lg:items-start">
						<div className={mainColumnClasses()}>
							<DispatchDefaultsPanel
								query={warrenConfig.data}
								isLoading={warrenConfig.isLoading}
								error={warrenConfig.error}
								onRetry={() => void warrenConfig.refetch()}
							/>
							{/* Triggers carry executable prompt text and their read is
							 * still `readOperator` — a spectator gets no panel. */}
							<OperatorOnly capability="readOperator">
								<TriggersPanel projectId={id} />
							</OperatorOnly>
							<ReadyPlansPanel projectId={id} />
						</div>
						<div className={sideRailClasses()}>
							<ProjectFactsPanel project={project.data} />
							<RecentRunsPanel projectId={id} />
						</div>
					</div>
				</>
			)}
		</div>
	);
}

function ProjectHeader({ project, eyebrow }: { project: ProjectRow; eyebrow: React.ReactNode }) {
	const navigate = useNavigate();
	const qc = useQueryClient();
	const [confirmDelete, setConfirmDelete] = useState(false);

	const refresh = useMutation({
		mutationFn: (pid: string) => projectsApi.refresh(pid),
		onSuccess: () => qc.invalidateQueries({ queryKey: ["projects"] }),
	});
	const del = useMutation({
		mutationFn: (pid: string) => projectsApi.delete(pid),
		onSuccess: () => {
			qc.invalidateQueries({ queryKey: ["projects"] });
			navigate("/projects");
		},
	});

	return (
		<>
			<PageHeader
				eyebrow={eyebrow}
				title={repoName(project)}
				description={
					<span className="flex min-w-0 flex-wrap items-center gap-2">
						<a
							href={project.gitUrl}
							target="_blank"
							rel="noreferrer"
							className="min-w-0 truncate font-mono text-xs text-(--color-text-3) hover:text-(--color-text-2) hover:underline"
						>
							{project.gitUrl.replace(/^https?:\/\//, "")}
						</a>
						{project.hasSeeds ? <Tag>Seeds issue queue</Tag> : null}
					</span>
				}
				actions={
					// Refresh / delete are `admin` routes (warren-b875): the
					// actions disappear, not disable, for a spectator.
					<OperatorOnly capability="admin">
						<Button
							variant="outline"
							size="sm"
							onClick={() => refresh.mutate(project.id)}
							disabled={refresh.isPending}
							title="Fetch the latest commits and reset the clone to the default branch"
						>
							<RefreshCw aria-hidden className={refresh.isPending ? "animate-spin" : undefined} />
							{refresh.isPending ? "Refreshing…" : "Refresh clone"}
						</Button>
						<Button
							variant="ghost"
							size="sm"
							className="text-(--color-danger) hover:text-(--color-danger)"
							onClick={() => setConfirmDelete(true)}
						>
							<Trash2 aria-hidden />
							Delete
						</Button>
					</OperatorOnly>
				}
			/>
			{refresh.isError ? (
				<p className="text-sm text-(--color-danger)">
					Refresh failed: {formatError(refresh.error)}
				</p>
			) : null}

			<Dialog open={confirmDelete} onOpenChange={setConfirmDelete}>
				<DialogContent>
					<DialogHeader>
						<DialogTitle>Delete project?</DialogTitle>
						<DialogDescription>
							This removes the clone of <strong>{repoName(project)}</strong> from disk, along with
							its runs and their event history. It cannot be undone.
						</DialogDescription>
					</DialogHeader>
					{del.isError ? (
						<p className="text-sm text-(--color-danger)">{formatError(del.error)}</p>
					) : null}
					<DialogFooter>
						<Button
							variant="outline"
							onClick={() => setConfirmDelete(false)}
							disabled={del.isPending}
						>
							Cancel
						</Button>
						<Button
							variant="destructive"
							onClick={() => del.mutate(project.id)}
							disabled={del.isPending}
						>
							{del.isPending ? "Deleting…" : "Delete"}
						</Button>
					</DialogFooter>
				</DialogContent>
			</Dialog>
		</>
	);
}
