import { useMutation, useQueryClient } from "@tanstack/react-query";
import { RefreshCw } from "lucide-react";
import { Link } from "react-router-dom";
import { projectsApi } from "@/api/client.ts";
import { OperatorOnly } from "@/components/operator-only.tsx";
import { Alert } from "@/components/ui/alert.tsx";
import { Button } from "@/components/ui/button.tsx";
import { PageHeader } from "@/components/ui/page-header.tsx";
import { formatError } from "@/lib/format-error.ts";
import { cn } from "@/lib/utils.ts";
import { WALK_FORM_ID, WalkForm } from "./dispatch-plan/walk-form.tsx";
import { useWalkState } from "./dispatch-plan/walk-state.ts";
import { WalkSummary } from "./dispatch-plan/walk-summary.tsx";

/**
 * Dispatch plan — walk a plan's steps one run at a time (warren-02bb;
 * restyled in warren-9474). Left: target, steps (a seeds plan or an
 * explicit ordered issue list), agent, per-step limits, prompt template.
 * Right: "What will happen", derived from the same draft plus real API
 * data, carrying the submit actions. Submit path is `POST /plan-runs`,
 * unchanged.
 *
 * Spectator safety lives at the route (`OperatorRoute` in app.tsx) —
 * this page is operator-only by construction because dispatch is a
 * mutation.
 */

function NoTrackerAlert({ projectId }: { projectId: string }) {
	const qc = useQueryClient();
	const refreshProject = useMutation({
		mutationFn: (id: string) => projectsApi.refresh(id),
		onSuccess: () => qc.invalidateQueries({ queryKey: ["projects"] }),
	});
	return (
		<Alert variant="warning" title="This project has no issue tracker" className="max-w-3xl">
			<p>
				Plan runs walk a seeds plan, so the project needs a{" "}
				<code className="font-mono">.seeds/</code> directory at its root. Add one, then refresh the
				project.
			</p>
			{/* `POST /projects/:id/refresh` is `admin`, a strictly narrower
			    grant than the `dispatch` this page is route-guarded on
			    (warren-f53e). */}
			<OperatorOnly capability="admin">
				<div className="mt-2.5 flex flex-wrap items-center gap-3">
					<Button
						type="button"
						variant="outline"
						size="sm"
						onClick={() => refreshProject.mutate(projectId)}
						disabled={refreshProject.isPending}
					>
						<RefreshCw className={cn(refreshProject.isPending && "animate-spin")} />
						Refresh project
					</Button>
					{refreshProject.isError ? (
						<span className="text-xs text-(--color-danger)">
							Refresh failed: {formatError(refreshProject.error)}
						</span>
					) : null}
				</div>
			</OperatorOnly>
		</Alert>
	);
}

export function DispatchPlanPage() {
	const s = useWalkState();
	const hasSeeds = s.selectedProject?.hasSeeds ?? false;

	const actions = (
		<>
			{s.submitError ? (
				<Alert variant="danger" title="Dispatch failed">
					{s.submitError}
				</Alert>
			) : null}
			<Button
				type="submit"
				form={WALK_FORM_ID}
				size="lg"
				className="h-11 w-full sm:h-10"
				disabled={!s.valid || s.pending}
			>
				{s.pending ? "Dispatching…" : "Start plan run"}
			</Button>
			<Button
				type="button"
				variant="ghost"
				className="h-11 w-full sm:h-8"
				onClick={s.cancel}
				disabled={s.pending}
			>
				Cancel
			</Button>
		</>
	);

	return (
		<div className="flex min-h-full flex-col gap-6 px-3.5 pt-5 pb-12 md:px-6">
			<PageHeader
				title="Dispatch a plan"
				description="Warren works the plan's issues in order, one run each, and waits for each pull request to merge before starting the next."
			/>

			{s.noProjects ? (
				<Alert variant="warning" title="No projects yet" className="max-w-3xl">
					Plan runs need a project with an issue tracker.{" "}
					<Link to="/projects" className="font-medium underline underline-offset-2">
						Add one on Projects
					</Link>
					.
				</Alert>
			) : null}
			{s.noAgents && hasSeeds ? (
				<Alert variant="warning" title="No agents available" className="max-w-3xl">
					Warren found no agents to dispatch.{" "}
					<Link to="/agents" className="font-medium underline underline-offset-2">
						Check Agents
					</Link>
					.
				</Alert>
			) : null}
			{s.draft.project.length > 0 && s.selectedProject !== undefined && !hasSeeds ? (
				<NoTrackerAlert projectId={s.draft.project} />
			) : null}

			<div className="flex flex-col items-start gap-4 lg:flex-row">
				<WalkForm
					draft={s.draft}
					agents={s.agentRows}
					projects={s.projectRows}
					projectsLoading={s.projectsLoading}
					agentsLoading={s.agentsLoading}
					plansLoading={s.plansLoading}
					selectedProject={s.selectedProject}
					hasSeeds={hasSeeds}
					agentDefaultFrom={s.agentDefaultFrom}
					providerDefaultKind={s.providerDefaultKind}
					modelDefaultKind={s.modelDefaultKind}
					planOptions={s.planOptions}
					planSelectorUnavailable={s.planSelectorUnavailable}
					openChildCount={s.openChildCount}
					issueStatuses={s.issueStatuses}
					costCapError={s.costCapError}
					onProject={s.setProject}
					onRef={s.setRef}
					onPlanId={s.setPlanId}
					onPlanIdManual={s.setPlanIdManual}
					onIssuesText={s.setIssuesText}
					onSourceMode={s.setSourceMode}
					onAgent={s.setAgent}
					onProvider={s.setProvider}
					onModel={s.setModel}
					onPrompt={s.setPrompt}
					onCostCap={s.setCostCap}
					onSubmit={s.submit}
				/>
				<WalkSummary
					input={{
						project: s.selectedProject,
						ref: s.draft.ref,
						agent: s.draft.agent,
						provider: s.draft.providerOverride.trim(),
						model: s.draft.modelOverride.trim(),
						costCap: s.draft.costCap,
						planId: s.draft.planId,
						issuesText: s.draft.issuesText,
						sourceMode: s.draft.sourceMode,
						runtime: s.facts?.runtime,
					}}
					project={s.selectedProject}
					facts={s.facts}
					openChildCount={s.openChildCount}
					valid={s.valid}
					actions={actions}
				/>
			</div>
		</div>
	);
}
