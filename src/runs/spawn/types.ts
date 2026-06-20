/**
 * Shared types for the spawn flow. Kept in their own module so the
 * source files (`dispatch.ts`, `plot-append.ts`, `seed-extensions.ts`,
 * `agent-cache.ts`) and their tests can import the input/result shapes
 * without dragging in the full `spawnRun` implementation graph.
 */

import type { Burrow, Run as BurrowRun } from "@os-eco/burrow-cli";
import type { BurrowClientPool } from "../../burrow-client/pool.ts";
import type { Repos } from "../../db/repos/index.ts";
import type { CloneKind, RunMode, RunRow } from "../../db/schema.ts";
import type { SpawnFn as ProjectSpawnFn } from "../../projects/clone.ts";
import type { ProjectsConfig } from "../../projects/config.ts";
import type { refreshProject } from "../../projects/manage.ts";
import type { AgentDefinition } from "../../registry/schema.ts";
import type { SeedsCliDeps } from "../../seeds-cli/index.ts";
import type { WarrenConfigCache } from "../../warren-config/index.ts";

export interface SpawnRunInput {
	readonly repos: Repos;
	/**
	 * Multi-worker successor to the legacy `burrowClient` parameter
	 * (warren-39c3 / pl-9ba1 step 4, parent warren-6747). `spawnRun`
	 * resolves placement via `pool.placeFor({projectId})` so the chosen
	 * worker name lands on `runs.worker_id` AND `burrows.worker_id`
	 * before any burrow HTTP call. The same client services provision +
	 * dispatch + rollback so a single run never crosses workers.
	 */
	readonly burrowClientPool: BurrowClientPool;
	readonly agentName: string;
	readonly projectId: string;
	/**
	 * Coordination project id (warren-c1a4 / pl-fb43 step 3). Splits the
	 * single project identity into two roles:
	 *
	 *   - `projectId` (execution) selects the repo cloned into the burrow
	 *     workspace — where the agent actually does its work.
	 *   - `seedProjectId` (coordination) selects the *host* project clone
	 *     used for the post-dispatch bookkeeping: the seeds
	 *     `updateExtensions` stamp (`role`/`lastRunId`/`lastRunAt`) and the
	 *     `run_dispatched` Plot append/mirror.
	 *
	 * Defaults to `projectId` when unset/empty, so a same-repo run is
	 * byte-identical to the pre-split behavior. When it differs, the seed
	 * stamp and Plot operations target the coordination project's clone
	 * while the workspace still clones the execution `projectId`. The
	 * burrow provisioning path is unaffected — it always uses `projectId`.
	 */
	readonly seedProjectId?: string;
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
	/**
	 * Optional Plot id this run is dispatched against (warren-a8c3,
	 * parent warren-000b). Validated against `project.hasPlot` here:
	 * passing a plot_id for a project whose clone has no `.plot/`
	 * directory raises a typed ValidationError so the operator gets a
	 * 400 with a clear hint instead of a silently-dropped field.
	 * Persisted to `runs.plot_id`; downstream steps (warren-e26f,
	 * warren-e848, warren-7e0f) read it from the runs row.
	 */
	readonly plotId?: string;
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
	 * Per-trigger spend cap (warren-a63d). When set, the spawn composer
	 * folds it onto `frontmatter.maxCostUsd` (overriding the agent's own
	 * value) before freezing `runs.rendered_agent_json`, so the bridge
	 * enforces a single trigger > agent precedence cap. Omitted for runs
	 * with no per-trigger cap — the agent's own `maxCostUsd` (if any)
	 * still applies.
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
	/** Branch, tag, or SHA to refresh to. Defaults to the project's tracked default branch. */
	readonly ref?: string;
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
	 * are set; if neither is set, spawnRun falls back to "burrow" so
	 * existing deployments are unchanged.
	 */
	readonly runBranchPrefixDefault?: string;
	/**
	 * Seeds CLI shell-out deps for the post-dispatch extension write
	 * (pl-bb70 step 4, warren-46cd). When both `seedId` and this are
	 * provided, spawnRun fires a single `sd update --extensions` after
	 * `attachBurrow(burrowRunId)` succeeds, merging `{role, trigger,
	 * lastRunId, lastRunAt}` onto the seed. Failure is fire-and-log
	 * (mirrors the pl-2f15 risk #4 mitigation in src/triggers/tick.ts):
	 * a `seeds_extension_write_failed` system event lands on the run,
	 * the run does NOT roll back. Omit on call sites that don't ship a
	 * project clone (CLI run, tests) — without it, the extension write
	 * is a no-op even when seedId is set.
	 */
	readonly seedsCli?: SeedsCliDeps;
	/**
	 * Handle of the user dispatching the run (warren-e848 / pl-2047 step 5).
	 * Used as the actor for the `run_dispatched` event appended to the
	 * originating Plot — Plot's SPEC §6 ACL allows both `user:*` and
	 * `agent:*` actors for `run_dispatched`, but warren attributes the
	 * dispatch to the human who triggered it. Falls back to
	 * `DEFAULT_DISPATCHER_HANDLE` when undefined, empty, or doesn't match
	 * the actor segment regex — non-user dispatch paths (cron/webhook)
	 * are accounted for under pl-2047 risk #4.
	 */
	readonly dispatcherHandle?: string;
	/**
	 * Test seam for the `run_dispatched` Plot append (warren-e848). The
	 * default opens a `UserPlotClient` against `<project>/.plot/` and
	 * fire-and-logs on failure; tests substitute a stub to assert the
	 * payload without touching disk.
	 */
	readonly plotAppender?: SpawnPlotAppender;
}

export interface AppendPlotRunDispatchedInput {
	readonly plotDir: string;
	readonly plotId: string;
	readonly handle: string;
	readonly runId: string;
	readonly agentName: string;
	readonly model: string | null;
	readonly projectId: string;
}

export interface SpawnPlotAppender {
	appendRunDispatched(input: AppendPlotRunDispatchedInput): Promise<void>;
}

export interface SpawnRunResult {
	readonly run: RunRow;
	readonly burrow: Burrow;
	readonly burrowRun: BurrowRun;
	readonly agent: AgentDefinition;
}
