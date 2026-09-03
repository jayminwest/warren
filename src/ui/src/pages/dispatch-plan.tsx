import { useMutation, useQueryClient } from "@tanstack/react-query";
import { RefreshCw } from "lucide-react";
import { projectsApi } from "@/api/client.ts";
import { OperatorOnly } from "@/components/operator-only.tsx";
import { WalkForm } from "./dispatch-plan/walk-form.tsx";
import { WalkManifest } from "./dispatch-plan/walk-manifest.tsx";
import { useWalkState } from "./dispatch-plan/walk-state.ts";

/**
 * Dispatch plan — the Direction C walk-definition page
 * (warren-02bb / pl-7e38 step 7), replacing the legacy new-plan-run
 * form. Left rail: target, agent runtime, children (plan source or
 * explicit ordered issue list), per-child guardrails, prompt template.
 * Right rail: the resolved walk manifest and admission policy, derived
 * from the same draft + real API data. Submit path is `POST
 * /plan-runs`, unchanged.
 *
 * Spectator safety lives at the route (`OperatorRoute` in app.tsx) —
 * this page is operator-only by construction because dispatch is a
 * mutation.
 */

export function DispatchPlanPage() {
	const s = useWalkState();
	const qc = useQueryClient();
	const refreshProject = useMutation({
		mutationFn: (id: string) => projectsApi.refresh(id),
		onSuccess: () => qc.invalidateQueries({ queryKey: ["projects"] }),
	});

	const hasSeeds = s.selectedProject?.hasSeeds ?? false;

	return (
		<div className="flex min-h-full flex-col gap-1.5 px-3.5 pt-5 pb-12 md:px-6">
			<p className="font-mono text-[10px] leading-3 text-(--color-text-3)">PLAN RUNS / NEW</p>
			<div className="flex flex-col gap-[5px] pb-[20px]">
				<h1 className="text-xl leading-6 font-semibold tracking-[-0.025em] text-(--color-text)">
					Dispatch plan
				</h1>
				<p className="max-w-prose text-[12px] leading-4 text-(--color-text-2)">
					Dispatch each child issue of a plan as its own run, in order.
				</p>
			</div>

			{s.noProjects ? (
				<p className="max-w-[760px] rounded-(--radius-sm) border border-(--color-border) bg-(--color-surface) p-3 text-[11px] leading-4 text-(--color-danger)">
					No projects added. Visit Projects to clone one from GitHub.
				</p>
			) : null}
			{s.noAgents && hasSeeds ? (
				<p className="max-w-[760px] rounded-(--radius-sm) border border-(--color-border) bg-(--color-surface) p-3 text-[11px] leading-4 text-(--color-danger)">
					No agents registered. Visit Agents and click Refresh registry.
				</p>
			) : null}
			{s.draft.project.length > 0 && !hasSeeds ? (
				<div className="flex max-w-[760px] flex-col gap-3 rounded-(--radius-sm) border border-(--color-border) bg-(--color-surface) p-3 text-[11px] leading-4 text-(--color-danger)">
					<p>
						Plan runs require <code className="font-mono">.seeds/</code>. The selected project has
						no <code className="font-mono">.seeds/</code> directory at the clone root. Add one and
						refresh the project to enable plan-run dispatch.
					</p>
					<div className="flex items-center gap-3">
						{/* `POST /projects/:id/refresh` is `admin`, a strictly
						    narrower grant than the `dispatch` this page is
						    route-guarded on (warren-f53e). */}
						<OperatorOnly capability="admin">
							<button
								type="button"
								onClick={() => refreshProject.mutate(s.draft.project)}
								disabled={refreshProject.isPending}
								className="flex h-[31px] items-center gap-2 rounded-(--radius-sm) border border-(--color-border-strong) bg-(--color-surface) px-[11px] text-[11px] font-medium leading-[14px] text-(--color-text-2) hover:bg-(--color-surface-hover) disabled:opacity-50"
							>
								<RefreshCw
									className={`h-3.5 w-3.5 ${refreshProject.isPending ? "animate-spin" : ""}`}
								/>
								Refresh project
							</button>
						</OperatorOnly>
						{refreshProject.isError ? (
							<span className="text-[11px]">
								{refreshProject.error instanceof Error
									? refreshProject.error.message
									: String(refreshProject.error)}
							</span>
						) : null}
					</div>
				</div>
			) : null}

			<div className="flex flex-col items-start gap-4 lg:flex-row">
				<WalkForm
					draft={s.draft}
					agents={s.agentRows}
					projects={s.projectRows}
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
					submitError={s.submitError}
					pending={s.pending}
					canSubmit={s.valid}
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
					onCancel={s.cancel}
					onSubmit={s.submit}
				/>
				<WalkManifest
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
					valid={s.valid}
				/>
			</div>
		</div>
	);
}
