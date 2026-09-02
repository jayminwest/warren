/**
 * The `RuntimeProvider` contract — the seam that decouples warren's domain from
 * its execution backend. Spec: `docs/design/runtime-provider-contract.md`.
 * Types-only; the domain must never leak a burrow-id, pod name, socket, host
 * path, or `SandboxProfile` across the seam.
 */

import type {
	AcceptedRuntimeId,
	EventOrigin,
	EventStream,
	InboxPriority,
	InboxState,
	RunState,
} from "../core/wire.ts";
import type { GitSpawnCredential } from "../workspace/git/credential-env.ts";
import type { ArtifactDelta } from "./finalize-deltas.ts";
import type { FinalizeStage } from "./finalize-stages.ts";

/**
 * Opaque handle — the only run reference that crosses the seam. Providers map
 * `runId` → native ids internally; the domain treats `sandboxId`/`providerRunId`
 * as opaque.
 */
export interface RunHandle {
	/** warren domain id — the identity, generated pre-dispatch */
	runId: string;
	/** provider workspace/sandbox id (sandboxId | pod name) */
	sandboxId: string;
	/** provider run/dispatch id (sandboxRunId | pod uid) */
	providerRunId: string;
}

/**
 * Provider-neutral INTENT. No `SandboxProfile`, no host paths, no callback URL —
 * the provider owns its own plumbing (§6.3: the callback URL is provider-owned,
 * not domain env).
 */
export interface RunSpec {
	runId: string;

	// Workspace materialization INPUTS (never a pre-built result — the provider
	// materializes: burrow internally, K8s in an init container).
	originUrl: string;
	branch: string;
	/**
	 * PROMOTED to first-class (§6.2) — burrow resolved it internally
	 * (`default_branch ?? "main"`); the K8s init container needs it explicit.
	 */
	baseBranch: string;
	/** optional burrow worktree optimization; K8s ignores it. */
	hostClonePathHint?: string;

	/** OPTIONAL project identity (warren `projects.id`) — K8s stamps it on the
	 * pod (`warren.io/project`) for admission (warren-b6f2); Local ignores it. */
	projectId?: string;
	/**
	 * OPTIONAL per-project concurrency cap — max simultaneous non-terminal run
	 * pods for this project, from `.warren/config.yaml` `admission.maxConcurrentRuns`
	 * (warren-b6f2). K8s enforces it; LocalProvider ignores it.
	 */
	maxProjectConcurrency?: number;

	/** Per-project agent image override (`.warren/config.yaml` `agentImage`,
	 * warren-fabb): this > the runtime's `WARREN_*_AGENT_IMAGE` env > default.
	 * Docker + K8s consume it; LocalProvider ignores it (host toolchain). */
	agentImage?: string;

	// Agent.
	runtimeId: AcceptedRuntimeId;
	/** system section already prepended by the domain */
	prompt: string;
	/** e.g. `{ frontmatter }` — provider carries to runtime */
	metadata?: Record<string, unknown>;
	mode: "batch" | "conversation";

	// Isolation INTENT (provider maps to SandboxProfile | pod securityContext+resources).
	network: "none" | "restricted" | "open";
	resources?: { memoryMiB?: number; cpuMillicores?: number; ephemeralStorageMiB?: number };
	/**
	 * OPTIONAL per-project pod resource defaults from `.warren/config.yaml`
	 * `resources` (warren-aedd) — same boot-time pattern as
	 * `maxProjectConcurrency`. Precedence: per-run `resources` limit >
	 * `projectResources` > env defaults. K8s only.
	 */
	projectResources?: {
		requests?: { memoryMiB?: number; cpuMillicores?: number; ephemeralStorageMiB?: number };
		limits?: { memoryMiB?: number; cpuMillicores?: number; ephemeralStorageMiB?: number };
		network?: "none" | "restricted" | "open";
	};
	timeoutMs?: number;

	/** Context drops written into the workspace (.canopy/.mulch/.seeds/.pi). */
	seedFiles: ReadonlyArray<{ path: string; contents: string; encoding?: string; mode?: number }>;

	/**
	 * DOMAIN env only — coordination + secrets: WARREN_QUALITY_GATE,
	 * WARREN_API_TOKEN. The provider ADDS its own plumbing (WARREN_API_URL
	 * callback, BUN_INSTALL_CACHE_DIR, …); the domain must NOT set those.
	 */
	env: Record<string, string>;
}

/**
 * One event off the ordered, resumable, lossless stream. `payload` is passed
 * through verbatim (§6.6) — providers MUST NOT summarize it; the budget/cost
 * extractor reads `total_cost_usd`/`usage` out of these payloads. Provenance
 * (`origin`) is classified at the parse boundary, never self-declared.
 */
export interface NormalizedEvent {
	/** Monotonic per run — burrow server-assigns, K8s synthesizes a cursor over pod logs (§6.4). */
	seq: number;
	/** ISO-8601 */
	ts: string;
	/**
	 * OPEN string. Terminal envelopes ride `kind="state_change"`, discriminated
	 * by `payload.type` (`"result"` | `"agent_end"`) — do NOT lift them into a
	 * typed terminal event or `detectRuntimeTerminal` breaks.
	 */
	kind: string;
	/** unknown coerces to `null`. Derived from `EVENT_STREAMS` (`src/core/wire.ts`). */
	stream: EventStream | null;
	/** warren-6646, see `src/core/wire.ts`: only `"warren"` keeps system authority. */
	origin?: EventOrigin;
	/** LOSSLESS — see interface doc; typed `unknown` deliberately. */
	payload: unknown;
}

/** Resume cursor — dedup: the domain skips `seq <= sinceSeq`. */
export interface StreamOpts {
	sinceSeq?: number;
}

/** Provider run phase — canonical `RUN_STATES` (`src/core/wire.ts`), warren-7b7a. */
export type RunPhase = RunState;

/**
 * Coarse terminal reason — the provider-owned terminal classification
 * (fine-grained `failure_reason` stays in the domain, §3).
 * - `completed` — agent finished normally.
 * - `error` — agent/runtime failed.
 * - `oom_killed` — killed by the cgroup/OOM killer (§6.5): burrow's oomKilled()
 *   probe; K8s `terminated.reason=="OOMKilled"`.
 * - `evicted` — the kubelet evicted the pod (K8s `status.reason=="Evicted"`)
 *   under node pressure, usually ephemeral-storage exhaustion (warren-c0cd).
 *   K8s-only; an infra-capacity signal, not a container or agent fault.
 * - `preempted` (warren-ea4b) — Spot preemption: the pod's (spot-labelled) node
 *   was reclaimed. K8s-only; witness set in `./k8s/status-map.ts`.
 * - `cancelled` — graceful stop via `cancel()`.
 * - `lost` — run vanished (burrow 404 / pod GC'd); pairs with `exists:false`.
 */
export type TerminalReason =
	| "completed"
	| "error"
	| "oom_killed"
	| "evicted"
	| "preempted"
	| "cancelled"
	| "lost";

/**
 * Out-of-band reconcile/recovery snapshot — what the watchdog/recovery/pod-watcher
 * read. `status()` NEVER throws on a missing run; it returns `exists:false` (§6.7).
 */
export interface RunStatus {
	phase: RunPhase;
	exitCode: number | null;
	terminalReason?: TerminalReason;
	/** Provider detail behind a terminal classification (warren-4a95), e.g. the kubelet's eviction message. */
	terminalDetail?: string | null;
	/** collapses the separate `maxSeqForRun` query */
	lastEventSeq: number;
	/** heartbeat anchor (the domain still owns the watchdog decision) */
	lastEventTs: string | null;
	/** `false` ⇒ run_lost (burrow 404 / pod GC'd) — a value, not a throw */
	exists: boolean;
}

/** Steering priority — canonical `INBOX_PRIORITIES` (`src/core/wire.ts`), warren-7b7a. */
export type MessagePriority = InboxPriority;

export interface OutboundMessage {
	body: string;
	priority?: MessagePriority;
	fromActor?: string;
}

/** The persisted row returned to the domain. */
export interface Message {
	id: string;
	runId: string | null;
	body: string;
	priority: MessagePriority;
	fromActor: string;
	/** Delivery lifecycle — canonical `INBOX_STATES` (`src/core/wire.ts`). */
	state: InboxState;
	createdAt: string;
	deliveredAt: string | null;
}

/**
 * What a provider can and can't do — the domain branches on these, it does not
 * assume (§5). K8s v1 degrades several of them relative to LocalProvider.
 */
export interface RuntimeCapabilities {
	/** inbound port exposure supported */
	previewPorts: boolean;
	/** burrow: domain-allowlist; K8s v1: coarse */
	networkPolicy: "none" | "coarse" | "domain-allowlist";
	/** conversation / holdStdin streaming */
	longLived: boolean;
	/** deliver mid-turn vs next-spawn only */
	midRunSteering: boolean;
	/** cgroup memory/cpu + oomKilled */
	enforcedResourceLimits: boolean;
	/** terminate returns an archive handle */
	workspaceArchive: boolean;
	/**
	 * Fallback GC of stranded run workspaces (warren-e24d): `true` for LocalProvider
	 * — reap's per-run destroy can strand a workspace on a mid-reap crash, so warren
	 * sweeps idle workspaces via the destroy seam. `false` where the backend's own
	 * lifecycle reclaims them (K8s pod-GC reclaims terminal pods + their emptyDir),
	 * so the sweep stays dark instead of aiming a burrow destroy at a pod name.
	 */
	workspaceGc: boolean;
}

export interface TeardownResult {
	archived: boolean;
	deletedEvents: number;
	deletedMessages: number;
	deletedRuns: number;
}

/**
 * The provider-neutral answer to reap's "where is this run's workspace, and what
 * branch does it push?" question (warren-e9e1). Replaces reap's direct
 * `burrows.get` — a burrow-only call that 404s on a K8s pod name and stranded
 * succeeded K8s runs before `finalize` ever ran.
 *
 * - `workspacePath` is a HOST path when the backend runs finalize host-side over
 *   a shared workspace (LocalProvider → the burrow worktree). It is `null` when
 *   the workspace is unreachable from the control plane (K8sProvider → the pod's
 *   `emptyDir`); the domain then routes finalize through the seam (in-pod) and
 *   applies the returned mirror deltas to the project clone itself.
 * - `branch` is the run's push branch, resolved from wherever the backend
 *   recorded it (burrow echoes it on `GET /burrows/:id`; K8s stamps it as a pod
 *   annotation). `null` when it could not be resolved — finalize then pushes
 *   `HEAD` (reap's historical fallback).
 *
 * A THROW means resolution failed (a live burrow that 404'd, an API error): the
 * domain records `workspace_lookup` and skips the success pipeline. A
 * `workspacePath: null` is NOT a failure — K8s reporting a legitimately
 * host-unreachable (but finalizable) workspace. */
export interface WorkspaceInfo {
	workspacePath: string | null;
	branch: string | null;
}

// Feature-neutral artifact deltas `finalize` returns for the domain to apply to
// its project clone. Extracted to `./finalize-deltas.ts` (warren-e9e1, frozen
// size budget); re-exported here so importers keep using `../contract.ts`.
export type { ArtifactDelta, ArtifactDeltaFile } from "./finalize-deltas.ts";

/**
 * The reap-where-the-workspace-is seam (§4). `finalize` runs the
 * workspace-DEPENDENT half of reap in place — burrow: host-side over the
 * worktree; K8s: a post-agent step inside the pod — and returns structured
 * artifacts the domain applies on its own side. The domain keeps orchestration
 * (*when* to reap, whether to open a PR, plan-run chaining); only the
 * workspace-touching execution crosses the seam. Ordering obligation: the
 * domain calls `finalize`, then `terminate` (§6.8).
 */
export interface FinalizeIntent {
	branch: string;
	/** push HEAD:branch from inside the workspace */
	push: boolean;
	/**
	 * Which artifact sets to extract (the MERGE half — always run in reap),
	 * named by OPAQUE provider keys (warren-df3e — no feature enumeration at
	 * the seam). The returned {@link FinalizeResult.artifacts} is keyed the
	 * same way.
	 */
	artifacts: string[];
	/**
	 * Which bookkeeping COMMITS to author before the push (warren-1f56). The
	 * reap pipeline runs the tracker merges unconditionally but gates the
	 * `chore(warren): seeds state` commit on `project.hasSeeds` — so
	 * merge-gating (`artifacts`) and commit-gating cannot be one set. `commit`
	 * decouples them, keyed off the SAME opaque artifact vocabulary as
	 * `artifacts` (warren-357c). OMITTED ⇒ defaults to `artifacts`.
	 */
	commit?: string[];
	/**
	 * Base ref for the commits-ahead / empty-push count
	 * (`git rev-list --count --first-parent <baseBranch>..HEAD`). A provider-NEUTRAL git ref
	 * (RunSpec.baseBranch was promoted first-class, §6.2), NOT a host path.
	 * Omitted ⇒ `commitsAhead` is `null` (warren-f3bb).
	 */
	baseBranch?: string;
	/**
	 * SEAM SIGNAL (mirrors `RunSpec.hostClonePathHint`): the host path of the
	 * project clone the LocalProvider merges each tracker INTO. REQUIRED by the
	 * burrow backend whenever `artifacts` is non-empty; the K8s backend IGNORES
	 * it (the in-pod finalize has no clone — it emits the deltas above and the
	 * control plane applies them, plan step 20).
	 */
	projectClonePathHint?: string;
	/**
	 * warren-8d95: warren-seeded workspace artifacts (the rendered agent
	 * envelope + `.pi/` drops + `.seeds/workflow.txt`) that must be RESET to
	 * `baseBranch` before `branch_push` so they never ride into a PR. In
	 * projects that themselves track a colliding path, warren's seed dirties the
	 * tracked file and a broad agent commit (`git add -A`) sweeps it in, tripping
	 * Article IX protected-path automerge guard. Each entry carries the path and
	 * the exact bytes warren seeded; finalize only resets a path whose live
	 * workspace content still EQUALS the seeded bytes (so an intentional agent
	 * edit is preserved). Omitted / empty ⇒ the reset stage is skipped (existing
	 * callers unchanged). LocalProvider honors it; the K8s wire does not yet
	 * project it.
	 */
	resetSeededPaths?: ReadonlyArray<{ path: string; contents: string }>;
	/**
	 * Per-spawn minted git credential for `branch_push` (warren-4e1c, forge
	 * contract §4: minted via `mintGitCredential` immediately before
	 * `finalize`, never held on a config object). LocalProvider splices it into
	 * the push's `GIT_CONFIG_*` env, K8s prefers it, undefined pushes anonymously. */
	gitCredential?: GitSpawnCredential;
}

/**
 * One user-visible event a merge stage emitted, captured by finalize's
 * collecting emit/fail and returned for the domain to re-emit through its REAL
 * event surface (warren-1f56). The reap merge functions emit ~10 per-record
 * kinds (`mulch.record.*`, `seeds.closed/created`, `seeds.plan_mirrored`,
 * `reap.seeds_committed`) plus per-line/stage `reap_failed`; finalize returns
 * counts, so those events are unreconstructable unless carried here. This array
 * rides the callback wire from the in-pod finalize later (plan step 20), so
 * `payload` MUST be JSON-serializable — same posture as `NormalizedEvent`.
 */
export interface FinalizeEvent {
	kind: string;
	payload: unknown;
}

export interface FinalizeResult {
	pushed: boolean;
	/** warren-5ea1: set ONLY on a warren-SYNTHESIZED failed result — the in-pod finalize never POSTed one. */
	unposted?: "timeout" | "pod_terminal" | "pod_gone";
	/**
	 * Commits the pushed branch is ahead of `intent.baseBranch`; `null` (warren-f3bb)
	 * when the push was skipped/failed, `baseBranch` is absent, or rev-list failed —
	 * `0` must mean "landed no new commits", never a failed count.
	 */
	commitsAhead: number | null;
	/**
	 * The ref the count ran against (warren-ba08): `baseBranch`, or on a repair run
	 * (branch === base ⇒ `base..HEAD` is empty by construction) the pre-push
	 * `origin/<base>` SHA. Outcome facts diff against it. Present iff `commitsAhead !== null`.
	 */
	commitsAheadBase?: string;
	/** dropped-commit detection: pushed but zero commits ahead of the base */
	emptyPush: boolean;
	/**
	 * Workspace-dirtiness at push time (warren-1f56): `git status --porcelain` was
	 * non-empty. Probed ONLY when `pushed && commitsAhead === 0` (reap's
	 * `commitsAheadStep`), else `false`. The domain owns `droppedCommit` + the
	 * `reap.empty_push` emission (they need the run outcome; `terminate` kills the workspace).
	 */
	dirty: boolean;
	/**
	 * The workspace-relative paths of every uncommitted change at push time
	 * (warren-89b0), populated ONLY when `dirty` is true (i.e. `pushed &&
	 * commitsAhead === 0` over a dirty tree). The domain uses it to classify a
	 * zero-commit dirty tree: a tree whose ONLY dirty paths are warren-managed
	 * bookkeeping artifacts (`.mulch/`, `.seeds/`) is a deliberate no-op
	 * (`succeeded`) rather than a dropped commit (`failed`). Optional/absent ⇒ the
	 * domain falls back to the conservative dropped-commit posture.
	 */
	dirtyPaths?: readonly string[];
	/**
	 * The workspace `.seeds/plans.jsonl` body snapshotted just before the seeds
	 * bookkeeping commit overwrote it with the clone-union (warren-1f56). This is
	 * exactly what reap's `snapshotWorkspacePlans` reads off the live workspace to
	 * feed auto-plan-run detection; the workspace is provider-owned and destroyed
	 * by `terminate`, so finalize must capture it and hand it back. `null` when
	 * the file was absent or unreadable. The domain parses plan ids from it (gated
	 * on its own auto-dispatch frontmatter checks).
	 */
	workspacePlansBody: string | null;
	/**
	 * The per-record + per-line/stage events the merge functions emitted,
	 * captured verbatim for the domain to re-emit through its real event surface
	 * (warren-1f56 — see `FinalizeEvent`). In pipeline order. Does NOT include
	 * `reap.empty_push` (domain-emitted, needs the run outcome) nor
	 * `reap.workspace_destroyed` (a `terminate` concern).
	 */
	events: FinalizeEvent[];
	/**
	 * Feature-neutral artifact deltas the domain applies to the project clone,
	 * keyed by the SAME opaque provider keys the intent's `artifacts` named
	 * (warren-df3e). An absent key means that merge did not run; the domain reads
	 * a delta back by key and never assumes a fixed feature set.
	 */
	artifacts: Record<string, ArtifactDelta>;
	/**
	 * The pushed branch when it carries real work ready for a PR
	 * (`pushed && commitsAhead > 0`), else `null`. finalize does NOT open the
	 * PR — that stays domain orchestration (§4); this only signals readiness.
	 */
	prBranch: string | null;
	/**
	 * Per-stage outcome trail — a REFINEMENT over the design-doc shape (which
	 * omitted it). Grounds in reap's best-effort `ReapStepError[]`: every
	 * workspace-touching stage is best-effort, so the domain must see which merged,
	 * which were skipped, and which failed (with the message).
	 */
	stages: FinalizeStageOutcome[];
}

export type { FinalizePipelineStage, FinalizeStage } from "./finalize-stages.ts";
// The finalize stage vocabulary (warren-357c) lives in `./finalize-stages.ts` (size-budget split).
export {
	FINALIZE_PIPELINE_STAGES,
	finalizeCommitStage,
	finalizeMergeStage,
	isFinalizeStage,
} from "./finalize-stages.ts";

export interface FinalizeStageOutcome {
	stage: FinalizeStage;
	status: "ok" | "skipped" | "failed";
	/** present only when `status === "failed"` — the error message */
	error?: string;
}

/**
 * The runtime backend seam. Eight methods; `create / streamEvents / status /
 * sendMessage / cancel / terminate` are firm and fully grounded, `finalize` is
 * the load-bearing §4 seam (its existence is not optional — something must
 * bridge the filesystem gap under pod-per-run).
 */
/** `WARREN_RUNTIME` backend id on a live provider (warren-e1f1). */
export type RuntimeProviderKind = "local" | "docker" | "k8s";

export interface RuntimeProvider {
	readonly capabilities: RuntimeCapabilities;
	/** Backend identity — set once per concrete class (warren-e1f1). */
	readonly kind: RuntimeProviderKind;

	/**
	 * Create a run. Collapses burrow's two-call (`burrows.up` + `runs.create`)
	 * into one (§6.1). The provider OWNS: workspace materialization (burrow:
	 * internal; K8s: init container), callback-URL computation, seq origin,
	 * uid/gid, and filesystem-layout env. The domain supplies only neutral
	 * intent (`RunSpec`).
	 */
	create(spec: RunSpec): Promise<RunHandle>;

	/**
	 * Ordered, resumable, lossless event stream. The provider GUARANTEES a
	 * monotonic per-run `seq` (burrow server-assigns; K8s synthesizes a cursor
	 * over pod logs) and passes `payload` through verbatim (the cost extractor
	 * reads it).
	 */
	streamEvents(handle: RunHandle, opts?: StreamOpts): AsyncIterable<NormalizedEvent>;

	/**
	 * Out-of-band reconcile/recovery snapshot. NEVER throws on a missing run —
	 * returns `exists:false`. This is what the watchdog/recovery/pod-watcher use.
	 */
	status(handle: RunHandle): Promise<RunStatus>;

	/**
	 * Enqueue a steering message. Priority-desc then FIFO claim ordering,
	 * run-attributed, crash-safe (unread→delivered→failed). Delivery timing
	 * depends on `capabilities.midRunSteering` (live stdin vs next-spawn fold-in).
	 */
	sendMessage(handle: RunHandle, msg: OutboundMessage): Promise<Message>;

	/**
	 * Graceful stop — distinct from `terminate`. Burrow: POST /cancel. K8s:
	 * SIGTERM + grace. Best-effort; the domain still reaps + terminates after.
	 */
	cancel(handle: RunHandle, reason?: string): Promise<void>;

	/**
	 * Resolve the run's workspace path + push branch (warren-e9e1) — the neutral
	 * replacement for reap's direct `burrows.get`. LocalProvider returns the live
	 * burrow worktree path + branch; K8sProvider returns `{ workspacePath: null,
	 * branch }` (the pod's `emptyDir` is host-unreachable). Throws only on a
	 * genuine resolution failure — a `null` workspace path is a value, not a throw.
	 * The domain gates its success pipeline on this resolving rather than on a
	 * host path existing, so succeeded K8s runs reach `finalize`.
	 */
	workspaceInfo(handle: RunHandle): Promise<WorkspaceInfo>;

	/**
	 * Runs the workspace-DEPENDENT half of reap while the workspace is still
	 * live and returns its artifacts (§4). The load-bearing method, not a detail.
	 */
	finalize(handle: RunHandle, intent: FinalizeIntent): Promise<FinalizeResult>;

	/**
	 * Kill the sandbox/pod, reclaim the workspace, archive+prune the ephemeral
	 * store. Idempotent, best-effort. The domain calls this ONLY after
	 * `finalize()`.
	 */
	terminate(handle: RunHandle): Promise<TeardownResult>;
}
