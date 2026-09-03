// Wire-side response shapes for warren's HTTP API. The ENUM VOCABULARY (run / plan-run / preview lifecycle states, the
// failure-cause discriminator, run mode, clone kind, event stream) is NOT
// declared here. It is defined once in `src/core/wire.ts` — warren's
// dependency-free kernel — and re-exported below, so the UI and the server
// can never drift the way they did before warren-b229 (a `RunFailureReason`
// missing two live values and a deleted `interactive` run mode).
// `src/ui/tsconfig.app.json` lists `../core/wire.ts` in its
// `include` so the separate `@os-eco/warren-ui` project can see the file.
//
// Only the RESPONSE ENVELOPES below are UI-local, and only because the
// server's row types are drizzle-inferred — importing them would drag
// drizzle and `bun:sqlite` into the browser bundle.

export {
	type AgentRow,
	type AgentSource,
	EVENT_STREAMS,
	type EventStream,
	type ForgeErrorKind,
	isActivePreviewState,
	isPullRequestLifecycle,
	isTerminalPlanRunChildState,
	isTerminalPlanRunState,
	isTerminalRunState,
	PLAN_RUN_ACTIVE_STATES,
	PLAN_RUN_TERMINAL_STATES,
	type PlanRunChildState,
	type PlanRunSource,
	type PlanRunState,
	type PlanRunStateFilter,
	PREVIEW_ACTIVE_STATES,
	type PreviewState,
	type PullRequestLifecycle,
	RUN_STATES,
	RUN_TERMINAL_STATES,
	type RunFailureReason,
	type RunMode,
	type RunState,
} from "../../../core/wire.ts";

import type {
	ActorKind,
	CapabilityName,
	CloneKind,
	ErrorEnvelope,
	EventStream,
	PlanRunChildState,
	PlanRunSource,
	PlanRunState,
	PreviewState,
	PullRequestLifecycle,
	RunCostBasis,
	RunFailureReason,
	RunMode,
	RunState,
} from "../../../core/wire.ts";

export interface ProjectRow {
	id: string;
	gitUrl: string;
	/**
	 * OPTIONAL on the wire: absolute server path, dropped by the public
	 * projection (warren-4f6c / warren-f53e) — test presence, not null.
	 */
	localPath?: string;
	defaultBranch: string;
	addedAt: string;
	lastFetchedAt: string | null;
	lastHeadSha: string | null;
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
	/**
	 * Internal runtime handles, named for burrow but populated by
	 * whichever runtime dispatched the run (warren-0965): burrow
	 * sandbox/run ids under the burrow runtime, the pod name and pod UID
	 * under `WARREN_RUNTIME=k8s` — NOT null there. OPTIONAL on the wire:
	 * the public projection drops both (warren-946f), so consumers must
	 * test presence, not `!== null` (warren-f53e).
	 */
	sandboxId?: string | null;
	sandboxRunId?: string | null;
	/**
	 * Back-link to the seeds issue this run was dispatched against
	 * (pl-bb70 step 3 / warren-805a). Null encodes "no seed" — manual
	 * prompts from POST /runs without `seedId`, or legacy rows. Surfaced
	 * as a MetaCard on RunDetail (pl-bb70 step 6 / warren-c845).
	 */
	seedId: string | null;
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
	cloneKind: CloneKind | null;
	/** Infra-lost auto-retry back-link (warren-4af7); null for first-attempt runs. */
	retryOf: string | null;
	/**
	 * Run mode discriminator (pl-0344 step 1 / warren-67b6). Pinned at row
	 * creation; warren-side only (burrow doesn't know about run mode).
	 * `batch` is the only member today.
	 */
	mode: RunMode;
	renderedAgentJson: unknown;
	state: RunState;
	failureReason: RunFailureReason | null;
	/**
	 * The queued instant as epoch ms (warren-0af9 / pl-103e step 1). Null on
	 * rows written before the column existed — render as "unknown", never as
	 * zero queue wait.
	 */
	createdAt: number | null;
	startedAt: string | null;
	endedAt: string | null;
	/**
	 * Reap-time measured outcome facts (warren-ab2b / pl-103e): commits the
	 * pushed branch was ahead of the base, plus the parsed diff totals.
	 * Null = unknown (pre-column rows, unmeasured finalize) — render as
	 * "unknown", never as zero.
	 */
	commitsAhead: number | null;
	filesChanged: number | null;
	insertions: number | null;
	deletions: number | null;
	prompt: string;
	trigger: string;
	/**
	 * URL of the PR reap opened (warren-f6af). Null when reap's `pr_open` sub-step
	 * was skipped or the GitHub call errored.
	 */
	prUrl: string | null;
	/**
	 * Merge-watcher PR facts (warren-3bc6): forge-reported lifecycle + merge
	 * instant. Null reads as "unknown" (historical rows, no PR), never "not merged".
	 */
	prState: PullRequestLifecycle | null;
	prMergedAt: string | null;
	/** Existing branch reap pushes the workspace back to (#419). Null when unset. */
	targetBranch: string | null;
	branch: string | null; // composed workspace branch frozen at dispatch (warren-5255)
	/** Dispatch-supplied clone ref (warren-afeb) / base-commit pin (warren-aaf7). Null when unset. */
	ref: string | null;
	baseCommit: string | null;
	/** Declared provider/model frozen at dispatch (warren-2ede / #860). Null = predates the columns. */
	provider: string | null;
	model: string | null;
	/** Salvage-before-destroy (warren-cd3b): rescue branch + git bundle of a finalize_failed run's work. */
	salvageRef: string | null;
	salvagePath: string | null;
	/** Per-run cost in USD (warren-a7dc), the bridge's `get_session_stats` start/end delta. Null for non-pi runtimes. */
	costUsd: number | null;
	costBasis: RunCostBasis; // warren-f3c3: `subscription_estimate` = estimate, not a bill
	maxCostUsd?: number | null; // warren-f8a2: runs-list cap overlay; absent for spectators and detail GETs
	runtimeBackend?: string | null; // warren-a0f4: local|docker|k8s frozen at dispatch; operator-only overlay beside maxCostUsd
	/** Input/output tokens consumed/produced (warren-a7dc); see `costUsd` for nullability. */
	tokensInput: number | null;
	tokensOutput: number | null;
	/** Cache-read tokens (warren-a7dc); see `costUsd` for nullability. */
	tokensCacheRead: number | null;
	/** Cache-write tokens (warren-a7dc); see `costUsd` for nullability. */
	tokensCacheWrite: number | null;
	/**
	 * Per-run preview environment columns (R-19 / docs/design/preview-environments.md). All null on
	 * runs whose project hasn't opted into previews; populated by reap's
	 * `preview_launch` sub-step, the readiness probe, the host reverse
	 * proxy (`previewLastHitAt`), and the eviction worker / manual
	 * teardown route.
	 */
	previewState: PreviewState | null;
	previewPort: number | null;
	previewStartedAt: string | null;
	previewLastHitAt: string | null;
	/**
	 * OPTIONAL on the wire: free text carrying a subprocess stderr tail, so
	 * the public projection drops it (warren-946f / warren-f53e).
	 */
	previewFailureMessage?: string | null;
}

/**
 * Wire envelope of `POST /runs/:id/preview/teardown` (R-19 / docs/design/preview-environments.md,
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

/**
 * Wire envelope of `POST /runs/:id/preview/login` (R-19 / docs/design/preview-environments.md,
 * warren-e1b0). The credential-bearing half of the handshake is the
 * `Set-Cookie` header; `url` is the mode-correct preview target.
 */
export interface PreviewLoginResponse {
	url: string;
}

export interface SandboxSummary {
	id: string;
	workspacePath: string;
}

/**
 * Wire-side input for `POST /runs`. `ref` is an optional branch name the clone
 * is cut at (pin a commit with `baseCommit`, warren-aaf7); omit to use
 * `project.defaultBranch` (warren-1bb6, warren-7589).
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
	baseCommit?: string;
	/** Existing branch reap pushes the workspace back to (#419). */
	targetBranch?: string;
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
	/** Run mode (pl-0344 step 1 / warren-67b6). Defaults to `'batch'` server-side. */
	mode?: RunMode;
	dispatcherHandle?: string;
	/**
	 * Optional continuation parent (warren-4b11). When set, the new run is
	 * spawned as a "re-run with follow-up": its workspace is seeded from the
	 * parent's pushed branch instead of the project default branch, and the
	 * link is recorded on `runs.parent_run_id`. The parent must belong to
	 * the same project.
	 */
	continueFromRunId?: string;
	/**
	 * Optional replicate parent (warren-e96f): re-dispatch this run's exact
	 * agent / model / project / prompt / cap against the project default
	 * base. Mutually exclusive with `continueFromRunId` (continuation wins
	 * server-side).
	 */
	cloneFromRunId?: string;
	/**
	 * Optional per-run USD spend cap (warren-a63d): wins over the agent's
	 * own `frontmatter.maxCostUsd` and the project's `.warren/config.yaml`
	 * default. Must be a positive finite number; the server rejects zero,
	 * negatives, and numeric strings.
	 */
	maxCostUsd?: number;
}

export interface SpawnRunResponse {
	run: RunRow;
	sandbox: SandboxSummary;
}

/**
 * `GET /runs` envelope (warren-ee50 / pl-b0c0 step 1). `runs` is the
 * paginated window; `total`/`costTotalUsd`/`costPricedCount` describe
 * the full filtered set so the Runs page can show all-time totals
 * even when only a window of rows is on screen. `limit`/`offset` echo
 * back the resolved pagination so the UI can render "Showing X–Y of
 * T" against the same numbers the server applied.
 *
 * `costTotalUsd` is OPTIONAL: it is the instance-wide all-time spend and
 * the public projection drops it (warren-946f), so a spectator's envelope
 * has no such key. Callers must render on presence — coalescing to 0 would
 * print a confident "total: $0.00" (warren-f53e).
 */
export interface ListRunsResponse {
	runs: RunRow[];
	total: number;
	costTotalUsd?: number;
	costPricedCount: number;
	limit: number;
	offset: number;
}

export interface CancelRunResponse {
	state: RunState;
	alreadyTerminal: boolean;
	sandboxRun: { state: string } | null;
}

export interface SteerRunResponse {
	message: unknown;
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
	stream: EventStream | null;
	payload: unknown;
}

/**
 * One slim line on the global lifecycle stream (`GET /events/stream`,
 * warren-f566): a pure invalidation hint — the server carries no replay,
 * so the consumer re-reads its list queries on receipt. `state` is the
 * run's best-known state after the transition, or null if no change.
 */
export interface LifecycleStreamNotification {
	runId: string;
	hook: string;
	state: RunState | null;
	ts: string;
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

export type { ErrorEnvelope } from "../../../core/wire.ts";

/**
 * UI-compat alias for the canonical error envelope in `src/core/wire.ts`
 * (warren-42f1). Alias, never re-list — `check:wire-types` enforces.
 */
export type ApiErrorEnvelope = ErrorEnvelope;

/* ----------------------------------------------------------------------- */
/* Caller identity — `GET /whoami` (warren-e195).                          */
/*                                                                         */
/* `ActorKind` and `CapabilityName` are declared once in src/core/wire.ts  */
/* (warren-3754) and re-exported here, the way this file already treats    */
/* the rest of the wire vocabulary. The hand-kept copies they replace had  */
/* already lost the `run` arm that per-run scoped tokens added.            */
/* ----------------------------------------------------------------------- */

export type { ActorCapabilities, ActorKind, CapabilityName } from "../../../core/wire.ts";

/**
 * Who warren admitted this browser as. Kept as the UI's own spelling and
 * derived from `ActorKind`, so the two can never disagree.
 */
export type ActorIdentity = ActorKind;

/**
 * Wire envelope of `GET /whoami`. `capabilities` lists only the granted
 * names, so the UI checks membership rather than a boolean flag. Under the
 * default `WARREN_AUTH=token` the route 401s a browser with no stored
 * token, which the existing `UnauthorizedError` path already handles.
 */
export interface WhoamiResponse {
	identity: ActorIdentity;
	capabilities: CapabilityName[];
}

/**
 * Wire envelope of `GET /preview/config` (R-19 / docs/design/preview-environments.md path addendum,
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
	/**
	 * Public port of the dedicated path-mode preview listener
	 * (warren-3f8a): path-mode previews live on their own browser origin
	 * (same hostname, this port). Null in subdomain mode and on legacy
	 * same-origin deployments — the URL then keeps the inbound port.
	 */
	port: number | null;
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
	qualityGate?: string;
	/**
	 * warren-a63d: project-wide default per-run USD spend cap, the weakest
	 * source in the cap chain (dispatch override > agent frontmatter > this).
	 * Surfaced read-only on the ProjectDetail config panel.
	 */
	maxCostUsd?: number;
}

export interface WarrenConfigResponse {
	/** Parsed triggers, or `null`; absent on the readPublic envelope (warren-b754). */
	triggers?: Trigger[] | null;
	/** Parsed defaults, or `null` when the file is absent or malformed. */
	defaults: DefaultsConfig | null;
	/**
	 * Path of the config source file that was loaded (`.warren/config.yaml`
	 * or the legacy `.warren/defaults.json`), or `null` when neither exists.
	 */
	sourceFile: string | null;
	/** Per-file failures; empty on success, absent on the readPublic envelope. */
	errors?: WarrenConfigFileError[];
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
	/** warren-a63d: the entry's per-run spend cap, surfaced so operators can verify it. */
	maxCostUsd?: number;
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
 * just needs `status` to drop closed seeds.
 */
export interface SeedStatusResponse {
	id: string;
	status: string;
	blockedBy: string[];
}

/**
 * `GET /projects/:id/seeds/plans` — wire-lean seeds plan summary
 * (warren-9b49 / pl-dfb5 step 3). Canonical declaration lives in
 * `src/core/wire-tracker.ts` (warren-6c29); re-exported here so the
 * browser bundle cannot drift from the server truth. The heavyweight
 * `sections` body is dropped server-side because the only consumer (the
 * plan-run dispatch form's plan-id selector) just needs a label and
 * status.
 */
import type { PlanSummary } from "../../../core/wire.ts";

export type { PlanSummary };

export interface SeedPlansResponse {
	plans: PlanSummary[];
}

/**
 * A plan surfaced by `GET /projects/:id/ready-plans` — approved, with at
 * least one open child seed, and not yet dispatched (warren-7937).
 */
export interface ReadyPlan {
	id: string;
	name?: string;
	status: string;
	/** Number of child seeds that are still open (non-closed). */
	openChildCount: number;
}

export interface ReadyPlansResponse {
	plans: ReadyPlan[];
}

/**
 * `POST /projects/:id/triggers/:triggerId/run` returns the spawned run row
 * plus the burrow summary — same envelope as `POST /runs` (mx-f3b48d).
 */
export interface RunTriggerResponse {
	run: RunRow;
	sandbox: SandboxSummary;
}

/* ----------------------------------------------------------------------- */
/* Plan-runs (warren-f923 / warren-a87f, pl-a258).                          */
/*                                                                         */
/* Mirrors the server payload shapes from src/server/handlers/ and the     */
/* drizzle row types in src/db/schema/sqlite.ts. The lifecycle vocabulary  */
/* (`PlanRunState`, `PlanRunChildState`, and their terminal/active sets)   */
/* is re-exported from `src/core/wire.ts` at the top of this file.         */
/* ----------------------------------------------------------------------- */

export interface PlanRunRow {
	id: string;
	/** Null on the warren-de42 `issues` form (source: 'plan' | 'issues'). */
	planId: string | null;
	source: PlanRunSource;
	projectId: string;
	agentName: string;
	/** Optional: redacted on the spectator projection (REDACTED_PLAN_RUN_FIELDS). */
	promptTemplate?: string;
	ref: string | null;
	providerOverride?: string | null;
	modelOverride?: string | null;
	/** warren-a63d per-child USD cap; optional: spectator-redacted field. */
	maxCostUsd?: number | null;
	dispatcherHandle?: string;
	trigger: string;
	state: PlanRunState;
	failureReason?: string | null;
	createdAt: string;
	startedAt: string | null;
	endedAt: string | null;
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
	/** Optional: redacted on the spectator projection (REDACTED_PLAN_RUN_CHILD_FIELDS). */
	failureReason?: string | null;
	/** warren-6de9: automatic child re-dispatch budget consumed so far. */
	retryCount: number;
}

/** `POST /plan-runs` request body (warren-f923). Exactly one of `planId` / `issues` (warren-de42). */
export interface CreatePlanRunInput {
	project: string;
	planId?: string;
	/** warren-de42: ordered issue-id list; the tracker need not support plans. */
	issues?: string[];
	agent: string;
	promptTemplate?: string;
	ref?: string;
	providerOverride?: string;
	modelOverride?: string;
	/** Per-child USD spend cap (warren-a63d); same validation as `POST /runs` maxCostUsd. */
	maxCostUsd?: number;
	dispatcherHandle?: string;
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

/* ----------------------------------------------------------------------- */
/* Run-analytics token types (warren-3be4 / pl-d1a2 step 3).               */
/*                                                                          */
/* Mirrors the server-side shapes from src/runs/analytics/run-metrics.ts   */
/* and src/server/handlers/runs/analytics.ts. Kept in sync by hand —       */
/* src/ui is excluded from the root tsconfig and the boundary is the HTTP  */
/* wire, not a TS import (mx-1bd551).                                       */
/* ----------------------------------------------------------------------- */

/**
 * Aggregate token counts by kind (input, output, cache-read, cache-write)
 * plus a pre-computed total. All values are non-negative integers; zero
 * means no token data for the window (not null — the server always zeroes
 * empty windows rather than omitting the field).
 */
export interface TokenBreakdown {
	readonly input: number;
	readonly output: number;
	readonly cacheRead: number;
	readonly cacheWrite: number;
	readonly total: number;
}

/** One calendar-day's token counts in an overall time-series. `date` is YYYY-MM-DD. */
export interface TokenDayBucket {
	readonly date: string;
	readonly input: number;
	readonly output: number;
	readonly cacheRead: number;
	readonly cacheWrite: number;
	readonly total: number;
}

/**
 * One key's (model or provider) daily token series in a per-dimension
 * breakdown. `key` may be the `__none__` or `__other__` sentinel — see
 * `RUN_ANALYTICS_NONE_KEY` / `RUN_ANALYTICS_OTHER_KEY` in client.ts.
 */
export interface DimensionTokenSeries {
	readonly key: string;
	readonly series: readonly TokenDayBucket[];
}

/**
 * The `tokens` section of `GET /analytics/runs` (warren-1244 / pl-d1a2
 * step 2). Carries aggregate totals, per-model/per-provider roll-ups,
 * and three time-series (overall + by-model + by-provider) all within
 * the same filter window applied to the rest of the response.
 */
export interface RunAnalyticsTokensSection {
	/** Aggregate token totals across the entire filter window. */
	readonly totals: TokenBreakdown;
	/** Per-model aggregate totals, sorted by total tokens desc. */
	readonly byModel: readonly { readonly key: string; readonly tokens: TokenBreakdown }[];
	/** Per-provider aggregate totals, sorted by total tokens desc. */
	readonly byProvider: readonly { readonly key: string; readonly tokens: TokenBreakdown }[];
	/** Overall daily token time-series (one bucket per calendar day). */
	readonly timeSeries: readonly TokenDayBucket[];
	/** Per-model daily series, top-5 by total + OTHER_KEY fold + NONE_KEY. */
	readonly byModelTimeSeries: readonly DimensionTokenSeries[];
	/** Per-provider daily series, top-5 by total + OTHER_KEY fold + NONE_KEY. */
	readonly byProviderTimeSeries: readonly DimensionTokenSeries[];
}
