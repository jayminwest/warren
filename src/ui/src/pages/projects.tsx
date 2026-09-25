import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { FolderGit2, Plus } from "lucide-react";
import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { projectsApi } from "@/api/client.ts";
import type { ProjectRow } from "@/api/types.ts";
import { AddProjectDialog } from "@/components/add-project-dialog.tsx";
import { OperatorOnly, useOperatorHint } from "@/components/operator-only.tsx";
import { RefreshProjectsCTA } from "@/components/refresh-projects-cta.tsx";
import { Button } from "@/components/ui/button.tsx";
import { Card } from "@/components/ui/card.tsx";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog.tsx";
import { EmptyState } from "@/components/ui/empty-state.tsx";
import { InventoryCardList } from "@/components/ui/inventory-card.tsx";
import { PageHeader } from "@/components/ui/page-header.tsx";
import { SkeletonRows } from "@/components/ui/skeleton.tsx";
import { Table, TableBody, TableHead, TableHeader, TableRow } from "@/components/ui/table.tsx";
import { useListKeys } from "@/hooks/use-list-keys.ts";
import { formatError } from "@/lib/format-error.ts";
import { ProjectCard, RegistryRow, repoName } from "@/pages/projects.rows.tsx";
import { ListError } from "@/pages/runs/list-error.tsx";

/**
 * Projects — the repository registry (warren-e228, migrated in
 * warren-9474). Every repo this instance can clone into run workspaces,
 * with clone freshness and whether it carries an issue queue. J/K moves
 * the selection, Enter opens it. Registration (add / refresh / delete) is
 * `admin`-gated (warren-b875 / warren-f53e): a spectator gets the
 * read-only list with no broken controls.
 */
export function ProjectsPage() {
	const qc = useQueryClient();
	const navigate = useNavigate();
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
	const { selected, setRef } = useListKeys(rows.length, (i) => {
		const p = rows[i];
		if (p) navigate(`/projects/${encodeURIComponent(p.id)}`);
	});
	const actionsFor = (p: ProjectRow) => ({
		onRefresh: () => refresh.mutate(p.id),
		refreshPending: refresh.isPending && refresh.variables === p.id,
		onDelete: () => setConfirmDelete(p),
	});

	return (
		<div className="flex flex-col gap-5 px-4 pt-6 pb-12 md:px-6">
			<PageHeader
				title="Projects"
				description="Repositories warren can dispatch runs against."
				actions={
					<>
						<OperatorOnly capability="admin">
							<RefreshProjectsCTA />
						</OperatorOnly>
						<OperatorOnly capability="admin">
							<Button size="sm" onClick={() => setAddOpen(true)}>
								<Plus aria-hidden />
								Add project
							</Button>
						</OperatorOnly>
					</>
				}
			/>

			<Card className="self-stretch">
				{projects.isLoading ? (
					<SkeletonRows rows={5} />
				) : projects.isError ? (
					<ListError
						what="projects"
						error={projects.error}
						onRetry={() => void projects.refetch()}
					/>
				) : rows.length === 0 ? (
					<EmptyState icon={FolderGit2} title="No projects yet" description={emptyHint} />
				) : (
					<>
						<InventoryCardList>
							{rows.map((p) => (
								<ProjectCard key={p.id} project={p} {...actionsFor(p)} />
							))}
						</InventoryCardList>
						<div className="hidden md:block">
							<Table>
								<TableHeader>
									<TableRow>
										<TableHead>Project</TableHead>
										<TableHead>Default branch</TableHead>
										<TableHead>Last head</TableHead>
										<TableHead>Last fetched</TableHead>
										<TableHead>Issue queue</TableHead>
										<TableHead>Added</TableHead>
										<TableHead className="text-right">
											<span className="sr-only">Actions</span>
										</TableHead>
									</TableRow>
								</TableHeader>
								<TableBody>
									{rows.map((p, i) => (
										<RegistryRow
											key={p.id}
											project={p}
											selected={selected === i}
											rowRef={setRef(i)}
											onOpen={navigate}
											{...actionsFor(p)}
										/>
									))}
								</TableBody>
							</Table>
						</div>
					</>
				)}
			</Card>

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
									This removes the clone of <strong>{repoName(confirmDelete)}</strong> from disk,
									along with its runs and their event history. It cannot be undone.
								</>
							) : null}
						</DialogDescription>
					</DialogHeader>
					{del.isError ? (
						<p className="text-sm text-(--color-danger)">{formatError(del.error)}</p>
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
