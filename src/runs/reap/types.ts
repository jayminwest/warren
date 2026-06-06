import type { BurrowClientPool } from "../../burrow-client/pool.ts";
import type { Repos } from "../../db/repos/index.ts";
import type { RunFailureReason, RunTerminalState } from "../../db/schema.ts";
import type {
	LaunchPreviewInput,
	LaunchPreviewResult,
	PreviewLaunchConfig,
} from "../../preview/launch/index.ts";
import type { PreviewPortAllocator } from "../../preview/port-allocator.ts";
import type { SeedsCliDeps } from "../../seeds-cli/index.ts";
import type { ServerPreviewConfig } from "../../warren-config/index.ts";
import type { RunEventBroker } from "../events.ts";
import type { AutoOpenPrConfig, OpenPullRequestInput, OpenPullRequestResult } from "../pr.ts";
import type { AnnotatePrPreviewInput, AnnotatePrPreviewResult } from "../pr-annotate.ts";
import type { PrTemplateOverrides } from "../pr-template.ts";
import type { BridgeLogger } from "../stream/index.ts";

/* ----------------------------------------------------------------------- */
/* Public surface                                                           */
/* ----------------------------------------------------------------------- */

export interface ReapFs {
	readonly mkdirp: (path: string) => Promise<void>;
	/** Read a file as utf-8. Resolves to `null` if the file does not exist. */
	readonly readFile: (path: string) => Promise<string | null>;
	readonly writeFile: (path: string, contents: string) => Promise<void>;
	/** List filenames in a directory. Resolves to `[]` if the dir does not exist. */
	readonly readdir: (path: string) => Promise<readonly string[]>;
}

export interface ReapExec {
	/** Run a command; resolves on exit-0, rejects with an `Error` whose
	 * `message` carries stderr otherwise. Mirrors `child_process.execFile`. */
	readonly run: (
		cmd: string,
		args: readonly string[],
		opts: { cwd: string; timeoutMs?: number },
	) => Promise<{ stdout: string; stderr: string }>;
}

export interface ReapRunInput {
	readonly runId: string;
	/** The burrow-observed terminal state to transition the warren row into. */
	readonly outcome: RunTerminalState;
	readonly repos: Repos;
	/**
	 * Multi-worker burrow pool (warren-c0c9 / pl-9ba1 step 5). reap resolves
	 * the owning worker via `pool.clientFor({burrowId: run.burrowId})` for
	 * the workspace lookup + seeds-close mirror http calls. Propagates
	 * `StickyWorkerUnreachableError` (503 via src/server/errors.ts) when the
	 * pinned worker is `unreachable`.
	 */
	readonly burrowClientPool: BurrowClientPool;
	/** If supplied, every reap-emitted event is published here too. */
	readonly broker?: RunEventBroker;
	readonly fs?: ReapFs;
	readonly exec?: ReapExec;
	readonly now?: () => Date;
	readonly logger?: BridgeLogger;
	/**
	 * Override the inferred failure reason (warren-3c40, warren-5165). Reap
	 * normally infers from state-on-entry plus the event log: `queued` ⇒
	 * `never_started`, `running` with no assistant output ⇒
	 * `no_model_response`, `running` with assistant output ⇒ `crashed`.
	 * Pass an explicit value when a higher-level caller has better
	 * information (e.g. a deadline-based reaper passing `timed_out`).
	 * Ignored when `outcome !== "failed"`.
	 */
	readonly failureReason?: RunFailureReason;
	/**
	 * Auto-open-PR config (warren-f6af). When omitted or `enabled: false`,
	 * the `pr_open` sub-step is skipped entirely (no event emitted, no
	 * runs.pr_url update). Higher-level callers (HTTP server boot, CLI
	 * `warren run`) load this from env via `loadAutoOpenPrConfigFromEnv`
	 * and pass it through; tests pass `{ enabled: false, ... }` (or omit)
	 * to keep the network out of the unit-test surface.
	 */
	readonly autoOpenPr?: AutoOpenPrConfig;
	/**
	 * Override the PR-open seam (tests). Defaults to the live
	 * `openPullRequest`. Receives the same input shape as the production
	 * function so tests can assert call arguments.
	 */
	readonly openPr?: (input: OpenPullRequestInput) => Promise<OpenPullRequestResult>;
	/**
	 * Override the sleep seam for PR-open retry back-off (warren-70c6 / tests).
	 * Defaults to real `setTimeout`-based sleep in production.
	 */
	readonly sleep?: (ms: number) => Promise<void>;
	/**
	 * Per-run preview environments (R-19 / SPEC §11.L, warren-f156). When
	 * the project has opted in via `.warren/defaults.json` and `outcome ===
	 * "succeeded"`, reap launches `preview.command` as a long-lived burrow
	 * sidecar in the same workspace (`preview_launch`) and — if `pr_open`
	 * produced a PR url — patches the live URL into the PR body
	 * (`pr_annotate_preview`). Both sub-steps are best-effort: failure
	 * emits `reap_failed` events with `step` ∈ {`preview_launch`,
	 * `pr_annotate_preview`} and never fails the run.
	 *
	 * Both `previewConfig` and `portAllocator` must be supplied together;
	 * omit `previewConfig` to skip the launch entirely (matching projects
	 * that haven't opted in). Tests typically omit; production wiring
	 * resolves the config from the per-project `.warren/defaults.json`
	 * loader and constructs one allocator per warren process.
	 */
	readonly previewConfig?: ServerPreviewConfig;
	readonly portAllocator?: PreviewPortAllocator;
	readonly previewLaunchConfig?: PreviewLaunchConfig;
	/**
	 * PR-body template overrides parsed from `.warren/pr-template.md`
	 * (warren-bd49). Threaded into `buildPrContent`'s named-fragment
	 * composer; missing-or-empty keeps the built-in defaults. Caller
	 * (bridges.ts / scheduler) loads this from the per-project warren
	 * config cache the same way it resolves `previewConfig`.
	 */
	readonly prTemplate?: PrTemplateOverrides;
	/**
	 * Override the preview-launch mechanics (tests). Defaults to
	 * `launchPreview`. Receives the resolved input shape, including the
	 * port allocator and the worker-local burrow client, so tests can
	 * assert call arguments without touching real sidecars.
	 */
	readonly launchPreview?: (input: LaunchPreviewInput) => Promise<LaunchPreviewResult>;
	/**
	 * Override the preview-annotation seam (tests). Defaults to
	 * `annotatePrPreview`.
	 */
	readonly annotatePrPreview?: (input: AnnotatePrPreviewInput) => Promise<AnnotatePrPreviewResult>;
	/**
	 * Optional seeds-CLI seam (warren-41d5). Forwarded to the auto_plan_run
	 * sub-step so reap validates a new plan's child seeds (via `showSeed`)
	 * before dispatching a plan-run — mirroring the manual `POST /plan-runs`
	 * handler. A plan referencing seeds that don't exist on the default
	 * branch is skipped with an `auto_plan_run_skipped` event instead of
	 * wedging the coordinator on the first unresolvable child. Omit (unit
	 * tests) ⇒ no validation, behavior unchanged.
	 */
	readonly seedsCli?: SeedsCliDeps;
}

export interface ReapStepError {
	readonly step: ReapStep;
	readonly message: string;
	readonly path?: string;
}

export type ReapStep =
	| "workspace_lookup"
	| "mulch_merge"
	| "seeds_close"
	| "plans_mirror"
	| "seeds_commit"
	| "plot_merge"
	| "plot_commit"
	| "auto_plan_run"
	| "branch_push"
	| "pr_open"
	| "preview_launch"
	| "pr_annotate_preview"
	| "workspace_destroy";

export interface ReapRunResult {
	readonly state: RunTerminalState;
	/**
	 * Failure-cause discriminator (warren-3c40, warren-5165). Set only
	 * when `state === "failed"`; null on succeeded/cancelled. Distinguishes
	 * "burrow accepted dispatch but never started the run" (`never_started`)
	 * from "agent started but produced no model output before exiting"
	 * (`no_model_response`, typically credential/runtime failure) from
	 * "agent ran and crashed mid-conversation" (`crashed`) — all three
	 * shared an observable shape before this field existed.
	 */
	readonly failureReason: RunFailureReason | null;
	readonly mulchUpdated: number;
	readonly mulchSkipped: number;
	readonly mulchAppended: number;
	readonly seedsClosed: number;
	readonly seedsCreated: number;
	/**
	 * Plot event log lines appended to the project's `.plot/plot-*.events.jsonl`
	 * files after merging the burrow workspace's deltas (warren-7e0f /
	 * pl-2047 step 6). Idempotent re-runs report 0 — the merge dedups by
	 * full-line content so a second sweep over the same workspace adds
	 * nothing.
	 */
	readonly plotEventsAppended: number;
	/**
	 * Distinct `plot-*.json` files overwritten in the project's `.plot/` from
	 * a newer workspace copy (warren-7e0f). Last-write-wins on `updated_at`
	 * mirrors the mulch-merge primitive; ties with different contents emit
	 * a `plot.conflict` event but leave the project copy untouched.
	 */
	readonly plotsUpdated: number;
	/**
	 * New agent-emitted `decision_made` / `question_posed` /
	 * `artifact_produced` events mirrored into warren's event stream tagged
	 * with `plot_id` (warren-7e0f). Idempotent — re-runs against an already
	 * merged workspace re-mirror nothing because the underlying file merge
	 * is content-dedup'd.
	 */
	readonly plotEventsMirrored: number;
	/**
	 * True when reap authored a `chore(warren): plot state` commit in the
	 * workspace before `branch_push` so origin's workspace branch carries
	 * the `.plot/` deltas (warren-343a, shape (a) commit-through-reap).
	 * Set when host-side appender writes in `<project>/.plot/` (or merge
	 * deltas from the burrow workspace) had not yet been committed by the
	 * agent — reap stages them and authors a warren-identity commit so
	 * the push isn't empty. False when nothing needed staging (agent had
	 * already committed everything, project has no `.plot/`, or the merge
	 * produced no on-disk delta) and false when the commit attempt failed
	 * (the failure surfaces as a `reap_failed` step=`plot_commit` event).
	 */
	readonly plotCommitted: boolean;
	/**
	 * True when reap authored a `chore(warren): seeds state` commit in the
	 * workspace before `branch_push` so origin's workspace branch carries
	 * the `.seeds/` deltas (warren-7ecc). Mirrors `plotCommitted` (warren-
	 * 343a, shape (a) commit-through-reap) but for the seeds tracker:
	 * agents with narrowly-scoped write contracts (the planner, see
	 * src/registry/builtins/planner.ts) are forbidden from running
	 * `git commit`, so `sd plan submit` writes to `.seeds/issues.jsonl` +
	 * `.seeds/plans.jsonl` and warren has to stage and commit them on the
	 * agent's behalf — otherwise the push lands empty and the plan is lost.
	 * Set when project has `.seeds/` and there's a real `.seeds/` delta the
	 * agent never committed. False when nothing needed staging or when the
	 * commit attempt failed (the failure surfaces as a `reap_failed`
	 * step=`seeds_commit` event).
	 */
	readonly seedsCommitted: boolean;
	readonly branchPushed: boolean;
	/**
	 * Commits the pushed branch is ahead of its base (warren-f3bb). `null`
	 * when the count couldn't be computed — burrow returned no `baseBranch`,
	 * `git rev-list` failed, or the push itself failed. `0` means the push
	 * landed no new work (silent no-op shape). Positive means real commits
	 * shipped. Distinguishes the `branchPushed: true, ahead_by: 0` shape
	 * (agent never committed) from the `branchPushed: true, ahead_by: N`
	 * shape (agent shipped real work) — the two are visually identical
	 * without this field.
	 */
	readonly commitsAhead: number | null;
	/**
	 * URL of the PR reap opened (warren-f6af). Null when the `pr_open`
	 * sub-step was skipped (auto-open disabled, missing token, push
	 * failed, branch == defaultBranch, no commits ahead) or when the
	 * GitHub call itself errored (errors append to `errors` instead).
	 */
	readonly prUrl: string | null;
	/**
	 * Terminal state of the preview launch (R-19 / SPEC §11.L,
	 * warren-f156). `null` when the sub-step was skipped (project didn't
	 * opt in, outcome !== succeeded, worker !== local, type !== server) —
	 * not when it failed. `live` / `failed` carry the matching
	 * `runs.preview_state` transition. The full failure tail lives on
	 * `runs.preview_failure_message`; reap surfaces only the lifecycle
	 * state here so callers can branch quickly.
	 */
	readonly previewState: "live" | "failed" | null;
	/**
	 * Allocated host port for a `live` or `failed` preview. Cleared when
	 * the launch was skipped or when the failure path released the port
	 * (port-exhausted, readiness timeout, sidecar exited early).
	 */
	readonly previewPort: number | null;
	/**
	 * URL the `pr_annotate_preview` sub-step patched into the PR body
	 * (`https://run-<id>.<host>`). Null when annotation was skipped (no
	 * PR opened, `WARREN_PREVIEW_HOST` unset, or launch failed) or when
	 * the GitHub call itself errored (errors append to `errors`).
	 */
	readonly previewUrl: string | null;
	/**
	 * True when reap auto-dispatched a plan-run for a plan the agent created
	 * during this run (warren-a32a). Requires `auto_plan_run: true` in the
	 * agent's canopy frontmatter, `outcome === "succeeded"`, and at least one
	 * new plan detected in the workspace's `.seeds/plans.jsonl`.
	 */
	readonly autoPlanRunCreated: boolean;
	readonly autoPlanRunId: string | null;
	readonly autoPlanRunPlanId: string | null;
	/**
	 * True when reap destroyed the burrow workspace as its final sub-step
	 * (warren-0d89) — the `DELETE /burrows/:id` call succeeded and the
	 * burrows row was removed. False when the destroy was skipped (no
	 * burrow, unresolved worker, interactive run, or a still-live preview)
	 * or when the destroy attempt failed (surfaced as a `reap_failed`
	 * step=`workspace_destroy` event). Per-reap cleanup that keeps the
	 * persistent volume from filling with stale workspaces; a fallback GC
	 * still covers crash-stranded burrows.
	 */
	readonly workspaceDestroyed: boolean;
	readonly errors: readonly ReapStepError[];
	/** True when the row was already terminal on entry — sub-steps were skipped. */
	readonly alreadyTerminal: boolean;
}

/* ----------------------------------------------------------------------- */
/* Implementation                                                           */
/* ----------------------------------------------------------------------- */
