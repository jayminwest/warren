import { DispatchForm } from "./dispatch/dispatch-form.tsx";
import { ResolvedManifest } from "./dispatch/resolved-manifest.tsx";
import { useDispatchState } from "./dispatch/use-dispatch-state.ts";

/**
 * Dispatch — the Direction C workload-definition page
 * (warren-bbe8 / pl-7e38 step 5), replacing the legacy new-run form.
 *
 * Left rail: the intent (project, agent, prompt, overrides, guardrails).
 * Right rail: the resolved manifest and admission policy, derived from the
 * same draft + real API data (`GET /instance`, project row, project
 * `.warren/config.yaml`). Submit path is `POST /runs`, unchanged.
 *
 * Spectator safety lives at the route (`OperatorRoute` in app.tsx) — this
 * page is operator-only by construction because dispatch is a mutation.
 */

export type { DispatchRouteState } from "./dispatch/dispatch-draft.ts";

export function DispatchPage() {
	const s = useDispatchState();

	return (
		<div className="flex min-h-full flex-col gap-1.5 px-3.5 pt-5 pb-12 md:px-6">
			<p className="font-mono text-[10px] leading-3 text-(--color-text-3)">RUNS / NEW</p>
			<div className="flex flex-col gap-[5px] pb-[20px]">
				<h1 className="text-xl leading-6 font-semibold tracking-[-0.025em] text-(--color-text)">
					Dispatch run
				</h1>
				<p className="max-w-prose text-[12px] leading-4 text-(--color-text-2)">Start a run.</p>
				{s.initialState.continueFromRunId !== undefined ? (
					<p className="font-mono text-[10px] leading-3 text-(--color-text-3)">
						↪ CONTINUATION FROM {s.initialState.continueFromRunId}
					</p>
				) : null}
				{s.initialState.cloneFromRunId !== undefined ? (
					<p className="font-mono text-[10px] leading-3 text-(--color-text-3)">
						⟳ RE-RUN OF {s.initialState.cloneFromRunId}
					</p>
				) : null}
			</div>

			{s.noProjects ? (
				<p className="max-w-[760px] rounded-(--radius-sm) border border-(--color-border) bg-(--color-surface) p-3 text-[11px] leading-4 text-(--color-danger)">
					No projects added. Visit Projects to clone one from GitHub.
				</p>
			) : null}
			{s.noAgents ? (
				<p className="max-w-[760px] rounded-(--radius-sm) border border-(--color-border) bg-(--color-surface) p-3 text-[11px] leading-4 text-(--color-danger)">
					No agents registered. Visit Agents and click Refresh registry.
				</p>
			) : null}

			<div className="flex flex-col items-start gap-4 lg:flex-row">
				<DispatchForm
					agents={s.agentRows}
					projects={s.projectRows}
					agentDefaultFrom={s.agentDefaultFrom}
					selectedProject={s.selectedProject}
					agent={s.draft.agent}
					project={s.draft.project}
					gitRef={s.draft.ref}
					seedId={s.draft.seedId}
					prompt={s.draft.prompt}
					providerOverride={s.draft.providerOverride}
					modelOverride={s.draft.modelOverride}
					costCap={s.draft.costCap}
					providerDefaultKind={s.providerDefaultKind}
					modelDefaultKind={s.modelDefaultKind}
					costCapError={s.costCapError}
					submitError={s.submitError}
					pending={s.pending}
					onAgent={s.setAgent}
					onProject={s.setProject}
					onRef={s.setRef}
					onSeedId={s.setSeedId}
					onPrompt={s.setPrompt}
					onProvider={s.setProvider}
					onModel={s.setModel}
					onCostCap={s.setCostCap}
					onCancel={s.cancel}
					onSubmit={s.submit}
				/>
				<ResolvedManifest
					project={s.selectedProject}
					gitRef={s.draft.ref}
					seedId={s.draft.seedId}
					agent={s.draft.agent}
					provider={s.draft.providerOverride.trim()}
					model={s.draft.modelOverride.trim()}
					costCap={s.draft.costCap}
					runBranchPrefix={s.defaults?.runBranchPrefix}
					facts={s.facts}
					valid={s.valid}
				/>
			</div>
		</div>
	);
}
