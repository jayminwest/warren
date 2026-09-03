/* ----------------------------------------------------------------------- */
/* Canonical wire vocabulary (warren-b229).                                 */
/*                                                                          */
/* Run / preview lifecycle states, the failure-cause discriminator, run     */
/* mode and the inbox classes are DEFINED ONCE in `src/core/wire.ts` and    */
/* re-exported here so the SDK's import surface is unchanged. Never         */
/* redeclare one of these names — `check:wire-types` (warren-d371) fails    */
/* the build if you do.                                                     */
/* ----------------------------------------------------------------------- */
import type {
	ActorKind,
	AgentRow,
	CapabilityName,
	CloneKind,
	ErrorEnvelope,
	EventStream,
	InboxPriority,
	InboxState,
	PreviewState,
	PullRequestLifecycle,
	RunCostBasis,
	RunFailureReason,
	RunMode,
	RunState,
} from "../core/wire.ts";
import type {
	DispatchAnalytics,
	DispatchAnalyticsRow,
	DispatchCountBucket,
} from "../runs/analytics/dispatch-analytics.ts";

export {
	type ActorCapabilities,
	type ActorKind,
	type AgentRow,
	type AgentSource,
	type CapabilityName,
	type CloneKind,
	type EventStream,
	type ForgeErrorKind,
	type InboxState,
	isPullRequestLifecycle,
	isTerminalRunState,
	type PreviewState,
	type PullRequestLifecycle,
	RUN_TERMINAL_STATES,
	type RunCostBasis,
	type RunFailureReason,
	type RunMode,
	type RunState,
	type RunTerminalState,
} from "../core/wire.ts";

/**
 * Identity discriminant reported by `GET /whoami` (warren-e195). Kept as
 * the SDK's published name for this type and derived from `ActorKind`, the
 * canonical spelling in `src/core/wire.ts`, so the two can never disagree.
 * The hand-copied union this replaces had already lost the `run` arm that
 * per-run scoped tokens added (warren-57fd).
 */
export type ActorIdentity = ActorKind;

/**
 * `GET /whoami` — who warren thinks the caller is and what it may do.
 * `capabilities` holds only the granted names, so a client checks
 * membership rather than a boolean flag.
 */
export interface WhoamiResponse {
	identity: ActorIdentity;
	capabilities: CapabilityName[];
}

export interface ListAgentsResponse {
	agents: AgentRow[];
}

export interface ProjectRow {
	id: string;
	gitUrl: string;
	localPath: string;
	defaultBranch: string;
	addedAt: string;
	lastFetchedAt: string | null;
	lastHeadSha: string | null;
	hasSeeds: boolean;
}

export interface RunRow {
	id: string;
	agentName: string;
	projectId: string | null;
	sandboxId: string | null;
	sandboxRunId: string | null;
	seedId: string | null;
	/** Chain back-link (warren-4b11 / warren-e96f); null for root runs. */
	parentRunId: string | null;
	cloneKind: CloneKind | null;
	/** Infra-lost auto-retry back-link (warren-4af7); null for first-attempt runs. */
	retryOf: string | null;
	mode: RunMode;
	renderedAgentJson: unknown;
	state: RunState;
	failureReason: RunFailureReason | null;
	/**
	 * The queued instant as epoch ms (warren-0af9 / pl-103e step 1), stamped
	 * by RunsRepo.create at insert. Null on rows written before the column
	 * existed — read as "unknown", never as zero queue wait.
	 */
	createdAt: number | null;
	startedAt: string | null;
	endedAt: string | null;
	/** Stage timestamps (warren-7116): workspace ready / agent ready (first event, same instant as startedAt) / agent ended (runtime-terminal) / reaped (terminal transition). Null = never observed. */
	workspaceReadyAt: string | null;
	agentReadyAt: string | null;
	agentEndedAt: string | null;
	reapedAt: string | null;
	/**
	 * Reap-time measured outcome facts (warren-ab2b / pl-103e): commits the
	 * pushed branch was ahead of the base, plus the parsed `git diff
	 * --numstat` totals. Null = unknown (pre-column rows, skipped/failed
	 * finalize, unmeasurable diff) — never read null as zero.
	 */
	commitsAhead: number | null;
	filesChanged: number | null;
	insertions: number | null;
	deletions: number | null;
	prompt: string;
	trigger: string;
	prUrl: string | null;
	/**
	 * Merge-watcher PR facts (warren-3bc6 / pl-103e step 6). `prState` is
	 * the forge-reported PR lifecycle; `prMergedAt` its merge instant. Null
	 * on runs that never opened a PR or predate the watcher — read null as
	 * "unknown", never as "not merged".
	 */
	prState: PullRequestLifecycle | null;
	prMergedAt: string | null;
	targetBranch: string | null;
	/**
	 * The composed workspace branch the run's push lands on (warren-5255):
	 * `${runBranchPrefix}/${runId}`, or `targetBranch` when that override
	 * pinned it. Frozen at dispatch. Null on rows predating the column.
	 */
	branch: string | null;
	/** Dispatch-supplied git ref the workspace was cloned from (warren-afeb). Null when unset. */
	ref: string | null;
	/** Base-commit pin (warren-aaf7): 40-hex SHA the workspace was cut at. Null when unset. */
	baseCommit: string | null;
	/**
	 * Declared provider/model frozen at dispatch (warren-2ede / #860).
	 * Null on rows predating the columns — read as "unknown".
	 */
	provider: string | null;
	model: string | null;
	/**
	 * Salvage-before-destroy (warren-cd3b): where a finalize_failed run's
	 * committed work was captured. `salvageRef` is the `warren/rescue/<runId>`
	 * branch on origin; `salvagePath` is the durable git-bundle file. Both null
	 * when no salvage was captured (or none was needed).
	 */
	salvageRef: string | null;
	salvagePath: string | null;
	costUsd: number | null;
	/** How `costUsd` was priced (warren-f3c3): `subscription_estimate` when
	 * the run authenticated via CLAUDE_CODE_OAUTH_TOKEN — an API-priced
	 * estimate, not a bill. `api` otherwise (and for legacy rows). */
	costBasis: RunCostBasis;
	/** Runtime backend kind frozen at dispatch (warren-a0f4):
	 * `local` | `docker` | `k8s`. Operator-only runs-list overlay; absent
	 * for spectators and detail GETs, null when no dispatch-context row. */
	runtimeBackend?: string | null;
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
	stream: EventStream | null;
	payload: unknown;
}

export interface StreamRunEventsOptions {
	/** Keep the connection open and emit new events as they arrive. */
	follow?: boolean;
	/** Replay starting just after this `sandboxEventSeq`. */
	sinceSeq?: number;
	/** External abort signal — closes the underlying HTTP body. */
	signal?: AbortSignal;
}

export type { ErrorEnvelope } from "../core/wire.ts";

/**
 * SDK-compat alias for the canonical error envelope in `src/core/wire.ts`
 * (warren-42f1). Alias, never re-list — `check:wire-types` enforces.
 */
export type ApiErrorEnvelope = ErrorEnvelope;

export interface CreateRunInput {
	// agent/project/prompt: required unless cloneFromRunId is set (warren-e96f).
	agent?: string;
	project?: string;
	prompt?: string;
	ref?: string;
	/** Base-commit pin (warren-aaf7): 40-hex SHA the workspace is cut at; PR base stays `ref`-shaped. */
	baseCommit?: string;
	/** Existing branch to push the workspace back to at reap (warren-05ea / #419). */
	targetBranch?: string;
	/** Opt-in dispatch onto an existing push-remote branch (warren-326f); fail-closed at the server. */
	existingBranch?: string;
	providerOverride?: string;
	modelOverride?: string;
	/** Run trigger label (warren-97a2); defaults to the server's own default when omitted. */
	trigger?: string;
	seedId?: string;
	dispatcherHandle?: string;
	/** Continuation parent (warren-4b11): seed the workspace from this run's branch. */
	continueFromRunId?: string;
	/** Replicate parent (warren-e96f): re-dispatch this run's config against the project base. */
	cloneFromRunId?: string;
	/** Per-run USD spend cap (warren-a63d): wins over the agent's own and the project default. */
	maxCostUsd?: number;
}

/** Ergonomic input for {@link WarrenClient.dispatch}: mirrors {@link CreateRunInput} with
 * `warren run` CLI field names (`model`/`branch`/`provider`), mapped at request time. */
export interface DispatchRunInput {
	agent: string;
	project: string;
	prompt: string;
	/** Maps to CreateRunInput.ref — git branch / ref to clone the workspace from. */
	branch?: string;
	/** Maps to CreateRunInput.baseCommit — 40-hex SHA to pin the workspace cut (warren-aaf7). */
	baseCommit?: string;
	/** Maps to CreateRunInput.targetBranch — branch reap pushes back to (#419). */
	targetBranch?: string;
	/** Maps to CreateRunInput.existingBranch — opt-in existing-branch dispatch (warren-326f). */
	existingBranch?: string;
	/** Maps to CreateRunInput.modelOverride. */
	model?: string;
	/** Maps to CreateRunInput.providerOverride. */
	provider?: string;
	/** Maps to CreateRunInput.trigger (warren-97a2). */
	trigger?: string;
	seedId?: string;
	dispatcherHandle?: string;
	/** Maps to CreateRunInput.continueFromRunId (warren-4b11). */
	continueFromRunId?: string;
	/** Maps to CreateRunInput.cloneFromRunId (warren-e96f). */
	cloneFromRunId?: string;
	/** Maps to CreateRunInput.maxCostUsd — per-run USD spend cap (warren-a63d). */
	maxCostUsd?: number;
}

export interface SpawnRunResponse {
	run: RunRow;
	sandbox: {
		id: string;
		workspacePath: string;
	};
}

/**
 * `GET /runs/:id` response. Detail GETs wrap the resource (warren-7d84):
 * `{run}` here, `{planRun, children, runs}` on `GET /plan-runs/:id`.
 */
export interface GetRunResponse {
	run: RunRow;
}

export interface ListProjectsResponse {
	projects: ProjectRow[];
}

export interface CreateProjectInput {
	gitUrl: string;
	defaultBranch?: string;
}

/** A plan from `GET /projects/:id/ready-plans` — approved, undispatched, ≥1 open child (warren-7937). */
export interface ReadyPlan {
	id: string;
	name?: string;
	status: string;
	openChildCount: number;
}

export interface ListReadyPlansResponse {
	plans: ReadyPlan[];
}

export interface RefreshProjectInput {
	ref?: string;
}

export interface RefreshProjectResponse {
	project: ProjectRow;
	headSha: string;
	ref: string;
}

/**
 * Inbox message priority. Alias of the canonical `InboxPriority`
 * (`src/core/wire.ts`), kept under the SDK's historical name.
 */
export type MessagePriority = InboxPriority;

/** Burrow inbox message row returned by `POST /runs/:id/steer`. */
export interface InboxMessage {
	id: string;
	sandboxId: string;
	fromActor: string;
	body: string;
	priority: InboxPriority;
	state: InboxState;
	deliveredAtRunId: string | null;
	createdAt: string;
	deliveredAt: string | null;
}

export interface SteerRunInput {
	/** Steering body — non-empty after trim. */
	body: string;
	priority?: InboxPriority;
	/** Actor identifier recorded on the burrow message. */
	fromActor?: string;
}

export interface SteerRunResponse {
	message: InboxMessage;
}

/** Input for {@link WarrenClient.cancelRun} (`POST /runs/:id/cancel`). */
export interface CancelRunInput {
	/** Optional operator note recorded on the cancel. */
	reason?: string;
}

/**
 * `POST /runs/:id/cancel` response. `alreadyTerminal` is true when the run
 * had already reached a terminal state, in which case no cancel was issued.
 * `sandboxRun` carries the burrow-side run's `{ id, state }` re-read after the
 * cancel, or null when there was nothing remote to cancel (queued run with
 * no `sandboxRunId`, or already terminal).
 */
export interface CancelRunResponse {
	state: RunState;
	alreadyTerminal: boolean;
	sandboxRun: { id: string; state: RunState } | null;
}

/** `GET /version` — the running warren build's semver. Auth-exempt. */
export interface VersionResponse {
	version: string;
}

export interface ListRunsResponse {
	runs: RunRow[];
	total: number;
	limit: number;
	offset: number;
	costTotalUsd: number | null;
	costPricedCount: number;
}

/* ----------------------------------------------------------------------- */
/* Dispatch-context analytics (warren-5423 / pl-a37b Track A step 5).      */
/* Pure aggregator owns the body shape; re-export so the SDK surface is   */
/* the single consumer-facing name (wire-vocabulary rule).                */
/* ----------------------------------------------------------------------- */
export type { DispatchAnalytics, DispatchAnalyticsRow, DispatchCountBucket };

/** `GET /analytics/dispatch` — filter echo wrapped around the pure rollup. */
export type DispatchAnalyticsResponse = DispatchAnalytics & {
	readonly filter: { projectId: string | null; from: string | null; to: string | null };
};

/* ----------------------------------------------------------------------- */
/* Plan-runs — typed facade over /plan-runs (warren-8ffc).                 */
/* Wire envelope is camelCase, mirroring /runs. Types live in              */
/* `./types.plan-runs.ts` (warren-fcc8); re-exported here for the          */
/* canonical `./types.ts` import surface.                                  */
/* ----------------------------------------------------------------------- */
export * from "./types.plan-runs.ts";
