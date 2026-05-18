import { useQuery } from "@tanstack/react-query";
import { Navigate } from "react-router-dom";
import { plotsApi, projectsApi } from "@/api/client.ts";

/**
 * Default landing route (warren-e59a / pl-9d6a step 19).
 *
 * Renders at the index Route inside the AuthGate slot. Decides where to
 * send the user on a fresh load:
 *
 *  - If at least one project has `hasPlot=true` AND `GET /plots` returns
 *    at least one Plot, redirect to `/plots`.
 *  - Otherwise redirect to `/runs` — preserves the CLAUDE.md standalone
 *    path where Plots are an opt-in built-in feature.
 *
 * Both queries reuse the cached `["projects"]` and `["plots", "all"]`
 * keys used by `Layout` and `PlotsPage` so tanstack-query dedupes the
 * fetch. `/plots` is only fired when at least one project is
 * Plot-enabled; on a vanilla install the second request never happens.
 */
export function DefaultLanding() {
	const projects = useQuery({
		queryKey: ["projects"],
		queryFn: ({ signal }) => projectsApi.list(signal),
		staleTime: 5000,
	});

	const anyHasPlot = (projects.data?.projects ?? []).some((p) => p.hasPlot);

	const plots = useQuery({
		queryKey: ["plots", "all"],
		queryFn: ({ signal }) => plotsApi.list({}, signal),
		enabled: anyHasPlot,
		staleTime: 5000,
	});

	// While `/projects` is in flight, render nothing — the redirect has
	// to wait on the gate. AuthGate already guarantees a token exists by
	// the time we get here, so this is purely the "decide where to send
	// them" window (typically <100ms against a warm cache).
	if (projects.isPending) return null;

	// No Plot-enabled projects → byte-identical to the pre-change path.
	if (!anyHasPlot) return <Navigate to="/runs" replace />;

	// Plot-enabled project exists but the Plots list is still loading —
	// don't flicker /runs in the meantime; wait one frame.
	if (plots.isPending) return null;

	const hasAnyPlot = (plots.data?.plots ?? []).length > 0;
	return <Navigate to={hasAnyPlot ? "/plots" : "/runs"} replace />;
}
