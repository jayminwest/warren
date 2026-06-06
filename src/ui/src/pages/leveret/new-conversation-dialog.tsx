import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState, useMemo } from "react";
import { useNavigate } from "react-router-dom";
import { conversationsApi, plotsApi, projectsApi, ApiError } from "@/api/client.ts";
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

export function NewConversationButton(): JSX.Element {
	const [open, setOpen] = useState(false);
	return (
		<>
			<Button type="button" size="sm" onClick={() => setOpen(true)}>
				New conversation
			</Button>
			{open ? (
				<NewConversationDialog onOpenChange={setOpen} />
			) : null}
		</>
	);
}

interface NewConversationDialogProps {
	onOpenChange: (open: boolean) => void;
}

export function NewConversationDialog({ onOpenChange }: NewConversationDialogProps): JSX.Element {
	const navigate = useNavigate();
	const qc = useQueryClient();

	const [projectId, setProjectId] = useState("");
	const [plotMode, setPlotMode] = useState<"auto-create" | "attach">("auto-create");
	const [selectedPlotId, setSelectedPlotId] = useState("");
	const [title, setTitle] = useState("");
	const [message, setMessage] = useState("");

	const projects = useQuery({
		queryKey: ["projects"],
		queryFn: ({ signal }) => projectsApi.list(signal),
	});

	const plots = useQuery({
		queryKey: ["plots"],
		queryFn: ({ signal }) => plotsApi.list({}, signal),
	});

	const selectedProject = projects.data?.projects.find((p) => p.id === projectId);
	const hasPlot = selectedProject?.hasPlot ?? false;

	// Reset auto-create mode if project lacks plot capability
	useEffect(() => {
		if (selectedProject && !hasPlot && plotMode === "auto-create") {
			setPlotMode("attach");
		}
	}, [projectId, selectedProject, hasPlot, plotMode]);

	const filteredPlots = useMemo(() => {
		if (!projectId) return [];
		return (plots.data?.plots ?? []).filter((plot) => plot.project_id === projectId);
	}, [plots.data, projectId]);

	const createMutation = useMutation({
		mutationFn: (input: {
			projectId: string;
			plotId?: string;
			title?: string;
			message?: string;
		}) => conversationsApi.create(input),
		onSuccess: (data) => {
			qc.invalidateQueries({ queryKey: ["conversations"] });
			navigate(`/leveret/${encodeURIComponent(data.conversation.id)}`);
			onOpenChange(false);
		},
	});

	const submittable =
		!createMutation.isPending &&
		projectId !== "" &&
		(plotMode === "auto-create"
			? hasPlot
			: selectedPlotId !== "" && filteredPlots.some((p) => p.id === selectedPlotId));

	const handleSubmit = (e: React.FormEvent): void => {
		e.preventDefault();
		if (!submittable) return;

		createMutation.mutate({
			projectId,
			...(plotMode === "attach" ? { plotId: selectedPlotId } : {}),
			...(title.trim() !== "" ? { title: title.trim() } : {}),
			...(message.trim() !== "" ? { message: message.trim() } : {}),
		});
	};

	const loading = projects.isLoading || plots.isLoading;

	const errorMessage = ((): string | null => {
		if (createMutation.error === null || createMutation.error === undefined) return null;
		if (createMutation.error instanceof ApiError) {
			return `${createMutation.error.message} (${createMutation.error.code})`;
		}
		return createMutation.error instanceof Error
			? createMutation.error.message
			: String(createMutation.error);
	})();

	return (
		<Dialog
			open={true}
			onOpenChange={(next) => {
				if (!next) createMutation.reset();
				onOpenChange(next);
			}}
		>
			<DialogContent className="max-w-xl">
				<DialogHeader>
					<DialogTitle>New conversation</DialogTitle>
					<DialogDescription>
						Start a fresh Leveret conversation to shape intent and requirements before driving agent plans.
					</DialogDescription>
				</DialogHeader>

				<form onSubmit={handleSubmit} className="space-y-4">
					<div className="space-y-1.5">
						<Label htmlFor="new-conv-project">Project</Label>
						<select
							id="new-conv-project"
							required
							value={projectId}
							onChange={(e) => {
								setProjectId(e.target.value);
								setSelectedPlotId("");
							}}
							disabled={createMutation.isPending}
							className="flex h-9 w-full rounded-md border bg-(--color-card) px-3 py-1 text-sm shadow-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-(--color-ring) disabled:cursor-not-allowed disabled:opacity-60"
						>
							<option value="" disabled>
								Pick a project…
							</option>
							{projects.data?.projects.map((p) => (
								<option key={p.id} value={p.id}>
									{p.gitUrl || p.id}
								</option>
							))}
						</select>
					</div>

					{projectId !== "" && (
						<div className="space-y-3">
							<div className="space-y-1.5">
								<Label>Plot mode</Label>
								<div className="flex gap-6 mt-1">
									<label className="flex items-center gap-2 text-sm font-medium cursor-pointer disabled:opacity-50">
										<input
											type="radio"
											name="plotMode"
											value="auto-create"
											checked={plotMode === "auto-create"}
											onChange={() => setPlotMode("auto-create")}
											disabled={!hasPlot || createMutation.isPending}
											className="h-4 w-4 border-gray-300 text-primary focus:ring-primary disabled:opacity-50 disabled:cursor-not-allowed"
										/>
										<span className={!hasPlot ? "text-(--color-muted-foreground) cursor-not-allowed" : ""}>
											Auto-create fresh Plot
										</span>
									</label>
									<label className="flex items-center gap-2 text-sm font-medium cursor-pointer">
										<input
											type="radio"
											name="plotMode"
											value="attach"
											checked={plotMode === "attach"}
											onChange={() => setPlotMode("attach")}
											disabled={createMutation.isPending}
											className="h-4 w-4 border-gray-300 text-primary focus:ring-primary"
										/>
										<span>Attach existing Plot</span>
									</label>
								</div>
								{selectedProject && !hasPlot && (
									<p className="text-xs text-(--color-destructive) mt-1">
										This project has no <code className="font-mono">.plot/</code> directory; cannot auto-create a Plot.
										Run <code className="font-mono">plot init</code> in the project clone and refresh, or attach an existing Plot.
									</p>
								)}
							</div>

							{plotMode === "attach" && (
								<div className="space-y-1.5">
									<Label htmlFor="new-conv-plot">Plot</Label>
									<select
										id="new-conv-plot"
										required
										value={selectedPlotId}
										onChange={(e) => setSelectedPlotId(e.target.value)}
										disabled={createMutation.isPending}
										className="flex h-9 w-full rounded-md border bg-(--color-card) px-3 py-1 text-sm shadow-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-(--color-ring) disabled:cursor-not-allowed disabled:opacity-60"
									>
										<option value="" disabled>
											Select a Plot to attach…
										</option>
										{filteredPlots.map((plot) => (
											<option key={plot.id} value={plot.id}>
												{plot.id} ({plot.name || "Unnamed"})
											</option>
										))}
									</select>
									{filteredPlots.length === 0 && !loading && (
										<p className="text-xs text-(--color-muted-foreground)">
											No existing Plots found for this project.
										</p>
									)}
								</div>
							)}
						</div>
					)}

					<div className="space-y-1.5">
						<Label htmlFor="new-conv-title">Title (optional)</Label>
						<Input
							id="new-conv-title"
							value={title}
							onChange={(e) => setTitle(e.target.value)}
							placeholder="e.g. Design search interface"
							disabled={createMutation.isPending}
							autoComplete="off"
							spellCheck={false}
							className="h-9 text-sm"
						/>
					</div>

					<div className="space-y-1.5">
						<Label htmlFor="new-conv-message">Opening message (optional)</Label>
						<Textarea
							id="new-conv-message"
							rows={3}
							value={message}
							onChange={(e) => setMessage(e.target.value)}
							placeholder="Describe the overall goals, non-goals, or constraints…"
							disabled={createMutation.isPending}
							className="text-sm"
						/>
					</div>

					{errorMessage !== null ? (
						<p className="text-sm text-(--color-destructive)">{errorMessage}</p>
					) : null}

					<DialogFooter className="pt-2">
						<Button
							type="button"
							variant="outline"
							onClick={() => onOpenChange(false)}
							disabled={createMutation.isPending}
						>
							Cancel
						</Button>
						<Button type="submit" disabled={!submittable}>
							{createMutation.isPending ? "Creating…" : "Create"}
						</Button>
					</DialogFooter>
				</form>
			</DialogContent>
		</Dialog>
	);
}
