import { useQuery } from "@tanstack/react-query";
import { Navigate, useParams } from "react-router-dom";
import { conversationsApi } from "@/api/client.ts";

/**
 * Legacy `/plots/:id` → `/workspace/:id` (warren-9cad / pl-0008 step 11).
 * The Plot is the durable spine of the Workspace surface, so the old
 * Plot-detail deep link maps straight onto the Workspace detail route,
 * preserving the id path parameter.
 */
export function PlotToWorkspaceRedirect() {
	const { id } = useParams<{ id: string }>();
	if (!id) return <Navigate to="/workspace" replace />;
	return <Navigate to={`/workspace/${encodeURIComponent(id)}`} replace />;
}

/**
 * Legacy `/leveret/:id` → `/workspace/:plotId?tab=shape` (warren-9cad).
 * The old conversation route is keyed by conversation id; the Workspace
 * surface is keyed by Plot. Resolve the conversation's owning Plot, then
 * land on its Shape tab (the conversation facet). While the lookup is in
 * flight we render a minimal placeholder; if it fails — or the
 * conversation has no Plot — we fall back to the Workspace list.
 */
export function ConversationToWorkspaceRedirect() {
	const { id } = useParams<{ id: string }>();
	const query = useQuery({
		queryKey: ["conversation", id],
		queryFn: ({ signal }) => conversationsApi.get(id as string, signal),
		enabled: Boolean(id),
		retry: false,
	});
	if (!id) return <Navigate to="/workspace" replace />;
	if (query.isPending) {
		return <div className="p-4 text-sm text-(--color-muted-foreground)">Opening workspace…</div>;
	}
	const plotId = query.data?.conversation.plotId ?? null;
	if (!plotId) return <Navigate to="/workspace" replace />;
	return <Navigate to={`/workspace/${encodeURIComponent(plotId)}?tab=shape`} replace />;
}
