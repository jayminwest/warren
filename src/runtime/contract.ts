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
	resources?: { memoryMiB?: number; cpuMillicores?: number };
	timeoutMs?: number;

	/** Context drops written into the workspace (.canopy/.mulch/.seeds/.pi). */
	seedFiles: ReadonlyArray<{ path: string; contents: string; encoding?: string; mode?: number }>;

	/**
	 * DOMAIN env only — coordination + secrets: PLOT_ID, PLOT_ACTOR,
	 * WARREN_QUALITY_GATE, WARREN_API_TOKEN. The provider ADDS its own plumbing
	 * (WARREN_API_URL callback, BUN_INSTALL_CACHE_DIR, …); the domain must NOT
	 * set those.
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
 * - `cancelled` — graceful stop via `cancel()`.
 * - `lost` — run vanished (burrow 404 / pod GC'd); pairs with `exists:false`.
 */
export type TerminalReason = "completed" | "error" | "oom_killed" | "cancelled" | "lost";

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
}

export interface TeardownResult {
	archived: boolean;
	deletedEvents: number;
	deletedMessages: number;
	deletedRuns: number;
}

/**
 * Artifact-set deltas `finalize` extracts from the live workspace and returns
 * for the domain to apply to its project clone. PINNED (pl-829f step 12 /
 * warren-371a) by SERIALIZING what today's in-process reap merge functions
 * (`src/runs/reap/{mulch,seeds,plot-merge}.ts`) actually produce — grounded in
 * their real return values, not a speculative shape.
 *
 * Contract guarantees for every delta:
 *   - **JSON-serializable** — round-trips through `JSON.parse(JSON.stringify(x))`
 *     unchanged. These are the wire format the K8s in-pod finalize (plan step
 *     20) emits over its callback, so no `Map`/`Set`/`Date`/`undefined` slots.
 *   - **`version`-tagged** so the wire format can evolve unambiguously.
 *   - **Apply-complete without filesystem access** — mulch / seeds / plans each
 *     carry the full post-merge JSONL body, so the domain applies by overwriting
 *     the target file; it never has to read the (by-then-destroyed) workspace.
 *     The counts mirror each merge function's own return value.
 *
 * PlotDelta is deliberately the exception — see its doc.
 */

/** One domain's post-merge mulch expertise file. */
export interface MulchDeltaFile {
	/** expertise filename minus `.jsonl` (e.g. `build`) */
	domain: string;
	/** clone-relative (posix) target path: `.mulch/expertise/<domain>.jsonl` */
	path: string;
	/** full merged JSONL body — the domain writes it verbatim */
	mergedBody: string;
}

/**
 * mulch expertise LWW-merge result — mirrors `MulchMergeResult`
 * (`{updated,skipped,appended}`) plus the per-file merged bodies
 * `mergeMulchFile` produces. "real effort" per `data-plane-trajectory.md`:
 * mulch is the memory layer, so its delta is complete.
 */
export interface MulchDelta {
	version: 1;
	/** records replaced because the incoming `recorded_at` was newer */
	updated: number;
	/** records dropped because the incoming was older-or-equal */
	skipped: number;
	/** brand-new records appended */
	appended: number;
	/** one entry per workspace expertise file, carrying its merged body */
	files: MulchDeltaFile[];
}

/**
 * seeds issue-tracker close/create mirror — mirrors `MirrorSeedsResult`
 * (`{closed,created}`) plus the merged `issues.jsonl`. Connector-shaped per
 * `data-plane-trajectory.md` (seeds is a swappable tracker), so this is done
 * properly: the full merged body travels for a filesystem-free apply.
 */
export interface SeedsDelta {
	version: 1;
	/** rows transitioned to `closed` (added-as-closed or status-updated) */
	closed: number;
	/** brand-new rows (e.g. planner-created) added to the clone */
	created: number;
	/** clone-relative (posix) target path: `.seeds/issues.jsonl` */
	path: string;
	/**
	 * full merged issues.jsonl, or `null` when the mirror was a no-op (the
	 * workspace had no `.seeds/issues.jsonl`, or it produced no delta).
	 */
	mergedBody: string | null;
}

/**
 * seeds plan mirror — append-only (plans are immutable once submitted).
 * Mirrors `mirrorPlans`'s `added` count plus the merged `plans.jsonl`.
 */
export interface PlansDelta {
	version: 1;
	/** plan rows appended to the clone */
	appended: number;
	/** clone-relative (posix) target path: `.seeds/plans.jsonl` */
	path: string;
	/** full merged plans.jsonl, or `null` when nothing was appended */
	mergedBody: string | null;
}

/**
 * Plot event/state mirror — deliberately THIN and disposable.
 * `data-plane-trajectory.md` marks plot the FIRST tool to go ("keep its
 * `finalize()` mirror delta thin and disposable"), so this carries only the
 * `PlotMergeResult` counts — NO merged bodies, NO per-event contents. The plot
 * files themselves still ride to origin on the pushed branch (the
 * `chore(warren): plot state` bookkeeping commit); this delta is pure
 * observability, and intentionally NOT apply-complete on its own.
 */
export interface PlotDelta {
	version: 1;
	/** event-log lines appended across all plots */
	eventsAppended: number;
	/** `plot-*.json` state docs overwritten (LWW on `updated_at`) */
	plotsUpdated: number;
	/** agent-emitted decision/question/artifact events worth surfacing */
	mirrored: number;
}

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
	/** which artifact sets to extract */
	mirror: ("mulch" | "seeds" | "plans" | "plot")[];
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
	 * `mirror` is non-empty (it does the merge host-side against the shared
	 * disk, exactly as reap does today); the K8s backend IGNORES it (the in-pod
	 * finalize has no clone — it emits the deltas above and the control plane
	 * applies them, plan step 20).
	 */
	projectClonePathHint?: string;
	closeSeedId?: string;
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
	/** artifact deltas the domain applies to the project clone */
	mirror: {
		mulch?: MulchDelta;
		seeds?: SeedsDelta;
		plans?: PlansDelta;
		plot?: PlotDelta;
	};
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
	| "plot_merge"
	| "plot_commit"
	| "seeds_commit"
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
