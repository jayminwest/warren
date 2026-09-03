import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Trash2 } from "lucide-react";
import { useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { projectsApi } from "@/api/client.ts";
import type { ProjectRow } from "@/api/types.ts";
import { OperatorOnly } from "@/components/operator-only.tsx";
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
import { Spinner } from "@/components/ui/spinner.tsx";
import { formatError } from "@/lib/format-error.ts";
import {
	DispatchDefaultsPanel,
	ReadyPlansPanel,
	TriggersPanel,
} from "@/pages/project-detail.panels.tsx";
import { ProjectFactsPanel, RecentRunsPanel } from "@/pages/project-detail.side-rail.tsx";
import { mainColumnClasses, sideRailClasses } from "@/pages/project-detail-layout.ts";

/**
 * Project detail — the Direction C project inspector (warren-8375 /
 * pl-7e38 step 10), from `docs/ui-revamp/screens/project-detail.jsx`.
 *
 * Left rail: dispatch defaults (`.warren/config.yaml`), cron triggers
 * (`.warren/triggers.yaml`, with the run-trigger action), and ready
 * plans (`.seeds` queue). Right rail: clone-state facts and recent
 * runs. The warren-config and ready-plans reads are `readPublic` —
 * a spectator sees the narrowed config envelope and the ready-plan
 * list, while the triggers panel (prompt text) and every mutation
 * control stay operator-only (warren-f53e / warren-b754).
 *
 * The panels live in `project-detail.panels.tsx` so this page and that
 * module both stay inside the 500-line budget (check:size).
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

	return (
		<div className="flex min-h-full flex-col px-3.5 pt-[22px] pb-12 md:px-6">
			<div className="pb-2.5">
				<span className="font-mono text-[10px] leading-3 text-(--color-text-3)">
					PROJECTS / {project.data ? repoName(project.data).toUpperCase() : "…"}
				</span>
			</div>
			<HeaderRow project={project.data} loading={project.isLoading} />

			{project.isLoading ? (
				<Spinner label="Loading project" />
			) : project.isError ? (
				<Alert variant="danger" title="Failed to load project">
					{formatError(project.error)}
				</Alert>
			) : project.data === undefined ? (
				<Alert variant="danger" title="Project not found" />
			) : (
				<div className="flex min-w-0 flex-1 flex-col gap-4 lg:flex-row">
					<div className={mainColumnClasses()}>
						<DispatchDefaultsPanel
							query={warrenConfig.data}
							isLoading={warrenConfig.isLoading}
							error={warrenConfig.error}
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
			)}
		</div>
	);
}

/* --------------------------------------------------------------------- */
/* Header                                                                 */
/* --------------------------------------------------------------------- */

function HeaderRow({ project, loading }: { project?: ProjectRow; loading: boolean }) {
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

	if (loading || project === undefined) {
		return <div className="flex h-[31px] items-center pb-5" />;
	}

	return (
		<div className="flex flex-wrap items-center gap-3 pb-5">
			<h1 className="font-mono text-base leading-5 font-medium text-(--color-text)">
				{repoName(project)}
			</h1>
			{project.hasSeeds ? (
				<span className="inline-flex h-5 items-center rounded-(--radius-xs) border border-(--color-border-strong) px-1.5 font-mono text-[9px] leading-3 text-(--color-primary)">
					.seeds
				</span>
			) : null}
			<span className="truncate font-mono text-[10px] leading-3 text-(--color-text-3)">
				{project.gitUrl}
			</span>
			<div className="min-w-0 flex-1" />
			{/* Refresh / delete are `admin` routes (warren-b875): the row
			    actions disappear, not disable, for a spectator. */}
			<OperatorOnly capability="admin">
				<Button
					variant="outline"
					size="sm"
					className="h-[31px] text-[11px]"
					onClick={() => refresh.mutate(project.id)}
					disabled={refresh.isPending}
					title="git fetch + reset --hard origin/<branch>"
				>
					{refresh.isPending ? "Refreshing…" : "Refresh clone"}
				</Button>
				<Button
					variant="outline"
					size="sm"
					className="h-[31px] text-[11px] text-(--color-danger)"
					onClick={() => setConfirmDelete(true)}
				>
					<Trash2 className="h-3 w-3" />
					Delete
				</Button>
			</OperatorOnly>

			<Dialog open={confirmDelete} onOpenChange={setConfirmDelete}>
				<DialogContent>
					<DialogHeader>
						<DialogTitle>Delete project?</DialogTitle>
						<DialogDescription>
							This removes <code>{project.localPath ?? project.id}</code> from disk and the project
							row. This project's runs and their event transcripts are deleted too.
						</DialogDescription>
					</DialogHeader>
					{del.isError ? (
						<p className="text-sm text-(--color-destructive)">{formatError(del.error)}</p>
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
		</div>
	);
}

/* --------------------------------------------------------------------- */
/* Helpers                                                                */
/* --------------------------------------------------------------------- */

/** Derive the registry display name (owner/name) from the git URL. */
export function repoName(project: ProjectRow): string {
	const match = project.gitUrl.match(/github\.com[/:]([^/]+\/[^/#?]+?)(?:\.git)?$/i);
	return match?.[1] ?? project.id;
}
