import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { RefreshCw, Trash2 } from "lucide-react";
import { useState } from "react";
import { Link } from "react-router-dom";
import { projectsApi } from "@/api/client.ts";
import type { ProjectRow } from "@/api/types.ts";
import { Button } from "@/components/ui/button.tsx";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card.tsx";
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
import { formatTimestamp } from "@/lib/utils.ts";

export function ProjectsPage() {
	const qc = useQueryClient();
	const projects = useQuery({
		queryKey: ["projects"],
		queryFn: ({ signal }) => projectsApi.list(signal),
	});
	const [confirmDelete, setConfirmDelete] = useState<ProjectRow | null>(null);

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
			<header>
				<h1 className="text-2xl font-semibold tracking-tight">Projects</h1>
				<p className="text-sm text-(--color-muted-foreground)">
					GitHub repos cloned under <code>$WARREN_PROJECTS_DIR</code>.
				</p>
			</header>

			<AddProjectForm
				onSubmit={(input) => create.mutate(input)}
				pending={create.isPending}
				error={create.error instanceof Error ? create.error.message : null}
			/>

			<Card>
				<CardHeader>
					<CardTitle>{projects.data?.projects.length ?? 0} projects</CardTitle>
				</CardHeader>
				<CardContent className="p-0">
					{projects.isLoading ? (
						<p className="p-6 text-sm text-(--color-muted-foreground)">Loading…</p>
					) : projects.isError ? (
						<p className="p-6 text-sm text-(--color-destructive)">
							{projects.error instanceof Error
								? projects.error.message
								: String(projects.error)}
						</p>
					) : projects.data?.projects.length === 0 ? (
						<p className="p-6 text-sm text-(--color-muted-foreground)">
							No projects yet. Add one with a GitHub URL above.
						</p>
					) : (
						<Table>
							<TableHeader>
								<TableRow>
									<TableHead className="whitespace-nowrap">ID</TableHead>
									<TableHead className="whitespace-nowrap">Git URL</TableHead>
									<TableHead className="whitespace-nowrap">Default branch</TableHead>
									<TableHead className="whitespace-nowrap">HEAD</TableHead>
									<TableHead className="whitespace-nowrap">Last fetched</TableHead>
									<TableHead className="whitespace-nowrap">Added</TableHead>
									<TableHead className="w-24" />
								</TableRow>
							</TableHeader>
							<TableBody>
								{projects.data?.projects.map((p) => (
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
							{del.error instanceof Error ? del.error.message : String(del.error)}
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
