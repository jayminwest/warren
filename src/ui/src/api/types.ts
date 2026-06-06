// Wire-side type mirrors. The server returns the `runs.RunRow`,
// `agents.AgentRow`, and `projects.ProjectRow` shapes from drizzle. We
// duplicate them here so the UI doesn't depend on `src/db/schema.ts`
// (root tsconfig excludes `src/ui` deliberately — the boundary is the
// HTTP wire, not a TS import).

export type RunState = "queued" | "running" | "paused" | "succeeded" | "failed" | "cancelled";

export const RUN_TERMINAL_STATES: readonly RunState[] = ["succeeded", "failed", "cancelled"];

/** Failure-cause discriminator for `state:failed` rows (warren-3c40, warren-5165). */
export type RunFailureReason =
	| "never_started"
	| "no_model_response"
	| "crashed"
	| "timed_out"
	| "burrow_run_lost"
	| "dropped_commit";

/**
 * Preview environment lifecycle (R-19 / SPEC §11.L). Null on rows whose
 * project hasn't opted into previews; non-null once reap's
 * `preview_launch` sub-step has fired. See `src/db/schema/columns.ts`.
 */
export type PreviewState = "starting" | "live" | "failed" | "torn-down";

export const PREVIEW_ACTIVE_STATES: readonly PreviewState[] = ["starting", "live"];

export interface AgentRow {
	name: string;
	renderedJson: unknown;
	registeredAt: string;
	lastRefreshed: string;
	/**
	 * Provenance decorated by the server (warren-f6ad / readAgentSource).
	 * R-03 (pl-fef5) widened this from `"builtin" | "library"` to also
	 * include `project:<projectId>` for the per-project `.canopy/` tier;
	 * UI surfaces classify by the `project:` prefix.
	 */
	source?: "builtin" | "library" | `project:${string}`;
}

export interface ProjectRow {
	id: string;
	gitUrl: string;
	localPath: string;
	defaultBranch: string;
	addedAt: string;
	lastFetchedAt: string | null;
	lastHeadSha: string | null;
	/**
	 * Plot opt-in gating flag (warren-4e20). True iff a `.plot/` directory
	 * existed at the clone root the last time addProject or
	 * refreshProjectClone probed it. The dispatch path consumes this to
	 * gate `plot_id` validation and PLOT_ID/PLOT_ACTOR env injection
	 * downstream (warren-a8c3, warren-e26f). No UI surface yet — the
	 * field exists so subsequent plan steps can read it without touching
	 * the wire envelope again.
	 */
	hasPlot: boolean;
	/**
	 * Seeds opt-in gating flag (warren-9990 / pl-a258 step 1). True iff a
	 * `.seeds/` directory existed at the clone root the last time
	 * addProject or refreshProjectClone probed it. The PlanRun API
	 * (warren-f923) reads this server-side to reject plan-run dispatch
	 * against projects without the issue queue; the NewPlanRun form
	 * disables submission when this is false.
	 */
	hasSeeds: boolean;
}

export interface RefreshProjectResponse {
	project: ProjectRow;
	headSha: string;
	ref: string;
}

export interface RunRow {
	id: string;
	agentName: string;
	/**
	 * Null when the project was deleted after the run was created
	 * (warren-5f19). The FK is `ON DELETE SET NULL`, so run history
	 * survives a project delete as orphan rows.
	 */
	projectId: string | null;
	burrowId: string | null;
	burrowRunId: string | null;
	/**
	 * Back-link to the seeds issue this run was dispatched against
	 * (pl-bb70 step 3 / warren-805a). Null encodes "no seed" — manual
	 * prompts from POST /runs without `seedId`, or legacy rows written
	 * before the column existed. Surfaced as a MetaCard on RunDetail so
	 * operators can navigate from a run back to its issue (pl-bb70 step
	 * 6 / warren-c845). R-04 will turn this into a proper hyperlink
	 * when the issues page lands.
	 */
	seedId: string | null;
	/**
	 * Back-link to the Plot this run was dispatched against (warren-a8c3,
	 * parent warren-000b). Null when the project hasn't opted into Plots
	 * (`project.hasPlot` false) or the dispatch omitted plot_id. The
	 * stream envelope mirrors the same field for live consumers.
	 */
	plotId: string | null;
	/**
	 * Continuation back-link (warren-4b11). Set when this run was spawned as
	 * a "re-run with follow-up" of a prior terminal run: its workspace was
	 * seeded from the parent's pushed branch instead of the project default
	 * branch. Null for root runs. The Runs list renders a `↪ from run_xxx`
	 * chain indicator and RunDetail links back to the parent.
	 */
	parentRunId: string | null;
	/**
	 * Chain-kind discriminator (warren-e96f) for a run carrying a
	 * `parentRunId`: `'continue'` (warren-4b11 — workspace seeded from the
	 * parent's pushed branch) vs `'replicate'` (warren-e96f — fresh
	 * re-dispatch of the parent's exact agent/model/project/prompt against
	 * the project default base). Null for root runs.
	 */
	cloneKind: "replicate" | "continue" | null;
	/**
	 * Run mode discriminator (pl-0344 step 1 / warren-67b6, step 4 /
	 * warren-b3b9). `'batch'` is the legacy one-shot dispatch; `'interactive'`
	 * is the respawn-per-turn primitive bound to a Plot. Pinned at row
	 * creation; warren-side only (burrow doesn't know about run mode).
	 */
	mode: "batch" | "interactive";
	renderedAgentJson: unknown;
	state: RunState;
	failureReason: RunFailureReason | null;
	startedAt: string | null;
	endedAt: string | null;
	prompt: string;
	trigger: string;
	/**
	 * URL of the PR reap opened (warren-f6af). Null when reap's `pr_open`
	 * sub-step was skipped (auto-open disabled, no commits, push failed,
	 * branch == defaultBranch) or the GitHub call errored.
	 */
	prUrl: string | null;
	/**
	 * Per-run cost in USD (warren-a7dc). Currently populated only for runs
	 * dispatched against the `pi` runtime — the bridge snapshots
	 * `get_session_stats` at run-start + run-end and persists the delta.
	 * Null for non-pi runtimes and for pi runs whose stats RPC failed.
	 */
	costUsd: number | null;
	/** Input tokens consumed (warren-a7dc); see `costUsd` for nullability. */
	tokensInput: number | null;
	/** Output tokens produced (warren-a7dc); see `costUsd` for nullability. */
	tokensOutput: number | null;
	/** Cache-read tokens (warren-a7dc); see `costUsd` for nullability. */
	tokensCacheRead: number | null;
	/** Cache-write tokens (warren-a7dc); see `costUsd` for nullability. */
	tokensCacheWrite: number | null;
	/**
	 * Per-run preview environment columns (R-19 / SPEC §11.L). All null on
	 * runs whose project hasn't opted into previews; populated by reap's
	 * `preview_launch` sub-step, the readiness probe, the host reverse
	 * proxy (`previewLastHitAt`), and the eviction worker / manual
	 * teardown route.
	 */
	previewState: PreviewState | null;
	previewPort: number | null;
	previewStartedAt: string | null;
	previewLastHitAt: string | null;
	previewFailureMessage: string | null;
}

/**
 * Wire envelope of `POST /runs/:id/preview/teardown` (R-19 / SPEC §11.L,
 * warren-d725). The handler is idempotent and always 200s with a CAS-
 * outcome discriminator: `tornDown: true` only when the call flipped a
 * `starting`/`live` row.
 */
export type PreviewTeardownStatus =
	| "torn-down"
	| "already-torn-down"
	| "already-failed"
	| "never-launched";

export interface PreviewTeardownResponse {
	status: PreviewTeardownStatus;
	tornDown: boolean;
	previousState: PreviewState | null;
	port: number | null;
}

export interface BurrowSummary {
	id: string;
	workspacePath: string;
}

/**
 * Wire-side input for `POST /runs`. `ref` is an optional branch / tag /
 * SHA the project clone should be checked out at before the run; omit
 * (or pass empty) to use `project.defaultBranch` (warren-1bb6, warren-7589).
 *
 * `providerOverride` / `modelOverride` are optional per-run overrides of
 * the agent's `frontmatter.provider` / `frontmatter.model`. Empty strings
 * are ignored. Runtimes that don't understand these fields (e.g.
 * claude-code) drop them silently; pi-style multi-provider runtimes map
 * them onto provider/model CLI flags.
 */
export interface CreateRunInput {
	agent: string;
	project: string;
	prompt: string;
	ref?: string;
	providerOverride?: string;
	modelOverride?: string;
	/**
	 * Optional back-link to the seeds issue this run was dispatched
	 * against (pl-bb70 step 3 / warren-805a). When set, the server
	 * persists it onto `runs.seed_id` and (when a seeds CLI is
	 * configured) writes warren-namespaced extension keys on the seed
	 * after dispatch (pl-bb70 step 4 / warren-46cd).
	 */
	seedId?: string;
	/**
	 * Optional back-link to the Plot this run is dispatched against
	 * (warren-a8c3, parent warren-000b). The server validates that the
	 * project has a `.plot/` directory (`project.hasPlot`); supplying
	 * plot_id for a project without Plots returns a 400 ValidationError.
	 */
	plotId?: string;
	/**
	 * Run mode (pl-0344 step 4 / warren-b3b9). Defaults to `'batch'`
	 * server-side; pass `'interactive'` together with `plotId` to spawn
	 * an interactive turn. `interactiveAgent` may override `agent` when
	 * mode is interactive so a UI surface can flip mode without
	 * re-keying the picker (`agent` stays its batch default).
	 */
	mode?: "batch" | "interactive";
	interactiveAgent?: string;
	dispatcherHandle?: string;
	/**
	 * Optional continuation parent (warren-4b11). When set, the new run is
	 * spawned as a "re-run with follow-up": its workspace is seeded from the
	 * parent's pushed branch instead of the project default branch, and the
	 * link is recorded on `runs.parent_run_id`. The parent must belong to
	 * the same project.
	 */
	continueFromRunId?: string;
}

export interface SpawnRunResponse {
	run: RunRow;
	burrow: BurrowSummary;
}

/**
 * `GET /runs` envelope (warren-ee50 / pl-b0c0 step 1). `runs` is the
 * paginated window; `total`/`costTotalUsd`/`costPricedCount` describe
 * the full filtered set so the Runs page can show all-time totals
 * even when only a window of rows is on screen. `limit`/`offset` echo
 * back the resolved pagination so the UI can render "Showing X–Y of
 * T" against the same numbers the server applied.
 */
export interface ListRunsResponse {
	runs: RunRow[];
	total: number;
	costTotalUsd: number;
	costPricedCount: number;
	limit: number;
	offset: number;
}

/**
 * Body for `POST /runs/:id/messages` (pl-0344 step 4 / warren-b3b9).
 * Sends a follow-up user turn on an interactive conversation. `:id` is
 * any prior interactive run row that shares the conversation's plotId
 * — the server resolves Plot context from disk, not from this row.
 */
export interface SendRunMessageInput {
	message: string;
	ref?: string;
	providerOverride?: string;
	modelOverride?: string;
	dispatcherHandle?: string;
}

/**
 * Wire envelope of `POST /runs/:id/messages`. The server returns 202
 * Accepted with the freshly-spawned turn row + the persisted
 * user_message event; the matching `agent_message` event lands later on
 * the events stream when reap fires.
 */
export interface SendRunMessageResponse {
	run: RunRow;
	burrow: BurrowSummary;
	userMessageEvent: {
		id: number;
		runId: string;
		seq: number;
		ts: string;
		kind: string;
	};
	priorRunId: string;
	plotContextDegraded: boolean;
}

export interface CancelRunResponse {
	state: RunState;
	alreadyTerminal: boolean;
	burrowRun: { state: string } | null;
}

export interface SteerRunResponse {
	message: unknown;
}

export interface RefreshAgentsResponse {
	clone: { localPath: string; head: string };
	registered: { name: string }[];
	skipped: { name: string; reason: string }[];
	removed: { name: string }[];
}

/**
 * Wire envelope of `POST /projects/:id/agents/refresh` (R-03 / pl-fef5
 * step 6). Mirrors `RefreshProjectResult` after server-side decoration:
 * each `registered` row carries the `source: "project:<id>"` provenance
 * stamp. Per-agent failures land in `skipped`; project-tier `removed` is
 * `string[]` because pruning is always-on at this tier (the project's
 * `.canopy/` is authoritative).
 */
export interface RefreshProjectAgentsResponse {
	projectId: string;
	registered: AgentRow[];
	skipped: { name: string; reason: string; code: string }[];
	removed: string[];
}

export interface ReadyCheckResult {
	name: string;
	ok: boolean;
	message?: string;
}

export interface ReadyzResponse {
	ok: boolean;
	checks: ReadyCheckResult[];
}

export interface RunEvent {
	id: number;
	runId: string;
	seq: number;
	ts: string;
	kind: string;
	stream: "stdout" | "stderr" | "system" | null;
	payload: unknown;
	/**
	 * Run-scoped Plot back-link, snapshotted at stream-open time from
	 * `runs.plot_id` (warren-a8c3). Null when the run was dispatched
	 * without a plot_id. Stable across the lifetime of the stream — the
	 * run row's plot_id is set at spawn and never mutates.
	 */
	plotId: string | null;
}

/**
 * Payload shape of the `reap.completed` system event (warren-f3bb,
 * warren-3c40). Fields are typed loosely because the wire is JSON; use
 * narrow guards before reading. `commitsAhead` is null when reap could
 * not compute the count (no `baseBranch`, rev-list failed, or push
 * failed); `0` is the silent-no-op shape (`branchPushed: true` but
 * agent never committed); positive means real work shipped.
 */
export interface ReapCompletedPayload {
	state?: RunState;
	failureReason?: RunFailureReason | null;
	branchPushed?: boolean;
	commitsAhead?: number | null;
	/** PR URL when reap auto-opened one (warren-f6af). */
	prUrl?: string | null;
	mulch?: { updated?: number; skipped?: number; appended?: number };
	seeds?: { closed?: number; committed?: boolean };
	errors?: { step: string; message: string; path?: string }[];
}

export interface ApiErrorEnvelope {
	error: { code: string; message: string; hint?: string };
}

/**
 * Wire envelope of `GET /preview/config` (R-19 / SPEC §11.L path addendum,
 * warren-016d). Deployment-wide preview routing mode + optional host. The
 * UI uses this to render the canonical preview URL in `PreviewCard` so
 * path-mode and subdomain-mode deploys both show a copyable string that
 * matches where the login handshake will redirect.
 *
 * `host === null` in path mode without `WARREN_PREVIEW_HOST` set; the UI
 * falls back to `window.location.origin` (previews ride on the same
 * hostname that serves the API/UI). Subdomain mode always carries `host`
 * because boot rejects that combo when the env var is unset.
 */
export type PreviewMode = "path" | "subdomain";

export interface PreviewConfigResponse {
	mode: PreviewMode;
	host: string | null;
}

/* ----------------------------------------------------------------------- */
/* Per-project `.warren/` config envelope (warren-435b, warren-756a).      */
/*                                                                         */
/* Mirrors src/warren-config/load.ts LoadedWarrenConfig — kept manually    */
/* in sync because src/ui/ is excluded from the root tsconfig and the     */
/* boundary is the HTTP wire, not a TS import (mx-1bd551).                 */
/* ----------------------------------------------------------------------- */

export type WarrenConfigFileErrorCode =
	| "warren_config_parse_error"
	| "warren_config_schema_error"
	| "warren_config_deprecated";

export interface WarrenConfigFileError {
	/** Project-relative path, e.g. `.warren/triggers.yaml`. */
	file: string;
	code: WarrenConfigFileErrorCode;
	message: string;
}

/**
 * Cron trigger entry. The `kind: 'cron'` discriminator leaves room for
 * future webhook-style triggers without a breaking schema rev (mx-3636de).
 */
export interface CronTrigger {
	id: string;
	kind: "cron";
	cron: string;
	seed?: string;
	role: string;
	timezone?: string;
	prompt?: string;
}

export type Trigger = CronTrigger;

export interface InteractiveAgentsConfig {
	brainstormRuntime?: "claude-code" | "sapling" | "pi";
	plannerRuntime?: "claude-code" | "sapling" | "pi";
}

export interface DefaultsConfig {
	defaultRole?: string;
	defaultBranch?: string;
	defaultPrompt?: string;
	/**
	 * warren-618b: per-project default provider/model. Applied at spawn time
	 * with precedence operator override > project default > agent frontmatter.
	 * The NewRun page surfaces these as the provider/model auto-fill when no
	 * per-run override is typed.
	 */
	defaultProvider?: string;
	defaultModel?: string;
	/**
	 * warren-9993: per-project run-branch prefix override. Warren composes
	 * the burrow workspace branch as `${prefix}/${run.id}`; this field is
	 * surfaced read-only on the ProjectDetail config panel so operators can
	 * verify which prefix is in effect.
	 */
	runBranchPrefix?: string;
	/**
	 * warren-b802: per-project override of the burrow runtime backing
	 * the interactive built-in agents (brainstorm / planner).
	 */
	interactiveAgents?: InteractiveAgentsConfig;
	qualityGate?: string;
}

export interface WarrenConfigResponse {
	/** Parsed triggers, or `null` when the file is absent or malformed. */
	triggers: Trigger[] | null;
	/** Parsed defaults, or `null` when the file is absent or malformed. */
	defaults: DefaultsConfig | null;
	/** Per-file failures collected during this load. Empty on full success. */
	errors: WarrenConfigFileError[];
	/**
	 * Non-fatal advisories (warren-5840) — e.g. `defaults.json` deprecation.
	 * Surfaced separately from `errors` so the UI / doctor can render them
	 * as informational instead of failures.
	 */
	warnings: WarrenConfigFileError[];
}

/* ----------------------------------------------------------------------- */
/* Trigger summaries — `GET /projects/:id/triggers` (warren-99c3).         */
/*                                                                         */
/* Joins parsed .warren/triggers.yaml entries with the warren-side         */
/* triggers table state (lastFiredAt, nextFireAt, lastRunId) and a fresh   */
/* croner re-parse so the wire envelope reflects the current expression    */
/* even when the persisted row is stale (mx-a93eb5). `parseError` is       */
/* non-null when croner's strict parse rejects an expression that warren-  */
/* config's loose 5/6-token check accepted.                                */
/* ----------------------------------------------------------------------- */

export interface TriggerSummary {
	id: string;
	kind: "cron";
	cron: string;
	seed?: string;
	role: string;
	timezone?: string;
	prompt?: string;
	lastFiredAt: string | null;
	nextFireAt: string | null;
	lastRunId: string | null;
	parseError: string | null;
}

export interface TriggersResponse {
	triggers: TriggerSummary[];
	errors: WarrenConfigFileError[];
}

/**
 * `GET /projects/:id/seeds/:seedId` — single-seed status read (warren-4015).
 * Mirrors the narrow `{id, status, blockedBy}` envelope warren returns;
 * the wire shape is intentionally minimal because the only consumer
 * (PlotDetail BatchDispatch) just needs `status` to drop closed seeds.
 */
export interface SeedStatusResponse {
	id: string;
	status: string;
	blockedBy: string[];
}

/**
 * `POST /projects/:id/triggers/:triggerId/run` returns the spawned run row
 * plus the burrow summary — same envelope as `POST /runs` (mx-f3b48d).
 */
export interface RunTriggerResponse {
	run: RunRow;
	burrow: BurrowSummary;
}

/* ----------------------------------------------------------------------- */
/* Plan-runs (warren-f923 / warren-a87f, pl-a258).                          */
/*                                                                         */
/* Mirrors the server payload shapes from src/server/handlers/ and the     */
/* drizzle row types in src/db/schema/sqlite.ts. Kept manually in sync     */
/* with the wire — src/ui/ is excluded from the root tsconfig and the      */
/* boundary is the HTTP wire, not a TS import (mx-1bd551).                 */
/* ----------------------------------------------------------------------- */

export type PlanRunState = "queued" | "running" | "succeeded" | "failed" | "cancelled";

export const PLAN_RUN_TERMINAL_STATES: readonly PlanRunState[] = [
	"succeeded",
	"failed",
	"cancelled",
];

export const PLAN_RUN_ACTIVE_STATES: readonly PlanRunState[] = ["queued", "running"];

export type PlanRunChildState =
	| "pending"
	| "dispatched"
	| "running"
	| "pr_open"
	| "merged"
	| "failed"
	| "skipped";

export interface PlanRunRow {
	id: string;
	planId: string;
	projectId: string;
	agentName: string;
	promptTemplate: string;
	ref: string | null;
	providerOverride: string | null;
	modelOverride: string | null;
	dispatcherHandle: string;
	trigger: string;
	state: PlanRunState;
	failureReason: string | null;
	createdAt: string;
	startedAt: string | null;
	endedAt: string | null;
	/**
	 * Back-link to the Plot this PlanRun was dispatched against
	 * (warren-06dc / pl-7937 Phase 2). Null when the project hasn't opted
	 * into Plots (`project.hasPlot` false) or the dispatch omitted plot_id.
	 * Threaded through every child run's spawn so per-child `run_dispatched`
	 * events and PLOT_ID/PLOT_ACTOR env injection light up via the Phase 1
	 * single-run path unchanged.
	 */
	plotId: string | null;
}

export interface PlanRunChildRow {
	planRunId: string;
	seq: number;
	seedId: string;
	runId: string | null;
	state: PlanRunChildState;
	createdAt: string;
	updatedAt: string;
	startedAt: string | null;
	endedAt: string | null;
	prMergedAt: string | null;
	failureReason: string | null;
}

/** `POST /plan-runs` request body (warren-f923). */
export interface CreatePlanRunInput {
	project: string;
	planId: string;
	agent: string;
	promptTemplate?: string;
	ref?: string;
	providerOverride?: string;
	modelOverride?: string;
	dispatcherHandle?: string;
	/**
	 * Optional back-link to the Plot this PlanRun is dispatched against
	 * (warren-06dc / pl-7937 Phase 2). The server validates that the
	 * project has a `.plot/` directory (`project.hasPlot`); supplying
	 * plot_id for a project without Plots returns a 400 with code
	 * `project_lacks_plot`.
	 */
	plotId?: string;
}

/** `POST /plan-runs` 201 response envelope. */
export interface CreatePlanRunResponse {
	planRun: PlanRunRow;
	children: PlanRunChildRow[];
}

/**
 * `GET /plan-runs/:id` envelope — row + children + fanned-out `runs[]`
 * via repos.runs.listByIds so the detail page renders in one round-trip
 * (warren-f923). `runs` excludes children whose `runId` is still null.
 */
export interface PlanRunDetailResponse {
	planRun: PlanRunRow;
	children: PlanRunChildRow[];
	runs: RunRow[];
}

/** `POST /plan-runs/:id/cancel` envelope. */
export interface CancelPlanRunResponse {
	planRun: PlanRunRow;
	cancelledChild: { childSeq: number; runId: string } | null;
	alreadyTerminal: boolean;
}

/**
 * `POST /plot-plan-runs` request body (warren-99b2 / pl-f404 step 3 /
 * SPEC §11.Q). Wire envelope is snake_case; UI camelCase is mapped at
 * the `plotsApi.dispatchSynthesizedPlanRun` boundary.
 */
export interface CreatePlotPlanRunInput {
	plotId: string;
	projectId: string;
	agent: string;
	promptTemplate?: string;
	ref?: string;
	providerOverride?: string;
	modelOverride?: string;
	dispatcherHandle?: string;
}

/**
 * `POST /plot-plan-runs` 201 response envelope. Same `{planRun,
 * children}` shape as `POST /plan-runs` so the navigation target is
 * identical, plus synthesis-specific `synthesizedPlanId` and
 * `parentSeedId` fields the UI can surface for debugging.
 */
export interface CreatePlotPlanRunResponse {
	planRun: PlanRunRow;
	children: PlanRunChildRow[];
	synthesizedPlanId: string;
	parentSeedId: string;
}

/* ----------------------------------------------------------------------- */
/* Plots (warren-4879 / pl-9d6a step 4).                                    */
/*                                                                          */
/* Mirrors the server-side `PlotSummary` shape from `src/plots/types.ts`    */
/* and the `@os-eco/plot-cli` `PlotStatus` literal union. Kept in sync by   */
/* hand because src/ui is excluded from the root tsconfig — the boundary   */
/* is the HTTP wire, not a TS import (mx-7f971c).                          */
/* ----------------------------------------------------------------------- */

/**
 * Plot status enum — mirror of `@os-eco/plot-cli` `PlotStatus`. The five
 * values match the SPEC §6.5 transition whitelist; UI status filter chips
 * iterate `PLOT_STATUSES` so the mirror is the single source of truth on
 * the UI side.
 */
export type PlotStatus = "drafting" | "ready" | "active" | "done" | "archived";

export const PLOT_STATUSES: readonly PlotStatus[] = [
	"drafting",
	"ready",
	"active",
	"done",
	"archived",
];

/**
 * Row shape returned by `GET /plots` (one row per Plot across every
 * project with `hasPlot=true`) and the JSON body of `POST /plots`
 * (warren-c167, warren-194e). Sortable in the UI by `last_event_ts`
 * desc, `name`, or `status`. Field names match the wire envelope
 * verbatim — snake_case on the wire, not the UI's camelCase
 * convention, because the server hands the `PlotSummary` interface
 * straight through to `JSON.stringify`.
 */
export interface PlotSummary {
	id: string;
	name: string;
	status: PlotStatus;
	/** First ~160 chars of `intent.goal`, with ellipsis when truncated. */
	intent_goal_preview: string;
	attachments_count: number;
	/** ISO 8601 timestamp of the most recent event in the Plot's log. */
	last_event_ts: string;
	/** Actor string of the most recent event (e.g. `user:alice`). */
	last_event_actor: string;
	/** Warren project id (`prj_xxx`) the Plot lives in. */
	project_id: string;
	/**
	 * Populated only by `GET /plots?filter=needs_attention` (warren-d693 /
	 * pl-0344 step 9). Ordered non-empty list of reasons the Plot
	 * surfaces in the Needs-you view; absent on the default list.
	 */
	reasons?: NeedsAttentionReason[];
}

/**
 * Canonical "Needs you" signals (mirrors `src/plots/needs-attention.ts`).
 * Order is significant — server returns reasons in this canonical
 * order so badges render consistently.
 */
export const NEEDS_ATTENTION_REASONS = [
	"paused_run",
	"merged_pr_unreviewed",
	"stale_draft",
] as const;
export type NeedsAttentionReason = (typeof NEEDS_ATTENTION_REASONS)[number];

/**
 * Optional partial intent body accepted on `POST /plots`. Every field
 * is optional; omitted fields stay at the `PlotStore.create` defaults
 * (empty string / empty arrays). The UI's New-Plot dialog surfaces
 * `goal` as the only field today; the array fields are reserved for
 * the Plot detail intent editor (warren-bdbf).
 */
export interface CreatePlotIntentPatch {
	goal?: string;
	non_goals?: string[];
	constraints?: string[];
	success_criteria?: string[];
}

/**
 * `POST /plots` request body. `projectId` is the warren project id
 * (the wire envelope's `project_id`); the client serializer rewrites
 * to snake_case so callers can keep the rest of the UI in camelCase.
 * Empty/whitespace-only `name` is rejected by the server; omit the
 * field entirely to accept the `"Untitled Plot"` default.
 */
export interface CreatePlotInput {
	projectId: string;
	name?: string;
	intent?: CreatePlotIntentPatch;
	dispatcherHandle?: string;
}

/** `GET /plots` envelope. */
export interface ListPlotsResponse {
	plots: PlotSummary[];
}

/* ----------------------------------------------------------------------- */
/* Plot detail (warren-961e/896f/e868/589c/e1ac, pl-9d6a steps 8–12).        */
/*                                                                          */
/* Mirrors @os-eco/plot-cli `Intent`, `Attachment`, `PlotEvent` plus the    */
/* server-side per-handler response envelopes. Kept in sync by hand —      */
/* src/ui is excluded from the root tsconfig (mx-7f971c).                  */
/* ----------------------------------------------------------------------- */

export const ATTACHMENT_TYPES = [
	"seeds_issue",
	"mulch_record",
	"agent_run",
	"gh_pr",
	"gh_issue",
	"file",
] as const;
export type AttachmentType = (typeof ATTACHMENT_TYPES)[number];

export interface PlotIntent {
	goal: string;
	non_goals: string[];
	constraints: string[];
	success_criteria: string[];
}

export interface PlotAttachment {
	id: string; // att-NNN
	type: AttachmentType;
	ref: string;
	role: string;
	added_at: string;
	added_by: string;
}

/**
 * One Plot event — discriminated union on `type`. Mirrors the
 * @os-eco/plot-cli `PlotEvent` shape. The UI treats unknown future
 * types as opaque `data: unknown` rather than rejecting on read.
 */
export type PlotEventType =
	| "plot_created"
	| "intent_edited"
	| "status_changed"
	| "attachment_added"
	| "attachment_removed"
	| "run_dispatched"
	| "plan_run_dispatched"
	| "decision_made"
	| "question_posed"
	| "question_answered"
	| "artifact_produced"
	| "note";

export interface PlotEvent {
	type: PlotEventType | string;
	actor: string;
	at: string; // ISO 8601; doubles as the event's stable id (used by
	           // POST /plots/:id/questions/:event_id/answer).
	data: Record<string, unknown>;
}

/**
 * `GET /plots/:id` envelope (warren-961e). The reader sorts the event
 * log by `at` ascending defensively; the UI collapses chains of
 * same-kind same-actor events client-side.
 */
export interface PlotEnvelope {
	id: string;
	name: string;
	status: PlotStatus;
	intent: PlotIntent;
	attachments: PlotAttachment[];
	event_log: PlotEvent[];
	project_id: string;
	/**
	 * Snapshot of warren runs in state=paused bound to this plot.
	 * Sourced from `runs.listByPlotId(plot.id)` filtered to `paused`
	 * at envelope-read time (warren-4ea4 / pl-0344 step 12). Drives
	 * the prominent "Answer & resume" affordance + countdown that
	 * PlotDetail renders below the matching `question_posed` event.
	 * Empty when no paused run exists for the plot.
	 */
	paused_runs: PausedRunInfo[];
}

/**
 * One row of `paused_runs[]` on `PlotEnvelope` (warren-4ea4 /
 * pl-0344 step 12). The shape is the narrow subset PlotDetail needs:
 * the run id (for diagnostics), the `paused_at` ISO timestamp (anchor
 * for the countdown), the `paused_question_event_id` that joins this
 * row to a `question_posed` event in `event_log` (same id contract as
 * the AnswerCard's `:event_id`), and the resolved per-project
 * `agent.pauseTimeoutMs` budget so the UI can render "resumes in
 * N:NN" without re-reading the project config.
 */
export interface PausedRunInfo {
	run_id: string;
	paused_at: string;
	paused_question_event_id: string;
	pause_timeout_ms: number;
}

/**
 * `POST /plots/:id/intent` request body (warren-896f). Flat top-level
 * fields (no `intent:` wrapper, unlike `POST /plots`). Omitted fields
 * are left untouched; an empty patch is accepted as a no-op.
 */
export interface EditPlotIntentInput {
	goal?: string;
	non_goals?: string[];
	constraints?: string[];
	success_criteria?: string[];
	dispatcherHandle?: string;
}

/**
 * `POST /plots/:id/rename` request body (warren-bed0 / pl-b0c0 step 3).
 * `name` is trimmed server-side; an empty-after-trim value is rejected
 * with 400. Renames are allowed in every status — the SPEC §6
 * frozen-at-done rule applies only to the intent body, not the name.
 */
export interface RenamePlotInput {
	name: string;
	dispatcherHandle?: string;
}

/**
 * `POST /plots/:id/status` request body + response envelope
 * (warren-e868). The server validates the SPEC §6.5 transition matrix
 * before delegating to the lib.
 */
export interface ChangePlotStatusInput {
	next: PlotStatus;
	dispatcherHandle?: string;
}
export interface ChangePlotStatusResponse {
	summary: PlotSummary;
	event: PlotEvent;
}

/**
 * `POST /plots/:id/attachments` request body + response envelope
 * (warren-589c). Per-kind ref shape is validated at the server edge.
 */
export interface AttachPlotInput {
	kind: AttachmentType;
	ref: string;
	role?: string;
	dispatcherHandle?: string;
}
export interface AttachPlotResponse {
	envelope: PlotEnvelope;
	attachment: PlotAttachment;
}

/** `DELETE /plots/:id/attachments/:ref` response envelope. */
export interface DetachPlotResponse {
	envelope: PlotEnvelope;
	removed_id: string;
}

/**
 * `POST /plots/:id/attachments/:ref/merge` request body + response
 * envelope (warren-8e39 / pl-0344 step 14).
 *
 * The `merge.kind` discriminant is forwarded verbatim from the server
 * so the UI can render rate-limit + error states without re-parsing.
 */
export type MergeMethod = "merge" | "squash" | "rebase";

export interface MergePlotPrInput {
	mergeMethod?: MergeMethod;
	dispatcherHandle?: string;
}

export type MergePlotPrOutcome =
	| { kind: "merged"; sha: string }
	| { kind: "already_merged" }
	| { kind: "not_mergeable"; message: string }
	| { kind: "not_found"; message: string }
	| { kind: "missing_token"; message: string }
	| { kind: "rate_limited"; message: string; resetAt: string | null }
	| { kind: "network"; message: string }
	| { kind: "http_error"; status: number; message: string };

export interface MergePlotPrResponse {
	envelope: PlotEnvelope;
	merge: MergePlotPrOutcome;
	attachment_id: string;
	refresh_scheduled: boolean;
}

/**
 * `POST /plots/:id/questions/:event_id/answer` request body + response.
 * `eventId` is the targeted `question_posed` event's `at` ISO timestamp.
 */
export interface AnswerPlotQuestionInput {
	eventId: string;
	answer: string;
	dispatcherHandle?: string;
}
/**
 * `POST /brainstorm` request body (pl-0344 step 8 / warren-d22e).
 * Atomically creates a draft Plot in the named project and dispatches
 * the first interactive turn against the built-in `brainstorm` agent
 * (override via `agent`). Returns the new Plot summary + run row.
 */
export interface StartBrainstormInput {
	projectId: string;
	prompt: string;
	name?: string;
	agent?: string;
	dispatcherHandle?: string;
	providerOverride?: string;
	modelOverride?: string;
	ref?: string;
}
export interface StartBrainstormResponse {
	plot: PlotSummary;
	run: RunRow;
	burrow: BurrowSummary;
}

/**
 * Server-side `SuggestedIntent` mirror (pl-0344 step 8 /
 * warren-d22e). Returned by `POST /plots/:id/formalize` as a
 * suggested edit — the UI renders it as a review form and applies
 * via the existing `POST /plots/:id/intent` route on accept.
 */
export interface SuggestedIntent {
	goal: string;
	non_goals: string[];
	constraints: string[];
	success_criteria: string[];
}
export interface FormalizePlotResponse {
	plot_id: string;
	suggested_intent: SuggestedIntent;
	source_message_count: number;
}

export interface AnswerPlotQuestionResponse {
	event: PlotEvent;
}

/* ----------------------------------------------------------------------- */
/* `GET /plots/:id/summary` — curated artifact view (warren-8917 /          */
/* pl-0344 step 15). Institutional-memory projection: formatted intent,    */
/* decisions filtered from the event log by type=decision_made, linked     */
/* PRs + commits, and a curated structural timeline.                       */
/* ----------------------------------------------------------------------- */

export interface PlotSummaryDecision {
	at: string;
	actor: string;
	summary: string;
	rationale?: string;
}

export interface PlotSummaryLinkedPr {
	attachment_id: string;
	ref: string;
	role: string;
	added_at: string;
	added_by: string;
	/** ISO 8601 of the pr_merged note, or null when not merged. */
	merged_at: string | null;
}

export interface PlotSummaryLinkedCommit {
	at: string;
	ref: string;
	actor: string;
}

export interface PlotSummaryLinkedSeed {
	attachment_id: string;
	ref: string;
	role: string;
	added_at: string;
	added_by: string;
}

export type PlotSummaryTimelineKind =
	| "plot_created"
	| "status_changed"
	| "decision_made"
	| "question_posed"
	| "question_answered"
	| "attachment_added"
	| "run_dispatched"
	| "plan_run_dispatched"
	| "artifact_produced";

export interface PlotSummaryTimelineEntry {
	at: string;
	actor: string;
	kind: PlotSummaryTimelineKind;
	label: string;
}

export interface PlotSummaryArtifact {
	id: string;
	name: string;
	status: PlotStatus;
	project_id: string;
	intent: PlotIntent;
	created_at: string;
	last_event_at: string;
	done_at: string | null;
	decisions: PlotSummaryDecision[];
	linked_prs: PlotSummaryLinkedPr[];
	linked_commits: PlotSummaryLinkedCommit[];
	linked_seeds: PlotSummaryLinkedSeed[];
	timeline: PlotSummaryTimelineEntry[];
}

export type PlotSyncResponse =
	| { kind: "no_op" }
	| {
			kind: "synced";
			branch: string;
			prUrl: string;
			prNumber?: number;
			merged: boolean;
	  };

/* ----------------------------------------------------------------------- */
/* Leveret conversations (LEVERET.md §0.5/§0.9, warren-af15/763f).           */
/*                                                                          */
/* Mirrors the `conversations` table wire shape (camelCase drizzle         */
/* $inferSelect) returned by GET /conversations. Kept in sync by hand —    */
/* src/ui is excluded from the root tsconfig (mx-7f971c).                  */
/* ----------------------------------------------------------------------- */

export const CONVERSATION_STATES = ["active", "closed"] as const;
export type ConversationState = (typeof CONVERSATION_STATES)[number];

export interface ConversationRow {
	id: string;
	projectId: string | null;
	plotId: string | null;
	anchoringRunId: string | null;
	status: ConversationState;
	title: string | null;
	createdAt: string;
	lastActivityAt: string;
	closedAt: string | null;
}

export interface ListConversationsFilter {
	/** Narrow to one project. Mutually exclusive with `plot`. */
	project?: string;
	/** Narrow to one Plot. Mutually exclusive with `project`. */
	plot?: string;
	/** Narrow to `active` / `closed`. */
	status?: ConversationState;
}

export interface ListConversationsResponse {
	conversations: ConversationRow[];
}

