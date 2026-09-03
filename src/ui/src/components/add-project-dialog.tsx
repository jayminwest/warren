import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { forgeApi } from "@/api/client.ts";
import { Button } from "@/components/ui/button.tsx";
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
import { Spinner } from "@/components/ui/spinner.tsx";
import { filterRepos, repoLabel, repoPickerMode } from "./add-project-repo-picker.helpers.ts";

/**
 * "＋ Add project" dialog (warren-e228 / pl-7e38 step 9; repo picker
 * warren-2601 / pl-26f3 step 10).
 *
 * When the active forge is the GitHub App, a picker lists the
 * installation's repositories (client-side filter over the fetched list —
 * no server search). The URL paste NEVER goes away: a repository the App
 * cannot see must remain addable, and PAT / no-forge mode is paste-only.
 * Registration stays operator-gated: the caller (ProjectsPage) mounts both
 * the button and this dialog only for a caller holding `admin`.
 */
export function AddProjectDialog({
	open,
	onOpenChange,
	onSubmit,
	pending,
	error,
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	onSubmit: (input: { gitUrl: string; defaultBranch?: string }) => void;
	pending: boolean;
	error: string | null;
}) {
	const [gitUrl, setGitUrl] = useState("");
	const [defaultBranch, setDefaultBranch] = useState("");
	const [filter, setFilter] = useState("");

	// Fetched only while the dialog is open; every non-picker answer
	// (PAT, no forge, failure) leaves the URL paste as the only path.
	const repos = useQuery({
		queryKey: ["forge-repos"],
		queryFn: ({ signal }) => forgeApi.repos(signal),
		enabled: open,
	});
	const mode = repoPickerMode(repos.data);
	const filtered = filterRepos(repos.data?.repos ?? [], filter);

	const handleSubmit = (e: React.FormEvent): void => {
		e.preventDefault();
		const input: { gitUrl: string; defaultBranch?: string } = { gitUrl: gitUrl.trim() };
		if (defaultBranch.trim().length > 0) input.defaultBranch = defaultBranch.trim();
		onSubmit(input);
		setGitUrl("");
		setDefaultBranch("");
		setFilter("");
	};

	/** Pick a row: fill the URL the form submits, plus the default branch. */
	const pick = (repo: { cloneUrl: string; defaultBranch: string; name: string }): void => {
		setGitUrl(repo.cloneUrl);
		if (repo.defaultBranch !== "" && defaultBranch.trim() === "") {
			setDefaultBranch(repo.defaultBranch);
		}
	};

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent>
				<DialogHeader>
					<DialogTitle>Add a project</DialogTitle>
					<DialogDescription>
						Clone a GitHub repository so warren can run against it.
					</DialogDescription>
				</DialogHeader>
				<form onSubmit={handleSubmit} className="grid gap-4">
					{mode === "picker" ? (
						<div className="space-y-1.5">
							<Label htmlFor="repo-filter">Your repositories</Label>
							<Input
								id="repo-filter"
								placeholder="Filter repositories…"
								value={filter}
								onChange={(e) => setFilter(e.target.value)}
							/>
							<div className="max-h-44 overflow-y-auto rounded-(--radius-xs) border border-(--color-border)">
								{filtered.length === 0 ? (
									<p className="p-2 text-[11px] leading-4 text-(--color-text-3)">
										No match — paste the URL below instead.
									</p>
								) : (
									filtered.map((repo) => (
										<button
											key={repo.cloneUrl}
											type="button"
											className="block w-full px-2.5 py-1.5 text-left font-mono text-[10px] leading-4 text-(--color-text) hover:bg-(--color-thead)"
											onClick={() => pick(repo)}
										>
											{repoLabel(repo)}
										</button>
									))
								)}
							</div>
						</div>
					) : null}
					{repos.isLoading && open ? (
						<div className="text-[11px] text-(--color-text-3)">
							<Spinner label="Checking your GitHub connection" />
						</div>
					) : null}
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
					{error !== null ? <p className="text-sm text-(--color-destructive)">{error}</p> : null}
					<DialogFooter>
						<Button
							type="button"
							variant="outline"
							onClick={() => onOpenChange(false)}
							disabled={pending}
						>
							Cancel
						</Button>
						<Button type="submit" disabled={pending || gitUrl.trim().length === 0}>
							{pending ? "Cloning…" : "Add project"}
						</Button>
					</DialogFooter>
				</form>
			</DialogContent>
		</Dialog>
	);
}
