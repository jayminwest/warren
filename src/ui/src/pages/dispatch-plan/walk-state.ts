import { useMutation, useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { agentsApi, instanceApi, planRunsApi, projectsApi } from "@/api/client.ts";
import type { InstanceFactsResponse } from "@/api/instance-types.ts";
import type {
	AgentRow,
	CreatePlanRunInput,
	DefaultsConfig,
	ProjectRow,
	SeedStatusResponse,
} from "@/api/types.ts";
import { resolveDefaultKind } from "../dispatch/dispatch-draft.ts";
import { useWalkDefaults } from "./use-walk-defaults.ts";
import {
	buildCreatePlanRunInput,
	type CostCapResult,
	costCapErrorOf,
	initialWalkDraft,
	initialWalkTouched,
	parseCostCap,
	parseIssueIds,
	readWalkRouteState,
	type WalkDraft,
	type WalkDraftPatch,
	type WalkRouteState,
} from "./walk-draft.ts";

/**
 * State + data wiring for the Dispatch plan page (warren-02bb): the
 * draft/touched pair, the project/agent/config/instance/plan queries,
 * the per-project default auto-fill (`use-walk-defaults.ts`), the
 * per-issue status lookups behind the children table, and the
 * `POST /plan-runs` mutation. The page component stays a thin render.
 */

export interface PlanOption {
	readonly id: string;
	readonly label: string;
	readonly status: string;
	readonly childCount: number;
}

export interface IssueStatusEntry {
	readonly id: string;
	readonly status: string | null;
}

export interface WalkStateResult {
	readonly initialState: WalkRouteState;
	readonly draft: WalkDraft;
	readonly agentRows: readonly AgentRow[];
	readonly projectRows: readonly ProjectRow[];
	readonly selectedProject: ProjectRow | undefined;
	readonly selectedAgent: AgentRow | undefined;
	readonly facts: InstanceFactsResponse | undefined;
	readonly agentDefaultFrom: { role: string; sourceFile: string } | null;
	readonly providerDefaultKind: "project" | "agent" | null;
	readonly modelDefaultKind: "project" | "agent" | null;
	readonly costCapError: string | null;
	readonly costCapResult: CostCapResult;
	readonly planOptions: readonly PlanOption[];
	readonly planSelectorUnavailable: boolean;
	readonly useManualPlanId: boolean;
	readonly openChildCount: number | null;
	readonly issueStatuses: readonly IssueStatusEntry[];
	readonly valid: boolean;
	readonly noAgents: boolean;
	readonly noProjects: boolean;
	readonly pending: boolean;
	readonly submitError: string | null;
	readonly setAgent: (value: string) => void;
	readonly setProject: (value: string) => void;
	readonly setRef: (value: string) => void;
	readonly setPlanId: (value: string) => void;
	readonly setPlanIdManual: () => void;
	readonly setIssuesText: (value: string) => void;
	readonly setPrompt: (value: string) => void;
	readonly setProvider: (value: string) => void;
	readonly setModel: (value: string) => void;
	readonly setCostCap: (value: string) => void;
	readonly setSourceMode: (mode: "plan" | "issues") => void;
	readonly cancel: () => void;
	readonly submit: () => void;
}

function agentsFilter(projectId: string): { projectId: string } | Record<string, never> {
	return projectId.length > 0 ? { projectId } : {};
}

function issueIdsOf(draft: WalkDraft): string[] {
	return draft.sourceMode === "issues" ? parseIssueIds(draft.issuesText).slice(0, 100) : [];
}

function costValueOf(result: CostCapResult): number | undefined {
	return result !== null && "value" in result ? result.value : undefined;
}

function errorTextOf(mutation: { isError: boolean; error: unknown }): string | null {
	return mutation.isError ? String(mutation.error) : null;
}

function toPlanOptions(
	plans: readonly { id: string; name?: string; status: string; childCount: number }[],
): PlanOption[] {
	return plans.map((p) => ({
		id: p.id,
		label: p.name !== undefined && p.name.length > 0 ? `${p.name} (${p.id})` : p.id,
		status: p.status,
		childCount: p.childCount,
	}));
}

function agentDefaultFromOf(
	defaults: DefaultsConfig | null,
	sourceFile: string | undefined,
	agent: string,
): { role: string; sourceFile: string } | null {
	if (defaults?.defaultRole === undefined || defaults.defaultRole !== agent) return null;
	return { role: defaults.defaultRole, sourceFile: sourceFile ?? ".warren/config.yaml" };
}

/** Pure submittability — every gate the submit button and manifest need. */
export function isSubmittable(args: {
	readonly draft: WalkDraft;
	readonly hasSeeds: boolean;
	readonly costCapError: string | null;
}): boolean {
	const { draft } = args;
	if (args.costCapError !== null) return false;
	if (draft.project.length === 0 || draft.agent.length === 0) return false;
	if (draft.promptTemplate.trim().length === 0) return false;
	if (draft.sourceMode === "issues") return parseIssueIds(draft.issuesText).length > 0;
	return draft.planId.trim().length > 0 && args.hasSeeds;
}

/** Per-issue status rows for the children table (issues mode). */
function useIssueStatuses(
	project: string,
	issueIds: readonly string[],
): readonly IssueStatusEntry[] {
	const queries = useQueries({
		queries: issueIds.map((id) => ({
			queryKey: ["projects", project, "seed", id],
			queryFn: ({ signal }: { signal: AbortSignal }) => projectsApi.seedStatus(project, id, signal),
			retry: false,
		})),
	});
	return issueIds.map((id, i) => {
		const data: SeedStatusResponse | undefined = queries[i]?.data;
		return { id, status: data?.status ?? null };
	});
}

export function useWalkState(): WalkStateResult {
	const navigate = useNavigate();
	const qc = useQueryClient();
	const location = useLocation();
	const [initialState] = useState(() => readWalkRouteState(location.state));
	const [patch, setPatch] = useState<WalkDraftPatch>(() => ({
		draft: initialWalkDraft(initialState),
		touched: initialWalkTouched(initialState),
	}));
	const draft = patch.draft;

	const setDraftValue = <K extends keyof WalkDraft>(key: K, value: WalkDraft[K]) =>
		setPatch((prev) => ({ ...prev, draft: { ...prev.draft, [key]: value } }));
	const setTouchedValue = <K extends keyof WalkDraft, T extends keyof WalkDraftPatch["touched"]>(
		key: K,
		value: WalkDraft[K],
		touchedKey: T,
	) =>
		setPatch((prev) => ({
			draft: { ...prev.draft, [key]: value },
			touched: { ...prev.touched, [touchedKey]: true },
		}));

	const projects = useQuery({
		queryKey: ["projects"],
		queryFn: ({ signal }) => projectsApi.list(signal),
	});
	const agents = useQuery({
		queryKey: ["agents", { projectId: draft.project }],
		queryFn: ({ signal }) => agentsApi.list(agentsFilter(draft.project), signal),
	});
	const facts = useQuery({
		queryKey: ["instance", "facts"],
		queryFn: ({ signal }) => instanceApi.facts(signal),
	});
	const warrenConfig = useQuery({
		queryKey: ["projects", draft.project, "warren-config"],
		queryFn: ({ signal }) => projectsApi.warrenConfig(draft.project, signal),
		enabled: draft.project.length > 0,
	});

	const selectedProject = projects.data?.projects.find((p) => p.id === draft.project);
	const hasSeeds = selectedProject?.hasSeeds ?? false;
	const plans = useQuery({
		queryKey: ["projects", draft.project, "seed-plans"],
		queryFn: ({ signal }) => projectsApi.seedPlans(draft.project, signal),
		enabled: draft.project.length > 0 && hasSeeds,
	});
	const readyPlans = useQuery({
		queryKey: ["projects", draft.project, "ready-plans"],
		queryFn: ({ signal }) => projectsApi.readyPlans(draft.project, signal),
		enabled: draft.project.length > 0 && hasSeeds,
	});

	const planOptions = toPlanOptions(plans.data?.plans ?? []);
	const planSelectorUnavailable = plans.isError || (!plans.isLoading && planOptions.length === 0);
	const useManualPlanId = draft.planIdManual || planSelectorUnavailable;

	const agentRows = agents.data?.agents ?? [];
	const projectRows = projects.data?.projects ?? [];
	const defaults = warrenConfig.data?.defaults ?? null;
	const selectedAgent = agentRows.find((a) => a.name === draft.agent);

	useWalkDefaults(
		defaults,
		agentRows,
		selectedAgent,
		useCallback((updater: (prev: WalkDraftPatch) => WalkDraftPatch) => setPatch(updater), []),
	);

	const openChildCount =
		readyPlans.data?.plans.find((p) => p.id === draft.planId)?.openChildCount ?? null;

	const issueStatuses = useIssueStatuses(draft.project, issueIdsOf(draft));

	const dispatch = useMutation({
		mutationFn: (input: CreatePlanRunInput) => planRunsApi.create(input),
		onSuccess: (data) => {
			qc.invalidateQueries({ queryKey: ["plan-runs"] });
			qc.invalidateQueries({ queryKey: ["projects"] });
			navigate(`/plan-runs/${encodeURIComponent(data.planRun.id)}`);
		},
	});

	const costCapResult = parseCostCap(draft.costCap);
	const costCapError = costCapErrorOf(draft.costCap);
	const valid = isSubmittable({ draft, hasSeeds, costCapError });

	const submit = useCallback((): void => {
		if (dispatch.isPending || !valid) return;
		dispatch.mutate(buildCreatePlanRunInput({ draft, maxCostUsd: costValueOf(costCapResult) }));
	}, [dispatch, valid, costCapResult, draft]);

	return {
		initialState,
		draft,
		agentRows,
		projectRows,
		selectedProject,
		selectedAgent,
		facts: facts.data,
		agentDefaultFrom: agentDefaultFromOf(
			defaults,
			warrenConfig.data?.sourceFile ?? undefined,
			draft.agent,
		),
		providerDefaultKind: resolveDefaultKind(
			draft.providerOverride,
			defaults?.defaultProvider,
			selectedAgent?.provider,
		),
		modelDefaultKind: resolveDefaultKind(
			draft.modelOverride,
			defaults?.defaultModel,
			selectedAgent?.model,
		),
		costCapError,
		costCapResult,
		planOptions,
		planSelectorUnavailable,
		useManualPlanId,
		openChildCount,
		issueStatuses,
		valid,
		noAgents: !agents.isLoading && agentRows.length === 0,
		noProjects: !projects.isLoading && projectRows.length === 0,
		pending: dispatch.isPending,
		submitError: errorTextOf(dispatch),
		setAgent: (value) => setTouchedValue("agent", value, "agent"),
		setProject: (value) => setDraftValue("project", value),
		setRef: (value) => setDraftValue("ref", value),
		setPlanId: (value) => setDraftValue("planId", value),
		setPlanIdManual: () => setDraftValue("planIdManual", true),
		setIssuesText: (value) => setDraftValue("issuesText", value),
		setPrompt: (value) => setTouchedValue("promptTemplate", value, "prompt"),
		setProvider: (value) => setTouchedValue("providerOverride", value, "provider"),
		setModel: (value) => setTouchedValue("modelOverride", value, "model"),
		setCostCap: (value) => setTouchedValue("costCap", value, "costCap"),
		setSourceMode: (mode) => setDraftValue("sourceMode", mode),
		cancel: () => navigate("/plan-runs"),
		submit,
	};
}
