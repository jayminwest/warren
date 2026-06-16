import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { RefreshCw } from "lucide-react";
import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { agentsApi, planRunsApi, projectsApi } from "@/api/client.ts";
import type { CreatePlanRunInput } from "@/api/types.ts";
import { Button } from "@/components/ui/button.tsx";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card.tsx";
import { Input } from "@/components/ui/input.tsx";
import { Label } from "@/components/ui/label.tsx";
import { PageHeader } from "@/components/ui/page-header.tsx";
import { Textarea } from "@/components/ui/textarea.tsx";

const DEFAULT_PROMPT_TEMPLATE = "work on sd {seed_id}";

function readFrontmatter(renderedJson: unknown): Record<string, unknown> {
	if (typeof renderedJson !== "object" || renderedJson === null) return {};
	const fm = (renderedJson as { frontmatter?: unknown }).frontmatter;
	if (typeof fm !== "object" || fm === null || Array.isArray(fm)) return {};
	return fm as Record<string, unknown>;
}

export function NewPlanRunPage() {
	const navigate = useNavigate();
	const qc = useQueryClient();

	const [project, setProject] = useState("");
	const [agent, setAgent] = useState("");
	const [agentTouched, setAgentTouched] = useState(false);
	const [planId, setPlanId] = useState("");
	const [planIdManual, setPlanIdManual] = useState(false);
	const [plotId, setPlotId] = useState("");
	const [promptTemplate, setPromptTemplate] = useState(DEFAULT_PROMPT_TEMPLATE);
	const [promptTouched, setPromptTouched] = useState(false);
	const [ref, setRef] = useState("");
	const [providerOverride, setProviderOverride] = useState("");
	const [providerTouched, setProviderTouched] = useState(false);
	const [modelOverride, setModelOverride] = useState("");
	const [modelTouched, setModelTouched] = useState(false);

	const projects = useQuery({
		queryKey: ["projects"],
		queryFn: ({ signal }) => projectsApi.list(signal),
	});
	const agents = useQuery({
		queryKey: ["agents", { projectId: project }],
		queryFn: ({ signal }) =>
			agentsApi.list(project.length > 0 ? { projectId: project } : {}, signal),
	});
	const warrenConfig = useQuery({
		queryKey: ["projects", project, "warren-config"],
		queryFn: ({ signal }) => projectsApi.warrenConfig(project, signal),
		enabled: project.length > 0,
	});

	const selectedProject = projects.data?.projects.find((p) => p.id === project);
	const hasSeeds = selectedProject?.hasSeeds ?? false;
	const plans = useQuery({
		queryKey: ["projects", project, "seed-plans"],
		queryFn: ({ signal }) => projectsApi.seedPlans(project, signal),
		enabled: project.length > 0 && hasSeeds,
	});
	const planOptions = plans.data?.plans ?? [];
	// Fall back to free-text entry when the selector can't be populated:
	// the project's plan list failed to load, or there are no plans yet.
	const planSelectorUnavailable = plans.isError || (!plans.isLoading && planOptions.length === 0);
	const useManualPlanId = planIdManual || planSelectorUnavailable;
	const knownPlanId = planOptions.some((p) => p.id === planId);
	const hasPlot = selectedProject?.hasPlot ?? false;

	const defaultRole = warrenConfig.data?.defaults?.defaultRole;
	const defaultProvider = warrenConfig.data?.defaults?.defaultProvider;
	const defaultModel = warrenConfig.data?.defaults?.defaultModel;
	const registeredAgents = agents.data?.agents ?? [];
	const defaultRoleRegistered =
		defaultRole !== undefined && registeredAgents.some((a) => a.name === defaultRole);

	useEffect(() => {
		if (agentTouched) return;
		if (!defaultRoleRegistered) return;
		if (agent === defaultRole) return;
		setAgent(defaultRole as string);
	}, [agentTouched, defaultRoleRegistered, defaultRole, agent]);

	const selectedAgent = agents.data?.agents.find((a) => a.name === agent);
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
			navigate(`/plan-runs/${encodeURIComponent(data.planRun.id)}`);
		},
	});
	const refreshProject = useMutation({
		mutationFn: (id: string) => projectsApi.refresh(id),
		onSuccess: () => qc.invalidateQueries({ queryKey: ["projects"] }),
	});

	const trimmedPlanId = planId.trim();
	const trimmedPrompt = promptTemplate.trim();
	// warren-bae5 / pl-5310 step 2: mirror server-side `^plot-[a-z0-9]+$`
	// validation (src/plots/id-validator.ts). Same lockstep-duplicated regex
	// as NewRun.tsx — keep them in sync.
	const PLOT_ID_RE = /^plot-[a-z0-9]+$/;
	const trimmedPlotIdForUi = plotId.trim();
	const plotIdMalformed =
		hasPlot && trimmedPlotIdForUi.length > 0 && !PLOT_ID_RE.test(trimmedPlotIdForUi);
	const submittable =
		project.length > 0 &&
		agent.length > 0 &&
		trimmedPlanId.length > 0 &&
		trimmedPrompt.length > 0 &&
		hasSeeds &&
		!plotIdMalformed;

	const handleSubmit = (e: React.FormEvent): void => {
		e.preventDefault();
		if (!submittable) return;
		const trimmedRef = ref.trim();
		const trimmedProvider = providerOverride.trim();
		const trimmedModel = modelOverride.trim();
		const trimmedPlotId = plotId.trim();
		dispatch.mutate({
			project,
			planId: trimmedPlanId,
			agent,
			promptTemplate: trimmedPrompt,
			...(trimmedRef.length > 0 ? { ref: trimmedRef } : {}),
			...(trimmedProvider.length > 0 ? { providerOverride: trimmedProvider } : {}),
			...(trimmedModel.length > 0 ? { modelOverride: trimmedModel } : {}),
			...(hasPlot && trimmedPlotId.length > 0 ? { plotId: trimmedPlotId } : {}),
		});
	};

	const noProjects = !projects.isLoading && (projects.data?.projects.length ?? 0) === 0;
	const noAgents = !agents.isLoading && (agents.data?.agents.length ?? 0) === 0;

	return (
		<div className="mx-auto max-w-3xl space-y-6">
			<PageHeader
				title="Dispatch plan run"
				description="Walk a seeds plan in order — one warren run per open child seed, sequentially."
			/>

			{noProjects ? (
				<Card>
					<CardContent className="p-4 text-sm text-(--color-destructive)">
						No projects added. Visit <strong>Projects</strong> to clone one from
						GitHub.
					</CardContent>
				</Card>
			) : null}
			{project.length > 0 && !hasSeeds ? (
				<Card>
					<CardContent className="space-y-3 p-4 text-sm text-(--color-destructive)">
						<p>
							Plan runs require <code className="font-mono">.seeds/</code>. The
							selected project has no <code className="font-mono">.seeds/</code>{" "}
							directory at the clone root. Add one and refresh the project to
							enable plan-run dispatch.
						</p>
						<div className="flex items-center gap-3">
							<Button
								type="button"
								variant="outline"
								size="sm"
								onClick={() => refreshProject.mutate(project)}
								disabled={refreshProject.isPending}
							>
								<RefreshCw
									className={`mr-2 h-4 w-4 ${
										refreshProject.isPending ? "animate-spin" : ""
									}`}
								/>
								Refresh project
							</Button>
							{refreshProject.isError ? (
								<span className="text-xs">
									{refreshProject.error instanceof Error
										? refreshProject.error.message
										: String(refreshProject.error)}
								</span>
							) : null}
						</div>
					</CardContent>
				</Card>
			) : null}

			<Card>
				<CardHeader>
					<CardTitle>Plan run configuration</CardTitle>
				</CardHeader>
				<CardContent>
					<form onSubmit={handleSubmit} className="space-y-4">
						<div className="space-y-1.5">
							<Label htmlFor="project">Project</Label>
							<select
								id="project"
								required
								value={project}
								onChange={(e) => setProject(e.target.value)}
								className="flex h-11 sm:h-9 w-full rounded-md border bg-(--color-card) px-3 py-1 text-base sm:text-sm shadow-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-(--color-ring)"
							>
								<option value="" disabled>
									Pick a project…
								</option>
								{projects.data?.projects.map((p) => (
									<option key={p.id} value={p.id}>
										{p.gitUrl} ({p.id})
										{p.hasSeeds ? "" : " — no .seeds/"}
									</option>
								))}
							</select>
						</div>

						<div className="space-y-1.5">
							<Label htmlFor="agent">Agent</Label>
							<select
								id="agent"
								required
								value={agent}
								onChange={(e) => {
									setAgent(e.target.value);
									setAgentTouched(true);
								}}
								disabled={!hasSeeds}
								className="flex h-11 sm:h-9 w-full rounded-md border bg-(--color-card) px-3 py-1 text-base sm:text-sm shadow-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-(--color-ring) disabled:cursor-not-allowed disabled:opacity-60"
							>
								<option value="" disabled>
									Pick an agent…
								</option>
								{agents.data?.agents.map((a) => (
									<option key={`${a.source ?? "unknown"}::${a.name}`} value={a.name}>
										{a.name}
									</option>
								))}
							</select>
							{noAgents && hasSeeds ? (
								<p className="text-xs text-(--color-destructive)">
									No agents registered. Visit <strong>Agents</strong> and click{" "}
									<strong>Refresh registry</strong>.
								</p>
							) : null}
						</div>

						<div className="space-y-1.5">
							<Label htmlFor="planId">Plan ID</Label>
							{useManualPlanId ? (
								<Input
									id="planId"
									required
									value={planId}
									onChange={(e) => setPlanId(e.target.value)}
									placeholder="pl-a258"
									disabled={!hasSeeds}
									autoComplete="off"
									spellCheck={false}
									className="h-11 sm:h-9 text-base sm:text-sm"
								/>
							) : (
								<select
									id="planId"
									required
									value={knownPlanId ? planId : ""}
									onChange={(e) => {
										if (e.target.value === "__manual__") {
											setPlanIdManual(true);
											setPlanId("");
											return;
										}
										setPlanId(e.target.value);
									}}
									disabled={!hasSeeds}
									className="flex h-11 sm:h-9 w-full rounded-md border bg-(--color-card) px-3 py-1 text-base sm:text-sm shadow-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-(--color-ring) disabled:cursor-not-allowed disabled:opacity-60"
								>
									<option value="" disabled>
										{plans.isLoading ? "Loading plans…" : "Pick a plan…"}
									</option>
									{planOptions.map((p) => (
										<option key={p.id} value={p.id}>
											{p.name ? `${p.name} (${p.id})` : p.id}
											{p.status ? ` — ${p.status}` : ""}
										</option>
									))}
									<option value="__manual__">Enter plan ID manually…</option>
								</select>
							)}
							<p className="text-xs text-(--color-muted-foreground)">
								{planSelectorUnavailable
									? plans.isError
										? "Couldn't load plans — enter the seeds plan id manually."
										: "No plans found — enter the seeds plan id manually."
									: useManualPlanId
										? "Manual entry. Seeds plan id (e.g. pl-a258)."
										: "Pick a seeds plan, or choose manual entry to type one."}
							</p>
						</div>

						{hasSeeds && hasPlot ? (
							<div className="space-y-1.5">
								<Label htmlFor="plotId">Plot ID (optional)</Label>
								<Input
									id="plotId"
									value={plotId}
									onChange={(e) => setPlotId(e.target.value)}
									placeholder="plot-…"
									autoComplete="off"
									spellCheck={false}
									className="h-11 sm:h-9 text-base sm:text-sm"
								/>
								<p className="text-xs text-(--color-muted-foreground)">
									Bind this plan run to a Plot. Each child run inherits
									PLOT_ID; the Plot auto-transitions to <code className="font-mono">done</code>{" "}
									when every child merges.
								</p>
								{plotIdMalformed ? (
									<p className="text-xs text-(--color-destructive)">
										Plot ID must look like <code className="font-mono">plot-xxxxxxxx</code>.
									</p>
								) : null}
							</div>
						) : null}

						<div className="space-y-1.5">
							<Label htmlFor="promptTemplate">Prompt template</Label>
							<Textarea
								id="promptTemplate"
								required
								rows={3}
								value={promptTemplate}
								onChange={(e) => {
									setPromptTemplate(e.target.value);
									setPromptTouched(true);
								}}
								disabled={!hasSeeds}
								placeholder={DEFAULT_PROMPT_TEMPLATE}
								className="text-base sm:text-sm"
							/>
							<p className="text-xs text-(--color-muted-foreground)">
								<code className="font-mono">{"{seed_id}"}</code> is substituted
								per child.
								{!promptTouched && promptTemplate === DEFAULT_PROMPT_TEMPLATE
									? " Default."
									: ""}
							</p>
						</div>

						<div className="space-y-1.5">
							<Label htmlFor="ref">Branch / tag / SHA (optional)</Label>
							<Input
								id="ref"
								value={ref}
								onChange={(e) => setRef(e.target.value)}
								placeholder={selectedProject?.defaultBranch ?? "default branch"}
								disabled={!hasSeeds}
								autoComplete="off"
								spellCheck={false}
								className="h-11 sm:h-9 text-base sm:text-sm"
							/>
							<p className="text-xs text-(--color-muted-foreground)">
								Leave blank to use the project's default branch.
							</p>
						</div>

						<div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
							<div className="space-y-1.5">
								<Label htmlFor="provider">Provider override (optional)</Label>
								<Input
									id="provider"
									value={providerOverride}
									onChange={(e) => {
										setProviderOverride(e.target.value);
										setProviderTouched(true);
									}}
									placeholder={
										providerAutoFill.length > 0
											? providerAutoFill
											: "anthropic, openai, …"
									}
									disabled={!hasSeeds}
									autoComplete="off"
									spellCheck={false}
									className="h-11 sm:h-9 text-base sm:text-sm"
								/>
							</div>
							<div className="space-y-1.5">
								<Label htmlFor="model">Model override (optional)</Label>
								<Input
									id="model"
									value={modelOverride}
									onChange={(e) => {
										setModelOverride(e.target.value);
										setModelTouched(true);
									}}
									placeholder={
										modelAutoFill.length > 0
											? modelAutoFill
											: "claude-sonnet-4-6, gpt-4o, …"
									}
									disabled={!hasSeeds}
									autoComplete="off"
									spellCheck={false}
									className="h-11 sm:h-9 text-base sm:text-sm"
								/>
							</div>
						</div>

						{dispatch.isError ? (
							<p className="text-sm text-(--color-destructive)">
								{dispatch.error instanceof Error
									? dispatch.error.message
									: String(dispatch.error)}
							</p>
						) : null}

						<div className="flex flex-col sm:flex-row sm:justify-end gap-2">
							<Button
								type="button"
								variant="outline"
								onClick={() => navigate("/plan-runs")}
								disabled={dispatch.isPending}
								className="h-11 w-full sm:h-9 sm:w-auto"
							>
								Cancel
							</Button>
							<Button
								type="submit"
								disabled={dispatch.isPending || !submittable}
								className="h-11 w-full sm:h-9 sm:w-auto"
							>
								{dispatch.isPending ? "Dispatching…" : "Dispatch"}
							</Button>
						</div>
					</form>
				</CardContent>
			</Card>
		</div>
	);
}
