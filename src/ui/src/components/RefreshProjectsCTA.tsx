import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { RefreshCw } from "lucide-react";
import { projectsApi } from "@/api/client.ts";
import { Button } from "@/components/ui/button.tsx";
import { formatError } from "@/lib/format-error.ts";

/**
 * "Refresh projects to discover new Plots" CTA (warren-bb22).
 *
 * First dogfood-discovered Plot UX gap: Plots created via the `plot` CLI in
 * a project repo are silently invisible in the warren UI until project
 * refresh runs (detectProjectFeatures only flips `hasPlot` during refresh).
 * Surfaces an inline refresh affordance on /plots empty-state and
 * /plots/:id 404 — fans out `projectsApi.refresh(id)` across every
 * registered project in parallel, then invalidates the plot caches.
 */
export function RefreshProjectsCTA({ label }: { label?: string }) {
	const qc = useQueryClient();
	const projects = useQuery({
		queryKey: ["projects"],
		queryFn: ({ signal }) => projectsApi.list(signal),
	});

	const refreshAll = useMutation({
		mutationFn: async () => {
			const rows = projects.data?.projects ?? [];
			await Promise.all(rows.map((p) => projectsApi.refresh(p.id)));
		},
		onSuccess: () => {
			qc.invalidateQueries({ queryKey: ["projects"] });
			qc.invalidateQueries({ queryKey: ["plots"] });
			qc.invalidateQueries({ queryKey: ["plot"] });
		},
	});

	const projectCount = projects.data?.projects.length ?? 0;
	const disabled = refreshAll.isPending || projects.isLoading || projectCount === 0;

	return (
		<div className="flex flex-wrap items-center gap-3">
			<Button
				type="button"
				variant="outline"
				size="sm"
				onClick={() => refreshAll.mutate()}
				disabled={disabled}
			>
				<RefreshCw
					className={`mr-2 h-4 w-4 ${refreshAll.isPending ? "animate-spin" : ""}`}
				/>
				{label ?? "Refresh projects to discover new Plots"}
			</Button>
			{refreshAll.isError ? (
				<span className="text-xs text-(--color-destructive)">{formatError(refreshAll.error)}</span>
			) : null}
			{refreshAll.isSuccess ? (
				<span className="text-xs text-(--color-muted-foreground)">
					Refreshed {projectCount} project{projectCount === 1 ? "" : "s"}.
				</span>
			) : null}
		</div>
	);
}
