import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { RefreshCw, Trash2 } from "lucide-react";
import { useState } from "react";
import { Link } from "react-router-dom";
import { projectsApi } from "@/api/client.ts";
import type { ProjectRow } from "@/api/types.ts";
import {
	compareStrings,
	type Comparator,
	useClientSort,
} from "@/hooks/use-client-sort.ts";
import { SortableTableHead } from "@/components/ui/sortable-table-head.tsx";
import { RefreshProjectsCTA } from "@/components/RefreshProjectsCTA.tsx";
import { Alert } from "@/components/ui/alert.tsx";
import { Button } from "@/components/ui/button.tsx";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card.tsx";
import { EmptyState } from "@/components/ui/empty-state.tsx";
import { PageHeader } from "@/components/ui/page-header.tsx";
import { responsiveCardHeaderRow } from "@/components/ui/responsive.ts";
import { Spinner } from "@/components/ui/spinner.tsx";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog.tsx";
import { Input } from "@/components/ui/input.tsx";
import { Label } from "@/components/ui/label.tsx";
import {
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from "@/components/ui/table.tsx";
import { formatError } from "@/lib/format-error.ts";
import { formatTimestamp } from "@/lib/utils.ts";

type ProjectSortKey = "id" | "gitUrl" | "defaultBranch" | "lastHeadSha" | "lastFetchedAt" | "addedAt";

const PROJECT_COMPARATORS: Record<ProjectSortKey, Comparator<ProjectRow>> = {
	id: (a, b) => compareStrings(a.id, b.id),
	gitUrl: (a, b) => compareStrings(a.gitUrl, b.gitUrl),
	defaultBranch: (a, b) => compareStrings(a.defaultBranch, b.defaultBranch),
	lastHeadSha: (a, b) => compareStrings(a.lastHeadSha, b.lastHeadSha),
	lastFetchedAt: (a, b) => compareStrings(a.lastFetchedAt, b.lastFetchedAt),
	addedAt: (a, b) => compareStrings(a.addedAt, b.addedAt),
};

export function ProjectsPage() {
	const qc = useQueryClient();
	const projects = useQuery({
		queryKey: ["projects"],
		queryFn: ({ signal }) => projectsApi.list(signal),
	});
	const [confirmDelete, setConfirmDelete] = useState<ProjectRow | null>(null);
	const { sorted, sort, onSort } = useClientSort(
		projects.data?.projects ?? [],
		PROJECT_COMPARATORS,
		{
			initialKey: "addedAt",
			initialDirection: "desc",
			defaultDirections: { lastFetchedAt: "desc", addedAt: "desc" },
		},
	);

	const create = useMutation({
		mutationFn: (input: { gitUrl: string; defaultBranch?: string }) =>
			projectsApi.create(input),
		onSuccess: () => qc.invalidateQueries({ queryKey: ["projects"] }),
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

	return (
		<div className="space-y-6">
			<PageHeader
				title="Projects"
				description={
					<>
						GitHub repos cloned under <code>$WARREN_PROJECTS_DIR</code>.
					</>
				}
			/>

			<AddProjectForm
				onSubmit={(input) => create.mutate(input)}
				pending={create.isPending}
				error={create.error ? formatError(create.error) : null}
			/>

			<Card>
				<CardHeader className={responsiveCardHeaderRow}>
					<CardTitle>{projects.data?.projects.length ?? 0} projects</CardTitle>
					<RefreshProjectsCTA label="Sync all" />
				</CardHeader>
				<CardContent className="p-0">
					{projects.isLoading ? (
						<div className="p-6"><Spinner label="Loading projects" /></div>
					) : projects.isError ? (
						<div className="p-6">
							<Alert variant="danger" title="Failed to load projects">
								{formatError(projects.error)}
							</Alert>
						</div>
					) : projects.data?.projects.length === 0 ? (
						<EmptyState
							title="No projects yet"
							description="Add one with a GitHub URL above."
						/>
					) : (
						<Table>
							<TableHeader>
								<TableRow>
									<SortableTableHead columnKey="id" sort={sort} onSort={onSort}>
										ID
									</SortableTableHead>
									<SortableTableHead columnKey="gitUrl" sort={sort} onSort={onSort}>
										Git URL
									</SortableTableHead>
									<SortableTableHead columnKey="defaultBranch" sort={sort} onSort={onSort}>
										Default branch
									</SortableTableHead>
									<SortableTableHead columnKey="lastHeadSha" sort={sort} onSort={onSort}>
										HEAD
									</SortableTableHead>
									<SortableTableHead columnKey="lastFetchedAt" sort={sort} onSort={onSort}>
										Last fetched
									</SortableTableHead>
									<SortableTableHead columnKey="addedAt" sort={sort} onSort={onSort}>
										Added
									</SortableTableHead>
									<TableHead className="w-24" />
								</TableRow>
							</TableHeader>
							<TableBody>
								{sorted.map((p) => (
									<TableRow key={p.id}>
										<TableCell className="whitespace-nowrap font-mono text-xs">
											<Link
												to={`/projects/${encodeURIComponent(p.id)}`}
												className="underline-offset-4 hover:underline"
											>
												{p.id}
											</Link>
										</TableCell>
										<TableCell className="whitespace-nowrap font-mono text-xs">
											{p.gitUrl}
										</TableCell>
										<TableCell className="whitespace-nowrap">{p.defaultBranch}</TableCell>
										<TableCell
											className="whitespace-nowrap font-mono text-xs"
											title={p.lastHeadSha ?? "never fetched"}
										>
											{p.lastHeadSha !== null ? p.lastHeadSha.slice(0, 7) : "—"}
										</TableCell>
										<TableCell className="whitespace-nowrap text-(--color-muted-foreground)">
											{p.lastFetchedAt !== null
												? formatTimestamp(p.lastFetchedAt)
												: "never"}
										</TableCell>
										<TableCell className="whitespace-nowrap text-(--color-muted-foreground)">
											{formatTimestamp(p.addedAt)}
										</TableCell>
										<TableCell>
											<div className="flex gap-1">
												<Button
													variant="ghost"
													size="icon"
													onClick={() => refresh.mutate(p.id)}
													disabled={
														refresh.isPending && refresh.variables === p.id
													}
													aria-label={`Refresh ${p.id}`}
													title="git fetch + reset --hard origin/<branch>"
												>
													<RefreshCw
														className={`h-4 w-4 ${
															refresh.isPending && refresh.variables === p.id
																? "animate-spin"
																: ""
														}`}
													/>
												</Button>
												<Button
													variant="ghost"
													size="icon"
													onClick={() => setConfirmDelete(p)}
													aria-label={`Delete ${p.id}`}
												>
													<Trash2 className="h-4 w-4" />
												</Button>
											</div>
										</TableCell>
									</TableRow>
								))}
							</TableBody>
						</Table>
					)}
				</CardContent>
			</Card>

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
									This removes <code>{confirmDelete.localPath}</code> from disk
									and the project row. Run history for this project is kept.
								</>
							) : null}
						</DialogDescription>
					</DialogHeader>
					{del.isError ? (
						<p className="text-sm text-(--color-destructive)">
							{formatError(del.error)}
						</p>
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

function AddProjectForm({
	onSubmit,
	pending,
	error,
}: {
	onSubmit: (input: { gitUrl: string; defaultBranch?: string }) => void;
	pending: boolean;
	error: string | null;
}) {
	const [gitUrl, setGitUrl] = useState("");
	const [defaultBranch, setDefaultBranch] = useState("");

	const handleSubmit = (e: React.FormEvent): void => {
		e.preventDefault();
		const input: { gitUrl: string; defaultBranch?: string } = { gitUrl: gitUrl.trim() };
		if (defaultBranch.trim().length > 0) input.defaultBranch = defaultBranch.trim();
		onSubmit(input);
		setGitUrl("");
		setDefaultBranch("");
	};

	return (
		<Card>
			<CardHeader>
				<CardTitle>Add a project</CardTitle>
			</CardHeader>
			<CardContent>
				<form onSubmit={handleSubmit} className="grid gap-4 md:grid-cols-[2fr_1fr_auto]">
					<div className="space-y-1">
						<Label htmlFor="gitUrl">GitHub URL</Label>
						<Input
							id="gitUrl"
							required
							placeholder="https://github.com/owner/name"
							value={gitUrl}
							onChange={(e) => setGitUrl(e.target.value)}
						/>
					</div>
					<div className="space-y-1">
						<Label htmlFor="branch">Branch (optional)</Label>
						<Input
							id="branch"
							placeholder="auto-detect"
							value={defaultBranch}
							onChange={(e) => setDefaultBranch(e.target.value)}
						/>
					</div>
					<div className="flex items-end">
						<Button type="submit" disabled={pending || gitUrl.trim().length === 0}>
							{pending ? "Cloning…" : "Add"}
						</Button>
					</div>
				</form>
				{error !== null ? (
					<p className="mt-3 text-sm text-(--color-destructive)">{error}</p>
				) : null}
			</CardContent>
		</Card>
	);
}
