import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { ApiError, plotsApi } from "@/api/client.ts";
import { PlotStatusBadge } from "@/components/PlotStatusBadge.tsx";

/**
 * Renders the *inner* content of a "Plot" MetaCard for run / plan-run
 * detail pages (warren-37fd / pl-9d6a step 17). Wraps a tanstack-query
 * call to `plotsApi.get(plotId)` so the link can degrade gracefully:
 *
 * - while loading: plain `plotId` in the link (no flash of empty state)
 * - on 404: render "Plot no longer available — <plotId>" muted text
 *   with no link, covering the case where `plan_runs.plot_id` /
 *   `runs.plot_id` still references a Plot that was archived or
 *   deleted from the workspace (warren-37fd)
 * - on other errors: fall back to a working link with the bare id
 *   (best-effort — the Plot detail page surfaces the real error)
 * - on success: render `{plot.name}` as the link text plus a status
 *   badge, with the `plotId` as a title attribute for debugging
 *
 * Polls every 30s in case the Plot is created/archived under us; uses
 * the same `["plot", plotId]` cache key as PlotDetail so a fresh GET
 * is shared when the user clicks through.
 *
 * Lives in src/ui/src/components/ rather than being inlined on
 * PlanRunDetail / RunDetail because both pages render the exact same
 * MetaCard contents — keeping it shared means the 404 fallback can't
 * skew between them.
 */
export function PlotMetaCardContent({ plotId }: { plotId: string }) {
	const q = useQuery({
		queryKey: ["plot", plotId],
		queryFn: ({ signal }) => plotsApi.get(plotId, signal),
		enabled: plotId.length > 0,
		// Don't bang on a missing Plot — 404 is a terminal "no longer
		// available" signal until something external changes.
		retry: (failureCount, err) => {
			if (err instanceof ApiError && err.status === 404) return false;
			return failureCount < 2;
		},
		staleTime: 30_000,
		refetchInterval: 30_000,
	});

	if (q.isError && q.error instanceof ApiError && q.error.status === 404) {
		return (
			<div className="space-y-1">
				<span
					className="text-(--color-muted-foreground) italic"
					title={`Plot ${plotId} no longer available — archived or deleted from the workspace`}
				>
					Plot no longer available
				</span>
				<div className="font-mono text-xs text-(--color-muted-foreground)">
					{plotId}
				</div>
			</div>
		);
	}

	const plot = q.data;
	return (
		<div className="space-y-1">
			<Link
				to={`/plots/${encodeURIComponent(plotId)}`}
				className="underline-offset-2 hover:underline"
				title={plotId}
			>
				{plot?.name ?? plotId}
			</Link>
			{plot !== undefined ? (
				<div className="flex items-center gap-2">
					<PlotStatusBadge status={plot.status} />
					<span className="font-mono text-xs text-(--color-muted-foreground)">
						{plotId}
					</span>
				</div>
			) : null}
		</div>
	);
}
