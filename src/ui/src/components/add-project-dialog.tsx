import { useState } from "react";
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

/**
 * "＋ Add project" dialog (warren-e228 / pl-7e38 step 9).
 *
 * The Direction C registry header carries a single quiet button rather
 * than an always-mounted form card; the registration form itself moved
 * into this dialog. Registration stays operator-gated: the caller
 * (ProjectsPage) mounts both the button and this dialog only for a
 * caller holding `admin` (POST /projects is an admin route, warren-b875).
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

	const handleSubmit = (e: React.FormEvent): void => {
		e.preventDefault();
		const input: { gitUrl: string; defaultBranch?: string } = { gitUrl: gitUrl.trim() };
		if (defaultBranch.trim().length > 0) input.defaultBranch = defaultBranch.trim();
		onSubmit(input);
		setGitUrl("");
		setDefaultBranch("");
	};

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent>
				<DialogHeader>
					<DialogTitle>Add a project</DialogTitle>
					<DialogDescription>
						Clone a GitHub repository into warren's workspace storage so it can be materialized into
						run workspaces.
					</DialogDescription>
				</DialogHeader>
				<form onSubmit={handleSubmit} className="grid gap-4">
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
