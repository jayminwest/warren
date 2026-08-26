import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { agentsApi, instanceApi, projectsApi, runsApi } from "@/api/client.ts";
import type { InstanceFactsResponse } from "@/api/instance-types.ts";
import type { AgentRow, CreateRunInput, ProjectRow } from "@/api/types.ts";
import {
	buildCreateRunInput,
	type DispatchDraft,
	type DispatchDraftPatch,
	type DispatchRouteState,
	initialDraft,
	initialTouched,
	parseCostCap,
	readDispatchRouteState,
	resolveDefaultKind,
} from "./dispatch-draft.ts";
import { useDispatchDefaults } from "./use-dispatch-defaults.ts";

/**
 * State + data wiring for the Dispatch page (warren-bbe8). Holds the
 * draft/touched pair, the project/agent/config/instance queries, the
 * per-project default auto-fill, and the `POST /runs` mutation — so the
 * page component stays a thin render.
 */

export interface useDispatchStateResult {
	readonly initialState: DispatchRouteState;
	readonly draft: DispatchDraft;
	readonly agentRows: readonly AgentRow[];
	readonly projectRows: readonly ProjectRow[];
	readonly selectedProject: ProjectRow | undefined;
	readonly facts: InstanceFactsResponse | undefined;
	readonly defaults: ReturnType<typeof readDefaults>;
	readonly agentDefaultFrom: { role: string; sourceFile: string } | null;
	readonly providerDefaultKind: "project" | "agent" | null;
	readonly modelDefaultKind: "project" | "agent" | null;
	readonly costCapError: string | null;
	readonly valid: boolean;
	readonly noAgents: boolean;
	readonly noProjects: boolean;
	readonly pending: boolean;
	readonly submitError: string | null;
	readonly setAgent: (value: string) => void;
	readonly setProject: (value: string) => void;
	readonly setRef: (value: string) => void;
	readonly setSeedId: (value: string) => void;
	readonly setPrompt: (value: string) => void;
	readonly setProvider: (value: string) => void;
	readonly setModel: (value: string) => void;
	readonly setCostCap: (value: string) => void;
	readonly cancel: () => void;
	readonly submit: () => void;
}

type Defaults = {
	defaultRole?: string;
	defaultProvider?: string;
	defaultModel?: string;
	runBranchPrefix?: string;
};

function readDefaults(data: undefined | { defaults: Defaults | null }): Defaults | null {
	return data?.defaults ?? null;
}

export function useDispatchState(): useDispatchStateResult {
	const navigate = useNavigate();
	const qc = useQueryClient();
	const location = useLocation();
	const [initialState] = useState(() => readDispatchRouteState(location.state));
	const [patch, setPatch] = useState<DispatchDraftPatch>(() => ({
		draft: initialDraft(initialState),
		touched: initialTouched(initialState),
	}));
	const draft = patch.draft;

	const setDraftValue = <K extends keyof DispatchDraft>(key: K, value: DispatchDraft[K]) =>
		setPatch((prev) => ({ ...prev, draft: { ...prev.draft, [key]: value } }));
	const setTouchedValue = <K extends keyof DispatchDraft>(key: K, value: DispatchDraft[K]) =>
		setPatch((prev) => ({
			draft: { ...prev.draft, [key]: value },
			touched: { ...prev.touched, [key]: true },
		}));

	const agents = useQuery({
		queryKey: ["agents", { projectId: draft.project }],
		queryFn: ({ signal }) =>
			agentsApi.list(draft.project.length > 0 ? { projectId: draft.project } : {}, signal),
	});
	const projects = useQuery({
		queryKey: ["projects"],
		queryFn: ({ signal }) => projectsApi.list(signal),
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

	const agentRows = agents.data?.agents ?? [];
	const projectRows = projects.data?.projects ?? [];
	const defaults = readDefaults(warrenConfig.data);
	const selectedAgent = agentRows.find((a) => a.name === draft.agent);
	const selectedProject = projectRows.find((p) => p.id === draft.project);

	useDispatchDefaults(
		{ defaults, agents: agentRows, selectedAgent },
		useCallback(
			(updater: (prev: DispatchDraftPatch) => DispatchDraftPatch) => setPatch(updater),
			[],
		),
	);

	const costCapResult = parseCostCap(draft.costCap);
	const costCapError =
		costCapResult !== null && "error" in costCapResult ? costCapResult.error : null;

	const spawn = useMutation({
		mutationFn: (input: CreateRunInput) => runsApi.create(input),
		onSuccess: (data) => {
			qc.invalidateQueries({ queryKey: ["runs"] });
			navigate(`/runs/${encodeURIComponent(data.run.id)}`);
		},
	});

	const submit = useCallback((): void => {
		if (
			spawn.isPending ||
			draft.agent.length === 0 ||
			draft.project.length === 0 ||
			draft.prompt.trim().length === 0 ||
			costCapError !== null
		) {
			return;
		}
		const cost =
			costCapResult !== null && "value" in costCapResult ? costCapResult.value : undefined;
		spawn.mutate(buildCreateRunInput({ draft, routeState: initialState, maxCostUsd: cost }));
	}, [spawn, draft, costCapError, costCapResult, initialState]);

	const agentDefaultFrom =
		defaults?.defaultRole !== undefined && defaults.defaultRole === draft.agent
			? {
					role: defaults.defaultRole,
					sourceFile: warrenConfig.data?.sourceFile ?? ".warren/config.yaml",
				}
			: null;

	return {
		initialState,
		draft,
		agentRows,
		projectRows,
		selectedProject,
		facts: facts.data,
		defaults,
		agentDefaultFrom,
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
		valid: draft.agent.length > 0 && draft.project.length > 0 && draft.prompt.trim().length > 0,
		noAgents: !agents.isLoading && agentRows.length === 0,
		noProjects: !projects.isLoading && projectRows.length === 0,
		pending: spawn.isPending,
		submitError: spawn.isError ? String(spawn.error) : null,
		setAgent: (value) => setTouchedValue("agent", value),
		setProject: (value) => setDraftValue("project", value),
		setRef: (value) => setDraftValue("ref", value),
		setSeedId: (value) => setDraftValue("seedId", value),
		setPrompt: (value) => setTouchedValue("prompt", value),
		setProvider: (value) => setTouchedValue("providerOverride", value),
		setModel: (value) => setTouchedValue("modelOverride", value),
		setCostCap: (value) => setTouchedValue("costCap", value),
		cancel: () => navigate("/runs"),
		submit,
	};
}
