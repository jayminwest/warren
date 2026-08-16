import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { RefreshCw } from "lucide-react";
import { projectsApi } from "@/api/client.ts";
import { Button } from "@/components/ui/button.tsx";
import { formatError } from "@/lib/format-error.ts";

/**
 * "Refresh projects" CTA (warren-bb22).
 *
 * Fans `projectsApi.refresh(id)` out across every registered project in
 * parallel, then invalidates the projects cache. `POST
 * /projects/:id/refresh` is what re-probes each clone's feature flags
 * (`hasSeeds`) and moves `lastHeadSha`, so this is the one-click way to
 * pick up a change made in the project repo without visiting each row.
 *
 * Retitled in warren-f53e / pl-b82d step 19: the label and the two dead
 * cache invalidations it carried named a coordination surface deleted back
 * in pl-3a79. `POST /projects/:id/refresh` is `admin` — callers gate it.
 */
export function RefreshProjectsCTA() {
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
				<RefreshCw className={`mr-2 h-4 w-4 ${refreshAll.isPending ? "animate-spin" : ""}`} />
				Refresh all
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
