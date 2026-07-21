import { Navigate, useParams } from "react-router-dom";

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
