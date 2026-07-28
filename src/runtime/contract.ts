/**
 * The `RuntimeProvider` contract — the seam that decouples warren's domain from
 * its execution backend (burrow today, Kubernetes next).
 *
 * Authoritative spec: `docs/design/runtime-provider-contract.md` (sections 1–2,
 * with the §4 finalize seam and §6 corrections baked in). This file is
 * types-only; the LocalProvider implementation lands in a later step.
 *
 * The invariant the contract exists to protect: the domain must never leak a
 * burrow-id, a pod name, a socket, a host path, or a `SandboxProfile` across the
 * seam. Everything here is warren's *need*; providers satisfy it.
 */

import type { ArtifactDelta } from "./finalize-deltas.ts";

/**
 * Opaque handle — the only run reference that crosses the seam. Providers map
 * `runId` → native ids internally; the domain treats `sandboxId`/`providerRunId`
 * as opaque.
 */
export interface RunHandle {
	/** warren domain id — the identity, generated pre-dispatch */
	runId: string;
	/** provider workspace/sandbox id (burrowId | pod name) */
	sandboxId: string;
	/** provider run/dispatch id (burrowRunId | pod uid) */
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

	/**
	 * OPTIONAL project identity (the warren `projects.id`). K8s stamps it onto the
	 * pod (`warren.io/project`) and counts by it for the per-project admission cap
	 * (warren-b6f2); LocalProvider ignores it.
	 */
	projectId?: string;
	/**
	 * OPTIONAL per-project concurrency cap — max simultaneous non-terminal run
	 * pods for this project, from `.warren/config.yaml` `admission.maxConcurrentRuns`
	 * (warren-b6f2). K8s enforces it; LocalProvider ignores it.
	 */
	maxProjectConcurrency?: number;

	// Agent.
	/** claude-code | pi | codex | sapling — selects image/toolchain */
	runtimeId: string;
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
	 * `resources` (warren-aedd) — the dispatch path reads the project config once
	 * and carries the subset here because the provider is built at boot and can't
	 * re-read it per run (same pattern as `maxProjectConcurrency`). Precedence:
	 * per-run `resources` limit > `projectResources` > env defaults. K8s only.
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
 * extractor reads `total_cost_usd`/`usage` out of these payloads.
 */
export interface NormalizedEvent {
	/**
	 * Monotonic per run — burrow server-assigns, K8s synthesizes a cursor over
	 * pod logs (§6.4, the single biggest K8s implementation burden).
	 */
	seq: number;
	/** ISO-8601 */
	ts: string;
	/**
	 * OPEN string. Terminal envelopes ride `kind="state_change"`, discriminated
	 * by `payload.type` (`"result"` | `"agent_end"`) — do NOT lift them into a
	 * typed terminal event or `detectRuntimeTerminal` breaks.
	 */
	kind: string;
	/** unknown coerces to `null` */
	stream: "stdout" | "stderr" | "system" | null;
	/** LOSSLESS — see interface doc; typed `unknown` deliberately. */
	payload: unknown;
}

/** Resume cursor — dedup: the domain skips `seq <= sinceSeq`. */
export interface StreamOpts {
	sinceSeq?: number;
}

export type RunPhase = "queued" | "running" | "succeeded" | "failed" | "cancelled";

/**
 * Coarse terminal reason — the only terminal classification that is a provider
 * concern (fine-grained `failure_reason` stays in the domain, §3).
 *
 * - `completed` — agent finished normally.
 * - `error` — agent/runtime failed.
 * - `oom_killed` — killed by the cgroup/OOM killer. NEW first-class value (§6.5):
 *   burrow already emits this signal (oomKilled() probe + `oom_killed` event)
 *   and warren currently discards it; K8s gives it via `terminated.reason=="OOMKilled"`.
 * - `evicted` — the kubelet evicted the pod (K8s `status.reason=="Evicted"`) under
 *   node resource pressure — most commonly ephemeral-storage exhaustion (a git
 *   clone + `bun install` overrunning the emptyDir budget, warren-c0cd). Distinct
 *   from `oom_killed` (a container cgroup kill) and from a plain `error`: an
 *   eviction is an infra-capacity signal, not an agent fault, so it earns its own
 *   reason. K8s-only (LocalProvider has no eviction concept).
 * - `cancelled` — graceful stop via `cancel()`.
 * - `lost` — run vanished (burrow 404 / pod GC'd); pairs with `exists:false`.
 */
export type TerminalReason =
	| "completed"
	| "error"
	| "oom_killed"
	| "evicted"
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
	/** collapses the separate `maxSeqForRun` query */
	lastEventSeq: number;
	/** heartbeat anchor (the domain still owns the watchdog decision) */
	lastEventTs: string | null;
	/** `false` ⇒ run_lost (burrow 404 / pod GC'd) — a value, not a throw */
	exists: boolean;
}

export type MessagePriority = "low" | "normal" | "high" | "urgent";

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
	state: "unread" | "delivered" | "failed";
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
	 * Fallback garbage collection of stranded run workspaces is a backend
	 * concern the control plane can drive (warren-e24d). `true` for the
	 * burrow-backed LocalProvider — reap's per-run destroy can leave a
	 * workspace stranded on a mid-reap crash, so warren runs a periodic sweep
	 * that destroys idle workspaces via the provider's destroy seam. `false`
	 * for backends whose own lifecycle reclaims stranded workspaces (K8s: the
	 * pod-GC loop reclaims terminal pods + their emptyDir), so the domain sweep
	 * stays dark and never issues a burrow-only destroy against a pod name.
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
 * A THROW means resolution failed (a live burrow that 404'd, an API error) —
 * the domain records `workspace_lookup` and skips the success pipeline, exactly
 * as reap did when `burrows.get` threw. A returned value with `workspacePath:
 * null` is NOT a failure: it is the K8s backend reporting a legitimately
 * host-unreachable (but finalizable) workspace.
 */
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
 * workspace-touching execution crosses the seam. Ordering is an explicit
 * obligation: the domain calls `finalize`, then `terminate` (§6.8).
 */
export interface FinalizeIntent {
	branch: string;
	/** push HEAD:branch from inside the workspace */
	push: boolean;
	/**
	 * Which artifact sets to extract (the MERGE half — always run in reap),
	 * named by OPAQUE provider keys (warren-df3e). The finalize contract no
	 * longer enumerates features: the domain passes the keys it wants merged
	 * (e.g. `["mulch", "seeds", "plans"]`) and the provider maps each to its own
	 * merge; the returned {@link FinalizeResult.artifacts} is keyed the same way.
	 */
	artifacts: string[];
	/**
	 * Which bookkeeping COMMITS to author before the push (warren-1f56). The
	 * reap pipeline runs the tracker merges unconditionally but gates the
	 * `chore(warren): seeds state` commit on `project.hasSeeds` — so
	 * merge-gating (`artifacts`) and commit-gating cannot be one set. `commit`
	 * decouples them: finalize authors the seeds bookkeeping commit iff this
	 * includes `"seeds"`. OMITTED ⇒ defaults to `artifacts` (commit whatever we
	 * merge) so callers that only ever passed the merge set keep their existing
	 * behavior.
	 */
	commit?: "seeds"[];
	/**
	 * Base ref for the commits-ahead / empty-push count
	 * (`git rev-list --count <baseBranch>..HEAD`). A provider-NEUTRAL git ref
	 * (RunSpec.baseBranch was promoted first-class, §6.2), NOT a host path.
	 * Omitted ⇒ the count is skipped and `commitsAhead` is `null` — the same
	 * way reap degrades when burrow exposed no base branch (warren-f3bb).
	 */
	baseBranch?: string;
	/**
	 * SEAM SIGNAL (mirrors `RunSpec.hostClonePathHint`): the host path of the
	 * project clone the LocalProvider merges each tracker INTO — a host path
	 * with no provider-neutral home. REQUIRED by the burrow backend whenever
	 * `artifacts` is non-empty (it does the merge host-side against the shared
	 * disk, exactly as reap does today); the K8s backend IGNORES it (the in-pod
	 * finalize has no clone — it emits the deltas above and the control plane
	 * applies them, plan step 20).
	 */
	projectClonePathHint?: string;
	closeSeedId?: string;
	/**
	 * warren-8d95: warren-seeded workspace artifacts (the rendered agent
	 * envelope + `.pi/` drops + `.seeds/workflow.txt`) that must be RESET to
	 * `baseBranch` before `branch_push` so they never ride into a PR. In
	 * projects that themselves track a colliding path, warren's seed dirties the
	 * tracked file and a
	 * broad agent commit (`git add -A`) sweeps it into the branch, tripping the
	 * Article IX protected-path automerge guard. Each entry carries the path and
	 * the exact bytes warren seeded; finalize only resets a path whose live
	 * workspace content still EQUALS the seeded bytes (so an intentional agent
	 * edit is preserved). Omitted / empty ⇒ the reset stage is skipped (existing
	 * callers unchanged). LocalProvider honors it; the K8s wire does not yet
	 * project it.
	 */
	resetSeededPaths?: ReadonlyArray<{ path: string; contents: string }>;
}

/**
 * One user-visible event a merge stage emitted, captured by finalize's
 * collecting emit/fail and returned for the domain to re-emit through its REAL
 * event surface (warren-1f56). The reap merge functions emit ~10 per-record
 * kinds (`mulch.record.*`, `seeds.closed/created`, `seeds.plan_mirrored`,
 * `reap.seeds_committed`) plus per-line/stage `reap_failed`;
 * finalize returns `FinalizeResult` counts, so those events are unreconstructable
 * unless carried here. K8s-friendly: this array rides the callback wire from the
 * in-pod finalize later (plan step 20), so `payload` MUST be JSON-serializable
 * (plain objects only — same posture as `NormalizedEvent.payload`).
 */
export interface FinalizeEvent {
	kind: string;
	payload: unknown;
}

export interface FinalizeResult {
	pushed: boolean;
	/**
	 * Commits the pushed branch is ahead of `intent.baseBranch`. WIDENED from
	 * the design-doc's `number` to `number | null` to match reap's real shape
	 * (warren-f3bb): the count is genuinely uncomputable when the push was
	 * skipped/failed, no `baseBranch` was supplied, or `git rev-list` failed,
	 * and collapsing that to `0` would masquerade a failed count as an empty
	 * push. `0` means the push landed no new commits; positive means real work.
	 */
	commitsAhead: number | null;
	/** dropped-commit detection: pushed but zero commits ahead of the base */
	emptyPush: boolean;
	/**
	 * Workspace-dirtiness at push time (warren-1f56): `git status --porcelain`
	 * was non-empty. Probed ONLY when `pushed && commitsAhead === 0` (matching
	 * reap's `commitsAheadStep`), `false` otherwise. The domain owns the
	 * `droppedCommit` derivation (`dirty && outcome === "succeeded"`) and the
	 * `reap.empty_push` emission — both need the run outcome, a domain concern
	 * the provider seam does not carry, and the workspace is provider-owned +
	 * destroyed by `terminate`, so the domain cannot re-probe post-finalize.
	 */
	dirty: boolean;
	/**
	 * The workspace-relative paths of every uncommitted change at push time
	 * (warren-89b0), populated ONLY when `dirty` is true (i.e. `pushed &&
	 * commitsAhead === 0` over a dirty tree). The domain uses it to classify a
	 * zero-commit dirty tree: a tree whose ONLY dirty paths are warren-managed
	 * bookkeeping artifacts (`.mulch/`, `.seeds/`, `.plot/`) is a
	 * deliberate no-op (`succeeded`, non-alarming) rather than a dropped commit
	 * (`failed`). Optional/absent ⇒ the domain falls back to the conservative
	 * dropped-commit posture (it cannot prove the tree was bookkeeping-only).
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
	 * workspace-touching stage is best-effort, so the domain must see which
	 * merged, which were skipped, and which failed (with the message) without
	 * reverse-engineering it from the deltas.
	 */
	stages: FinalizeStageOutcome[];
}

/** The workspace-touching stages `finalize` runs, in pipeline order. */
export type FinalizeStage =
	| "mulch_merge"
	| "seeds_mirror"
	| "plans_mirror"
	| "seeds_commit"
	| "seed_reset"
	| "branch_push"
	| "commits_ahead";

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
export interface RuntimeProvider {
	readonly capabilities: RuntimeCapabilities;

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
	 * SIGTERM + grace period. Best-effort; the domain still reaps + terminates
	 * afterward.
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
