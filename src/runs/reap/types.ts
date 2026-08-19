import type { Repos } from "../../db/repos/index.ts";
import type { RunFailureReason, RunTerminalState } from "../../db/schema.ts";
import type { Forge } from "../../forge/contract.ts";
import type {
	LaunchPreviewInput,
	LaunchPreviewResult,
	PreviewLaunchConfig,
	PreviewSidecarResolver,
} from "../../preview/launch/index.ts";
import type { PreviewPortAllocator } from "../../preview/port-allocator.ts";
import type { RuntimeProvider } from "../../runtime/contract.ts";
import type { SeedsCliDeps } from "../../seeds-cli/index.ts";
import type { IssueTracker } from "../../tracker/contract.ts";
import type { ServerPreviewConfig } from "../../warren-config/index.ts";
import type { RunEventBroker } from "../events.ts";
import type { AutoOpenPrConfig } from "../pr.ts";
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
	 * `message` carries stderr otherwise. Mirrors `child_process.execFile`.
	 *
	 * `env` (warren-035c) is merged OVER the inherited process environment at
	 * the spawn — the commit sites pass `warrenCommitIdentityEnv()` so an
	 * inherited `GIT_AUTHOR_*` / `GIT_COMMITTER_*` can't out-rank the pinned
	 * bot identity. A key mapped to `undefined` is REMOVED from the child env
	 * (warren-fa84) — how clone-apply scrubs repo-context `GIT_*` a parent
	 * hook leaked. Omitted ⇒ plain inheritance, behavior unchanged. */
	readonly run: (
		cmd: string,
		args: readonly string[],
		opts: { cwd: string; timeoutMs?: number; env?: Record<string, string | undefined> },
	) => Promise<{ stdout: string; stderr: string }>;
}

export interface ReapRunInput {
	readonly runId: string;
	/** The provider-observed terminal state to transition the warren row into. */
	readonly outcome: RunTerminalState;
	readonly repos: Repos;
	/**
	 * Runtime-provider seam (K8s migration pl-829f step 13 / warren-1f56). The
	 * workspace-dependent half of reap runs as `provider.finalize(handle, intent)`
	 * followed by `provider.terminate(handle)`; workspace resolution runs through
	 * `provider.workspaceInfo`. REQUIRED (warren-e24d): reap no longer builds a
	 * fallback burrow-backed provider, so it holds no burrow client of its own —
	 * the boot wiring (and tests) construct the provider and thread it here.
	 */
	readonly runtimeProvider: RuntimeProvider;
	/**
	 * Preview sidecar seam (warren-e24d), used ONLY by the preview launch
	 * sub-step — a LocalProvider-only capability. Built at boot from the runtime
	 * provider (`createLocalSidecarsResolver`) and threaded here gated on
	 * `runtimeProvider.capabilities.previewPorts`. Omitted (or absent capability)
	 * ⇒ the preview launch is skipped exactly as for a backend without preview
	 * ports; the pipeline surfaces `reap.preview_skipped_unsupported` for an
	 * opted-in project.
	 */
	readonly previewSidecars?: PreviewSidecarResolver;
	/** If supplied, every reap-emitted event is published here too. */
	readonly broker?: RunEventBroker;
	readonly fs?: ReapFs;
	readonly exec?: ReapExec;
	/**
	 * Durable dir for the local salvage bundle capture (warren-cd3b), boot-wired
	 * to `<dataDir>/salvage`. Consulted ONLY when the finalize branch push
	 * failed and the rescue-ref push also fails — the bundle is the last
	 * capture before the workspace is preserved-or-destroyed. Absent ⇒ the
	 * bundle form is skipped (tests); the rescue push still runs.
	 */
	readonly salvageDir?: string;
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
	 * Infra-lost auto-retry hook (warren-4af7). Fired once, after the
	 * terminal transition + workspace teardown, when the run finalized
	 * `failed` with an infra-lost failure reason (`sandbox_run_lost`). The
	 * hook re-dispatches ONE replacement run linked via `runs.retry_of`
	 * (see `src/runs/retry/infra-lost-retry.ts`); boot wires it, tests omit it (no retry).
	 * Fire-and-log: a hook throw is caught by reap and surfaced as a
	 * `run.retry_failed` event, never as a reap failure.
	 */
	readonly onInfraLostRun?: (runId: string) => Promise<void>;
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
	 * The boot-resolved forge (warren-45e6, plan pl-d1c9 step 10). The
	 * `pr_open` and `pr_annotate_preview` sub-steps run through it
	 * (`forge.openPullRequest` / `forge.setPullRequestBody`); it also mints
	 * the K8s clone-fetch credential (forge-contract.md §4). Production boot
	 * wiring always binds it (`bindReap` / `cancelRunWiring`); when omitted
	 * (tests), the PR sub-steps skip exactly as when auto-open is disabled.
	 */
	readonly forge?: Forge;
	/**
	 * Override the sleep seam for PR-open retry back-off (warren-70c6 / tests).
	 * Defaults to real `setTimeout`-based sleep in production.
	 */
	readonly sleep?: (ms: number) => Promise<void>;
	/**
	 * Per-run preview environments (R-19 / docs/design/preview-environments.md, warren-f156). When
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
	 * port allocator and the resolved sidecars facade, so tests can
	 * assert call arguments without touching real sidecars.
	 */
	readonly launchPreview?: (input: LaunchPreviewInput) => Promise<LaunchPreviewResult>;
	/**
	 * Optional seeds-CLI seam (warren-41d5). Retained for the legacy
	 * write/extension paths; the auto_plan_run sub-step now reads
	 * `issueTracker` (warren-2d98).
	 */
	readonly seedsCli?: SeedsCliDeps;
	/**
	 * Boot-resolved IssueTracker (warren-5819, pl-a37b Track B). The
	 * auto_plan_run sub-step validates a new plan's children through it
	 * (warren-2d98).
	 */
	readonly issueTracker?: IssueTracker;
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
	| "seed_id_close"
	| "clone_apply"
	| "clone_apply_push"
	| "seeds_commit"
	| "seed_reset"
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
	/**
	 * The provider `errorMessage` captured when a terminal model turn ended
	 * with `stopReason === "error"` (warren-edc3), else `null`. Set iff
	 * `failureReason === "provider_error"`; the run row's `failure_reason`
	 * carries only the enum discriminator (the column is enum-narrowed), so
	 * this field is the only reap surface for the human-readable provider
	 * message (also emitted on the `reap.provider_error` event).
	 */
	readonly providerError: string | null;
	readonly mulchUpdated: number;
	readonly mulchSkipped: number;
	readonly mulchAppended: number;
	readonly seedsClosed: number;
	readonly seedsCreated: number;
	// warren-df3e: the host-side seed-id close (warren-0d2d) is no longer a reap
	// step — it observes `post_reap` on the observation bus
	// (`./seed-close-lifecycle.ts`), so its outcome is no longer reported here.
	/**
	 * True when reap authored a `chore(warren): seeds state` commit in the
	 * workspace before `branch_push` so origin's workspace branch carries
	 * the `.seeds/` deltas (warren-7ecc). For the seeds tracker,
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
	 * Terminal state of the preview launch (R-19 / docs/design/preview-environments.md,
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
	/**
	 * Salvage-before-destroy outcome (warren-cd3b): where the run's committed
	 * work was captured when the finalize branch push failed. `salvageRescueRef`
	 * is the `warren/rescue/<runId>` branch on origin; `salvagePath` is the
	 * durable git-bundle file. Both null when no salvage ran (push fine, k8s
	 * backend — the pod self-salvages) or when every capture failed (the
	 * `reap.workspace_salvage_failed` event carries the notes).
	 */
	readonly salvageRescueRef: string | null;
	readonly salvagePath: string | null;
	readonly errors: readonly ReapStepError[];
	/** True when the row was already terminal on entry — sub-steps were skipped. */
	readonly alreadyTerminal: boolean;
}

/* ----------------------------------------------------------------------- */
/* Implementation                                                           */
/* ----------------------------------------------------------------------- */
