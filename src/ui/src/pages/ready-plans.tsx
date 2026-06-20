import { useQuery } from "@tanstack/react-query";
import { projectsApi } from "@/api/client.ts";
import type { ProjectRow, ReadyPlan } from "@/api/types.ts";
import { Alert } from "@/components/ui/alert.tsx";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card.tsx";
import { EmptyState } from "@/components/ui/empty-state.tsx";
import {
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from "@/components/ui/table.tsx";
import { Spinner } from "@/components/ui/spinner.tsx";
import { formatError } from "@/lib/format-error.ts";
import { DispatchPlanButton } from "./conversation-detail/dispatch-plan-dialog.tsx";

/**
 * "Ready to dispatch" tab body (warren-ce62 / pl-3fc4 step 7).
 *
 * Read-on-demand surface for the per-project `GET /projects/:id/ready-plans`
 * endpoint: approved plans with at least one open child seed that have not
 * already been dispatched. Each row offers a one-click Dispatch button that
 * opens the generalized DispatchPlanDialog pre-filled with the plan id +
 * project (and, when the project has `.plot/`, the plan id as the plot
 * back-link — the dialog omits an unbindable plot from the dispatch itself).
 *
 * The endpoint is per-project, so the operator must pick a project first;
 * with none selected we prompt rather than fetching.
 */
export function ReadyPlansView({
	projectId,
	project,
}: {
	projectId: string;
	project: ProjectRow | undefined;
}): JSX.Element {
	const hasProject = projectId.length > 0;
	const readyPlans = useQuery({
		queryKey: ["ready-plans", projectId],
		queryFn: ({ signal }) => projectsApi.readyPlans(projectId, signal),
		refetchInterval: 5000,
		enabled: hasProject,
	});

	if (!hasProject) {
		return (
			<Card>
				<CardContent className="p-0">
					<EmptyState
						title="Pick a project"
						description="Ready-to-dispatch plans are computed per project — choose one above to load its approved, undispatched plans."
					/>
				</CardContent>
			</Card>
		);
	}

	const plans = readyPlans.data?.plans ?? [];
	return (
		<Card>
			<CardHeader>
				<CardTitle>{plans.length} ready to dispatch</CardTitle>
			</CardHeader>
			<CardContent className="p-0">
				{readyPlans.isLoading ? (
					<div className="p-6">
						<Spinner label="Loading ready plans" />
					</div>
				) : readyPlans.isError ? (
					<div className="p-6">
						<Alert variant="danger" title="Failed to load ready plans">
							{formatError(readyPlans.error)}
						</Alert>
					</div>
				) : plans.length === 0 ? (
					<EmptyState
						title="No plans ready to dispatch"
						description="Approved plans with at least one open child that haven't been dispatched yet appear here."
					/>
				) : (
					<Table>
						<TableHeader>
							<TableRow>
								<TableHead className="whitespace-nowrap">Plan</TableHead>
								<TableHead>Name</TableHead>
								<TableHead className="whitespace-nowrap">Status</TableHead>
								<TableHead className="whitespace-nowrap">Open children</TableHead>
								<TableHead className="whitespace-nowrap text-right">Dispatch</TableHead>
							</TableRow>
						</TableHeader>
						<TableBody>
							{plans.map((plan) => (
								<ReadyPlanRow
									key={plan.id}
									plan={plan}
									projectId={projectId}
									hasPlot={project?.hasPlot ?? false}
								/>
							))}
						</TableBody>
					</Table>
				)}
			</CardContent>
		</Card>
	);
}

function ReadyPlanRow({
	plan,
	projectId,
	hasPlot,
}: {
	plan: ReadyPlan;
	projectId: string;
	hasPlot: boolean;
}): JSX.Element {
	return (
		<TableRow>
			<TableCell className="whitespace-nowrap font-mono text-xs">{plan.id}</TableCell>
			<TableCell>{plan.name ?? "—"}</TableCell>
			<TableCell className="whitespace-nowrap font-mono text-xs">{plan.status}</TableCell>
			<TableCell className="whitespace-nowrap font-mono text-xs text-(--color-muted-foreground)">
				{plan.openChildCount}
			</TableCell>
			<TableCell className="text-right">
				<DispatchPlanButton
					projectId={projectId}
					planId={plan.id}
					planIdLocked
					plotId={hasPlot ? plan.id : null}
				/>
			</TableCell>
		</TableRow>
	);
}
