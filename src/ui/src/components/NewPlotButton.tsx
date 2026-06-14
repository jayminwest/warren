import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { plotsApi, projectsApi } from "@/api/client.ts";
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
import { Textarea } from "@/components/ui/textarea.tsx";

/**
 * Shared "New Plot" affordance (warren-dc54 / pl-0008 step 5). Extracted
 * from the original Plots page so both the legacy /plots list and the new
 * /workspace surface drive the same create dialog. Fetches the project
 * list itself and filters to `hasPlot=true` projects, surfacing the
 * documented empty-state copy when none exist (mx-0b5f9c contract). On
 * success it invalidates the `plots` query and navigates to the new Plot.
 */
export function NewPlotButton({
	destination = "/plots",
}: {
	/** Route prefix to navigate to after create — `${destination}/:id`. */
	destination?: string;
}): JSX.Element {
	const [open, setOpen] = useState(false);
	const projects = useQuery({
		queryKey: ["projects"],
		queryFn: ({ signal }) => projectsApi.list(signal),
	});

	const hasPlotProjects = useMemo(
		() => (projects.data?.projects ?? []).filter((p) => p.hasPlot),
		[projects.data],
	);

	return (
		<>
			<Button onClick={() => setOpen(true)} disabled={projects.isLoading}>
				New Plot
			</Button>
			<NewPlotDialog
				open={open}
				onOpenChange={setOpen}
				hasPlotProjects={hasPlotProjects}
				destination={destination}
			/>
		</>
	);
}

export function NewPlotDialog({
	open,
	onOpenChange,
	hasPlotProjects,
	destination = "/plots",
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	hasPlotProjects: { id: string; gitUrl: string }[];
	destination?: string;
}) {
	const navigate = useNavigate();
	const qc = useQueryClient();
	const [projectId, setProjectId] = useState("");
	const [name, setName] = useState("");
	const [intentGoal, setIntentGoal] = useState("");

	const create = useMutation({
		mutationFn: () => {
			const trimmedName = name.trim();
			const trimmedGoal = intentGoal.trim();
			return plotsApi.create({
				projectId,
				...(trimmedName.length > 0 ? { name: trimmedName } : {}),
				...(trimmedGoal.length > 0 ? { intent: { goal: trimmedGoal } } : {}),
			});
		},
		onSuccess: (plot) => {
			qc.invalidateQueries({ queryKey: ["plots"] });
			onOpenChange(false);
			setProjectId("");
			setName("");
			setIntentGoal("");
			navigate(`${destination}/${encodeURIComponent(plot.id)}`);
		},
	});

	const noEligible = hasPlotProjects.length === 0;
	const submittable = projectId.length > 0 && !create.isPending;

	const handleSubmit = (e: React.FormEvent): void => {
		e.preventDefault();
		if (!submittable) return;
		create.mutate();
	};

	return (
		<Dialog
			open={open}
			onOpenChange={(next) => {
				if (!next) create.reset();
				onOpenChange(next);
			}}
		>
			<DialogContent>
				<DialogHeader>
					<DialogTitle>New Plot</DialogTitle>
					<DialogDescription>
						Create a fresh Plot in a project with{" "}
						<code className="font-mono">.plot/</code> enabled.
					</DialogDescription>
				</DialogHeader>

				{noEligible ? (
					<p className="text-sm text-(--color-muted-foreground)">
						No Plot-enabled projects yet — run{" "}
						<code className="font-mono">plot init</code> in a project clone and
						refresh.
					</p>
				) : (
					<form onSubmit={handleSubmit} className="space-y-4">
						<div className="space-y-1.5">
							<Label htmlFor="plot-project">Project</Label>
							<select
								id="plot-project"
								required
								value={projectId}
								onChange={(e) => setProjectId(e.target.value)}
								className="flex h-9 w-full rounded-md border bg-(--color-card) px-3 py-1 text-sm shadow-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-(--color-ring)"
							>
								<option value="" disabled>
									Pick a Plot-enabled project…
								</option>
								{hasPlotProjects.map((p) => (
									<option key={p.id} value={p.id}>
										{p.gitUrl} ({p.id})
									</option>
								))}
							</select>
						</div>

						<div className="space-y-1.5">
							<Label htmlFor="plot-name">Name (optional)</Label>
							<Input
								id="plot-name"
								value={name}
								onChange={(e) => setName(e.target.value)}
								placeholder="Untitled Plot"
								autoComplete="off"
								spellCheck={false}
							/>
						</div>

						<div className="space-y-1.5">
							<Label htmlFor="plot-intent">Intent — goal (optional)</Label>
							<Textarea
								id="plot-intent"
								rows={4}
								value={intentGoal}
								onChange={(e) => setIntentGoal(e.target.value)}
								placeholder="One paragraph describing what this Plot is for…"
							/>
							<p className="text-xs text-(--color-muted-foreground)">
								Non-goals, constraints, and success criteria can be edited on
								the Plot detail page.
							</p>
						</div>

						{create.isError ? (
							<p className="text-sm text-(--color-destructive)">
								{create.error instanceof Error
									? create.error.message
									: String(create.error)}
							</p>
						) : null}

						<DialogFooter>
							<Button
								type="button"
								variant="outline"
								onClick={() => onOpenChange(false)}
								disabled={create.isPending}
							>
								Cancel
							</Button>
							<Button type="submit" disabled={!submittable}>
								{create.isPending ? "Creating…" : "Create Plot"}
							</Button>
						</DialogFooter>
					</form>
				)}
			</DialogContent>
		</Dialog>
	);
}
