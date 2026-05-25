export type RunState = "queued" | "running" | "paused" | "succeeded" | "failed" | "cancelled";

export type RunTerminalState = "succeeded" | "failed" | "cancelled";

/** Canonical set of terminal run states. Mirrors src/db/schema.ts RUN_TERMINAL_STATES. */
export const RUN_TERMINAL_STATES: ReadonlySet<RunState> = new Set([
	"succeeded",
	"failed",
	"cancelled",
]);

/** Narrow a RunState to a terminal one. */
export function isTerminalRunState(state: RunState): state is RunTerminalState {
	return RUN_TERMINAL_STATES.has(state);
}

export type RunFailureReason =
	| "never_started"
	| "no_model_response"
	| "crashed"
	| "timed_out"
	| "burrow_run_lost";

export type PreviewState = "starting" | "live" | "failed" | "torn-down";

export type AgentSource = "builtin" | "library" | `project:${string}`;

export interface AgentRow {
	name: string;
	renderedJson: unknown;
	registeredAt: string;
	lastRefreshed: string;
	source?: AgentSource;
}

export interface RefreshSkipped {
	name: string;
	reason: string;
	code: string;
}

export interface CloneResult {
	cloned: boolean;
	localDir: string;
}

export interface ListAgentsQuery {
	projectId?: string;
}

export interface ListAgentsResponse {
	agents: AgentRow[];
}

export interface RefreshProjectAgentsResult {
	projectId: string;
	registered: AgentRow[];
	skipped: RefreshSkipped[];
	removed: string[];
}

export interface ProjectRefreshErrorRow {
	projectId: string;
	code: string;
	message: string;
}

export interface RefreshAgentsResponse {
	clone: CloneResult;
	registered: AgentRow[];
	skipped: RefreshSkipped[];
	removed: string[];
	projects: RefreshProjectAgentsResult[];
	projectErrors: ProjectRefreshErrorRow[];
}

export interface ProjectRow {
	id: string;
	gitUrl: string;
	localPath: string;
	defaultBranch: string;
	addedAt: string;
	lastFetchedAt: string | null;
	lastHeadSha: string | null;
	hasPlot: boolean;
	hasSeeds: boolean;
}

export interface RunRow {
	id: string;
	agentName: string;
	projectId: string | null;
	burrowId: string | null;
	burrowRunId: string | null;
	seedId: string | null;
	plotId: string | null;
	mode: "batch" | "interactive";
	renderedAgentJson: unknown;
	state: RunState;
	failureReason: RunFailureReason | null;
	startedAt: string | null;
	endedAt: string | null;
	prompt: string;
	trigger: string;
	prUrl: string | null;
	costUsd: number | null;
	tokensInput: number | null;
	tokensOutput: number | null;
	tokensCacheRead: number | null;
	tokensCacheWrite: number | null;
	previewState: PreviewState | null;
	previewPort: number | null;
	previewStartedAt: string | null;
	previewLastHitAt: string | null;
	previewFailureMessage: string | null;
}

export interface RunEvent {
	id: number;
	runId: string;
	seq: number;
	ts: string;
	kind: string;
	stream: "stdout" | "stderr" | "system" | null;
	payload: unknown;
	plotId: string | null;
}

export interface ApiErrorEnvelope {
	error: {
		code: string;
		message: string;
		hint?: string;
	};
}

export interface CreateRunInput {
	agent: string;
	project: string;
	prompt: string;
	ref?: string;
	providerOverride?: string;
	modelOverride?: string;
	seedId?: string;
	plotId?: string;
	mode?: "batch" | "interactive";
	interactiveAgent?: string;
	dispatcherHandle?: string;
}

/**
 * Ergonomic input for {@link WarrenClient.dispatch}. Mirrors
 * {@link CreateRunInput} but uses the user-facing field names
 * (`model`, `branch`, `provider`) from `warren run` CLI flags. Mapped
 * onto CreateRunInput at request time.
 */
export interface DispatchRunInput {
	agent: string;
	project: string;
	prompt: string;
	/** Maps to CreateRunInput.ref — git branch / ref to clone the workspace from. */
	branch?: string;
	/** Maps to CreateRunInput.modelOverride. */
	model?: string;
	/** Maps to CreateRunInput.providerOverride. */
	provider?: string;
	seedId?: string;
	plotId?: string;
	mode?: "batch" | "interactive";
	interactiveAgent?: string;
	dispatcherHandle?: string;
}

export interface SpawnRunResponse {
	run: RunRow;
	burrow: {
		id: string;
		workspacePath: string;
	};
}

export interface ListProjectsResponse {
	projects: ProjectRow[];
}

export interface CreateProjectInput {
	gitUrl: string;
	defaultBranch?: string;
}

export interface RefreshProjectInput {
	ref?: string;
}

export interface RefreshProjectResponse {
	project: ProjectRow;
	headSha: string;
	ref: string;
}

export interface ListRunsResponse {
	runs: RunRow[];
	total: number;
	limit: number;
	offset: number;
	costTotalUsd: number | null;
	costPricedCount: number;
}
