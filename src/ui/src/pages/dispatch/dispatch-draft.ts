/**
 * Dispatch draft state for the Direction C Dispatch page
 * (warren-bbe8 / pl-7e38 step 5).
 *
 * All field state lives in one flat object so the page can derive the
 * resolved manifest from the same values the form edits — the right rail
 * and the left card can never disagree about what will be dispatched.
 */

/**
 * Route state accepted by the Dispatch page when navigated via
 * `navigate("/dispatch", { state })` — pre-fills the form so the operator
 * can submit immediately without typing. All fields are optional; absent
 * values fall back to the defaulting flow (project-default agent /
 * prompt, etc.).
 */
export interface DispatchRouteState {
	project?: string;
	agent?: string;
	prompt?: string;
	/**
	 * Optional seed (tracker item) back-link — persisted onto the run
	 * record as `runs.seed_id`.
	 */
	seedId?: string;
	/**
	 * Continuation parent (warren-4b11). When Run detail's "Re-run with
	 * follow-up" navigates here, it carries the prior run id so the new
	 * run is spawned with that run's pushed branch as the workspace base.
	 */
	continueFromRunId?: string;
	/**
	 * Replicate parent (warren-e96f). When Run detail's "Re-run from
	 * scratch" navigates here, it carries the prior run id so the new run
	 * re-dispatches that run's exact config against the project default
	 * base (NOT the parent's pushed branch).
	 */
	cloneFromRunId?: string;
}

export function readDispatchRouteState(state: unknown): DispatchRouteState {
	if (typeof state !== "object" || state === null) return {};
	const s = state as Record<string, unknown>;
	const out: DispatchRouteState = {};
	if (typeof s.project === "string") out.project = s.project;
	if (typeof s.agent === "string") out.agent = s.agent;
	if (typeof s.prompt === "string") out.prompt = s.prompt;
	if (typeof s.seedId === "string") out.seedId = s.seedId;
	if (typeof s.continueFromRunId === "string") out.continueFromRunId = s.continueFromRunId;
	if (typeof s.cloneFromRunId === "string") out.cloneFromRunId = s.cloneFromRunId;
	return out;
}

import type { CreateRunInput } from "@/api/types.ts";

/** The operator-editable workload definition. */
export interface DispatchDraft {
	readonly project: string;
	readonly agent: string;
	readonly prompt: string;
	/** Git ref (branch / tag / SHA); empty = project default branch. */
	readonly ref: string;
	/** Optional tracker item back-link (`runs.seed_id`). */
	readonly seedId: string;
	readonly providerOverride: string;
	readonly modelOverride: string;
	/** Cost cap as free text; parsed to `maxCostUsd` at submit. */
	readonly costCap: string;
}

/** Touched flags stop the per-project default auto-fill per field. */
export interface DispatchTouched {
	readonly agent: boolean;
	readonly prompt: boolean;
	readonly provider: boolean;
	readonly model: boolean;
	readonly costCap: boolean;
}

/** Draft + touched flags travel together through the page's single state. */
export interface DispatchDraftPatch {
	readonly draft: DispatchDraft;
	readonly touched: DispatchTouched;
}

export function initialDraft(state: DispatchRouteState): DispatchDraft {
	return {
		project: state.project ?? "",
		agent: state.agent ?? "",
		prompt: state.prompt ?? "",
		ref: "",
		seedId: state.seedId ?? "",
		providerOverride: "",
		modelOverride: "",
		costCap: "",
	};
}

export function initialTouched(state: DispatchRouteState): DispatchTouched {
	return {
		agent: state.agent !== undefined && state.agent.length > 0,
		prompt: state.prompt !== undefined && state.prompt.length > 0,
		provider: false,
		model: false,
		costCap: false,
	};
}

/** Parse `costCap` into a `maxCostUsd` value. Invalid text returns null. */
export function parseCostCap(text: string): { value: number } | { error: string } | null {
	const trimmed = text.trim();
	if (trimmed.length === 0) return null;
	const value = Number(trimmed);
	if (!Number.isFinite(value) || value <= 0) {
		return { error: "Cost cap must be a positive number." };
	}
	return { value };
}

/**
 * Build the `POST /runs` body from the draft (plus parsed cost cap and
 * continuation/replicate route state). Pure — the page only fires it.
 */
export function buildCreateRunInput(args: {
	readonly draft: DispatchDraft;
	readonly routeState: DispatchRouteState;
	readonly maxCostUsd: number | undefined;
}): CreateRunInput {
	const { draft } = args;
	const trimmedRef = draft.ref.trim();
	const trimmedProvider = draft.providerOverride.trim();
	const trimmedModel = draft.modelOverride.trim();
	const trimmedSeed = draft.seedId.trim();
	return {
		agent: draft.agent,
		project: draft.project,
		prompt: draft.prompt,
		...(trimmedRef.length > 0 ? { ref: trimmedRef } : {}),
		...(trimmedProvider.length > 0 ? { providerOverride: trimmedProvider } : {}),
		...(trimmedModel.length > 0 ? { modelOverride: trimmedModel } : {}),
		...(trimmedSeed.length > 0 ? { seedId: trimmedSeed } : {}),
		...(args.maxCostUsd !== undefined ? { maxCostUsd: args.maxCostUsd } : {}),
		...(args.routeState.continueFromRunId !== undefined
			? { continueFromRunId: args.routeState.continueFromRunId }
			: {}),
		...(args.routeState.cloneFromRunId !== undefined
			? { cloneFromRunId: args.routeState.cloneFromRunId }
			: {}),
	};
}

/**
 * Which source the current provider/model text came from — project
 * default, agent row, or an operator override — for the form hints.
 */
export function resolveDefaultKind(
	value: string,
	projectDefault: string | undefined,
	agentValue: string | null | undefined,
): "project" | "agent" | null {
	if (projectDefault !== undefined && projectDefault === value) return "project";
	if (agentValue !== null && agentValue !== undefined && agentValue === value && value.length > 0) {
		return "agent";
	}
	return null;
}
