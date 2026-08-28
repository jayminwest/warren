/**
 * Shared types for the spawn flow. Kept in their own module so the
 * source files (`dispatch.ts`, `seed-extensions.ts`,
 * `agent-cache.ts`) and their tests can import the input/result shapes
 * without dragging in the full `spawnRun` implementation graph.
 */

import type { Repos } from "../../db/repos/index.ts";
import type { CloneKind, RunMode, RunRow } from "../../db/schema.ts";
import type { SpawnFn as ProjectSpawnFn } from "../../projects/clone.ts";
import type { ProjectsConfig } from "../../projects/config.ts";
import type { refreshProject } from "../../projects/manage.ts";
import type { AgentDefinition } from "../../registry/schema.ts";
import type { RuntimeProvider } from "../../runtime/contract.ts";
import type { SeedsCliDeps } from "../../seeds-cli/index.ts";
import type { WarrenConfigCache } from "../../warren-config/index.ts";
import type { GitSpawnCredential } from "../../workspace/git/credential-env.ts";
import type { MigrationHealFn } from "./migration-preflight.ts";

/**
 * Narrow structured logger for the spawn flow (warren-c686 / pl-f700
 * step 1). Pino-shaped so the HTTP handler can hand down its per-request
 * child logger (already bound with `request_id` via warren-30af) and
 * `spawnRun` re-binds `run_id` on top. Optional on the input — legacy
 * callers and tests that don't wire a logger fall back to a no-op, so
 * instrumentation never changes control flow.
 */
export interface SpawnLogger {
	info(obj: object, msg?: string): void;
	warn(obj: object, msg?: string): void;
	error(obj: object, msg?: string): void;
	/** warren-6234: optional debug channel for capability-gated skips. */
	debug?(obj: object, msg?: string): void;
	child?(bindings: object): SpawnLogger;
}

/**
 * Explicit dispatch provenance for the dispatch-context log
 * (warren-9ce3 / pl-a37b Track A). Closed vocabulary stamped at every
 * production `spawnRun` call site. Distinct from `runs.trigger`: both
 * retry paths inherit the original run's trigger, so deriving origin
 * from trigger is lossy. Underscore spellings match the issue surface
 * warren-d6ca will persist; they deliberately differ from the
 * hyphenated `RUN_TRIGGER_KINDS` column values.
 */
export const DISPATCH_ORIGINS = [
	"api",
	"cli",
	"cron",
	"scheduled",
	"manual_trigger",
	"ci_fixer",
	"healer",
	"plan_run",
	"retry_infra_lost",
	"retry_provider",
] as const;
export type DispatchOrigin = (typeof DISPATCH_ORIGINS)[number];

export interface SpawnRunInput {
	readonly repos: Repos;
	/**
	 * Runtime-provider seam (warren-c42c: burrow-client eviction, bucket 2).
	 * `spawnRun` dispatches EXCLUSIVELY through `provider.create(spec)` — the
	 * single call that collapses burrow's `sandboxUp` + `runs.create` (and, on
	 * a partial failure, owns the sandbox-half teardown). Required: the spawn
	 * path no longer knows about burrow, so callers resolve the boot-selected
	 * provider (`resolveRuntimeProvider`, honoring `WARREN_RUNTIME`) and thread
	 * it here. LocalProvider (default) wraps burrow; K8sProvider runs a pod.
	 */
	readonly runtimeProvider: RuntimeProvider;
	readonly agentName: string;
	readonly projectId: string;
	readonly prompt: string;
	readonly trigger?: string;
	/**
	 * Optional seeds issue id this run was dispatched against (pl-bb70
	 * step 3, warren-805a). Persisted on the runs row as `seed_id`, so
	 * the post-dispatch `updateExtensions` write (pl-bb70 step 4) has a
	 * seed to merge `{role, trigger, lastRunId, lastRunAt}` into and the
	 * Run API can surface a back-link on RunDetail (pl-bb70 step 6).
	 * Manual prompts and legacy callers leave it undefined → null on disk.
	 */
	readonly seedId?: string;
	/**
	 * Run mode (pl-0344 step 1 / warren-67b6).
	 * `batch` (default) is the historical single-shot run; `conversation`
	 * anchors a long-lived pi-chat session. Persisted to
	 * `runs.mode` and fixed at row creation;
	 * forwarded onto the burrow up call unchanged (burrow has no notion of
	 * mode — the discriminator is warren-side only).
	 */
	readonly mode?: RunMode;
	readonly metadata?: unknown;
	/**
	 * Optional per-run override of the agent's `frontmatter.provider`. When
	 * set (and non-empty), the spawn composer folds it onto the frozen
	 * agent definition before persisting `runs.rendered_agent_json`. Empty
	 * / whitespace-only values are ignored — same shape as `ref`.
	 */
	readonly providerOverride?: string;
	/** Optional per-run override of the agent's `frontmatter.model`. */
	readonly modelOverride?: string;
	/**
	 * Per-trigger / per-dispatch spend cap (warren-a63d). Set by a
	 * `.warren/triggers.yaml` cron entry or a `POST /runs` `maxCostUsd`
	 * body field. When set, the spawn composer folds it onto
	 * `frontmatter.maxCostUsd` (overriding the agent's own value) before
	 * freezing `runs.rendered_agent_json`, so the bridge enforces a single
	 * override > agent precedence cap. Omitted for runs with no explicit
	 * cap — the agent's own `maxCostUsd` (or, failing that, the project's
	 * `.warren/config.yaml` `maxCostUsd` default) still applies.
	 */
	readonly maxCostUsdOverride?: number;
	readonly now?: () => Date;
	/**
	 * Refresh the project's on-disk clone before provisioning burrow.
	 * Without this, every run reuses the registration-time commit
	 * forever (warren-1bb6). Required for spawnRun to pick up new
	 * commits without DELETE + POST /projects.
	 *
	 * Skipped if `projectsConfig` and `projectSpawn` aren't both wired.
	 * Tests that don't care about refresh can leave them off; the HTTP
	 * server passes both.
	 */
	readonly projectsConfig?: ProjectsConfig;
	readonly projectSpawn?: ProjectSpawnFn;
	/**
	 * GitHub credential for the pre-dispatch refresh's `git fetch`
	 * against a private repo (minted per-spawn via
	 * `mintGitCredential`, forwarded to `refreshProject`).
	 * Absent → anonymous.
	 */
	readonly gitCredential?: GitSpawnCredential;
	/** Branch, tag, or SHA to refresh to. Defaults to the project's tracked default branch. */
	readonly ref?: string;
	/**
	 * Base-commit pin (warren-aaf7): a full 40-hex commit SHA the workspace
	 * is cut at. Overrides `ref` (and the continuation parent branch) for the
	 * workspace materialization ONLY — the PR base stays `ref`-shaped, so a
	 * SHA never reaches the GitHub PR call. Persisted on `runs.base_commit`.
	 */
	readonly baseCommit?: string;
	/**
	 * Continuation parent (warren-4b11). When set, this run is a "re-run with
	 * follow-up" of a prior terminal run: its workspace is seeded from the
	 * parent's pushed branch (`${prefix}/${parentRunId}`) instead of the
	 * project default branch, and the link is recorded on `runs.parent_run_id`.
	 * The parent must belong to the same project. Empty / unset → a root run.
	 * Overrides `ref` when both are provided — the continuation base wins.
	 */
	readonly parentRunId?: string;
	/**
	 * Chain-kind discriminator (warren-e96f) for a run carrying `parentRunId`.
	 * Defaults to `continue` (warren-4b11 semantics: seed the workspace from
	 * the parent's pushed branch) so existing continuation callers are
	 * unchanged. `replicate` flips the base-ref resolution to the caller's
	 * explicit `ref` (or the project default branch) instead of the parent's
	 * pushed branch — a fresh re-dispatch of the parent's config that is
	 * independent of whatever the parent did. Persisted to `runs.clone_kind`.
	 * Ignored when `parentRunId` is unset (root run → null clone_kind).
	 */
	readonly cloneKind?: CloneKind;
	/**
	 * Infra-lost auto-retry back-link (warren-4af7). Set only by the
	 * run-level retry path (`src/runs/retry/infra-lost-retry.ts`): this run is the single
	 * automatic re-dispatch of a run that terminalized `failed` with an
	 * infra-lost failure reason (`sandbox_run_lost`). Persisted to
	 * `runs.retry_of`; the retry budget reads it (a run carrying `retryOf`
	 * never earns a further automatic retry). Distinct from `parentRunId`:
	 * no continuation base-ref semantics — the retry re-dispatches the same
	 * prompt against the same ref.
	 */
	readonly retryOf?: string;
	/**
	 * Existing branch the run must push to instead of the composed
	 * `${prefix}/${runId}` (warren-a993). The CI-fixer poller sets this to
	 * the PR head branch so the fixer's commits push to the open PR and its
	 * CI re-runs, rather than opening a fresh `${prefix}/run_xxx` branch (and
	 * a second PR). A non-empty value short-circuits the prefix composition
	 * (see `composeRunBranch`); empty / whitespace-only falls back to the
	 * composed branch so a stray override can never strand the spawn on a
	 * blank ref. Pairs with `parentRunId` (`cloneKind: "continue"`) so the
	 * workspace also forks from that same branch tip.
	 */
	readonly targetBranch?: string;
	/**
	 * Opt-in dispatch onto an EXISTING branch (warren-326f). When set, the
	 * branch must already exist on the push remote (verified before any side
	 * effect; a missing branch is a fail-closed 400), the workspace is cut
	 * from its remote tip, and reap pushes back to the same branch with no
	 * PR. Formalized as ref + targetBranch on the run row, so providers and
	 * reap need no special-casing. Mutually exclusive with `ref`,
	 * `targetBranch`, and `parentRunId`. Default dispatches (field absent)
	 * are byte-identical to the composed `${prefix}/${runId}` path.
	 */
	readonly existingBranch?: string;
	/** Override the project refresher; defaults to `refreshProject`. */
	readonly refreshProjectFn?: typeof refreshProject;
	/**
	 * Optional warren-config cache. Forwarded into the pre-spawn refresh
	 * so a run that updates the working tree also invalidates any cached
	 * `.warren/` envelope (pl-5d74 risk #4). Tests that don't exercise
	 * the cache can omit.
	 */
	readonly warrenConfigs?: WarrenConfigCache;
	/**
	 * Deployment-wide run-branch prefix fallback (warren-9993), resolved
	 * from `WARREN_RUN_BRANCH_PREFIX` by the caller. Project-default
	 * (`.warren/defaults.json.runBranchPrefix`) wins over this when both
	 * are set; if neither is set, spawnRun falls back to the built-in default
	 * ("warren").
	 */
	readonly runBranchPrefixDefault?: string;
	/**
	 * Server-process environment used to derive the warren API callback
	 * vars injected into the sandbox (`WARREN_API_TOKEN` + `WARREN_API_URL`,
	 * warren-f248). Defaults to `process.env` when omitted, so production
	 * call sites need not thread it; tests substitute a fixture env to
	 * assert the injected (or skipped) callback credential without touching
	 * the real process environment.
	 */
	readonly serverEnv?: Readonly<Record<string, string | undefined>>;
	/**
	 * Seeds CLI shell-out deps for the post-dispatch extension write
	 * (pl-bb70 step 4, warren-46cd). When both `seedId` and this are
	 * provided, spawnRun fires a single `sd update --extensions` after
	 * `attachBurrow(sandboxRunId)` succeeds, merging `{role, trigger,
	 * lastRunId, lastRunAt}` onto the seed. Failure is fire-and-log
	 * (mirrors the pl-2f15 risk #4 mitigation in src/triggers/tick.ts):
	 * a `seeds_extension_write_failed` system event lands on the run,
	 * the run does NOT roll back. Omit on call sites that don't ship a
	 * project clone (CLI run, tests) — without it, the extension write
	 * is a no-op even when seedId is set.
	 */
	readonly seedsCli?: SeedsCliDeps;
	/**
	 * Boot-resolved IssueTracker (warren-5819, pl-a37b Track B). The
	 * post-dispatch extension write routes through `tracker.mergeIssueMetadata`
	 * (warren-6234); when omitted but `seedsCli` is wired, spawnRun wraps the
	 * facade in a SeedsTracker so legacy callers keep the write. Tests may
	 * omit both.
	 */
	readonly issueTracker?: import("../../tracker/contract.ts").IssueTracker;
	/**
	 * Handle of the user dispatching the run (warren-e848). Persisted onto
	 * plan-run bookkeeping; carried through unchanged by the spawn flow.
	 * Read by {@link spawnRun} so the dispatch-context writer (warren-d6ca)
	 * can stamp who dispatched without a second pass over the input.
	 */
	readonly dispatcherHandle?: string;
	/**
	 * Explicit dispatch provenance (warren-9ce3 / pl-a37b Track A).
	 * Who/what kicked this run off — distinct from `trigger`, which both
	 * retry paths inherit from the original run and is therefore lossy for
	 * "why was THIS row created". Set at every production `spawnRun` call
	 * site; the dispatch-context writer (warren-d6ca) records it. Internal
	 * to the spawn seam today — not on the HTTP wire yet.
	 */
	readonly dispatchOrigin?: DispatchOrigin;
	/**
	 * Structured logger for the spawn flow (warren-c686 / pl-f700 step 1).
	 * The HTTP handlers pass `ctx.logger` (pre-bound with `request_id`);
	 * `spawnRun` re-binds `run_id` so every spawn log line correlates back
	 * to both the run row and the originating request. Omitted by tests and
	 * CLI paths that don't care — the flow degrades to a no-op logger.
	 */
	readonly logger?: SpawnLogger;
	/**
	 * Fired once with the freshly-minted warren run id, right after the run
	 * row is created and before any runtime contact (warren-a0a2). Lets a
	 * caller learn the row id even when `spawnRun` later throws (the row is
	 * finalized `failed`/`never_started` on a pre-dispatch failure). The
	 * scheduler's bounded-retry GC uses this to drop the transient
	 * never_started rows a persistently-unreachable runtime would flood the
	 * runs list with. Best-effort: the callback must not throw.
	 */
	readonly onRunRowCreated?: (runId: string) => void;
	/**
	 * Migration journal preflight seam (warren-1f03). For ref-dispatches onto
	 * an existing branch, spawnRun runs a drizzle journal-slot collision check
	 * against fresh main after the refresh and heals prompt-free (delete the
	 * colliding migration, re-run `bun run db:generate`, commit). Tests
	 * override; production resolves to `healMigrationJournalCollisions`.
	 */
	readonly migrationHealFn?: MigrationHealFn;
}

export interface SpawnRunResult {
	readonly run: RunRow;
	/**
	 * Narrowed from burrow's full `Run`/`Burrow` rows (warren-1f56) to just the
	 * ids the callers use (`bridges.start`, the HTTP response). The runtime seam
	 * returns only an opaque `RunHandle`, so `burrow.workspacePath` — a host path
	 * with no provider-neutral home — is a display-only carry-over (empty on the
	 * real dispatch path) kept for wire/UI compatibility until the `/sandboxes`
	 * surface is retired (plan §5.C).
	 */
	readonly sandbox: { readonly id: string; readonly workspacePath: string };
	readonly sandboxRun: { readonly id: string };
	readonly agent: AgentDefinition;
}
