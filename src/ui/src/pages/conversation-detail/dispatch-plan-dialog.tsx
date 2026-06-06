import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { agentsApi, ApiError, planRunsApi, projectsApi } from "@/api/client.ts";
import type { CreatePlanRunInput } from "@/api/types.ts";
import { Button } from "@/components/ui/button.tsx";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog.tsx";
import { Input } from "@/components/ui/input.tsx";
import { Label } from "@/components/ui/label.tsx";
import { Textarea } from "@/components/ui/textarea.tsx";

/**
 * Operator-gated "Dispatch plan" popup (warren-6e45, LEVERET.md §0.0.B
 * step 4 / §0.7 step 4 / §0.9 / build-phase 5).
 *
 * Plan-run dispatch stays OPERATOR-GATED in v1 — there is no auto-dispatch
 * (this preserves the SPEC §10.4 approval-gate taste signal). Once the
 * send-off poller has dispatched the planner (`conversation.plannerRunId !=
 * null`), the planner emits a structured seeds plan and STOPS. This popup is
 * the manual hand-off: it MIRRORS the `/plan-runs/new` fields — pre-filled
 * from the conversation's Plot/project context — and dispatches a plan-run
 * over the EXISTING `planRunsApi.create` (`POST /plan-runs`) path. No new
 * dispatch path is introduced; this is byte-for-byte a manual plan-run
 * dispatch keyed on the conversation's Plot.
 *
 * The synthesized plan id is surfaced by the planner run, so the operator
 * pastes it in (the field is required); project + plot are locked to the
 * conversation's bindings, and agent/provider/model auto-fill from the
 * project defaults exactly like `/plan-runs/new`.
 */

const DEFAULT_PROMPT_TEMPLATE = "work on sd {seed_id}";

/** Mirror server-side `^plot-[a-z0-9]+$` (src/plots/id-validator.ts). */
const PLOT_ID_RE = /^plot-[a-z0-9]+$/;

export function DispatchPlanButton({
	projectId,
	plotId,
	plannerRunId,
}: {
	projectId: string;
	plotId: string | null;
	plannerRunId: string;
}): JSX.Element {
	const [open, setOpen] = useState(false);
	return (
		<>
			<Button type="button" size="sm" onClick={() => setOpen(true)}>
				Dispatch plan
			</Button>
			{open ? (
				<DispatchPlanDialog
					projectId={projectId}
					plotId={plotId}
					plannerRunId={plannerRunId}
					onOpenChange={setOpen}
				/>
			) : null}
		</>
	);
}

function readFrontmatter(renderedJson: unknown): Record<string, unknown> {
	if (typeof renderedJson !== "object" || renderedJson === null) return {};
	const fm = (renderedJson as { frontmatter?: unknown }).frontmatter;
	if (typeof fm !== "object" || fm === null || Array.isArray(fm)) return {};
	return fm as Record<string, unknown>;
}

function DispatchPlanDialog({
	projectId,
	plotId,
	plannerRunId,
	onOpenChange,
}: {
	projectId: string;
	plotId: string | null;
	plannerRunId: string;
	onOpenChange: (open: boolean) => void;
}): JSX.Element {
	const navigate = useNavigate();
	const qc = useQueryClient();

	const [planId, setPlanId] = useState("");
	const [agent, setAgent] = useState("");
	const [agentTouched, setAgentTouched] = useState(false);
	const [promptTemplate, setPromptTemplate] = useState(DEFAULT_PROMPT_TEMPLATE);
	const [providerOverride, setProviderOverride] = useState("");
	const [providerTouched, setProviderTouched] = useState(false);
	const [modelOverride, setModelOverride] = useState("");
	const [modelTouched, setModelTouched] = useState(false);

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
	const hasSeeds = project?.hasSeeds ?? false;
	const hasPlot = project?.hasPlot ?? false;
	const defaults = warrenConfig.data?.defaults ?? null;
	const defaultRole = defaults?.defaultRole;
	const defaultProvider = defaults?.defaultProvider;
	const defaultModel = defaults?.defaultModel;
	const registered = agents.data?.agents ?? [];
	const defaultRoleRegistered =
		defaultRole !== undefined && registered.some((a) => a.name === defaultRole);

	useEffect(() => {
		if (agentTouched) return;
		if (!defaultRoleRegistered) return;
		if (agent === defaultRole) return;
		setAgent(defaultRole as string);
	}, [agentTouched, defaultRoleRegistered, defaultRole, agent]);

	const selectedAgent = registered.find((a) => a.name === agent);
	const agentFrontmatter = readFrontmatter(selectedAgent?.renderedJson);
	const agentProvider =
		typeof agentFrontmatter.provider === "string" ? agentFrontmatter.provider : "";
	const agentModel = typeof agentFrontmatter.model === "string" ? agentFrontmatter.model : "";
	const providerAutoFill =
		defaultProvider !== undefined && defaultProvider.length > 0 ? defaultProvider : agentProvider;
	const modelAutoFill =
		defaultModel !== undefined && defaultModel.length > 0 ? defaultModel : agentModel;

	useEffect(() => {
		if (providerTouched) return;
		if (providerOverride === providerAutoFill) return;
		setProviderOverride(providerAutoFill);
	}, [providerTouched, providerAutoFill, providerOverride]);
	useEffect(() => {
		if (modelTouched) return;
		if (modelOverride === modelAutoFill) return;
		setModelOverride(modelAutoFill);
	}, [modelTouched, modelAutoFill, modelOverride]);

	const dispatch = useMutation({
		mutationFn: (input: CreatePlanRunInput) => planRunsApi.create(input),
		onSuccess: (data) => {
			qc.invalidateQueries({ queryKey: ["plan-runs"] });
			if (plotId !== null) qc.invalidateQueries({ queryKey: ["plot", plotId] });
			navigate(`/plan-runs/${encodeURIComponent(data.planRun.id)}`);
		},
	});

	const trimmedPlanId = planId.trim();
	const trimmedPrompt = promptTemplate.trim();
	const bindablePlot = hasPlot && plotId !== null && PLOT_ID_RE.test(plotId);
	const submittable =
		!dispatch.isPending &&
		hasSeeds &&
		agent.length > 0 &&
		trimmedPlanId.length > 0 &&
		trimmedPrompt.length > 0;

	const handleDispatch = (): void => {
		if (!submittable) return;
		const trimmedProvider = providerOverride.trim();
		const trimmedModel = modelOverride.trim();
		dispatch.mutate({
			project: projectId,
			planId: trimmedPlanId,
			agent,
			promptTemplate: trimmedPrompt,
			...(trimmedProvider.length > 0 ? { providerOverride: trimmedProvider } : {}),
			...(trimmedModel.length > 0 ? { modelOverride: trimmedModel } : {}),
			...(bindablePlot ? { plotId: plotId as string } : {}),
		});
	};

	const loading = projects.isLoading || warrenConfig.isLoading || agents.isLoading;
	const errorMessage = ((): string | null => {
		if (dispatch.error === null || dispatch.error === undefined) return null;
		if (dispatch.error instanceof ApiError) {
			return `${dispatch.error.message} (${dispatch.error.code})`;
		}
		return dispatch.error instanceof Error ? dispatch.error.message : String(dispatch.error);
	})();

	return (
		<Dialog
			open={true}
			onOpenChange={(next) => {
				if (!next) dispatch.reset();
				onOpenChange(next);
			}}
		>
			<DialogContent className="max-w-xl">
				<DialogHeader>
					<DialogTitle>Dispatch plan</DialogTitle>
					<DialogDescription>
						The planner emitted a seeds plan from this conversation's Plot intent and
						stopped — dispatch is operator-gated. Paste the plan id (from planner run{" "}
						<code className="font-mono">{plannerRunId}</code>) and dispatch a plan-run
						over the same path as <code className="font-mono">/plan-runs/new</code>.
						Each open child seed runs sequentially.
					</DialogDescription>
				</DialogHeader>

				<div className="space-y-4">
					<div className="space-y-1.5">
						<Label htmlFor="dispatch-plan-project">Project</Label>
						<Input
							id="dispatch-plan-project"
							value={project?.gitUrl ?? projectId}
							readOnly
							disabled
							className="h-9 font-mono text-sm"
						/>
					</div>

					<div className="space-y-1.5">
						<Label htmlFor="dispatch-plan-planId">Plan ID</Label>
						<Input
							id="dispatch-plan-planId"
							required
							value={planId}
							onChange={(e) => setPlanId(e.target.value)}
							placeholder="pl-…"
							disabled={!hasSeeds || dispatch.isPending}
							autoComplete="off"
							spellCheck={false}
							className="h-9 text-sm"
						/>
						<p className="text-xs text-(--color-muted-foreground)">
							The synthesized plan id, surfaced by the planner run.
						</p>
					</div>

					{plotId !== null ? (
						<div className="space-y-1.5">
							<Label htmlFor="dispatch-plan-plotId">Plot</Label>
							<Input
								id="dispatch-plan-plotId"
								value={plotId}
								readOnly
								disabled
								className="h-9 font-mono text-sm"
							/>
							<p className="text-xs text-(--color-muted-foreground)">
								{bindablePlot
									? "Children inherit PLOT_ID; the Plot auto-transitions to done when every child merges."
									: "This Plot can't be bound (project has no .plot/) — the plan-run dispatches unbound."}
							</p>
						</div>
					) : null}

					<div className="space-y-1.5">
						<Label htmlFor="dispatch-plan-agent">Agent</Label>
						<select
							id="dispatch-plan-agent"
							required
							value={agent}
							onChange={(e) => {
								setAgent(e.target.value);
								setAgentTouched(true);
							}}
							disabled={!hasSeeds || dispatch.isPending}
							className="flex h-9 w-full rounded-md border bg-(--color-card) px-3 py-1 text-sm shadow-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-(--color-ring) disabled:cursor-not-allowed disabled:opacity-60"
						>
							<option value="" disabled>
								Pick an agent…
							</option>
							{registered.map((a) => (
								<option key={`${a.source ?? "unknown"}::${a.name}`} value={a.name}>
									{a.name}
								</option>
							))}
						</select>
					</div>

					<div className="space-y-1.5">
						<Label htmlFor="dispatch-plan-promptTemplate">Prompt template</Label>
						<Textarea
							id="dispatch-plan-promptTemplate"
							required
							rows={3}
							value={promptTemplate}
							onChange={(e) => setPromptTemplate(e.target.value)}
							disabled={!hasSeeds || dispatch.isPending}
							placeholder={DEFAULT_PROMPT_TEMPLATE}
							className="text-sm"
						/>
						<p className="text-xs text-(--color-muted-foreground)">
							<code className="font-mono">{"{seed_id}"}</code> is substituted per child.
						</p>
					</div>

					<div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
						<div className="space-y-1.5">
							<Label htmlFor="dispatch-plan-provider">Provider override</Label>
							<Input
								id="dispatch-plan-provider"
								value={providerOverride}
								onChange={(e) => {
									setProviderOverride(e.target.value);
									setProviderTouched(true);
								}}
								placeholder={
									providerAutoFill.length > 0 ? providerAutoFill : "anthropic, openai, …"
								}
								disabled={!hasSeeds || dispatch.isPending}
								autoComplete="off"
								spellCheck={false}
								className="h-9 text-sm"
							/>
						</div>
						<div className="space-y-1.5">
							<Label htmlFor="dispatch-plan-model">Model override</Label>
							<Input
								id="dispatch-plan-model"
								value={modelOverride}
								onChange={(e) => {
									setModelOverride(e.target.value);
									setModelTouched(true);
								}}
								placeholder={
									modelAutoFill.length > 0 ? modelAutoFill : "claude-sonnet-4-6, gpt-4o, …"
								}
								disabled={!hasSeeds || dispatch.isPending}
								autoComplete="off"
								spellCheck={false}
								className="h-9 text-sm"
							/>
						</div>
					</div>
				</div>

				{!loading && !hasSeeds ? (
					<p className="text-sm text-(--color-destructive)">
						Plan runs require <code className="font-mono">.seeds/</code> at the project
						root. This project has none — add one and refresh.
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
					<Button type="button" disabled={!submittable} onClick={handleDispatch}>
						{dispatch.isPending ? "Dispatching…" : "Dispatch"}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
