import { Link } from "react-router-dom";
import { Alert } from "@/components/ui/alert.tsx";
import { Button } from "@/components/ui/button.tsx";
import { Kbd } from "@/components/ui/kbd.tsx";
import { PageHeader } from "@/components/ui/page-header.tsx";
import type { DispatchRouteState } from "./dispatch/dispatch-draft.ts";
import { DISPATCH_FORM_ID, DispatchForm } from "./dispatch/dispatch-form.tsx";
import { DispatchSummary } from "./dispatch/dispatch-summary.tsx";
import { useDispatchState } from "./dispatch/use-dispatch-state.ts";

/**
 * Dispatch — start one run (warren-bbe8; restyled in warren-9474).
 *
 * Left: the form (project, agent, task, limits). Right: "What will
 * happen", derived from the same draft plus real API data (`GET
 * /instance`, the project row, the project's `.warren/config.yaml`),
 * carrying the submit actions. Submit path is `POST /runs`, unchanged.
 *
 * Spectator safety lives at the route (`OperatorRoute` in app.tsx) — this
 * page is operator-only by construction because dispatch is a mutation.
 */

export type { DispatchRouteState } from "./dispatch/dispatch-draft.ts";

function RunLink({ id }: { id: string }) {
	return (
		<Link
			to={`/runs/${encodeURIComponent(id)}`}
			className="font-mono text-(--color-text-2) hover:text-(--color-text) hover:underline"
		>
			{id}
		</Link>
	);
}

/** Title, description and parent-run eyebrow for the four ways in. */
function headerCopy(state: DispatchRouteState) {
	if (state.continueFromRunId !== undefined) {
		return {
			title: "Follow up on a run",
			description:
				"The new run starts from the earlier run's pushed branch and gets your follow-up instructions.",
			eyebrow: (
				<>
					Follow-up to <RunLink id={state.continueFromRunId} />
				</>
			),
		};
	}
	if (state.rescueFromRunId !== undefined) {
		return {
			title: "Rescue a run",
			description: "The new run picks up the work warren saved from the earlier run.",
			eyebrow: (
				<>
					Rescue of <RunLink id={state.rescueFromRunId} />
				</>
			),
		};
	}
	if (state.cloneFromRunId !== undefined) {
		return {
			title: "Re-run from scratch",
			description: "Same setup as the earlier run, on a fresh clone of the project.",
			eyebrow: (
				<>
					Re-run of <RunLink id={state.cloneFromRunId} />
				</>
			),
		};
	}
	return {
		title: "Dispatch a run",
		description:
			"Point an agent at a project and a task. It works in an isolated workspace and pushes a branch.",
		eyebrow: undefined,
	};
}

export function DispatchPage() {
	const s = useDispatchState();
	const copy = headerCopy(s.initialState);
	const capsValid = s.costCapError === null && s.timeLimitError === null;
	const canSubmit = s.valid && capsValid && !s.pending;

	const actions = (
		<>
			{s.submitError ? (
				<Alert variant="danger" title="Dispatch failed">
					{s.submitError}
				</Alert>
			) : null}
			<Button
				type="submit"
				form={DISPATCH_FORM_ID}
				size="lg"
				className="h-11 w-full sm:h-10"
				disabled={!canSubmit}
			>
				{s.pending ? "Dispatching…" : "Dispatch run"}
				<Kbd className="hidden border-transparent bg-(--color-primary-ink)/15 text-(--color-primary-ink) sm:inline-flex">
					⌘↵
				</Kbd>
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
			<PageHeader title={copy.title} description={copy.description} eyebrow={copy.eyebrow} />

			{s.noProjects ? (
				<Alert variant="warning" title="No projects yet" className="max-w-3xl">
					Dispatch needs a project to work in.{" "}
					<Link to="/projects" className="font-medium underline underline-offset-2">
						Add one on Projects
					</Link>
					.
				</Alert>
			) : null}
			{s.noAgents ? (
				<Alert variant="warning" title="No agents available" className="max-w-3xl">
					Warren found no agents to dispatch.{" "}
					<Link to="/agents" className="font-medium underline underline-offset-2">
						Check Agents
					</Link>
					.
				</Alert>
			) : null}

			<div className="flex flex-col items-start gap-4 lg:flex-row">
				<DispatchForm
					agents={s.agentRows}
					projects={s.projectRows}
					projectsLoading={s.projectsLoading}
					agentsLoading={s.agentsLoading}
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
					timeLimit={s.draft.timeLimit}
					providerDefaultKind={s.providerDefaultKind}
					modelDefaultKind={s.modelDefaultKind}
					costCapError={s.costCapError}
					timeLimitError={s.timeLimitError}
					onAgent={s.setAgent}
					onProject={s.setProject}
					onRef={s.setRef}
					onSeedId={s.setSeedId}
					onPrompt={s.setPrompt}
					onProvider={s.setProvider}
					onModel={s.setModel}
					onCostCap={s.setCostCap}
					onTimeLimit={s.setTimeLimit}
					onSubmit={s.submit}
				/>
				<DispatchSummary
					project={s.selectedProject}
					gitRef={s.draft.ref}
					seedId={s.draft.seedId}
					agent={s.draft.agent}
					provider={s.draft.providerOverride.trim()}
					model={s.draft.modelOverride.trim()}
					costCap={s.draft.costCap}
					timeLimit={s.draft.timeLimit}
					runBranchPrefix={s.defaults?.runBranchPrefix}
					facts={s.facts}
					routeState={s.initialState}
					valid={s.valid && capsValid}
					actions={actions}
				/>
			</div>
		</div>
	);
}
