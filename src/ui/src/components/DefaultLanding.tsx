import { useQuery } from "@tanstack/react-query";
import { Navigate } from "react-router-dom";
import { projectsApi } from "@/api/client.ts";

/**
 * Default landing route (warren-e59a / pl-9d6a step 19,
 * Plot-first home in warren-f0e2 / pl-0344 step 13).
 *
 * Renders at the index Route inside the AuthGate slot. Decides where
 * to send the user on a fresh load:
 *
 *  - If at least one project has `hasPlot=true`, redirect to `/plots`
 *    **unconditionally** — even when the list is empty, since the
 *    landing page itself surfaces the "New Plot" affordance for
 *    spinning the first one up.
 *  - Otherwise redirect to `/runs` — preserves the CLAUDE.md standalone
 *    path where Plots are an opt-in built-in feature.
 *
 * Reuses the cached `["projects"]` query key shared with `Layout` and
 * `PlotsPage` so tanstack-query dedupes the fetch.
 */
export function DefaultLanding() {
	const projects = useQuery({
		queryKey: ["projects"],
		queryFn: ({ signal }) => projectsApi.list(signal),
		staleTime: 5000,
	});

	// While `/projects` is in flight, render nothing — the redirect has
	// to wait on the gate. AuthGate already guarantees a token exists by
	// the time we get here, so this is purely the "decide where to send
	// them" window (typically <100ms against a warm cache).
	if (projects.isPending) return null;

	const anyHasPlot = (projects.data?.projects ?? []).some((p) => p.hasPlot);
	return <Navigate to={anyHasPlot ? "/plots" : "/runs"} replace />;
}
