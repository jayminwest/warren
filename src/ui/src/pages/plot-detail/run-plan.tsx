import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { agentsApi, ApiError, plotsApi, projectsApi } from "@/api/client.ts";
import type { PlotAttachment } from "@/api/types.ts";
import { Button } from "@/components/ui/button.tsx";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog.tsx";
import { Label } from "@/components/ui/label.tsx";
import { Textarea } from "@/components/ui/textarea.tsx";

/**
 * Per-sd_plan-attachment actions: "Run plan" dispatches a plan-run via
 * POST /plan-runs (warren-5d94); "Dispatch as plan-run" (warren-bce0 /
 * pl-f404 step 4 / SPEC §11.Q) is the recommended path over the
 * batch-dispatch button when you want a single coordinated plan-run.
 *
 * `ReadOnlyField` lives here because the dispatch dialogs were the
 * first consumers; it's re-exported for batch-dispatch (which also
 * renders confirm dialogs over read-only facts).
 */

/* ----------------------------------------------------------------------- */
/* RunPlanButton (warren-5d94)                                              */
/* ----------------------------------------------------------------------- */

const DEFAULT_PROMPT_TEMPLATE = "work on sd {seed_id}";

/**
 * Per-attachment "Run plan" action. Visible only when the row is an
 * sd_plan attachment (see isSdPlanAttachment). Clicking opens a
 * confirm dialog showing the read-only triple (plan ref, project,
 * auto-filled plot_id) and the resolved agent + default prompt
 * template; confirm POSTs to `/plan-runs` via `plotsApi.dispatchPlanRun`.
 * On success the user is routed to `/plan-runs/:id`, which closes the
 * loop back to this Plot via PlanRunDetail's existing back-link
 * (mx-757be9 / warren-37fd).
 */
export function RunPlanButton({
	plotId,
	projectId,
	planRef,
}: {
	plotId: string;
	projectId: string;
	planRef: string;
}) {
	const [open, setOpen] = useState(false);
	return (
		<>
			<Button type="button" size="sm" onClick={() => setOpen(true)}>
				Run plan
			</Button>
			{open ? (
				<RunPlanDialog
					plotId={plotId}
					projectId={projectId}
					planRef={planRef}
					onOpenChange={setOpen}
				/>
			) : null}
		</>
	);
}

function RunPlanDialog({
	plotId,
	projectId,
	planRef,
	onOpenChange,
}: {
	plotId: string;
	projectId: string;
	planRef: string;
	onOpenChange: (open: boolean) => void;
}) {
	const navigate = useNavigate();
	const qc = useQueryClient();

	// Editable prompt template (warren-6e4c / pl-f666 step 1). Mirrors
	// NewPlanRun.tsx ~line 300-320 so dispatching from a Plot has the
	// same expressivity as the dedicated /plan-runs/new page. State
	// resets on close because RunPlanButton unmounts this dialog.
	const [promptTemplate, setPromptTemplate] = useState(DEFAULT_PROMPT_TEMPLATE);
	const [promptTouched, setPromptTouched] = useState(false);
	const trimmedPrompt = promptTemplate.trim();

	// Resolve project defaults + agent registry to fill in the dispatch
	// inputs the user can't see on PlotDetail. This mirrors NewPlanRun's
	// defaults flow (mx-4c064b / mx-be04a6) so dispatching from a Plot
	// uses the same auto-filled provider/model/agent the dedicated
	// NewPlanRun page would have used.
	const projects = useQuery({
		queryKey: ["projects"],
		queryFn: ({ signal }) => projectsApi.list(signal),
	});
	const warrenConfig = useQuery({
		queryKey: ["projects", projectId, "warren-config"],
		queryFn: ({ signal }) => projectsApi.warrenConfig(projectId, signal),
	});
	const agents = useQuery({
		queryKey: ["agents", { projectId }],
		queryFn: ({ signal }) => agentsApi.list({ projectId }, signal),
	});

	const project = projects.data?.projects.find((p) => p.id === projectId);
	const defaults = warrenConfig.data?.defaults ?? null;
	const defaultRole = defaults?.defaultRole;
	const registered = agents.data?.agents ?? [];
	const defaultRoleRegistered =
		defaultRole !== undefined && registered.some((a) => a.name === defaultRole);
	const resolvedAgent = defaultRoleRegistered ? (defaultRole as string) : null;

	const dispatch = useMutation({
		mutationFn: () => {
			if (resolvedAgent === null) {
				throw new Error(
					"No default agent resolved — set `defaults.defaultRole` in `.warren/defaults.yaml` and register the agent.",
				);
			}
			if (trimmedPrompt.length === 0) {
				throw new Error("Prompt template must not be empty.");
			}
			const provider = defaults?.defaultProvider;
			const model = defaults?.defaultModel;
			return plotsApi.dispatchPlanRun({
				project: projectId,
				planId: planRef,
				agent: resolvedAgent,
				promptTemplate: trimmedPrompt,
				plotId,
				...(provider !== undefined && provider.length > 0
					? { providerOverride: provider }
					: {}),
				...(model !== undefined && model.length > 0
					? { modelOverride: model }
					: {}),
			});
		},
		onSuccess: (data) => {
			qc.invalidateQueries({ queryKey: ["plan-runs"] });
			qc.invalidateQueries({ queryKey: ["plot", plotId] });
			navigate(`/plan-runs/${encodeURIComponent(data.planRun.id)}`);
		},
	});

	const loading = projects.isLoading || warrenConfig.isLoading || agents.isLoading;
	const hasSeeds = project?.hasSeeds ?? false;
	const readyToDispatch =
		!loading &&
		hasSeeds &&
		resolvedAgent !== null &&
		trimmedPrompt.length > 0 &&
		!dispatch.isPending;

	const errorMessage = ((): string | null => {
		if (dispatch.error === null || dispatch.error === undefined) return null;
		if (dispatch.error instanceof ApiError) {
			return `${dispatch.error.message} (${dispatch.error.code})`;
		}
		return dispatch.error instanceof Error
			? dispatch.error.message
			: String(dispatch.error);
	})();

	return (
		<Dialog
			open={true}
			onOpenChange={(next) => {
				if (!next) dispatch.reset();
				onOpenChange(next);
			}}
		>
			<DialogContent>
				<DialogHeader>
					<DialogTitle>Run plan</DialogTitle>
					<DialogDescription>
						Dispatch a plan run bound to this Plot. Each child seed in
						the plan is dispatched as its own warren run; the Plot
						auto-transitions to <code className="font-mono">done</code>{" "}
						when every child merges.
					</DialogDescription>
				</DialogHeader>

				<div className="space-y-3 text-sm">
					<ReadOnlyField label="Plan" value={planRef} />
					<ReadOnlyField
						label="Project"
						value={project?.gitUrl ?? projectId}
						hint={project?.gitUrl !== undefined ? projectId : undefined}
					/>
					<ReadOnlyField label="Plot" value={plotId} />
					<ReadOnlyField
						label="Agent"
						value={
							loading
								? "resolving…"
								: (resolvedAgent ?? "(no default agent set)")
						}
					/>
					<div className="space-y-1.5">
						<Label htmlFor="plot-run-plan-promptTemplate">
							Prompt template
						</Label>
						<Textarea
							id="plot-run-plan-promptTemplate"
							required
							rows={3}
							value={promptTemplate}
							onChange={(e) => {
								setPromptTemplate(e.target.value);
								setPromptTouched(true);
							}}
							disabled={!hasSeeds || dispatch.isPending}
							placeholder={DEFAULT_PROMPT_TEMPLATE}
							className="text-base sm:text-sm"
						/>
						<p className="text-xs text-(--color-muted-foreground)">
							<code className="font-mono">{"{seed_id}"}</code> is
							substituted per child.
							{!promptTouched && promptTemplate === DEFAULT_PROMPT_TEMPLATE
								? " Default."
								: ""}
						</p>
					</div>
				</div>

				{!loading && !hasSeeds ? (
					<p className="text-sm text-(--color-destructive)">
						Plan runs require <code className="font-mono">.seeds/</code>{" "}
						at the project root. This project has none — add one and
						refresh.
					</p>
				) : null}
				{!loading && hasSeeds && resolvedAgent === null ? (
					<p className="text-sm text-(--color-destructive)">
						No default agent resolved. Set{" "}
						<code className="font-mono">defaults.defaultRole</code> in{" "}
						<code className="font-mono">.warren/defaults.yaml</code> and
						register the agent, or dispatch from{" "}
						<Link
							to="/plan-runs/new"
							className="underline-offset-2 hover:underline"
						>
							/plan-runs/new
						</Link>{" "}
						with the agent picker.
					</p>
				) : null}
				{errorMessage !== null ? (
					<p className="text-sm text-(--color-destructive)">{errorMessage}</p>
				) : null}

				<DialogFooter>
					<Button
						type="button"
						variant="outline"
						onClick={() => onOpenChange(false)}
						disabled={dispatch.isPending}
					>
						Cancel
					</Button>
					<Button
						type="button"
						disabled={!readyToDispatch}
						onClick={() => dispatch.mutate()}
					>
						{dispatch.isPending ? "Dispatching…" : "Dispatch"}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}

export function ReadOnlyField({
	label,
	value,
	hint,
}: {
	label: string;
	value: string;
	hint?: string;
}) {
	return (
		<div className="space-y-0.5">
			<div className="text-xs font-medium uppercase tracking-wide text-(--color-muted-foreground)">
				{label}
			</div>
			<div className="break-all font-mono text-sm">{value}</div>
			{hint !== undefined ? (
				<div className="text-xs text-(--color-muted-foreground)">{hint}</div>
			) : null}
		</div>
	);
}

/* ----------------------------------------------------------------------- */
/* DispatchAsPlanRunButton (warren-bce0 / pl-f404 step 4 / SPEC §11.Q)      */
/* ----------------------------------------------------------------------- */

/**
 * Synthesized plan-title preview shown in the confirm dialog. Mirrors
 * the server-side synthesizer's title (see src/plot-plan-runs/
 * synthesizer.ts) so the operator sees the exact name that will land in
 * `.seeds/plans.jsonl`.
 */
function synthesizedPlanTitle(plotId: string): string {
	return `Plot ${plotId} synthesized plan-run`;
}

/**
 * Per-Plot "Dispatch as plan-run" header action (warren-bce0 /
 * pl-f404 step 4). Recommended path over `BatchDispatchAllButton`
 * (warren-7c3f) once SPEC §11.Q ships: instead of N parallel `POST
 * /runs`, this synthesizes a seeds plan from the Plot's open
 * `seeds_issue` attachments and dispatches it through the §11.P
 * coordinator — one tracked PlanRun row, PR-merge-serial gating, and
 * the auto-`done` Plot transition inherited for free. Eligibility is
 * the same `isBatchDispatchTarget` filter the batch button uses; the
 * confirm dialog lists the candidates (server-side will further drop
 * any closed seeds at synthesis time).
 */
export function DispatchAsPlanRunButton({
	plotId,
	projectId,
	targets,
}: {
	plotId: string;
	projectId: string;
	targets: readonly PlotAttachment[];
}) {
	const [open, setOpen] = useState(false);
	return (
		<>
			<Button type="button" size="sm" onClick={() => setOpen(true)}>
				Dispatch as plan-run ({targets.length})
			</Button>
			{open ? (
				<DispatchAsPlanRunDialog
					plotId={plotId}
					projectId={projectId}
					targets={targets}
					onOpenChange={setOpen}
				/>
			) : null}
		</>
	);
}

function DispatchAsPlanRunDialog({
	plotId,
	projectId,
	targets,
	onOpenChange,
}: {
	plotId: string;
	projectId: string;
	targets: readonly PlotAttachment[];
	onOpenChange: (open: boolean) => void;
}) {
	const navigate = useNavigate();
	const qc = useQueryClient();

	// Same defaults/agent resolution as RunPlanDialog (mx-4c064b /
	// mx-be04a6) so dispatching from a Plot uses the project's
	// configured agent + provider/model overrides without bouncing
	// through /plan-runs/new.
	const projects = useQuery({
		queryKey: ["projects"],
		queryFn: ({ signal }) => projectsApi.list(signal),
	});
	const warrenConfig = useQuery({
		queryKey: ["projects", projectId, "warren-config"],
		queryFn: ({ signal }) => projectsApi.warrenConfig(projectId, signal),
	});
	const agents = useQuery({
		queryKey: ["agents", { projectId }],
		queryFn: ({ signal }) => agentsApi.list({ projectId }, signal),
	});

	const project = projects.data?.projects.find((p) => p.id === projectId);
	const defaults = warrenConfig.data?.defaults ?? null;
	const defaultRole = defaults?.defaultRole;
	const registered = agents.data?.agents ?? [];
	const resolvedAgent =
		defaultRole !== undefined && registered.some((a) => a.name === defaultRole)
			? (defaultRole as string)
			: null;
	const template = defaults?.defaultPrompt ?? DEFAULT_PROMPT_TEMPLATE;

	const dispatch = useMutation({
		mutationFn: () => {
			if (resolvedAgent === null) {
				throw new Error(
					"No default agent resolved — set `defaults.defaultRole` in `.warren/defaults.yaml` and register the agent.",
				);
			}
			const provider = defaults?.defaultProvider;
			const model = defaults?.defaultModel;
			return plotsApi.dispatchSynthesizedPlanRun({
				plotId,
				projectId,
				agent: resolvedAgent,
				promptTemplate: template,
				...(provider !== undefined && provider.length > 0
					? { providerOverride: provider }
					: {}),
				...(model !== undefined && model.length > 0
					? { modelOverride: model }
					: {}),
			});
		},
		onSuccess: (data) => {
			qc.invalidateQueries({ queryKey: ["plan-runs"] });
			qc.invalidateQueries({ queryKey: ["plot", plotId] });
			navigate(`/plan-runs/${encodeURIComponent(data.planRun.id)}`);
		},
	});

	const loading = projects.isLoading || warrenConfig.isLoading || agents.isLoading;
	const hasSeeds = project?.hasSeeds ?? false;
	const readyToDispatch =
		!loading && hasSeeds && resolvedAgent !== null && !dispatch.isPending;

	const errorMessage = ((): string | null => {
		if (dispatch.error === null || dispatch.error === undefined) return null;
		if (dispatch.error instanceof ApiError) {
			return `${dispatch.error.message} (${dispatch.error.code})`;
		}
		return dispatch.error instanceof Error
			? dispatch.error.message
			: String(dispatch.error);
	})();

	return (
		<Dialog
			open={true}
			onOpenChange={(next) => {
				if (!next) dispatch.reset();
				onOpenChange(next);
			}}
		>
			<DialogContent>
				<DialogHeader>
					<DialogTitle>Dispatch as plan-run</DialogTitle>
					<DialogDescription>
						Synthesize a seeds plan from this Plot's open{" "}
						<code className="font-mono">seeds_issue</code> attachments and
						dispatch it as a single plan-run. Children run serially, gated on
						each previous PR merging; the Plot auto-transitions to{" "}
						<code className="font-mono">done</code> when the final child
						merges.
					</DialogDescription>
				</DialogHeader>

				<div className="space-y-3 text-sm">
					<ReadOnlyField label="Project" value={project?.gitUrl ?? projectId} hint={project?.gitUrl !== undefined ? projectId : undefined} />
					<ReadOnlyField label="Plot" value={plotId} />
					<ReadOnlyField
						label="Synthesized plan title"
						value={synthesizedPlanTitle(plotId)}
						hint="Mints a fresh throwaway parent seed on submit."
					/>
					<ReadOnlyField
						label="Agent"
						value={
							loading
								? "resolving…"
								: (resolvedAgent ?? "(no default agent set)")
						}
					/>
					<ReadOnlyField
						label="Prompt template"
						value={template}
						hint="{seed_id} is substituted per child."
					/>
					<div className="space-y-1">
						<div className="text-xs font-medium uppercase tracking-wide text-(--color-muted-foreground)">
							Candidates ({targets.length})
						</div>
						<p className="text-xs text-(--color-muted-foreground)">
							seeds_issue attachments excluding sd_plan-shaped refs
							(<code className="font-mono">pl-*</code>, dispatched via the
							per-row Run plan button). Closed seeds are dropped server-side
							at synthesis time.
						</p>
						<ul className="max-h-40 overflow-auto divide-y rounded-md border">
							{targets.map((t) => (
								<li
									key={t.id}
									className="px-3 py-1.5 text-xs"
								>
									<span className="truncate font-mono">{t.ref}</span>
								</li>
							))}
						</ul>
					</div>
				</div>

				{!loading && !hasSeeds ? (
					<p className="text-sm text-(--color-destructive)">
						Plan-runs require <code className="font-mono">.seeds/</code> at
						the project root. This project has none — add one and refresh.
					</p>
				) : null}
				{!loading && hasSeeds && resolvedAgent === null ? (
					<p className="text-sm text-(--color-destructive)">
						No default agent resolved. Set{" "}
						<code className="font-mono">defaults.defaultRole</code> in{" "}
						<code className="font-mono">.warren/defaults.yaml</code> and
						register the agent before dispatching.
					</p>
				) : null}
				{errorMessage !== null ? (
					<p className="text-sm text-(--color-destructive)">{errorMessage}</p>
				) : null}

				<DialogFooter>
					<Button
						type="button"
						variant="outline"
						onClick={() => onOpenChange(false)}
						disabled={dispatch.isPending}
					>
						Cancel
					</Button>
					<Button
						type="button"
						disabled={!readyToDispatch}
						onClick={() => dispatch.mutate()}
					>
						{dispatch.isPending ? "Dispatching…" : "Dispatch"}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}

