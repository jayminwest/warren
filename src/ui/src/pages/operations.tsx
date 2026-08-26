import { ComingPage } from "@/components/console/coming-page.tsx";

/**
 * Operations — the Direction C index route (warren-4ed7 skeleton).
 * The real page (instance overview: capacity, services, operator
 * interventions, active workloads, recent control-plane events) lands
 * with warren-d903, behind the ops overview API (warren-d850).
 */
export function OperationsPage() {
	return (
		<ComingPage
			title="Operations"
			summary="Instance overview: control-plane service health, lifecycle snapshot, spend rate, delivery stats, and operator interventions."
			issueId="warren-d903"
		/>
	);
}
