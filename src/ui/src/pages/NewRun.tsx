import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { agentsApi, projectsApi, runsApi } from "@/api/client.ts";
import type { AgentRow, CreateRunInput } from "@/api/types.ts";
import { Badge } from "@/components/ui/badge.tsx";
import { Button } from "@/components/ui/button.tsx";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card.tsx";
import { Input } from "@/components/ui/input.tsx";
import { Field } from "@/components/ui/field.tsx";
import { Label } from "@/components/ui/label.tsx";
import { PageHeader } from "@/components/ui/page-header.tsx";
import {
	responsiveFooterActions,
	responsiveFooterButton,
	responsiveFormControl,
} from "@/components/ui/responsive.ts";
import { Textarea } from "@/components/ui/textarea.tsx";
import { classifyAgentSource } from "@/lib/agent-source.ts";

/**
 * Route state accepted by NewRunPage when navigated via `navigate("/runs/new",
 * { state })` — pre-fills the form so the user can click Dispatch
 * immediately without typing. All fields are optional; absent values fall back
 * to NewRun's defaulting flow (project-default agent/prompt, etc.).
 */
export interface NewRunRouteState {
	project?: string;
	agent?: string;
	prompt?: string;
	/**
	 * Continuation parent (warren-4b11). When RunDetail's "Re-run with
	 * follow-up" navigates here, it carries the prior run id so the new run
	 * is spawned with that run's pushed branch as the workspace base.
	 */
	continueFromRunId?: string;
	/**
	 * Replicate parent (warren-e96f). When RunDetail's "Re-run from scratch"
	 * navigates here, it carries the prior run id so the new run re-dispatches
	 * that run's exact config against the project default base (NOT the
	 * parent's pushed branch — that's `continueFromRunId`'s job).
	 */
	cloneFromRunId?: string;
}

function readRouteState(state: unknown): NewRunRouteState {
	if (typeof state !== "object" || state === null) return {};
	const s = state as Record<string, unknown>;
	const out: NewRunRouteState = {};
	if (typeof s.project === "string") out.project = s.project;
	if (typeof s.agent === "string") out.agent = s.agent;
	if (typeof s.prompt === "string") out.prompt = s.prompt;
	if (typeof s.continueFromRunId === "string") out.continueFromRunId = s.continueFromRunId;
	if (typeof s.cloneFromRunId === "string") out.cloneFromRunId = s.cloneFromRunId;
	return out;
}

function readFrontmatter(renderedJson: unknown): Record<string, unknown> {
	if (typeof renderedJson !== "object" || renderedJson === null) return {};
	const fm = (renderedJson as { frontmatter?: unknown }).frontmatter;
	if (typeof fm !== "object" || fm === null || Array.isArray(fm)) return {};
	return fm as Record<string, unknown>;
}

export function NewRunPage() {
	const navigate = useNavigate();
	const qc = useQueryClient();
	const location = useLocation();
	// RunDetail's re-run buttons (and any future callers) can pre-fill the
	// form via location.state. Read once on mount — further navigation away
	// and back resets to the defaulting flow.
	const [initialState] = useState(() => readRouteState(location.state));

	const [agent, setAgent] = useState(initialState.agent ?? "");
	const [agentTouched, setAgentTouched] = useState(
		initialState.agent !== undefined && initialState.agent.length > 0,
	);
	const [project, setProject] = useState(initialState.project ?? "");
	// R-03 / pl-fef5 step 8: scope the agent picker to global ∪ this
	// project's `.canopy/` tier as soon as the operator picks a project,
	// so project-scoped roles appear alongside built-ins/library. Without
	// a project selected the query stays global.
	const agents = useQuery({
		queryKey: ["agents", { projectId: project }],
		queryFn: ({ signal }) =>
			agentsApi.list(project.length > 0 ? { projectId: project } : {}, signal),
	});
	const projects = useQuery({
		queryKey: ["projects"],
		queryFn: ({ signal }) => projectsApi.list(signal),
	});
	const [prompt, setPrompt] = useState(initialState.prompt ?? "");
	const [promptTouched, setPromptTouched] = useState(
		initialState.prompt !== undefined && initialState.prompt.length > 0,
	);
	const [ref, setRef] = useState("");
	const [providerOverride, setProviderOverride] = useState("");
	const [providerTouched, setProviderTouched] = useState(false);
	const [modelOverride, setModelOverride] = useState("");
	const [modelTouched, setModelTouched] = useState(false);

	// Per-project defaults from `.warren/config.yaml` (R-02). When the project
	// declares a `defaultRole` that matches a registered agent, auto-fill the
	// agent picker; when it declares a `defaultPrompt`, pre-fill the prompt
	// textarea — unless the user has already taken control of either.
	const warrenConfig = useQuery({
		queryKey: ["projects", project, "warren-config"],
		queryFn: ({ signal }) => projectsApi.warrenConfig(project, signal),
		enabled: project.length > 0,
	});
	const defaultRole = warrenConfig.data?.defaults?.defaultRole;
	const defaultPrompt = warrenConfig.data?.defaults?.defaultPrompt;
	const defaultProvider = warrenConfig.data?.defaults?.defaultProvider;
	const defaultModel = warrenConfig.data?.defaults?.defaultModel;
	const configSourceFile = warrenConfig.data?.sourceFile ?? ".warren/config.yaml";
	const registeredAgents = agents.data?.agents ?? [];
	const defaultRoleRegistered =
		defaultRole !== undefined && registeredAgents.some((a) => a.name === defaultRole);
	const agentFromDefault =
		!agentTouched && defaultRoleRegistered && agent === defaultRole;
	const promptFromDefault =
		!promptTouched && defaultPrompt !== undefined && prompt === defaultPrompt;

	useEffect(() => {
		if (agentTouched) return;
		if (!defaultRoleRegistered) return;
		if (agent === defaultRole) return;
		setAgent(defaultRole as string);
	}, [agentTouched, defaultRoleRegistered, defaultRole, agent]);

	useEffect(() => {
		if (promptTouched) return;
		if (defaultPrompt === undefined) return;
		if (prompt === defaultPrompt) return;
		setPrompt(defaultPrompt);
	}, [promptTouched, defaultPrompt, prompt]);

	// Pull provider/model defaults off the selected agent's frontmatter
	// (warren-f8c0). Both are free-text strings — runtimes that don't
	// support multi-provider just ignore them. Auto-fill stops once the
	// operator types in either field. Per warren-618b, when the project
	// declares `.warren/config.yaml.defaultProvider` / `defaultModel`,
	// those win over the agent's frontmatter — the form surfaces the same
	// precedence the server applies (operator override > project default >
	// agent frontmatter).
	const selectedAgent = agents.data?.agents.find((a) => a.name === agent);
	const agentFrontmatter = readFrontmatter(selectedAgent?.renderedJson);
	const agentProvider =
		typeof agentFrontmatter.provider === "string" ? agentFrontmatter.provider : "";
	const agentModel = typeof agentFrontmatter.model === "string" ? agentFrontmatter.model : "";
	const providerAutoFill =
		defaultProvider !== undefined && defaultProvider.length > 0 ? defaultProvider : agentProvider;
	const modelAutoFill =
		defaultModel !== undefined && defaultModel.length > 0 ? defaultModel : agentModel;
	const providerFromProjectDefault =
		!providerTouched &&
		defaultProvider !== undefined &&
		defaultProvider.length > 0 &&
		providerOverride === defaultProvider;
	const modelFromProjectDefault =
		!modelTouched &&
		defaultModel !== undefined &&
		defaultModel.length > 0 &&
		modelOverride === defaultModel;
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

	const spawn = useMutation({
		mutationFn: (input: CreateRunInput) => runsApi.create(input),
		onSuccess: (data) => {
			qc.invalidateQueries({ queryKey: ["runs"] });
			navigate(`/runs/${encodeURIComponent(data.run.id)}`);
		},
	});

	const handleSubmit = (e: React.FormEvent): void => {
		e.preventDefault();
		if (agent.length === 0 || project.length === 0 || prompt.trim().length === 0) return;
		const trimmedRef = ref.trim();
		const trimmedProvider = providerOverride.trim();
		const trimmedModel = modelOverride.trim();
		spawn.mutate({
			agent,
			project,
			prompt,
			...(trimmedRef.length > 0 ? { ref: trimmedRef } : {}),
			...(trimmedProvider.length > 0 ? { providerOverride: trimmedProvider } : {}),
			...(trimmedModel.length > 0 ? { modelOverride: trimmedModel } : {}),
			...(continueFromRunId !== undefined ? { continueFromRunId } : {}),
			...(cloneFromRunId !== undefined ? { cloneFromRunId } : {}),
		});
	};

	// warren-4b11: a continuation pre-fills the parent id from route state
	// and is fixed for the life of the form — there's no picker for it.
	const continueFromRunId = initialState.continueFromRunId;
	// warren-e96f: a replicate ("re-run from scratch") pre-fills the parent id
	// the same way; mutually exclusive with continueFromRunId in practice.
	const cloneFromRunId = initialState.cloneFromRunId;

	const noAgents = !agents.isLoading && (agents.data?.agents.length ?? 0) === 0;
	const noProjects = !projects.isLoading && (projects.data?.projects.length ?? 0) === 0;
	const selectedProject = projects.data?.projects.find((p) => p.id === project);

	return (
		<div className="mx-auto max-w-3xl space-y-6">
			<PageHeader
				title="Dispatch run"
				description="Spawn an agent against a project repo inside a fresh sandbox."
			/>

			{continueFromRunId !== undefined ? (
				<p className="font-mono text-sm text-(--color-muted-foreground)">
					↪ from {continueFromRunId}
				</p>
			) : null}

			{cloneFromRunId !== undefined ? (
				<p className="font-mono text-sm text-(--color-muted-foreground)">
					⟳ re-run of {cloneFromRunId}
				</p>
			) : null}

			{noAgents ? (
				<Card>
					<CardContent className="p-4 text-sm text-(--color-destructive)">
						No agents registered. Visit <strong>Agents</strong> and click{" "}
						<strong>Refresh registry</strong>.
					</CardContent>
				</Card>
			) : null}
			{noProjects ? (
				<Card>
					<CardContent className="p-4 text-sm text-(--color-destructive)">
						No projects added. Visit <strong>Projects</strong> to clone one from
						GitHub.
					</CardContent>
				</Card>
			) : null}

			<Card>
				<CardHeader>
					<CardTitle>Run configuration</CardTitle>
				</CardHeader>
				<CardContent>
					<form onSubmit={handleSubmit} className="space-y-4">
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
								className={`flex w-full rounded-md border bg-(--color-card) px-3 py-1 shadow-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-(--color-ring) ${responsiveFormControl}`}
							>
								<option value="" disabled>
									Pick an agent…
								</option>
								{agents.data?.agents.map((a) => (
									<option key={`${a.source ?? "unknown"}::${a.name}`} value={a.name}>
										{a.name}
										{classifyAgentSource(a.source).tier === "project"
											? " (project)"
											: ""}
									</option>
								))}
							</select>
							<AgentSourceHint agent={selectedAgent} project={project} />
							{agentFromDefault ? (
								<p className="text-xs text-(--color-muted-foreground)">
									Defaulted from this project's{" "}
									<code className="font-mono">{configSourceFile}</code>.
								</p>
							) : defaultRole !== undefined && !defaultRoleRegistered ? (
								<p className="text-xs text-(--color-destructive)">
									Project default role{" "}
									<code className="font-mono">{defaultRole}</code> is not a
									registered agent.
								</p>
							) : null}
						</div>

						<div className="space-y-1.5">
							<Label htmlFor="project">Project</Label>
							<select
								id="project"
								required
								value={project}
								onChange={(e) => setProject(e.target.value)}
								className={`flex w-full rounded-md border bg-(--color-card) px-3 py-1 shadow-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-(--color-ring) ${responsiveFormControl}`}
							>
								<option value="" disabled>
									Pick a project…
								</option>
								{projects.data?.projects.map((p) => (
									<option key={p.id} value={p.id}>
										{p.gitUrl} ({p.id})
									</option>
								))}
							</select>
						</div>

						<Field
							label="Branch / tag / SHA (optional)"
							htmlFor="ref"
							description="Leave blank to use the project's default branch. Free text — no remote-branch lookup yet."
						>
							<Input
								id="ref"
								value={ref}
								onChange={(e) => setRef(e.target.value)}
								placeholder={selectedProject?.defaultBranch ?? "default branch"}
								autoComplete="off"
								spellCheck={false}
								className={responsiveFormControl}
							/>
						</Field>

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
										providerAutoFill.length > 0 ? providerAutoFill : "anthropic, openai, …"
									}
									autoComplete="off"
									spellCheck={false}
									className={responsiveFormControl}
								/>
								{providerFromProjectDefault ? (
									<p className="text-xs text-(--color-muted-foreground)">
										Defaulted from this project's{" "}
										<code className="font-mono">{configSourceFile}</code>.
									</p>
								) : !providerTouched && agentProvider.length > 0 ? (
									<p className="text-xs text-(--color-muted-foreground)">
										Defaulted from agent frontmatter.
									</p>
								) : (
									<p className="text-xs text-(--color-muted-foreground)">
										Free text — runtimes that don't support it ignore the field.
									</p>
								)}
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
										modelAutoFill.length > 0 ? modelAutoFill : "claude-sonnet-4-6, gpt-4o, …"
									}
									autoComplete="off"
									spellCheck={false}
									className={responsiveFormControl}
								/>
								{modelFromProjectDefault ? (
									<p className="text-xs text-(--color-muted-foreground)">
										Defaulted from this project's{" "}
										<code className="font-mono">{configSourceFile}</code>.
									</p>
								) : !modelTouched && agentModel.length > 0 ? (
									<p className="text-xs text-(--color-muted-foreground)">
										Defaulted from agent frontmatter.
									</p>
								) : null}
							</div>
						</div>

						<div className="space-y-1.5">
							<Label htmlFor="prompt">Prompt</Label>
							<Textarea
								id="prompt"
								required
								rows={6}
								value={prompt}
								onChange={(e) => {
									setPrompt(e.target.value);
									setPromptTouched(true);
								}}
								placeholder="What should the agent do?"
								className="text-base sm:text-sm"
							/>
							{promptFromDefault ? (
								<p className="text-xs text-(--color-muted-foreground)">
									Defaulted from this project's{" "}
									<code className="font-mono">{configSourceFile}</code>.
								</p>
							) : null}
						</div>

						{spawn.isError ? (
							<p className="text-sm text-(--color-destructive)">
								{spawn.error instanceof Error
									? spawn.error.message
									: String(spawn.error)}
							</p>
						) : null}

						<div className={responsiveFooterActions}>
							<Button
								type="button"
								variant="outline"
								onClick={() => navigate("/runs")}
								disabled={spawn.isPending}
								className={`h-11 sm:h-9 ${responsiveFooterButton}`}
							>
								Cancel
							</Button>
							<Button
								type="submit"
								disabled={
									spawn.isPending ||
									agent.length === 0 ||
									project.length === 0 ||
									prompt.trim().length === 0
								}
								className={`h-11 sm:h-9 ${responsiveFooterButton}`}
							>
								{spawn.isPending ? "Dispatching…" : "Dispatch"}
							</Button>
						</div>
					</form>
				</CardContent>
			</Card>
		</div>
	);
}

/**
 * Source provenance hint shown under the agent picker (R-03 / pl-fef5
 * step 8). Surfaces a small badge classifying the selected agent as
 * built-in / library / project so the operator can see at-a-glance
 * which tier they're about to dispatch. Tier badges are intentionally
 * coarse — the expanded Agents row carries the full `project:<id>`
 * string when needed.
 */
function AgentSourceHint({
	agent,
	project,
}: {
	agent: AgentRow | undefined;
	project: string;
}) {
	if (agent === undefined) return null;
	const classified = classifyAgentSource(agent.source);
	if (classified.tier === "unknown") return null;
	const variant =
		classified.tier === "builtin"
			? "secondary"
			: classified.tier === "library"
				? "running"
				: classified.tier === "project"
					? "succeeded"
					: "default";
	return (
		<p className="flex flex-wrap items-center gap-1.5 text-xs text-(--color-muted-foreground)">
			<span>Source:</span>
			<Badge
				variant={variant}
				className="font-mono text-xs"
				title={classified.projectId !== null ? `project:${classified.projectId}` : undefined}
			>
				{classified.label}
			</Badge>
			{classified.tier === "project" && classified.projectId !== project ? (
				<span className="text-(--color-destructive)">
					— belongs to a different project ({classified.projectId})
				</span>
			) : null}
		</p>
	);
}
