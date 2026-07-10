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
 * Artifact-set diffs `finalize` extracts from the live workspace and returns for
 * the domain to apply to its project clone.
 *
 * Exact shapes are the §4 open sub-question for the finalize spike — worked out
 * empirically during the LocalProvider checkpoint by serializing the current
 * in-process merge logic across the seam. Left as deferred placeholders so the
 * core contract compiles without inventing a shape the design doc doesn't fix.
 */
export type MulchDelta = unknown;
export type SeedsDelta = unknown;
export type PlansDelta = unknown;
export type PlotDelta = unknown;

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
	closeSeedId?: string;
}

export interface FinalizeResult {
	pushed: boolean;
	commitsAhead: number;
	/** dropped-commit detection */
	emptyPush: boolean;
	/** artifact diffs the domain applies to the project clone */
	mirror: {
		mulch?: MulchDelta;
		seeds?: SeedsDelta;
		plans?: PlansDelta;
		plot?: PlotDelta;
	};
	prBranch: string | null;
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
