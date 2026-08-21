# RuntimeProvider Contract — Design Spike

**Kind:** contract
**Design state:** approved
**Delivery:** shipped
**Arrived:** 2026-07-09
**Shipped:** v0.10.0
**Current truth:** `src/runtime/contract.ts` and `src/runtime/registry.ts`

> **HISTORICAL — shipped in v0.10.0.** This document is a design record, not a plan in flight. The contract below now lives in `src/runtime/contract.ts`, and both backends implement it — see [`docs/RUNBOOK-K8S.md`](../RUNBOOK-K8S.md) §0 for the operator view. Read the code when the two disagree.

**Date:** 2026-07-09
**Companion:** [`k8s-migration.md`](./k8s-migration.md) — the architecture record this seam serves
**Grounded in:** three codebase ground-truth audits (dispatch/RunSpec, event/status,
steer/terminate/capabilities), 2026-07-09.

---

## 0. The test this contract must pass

The domain must never leak a burrow-id, a pod name, a socket, a host path, or a
`SandboxProfile` across the seam. If swapping the provider forces a change in
`src/runs/*` domain logic, the abstraction failed (design bible: *"if swapping the
framework requires rewriting the domain, the domain wasn't separated"*).

Everything below is derived from what warren **actually** does to burrow today, not
from what a K8s API affords. The contract is warren's need; providers satisfy it.

---

## 1. The interface

```ts
interface RuntimeProvider {
  readonly capabilities: RuntimeCapabilities;

  // Create a run. Collapses burrow's two-call (burrows.up + runs.create) into one.
  // The provider OWNS: workspace materialization (burrow: internal; K8s: init
  // container), callback-URL computation, seq origin, uid/gid, and filesystem-layout
  // env. The domain supplies only neutral intent (RunSpec).
  create(spec: RunSpec): Promise<RunHandle>;

  // Ordered, resumable, lossless event stream. Provider GUARANTEES a monotonic
  // per-run `seq` (burrow server-assigns; K8s synthesizes a cursor over pod logs)
  // and passes `payload` through verbatim (the cost extractor reads it).
  streamEvents(handle: RunHandle, opts?: StreamOpts): AsyncIterable<NormalizedEvent>;

  // Out-of-band reconcile/recovery snapshot. NEVER throws on a missing run —
  // returns `exists: false`. This is what the watchdog/recovery/pod-watcher use.
  status(handle: RunHandle): Promise<RunStatus>;

  // Enqueue a steering message. Priority-desc then FIFO claim ordering, run-attributed,
  // crash-safe (unread→delivered→failed). Delivery timing depends on
  // `capabilities.midRunSteering` (live stdin vs next-spawn fold-in).
  sendMessage(handle: RunHandle, msg: OutboundMessage): Promise<Message>;

  // Graceful stop — distinct from terminate. Burrow: POST /cancel. K8s: SIGTERM +
  // grace period. Best-effort; the domain still reaps + terminates afterward.
  cancel(handle: RunHandle, reason?: string): Promise<void>;

  // Runs the workspace-DEPENDENT half of reap while the workspace is still live and
  // returns its artifacts. See §4 — this is the load-bearing method, not a detail.
  finalize(handle: RunHandle, intent: FinalizeIntent): Promise<FinalizeResult>;

  // Kill the sandbox/pod, reclaim the workspace, archive+prune the ephemeral store.
  // Idempotent, best-effort. The domain calls this ONLY after finalize().
  terminate(handle: RunHandle): Promise<TeardownResult>;
}
```

Eight methods. `create / streamEvents / status / sendMessage / cancel / terminate`
are firm and fully grounded. `finalize` is the one whose *shape* needs the §4
decision — its existence is not optional (something must bridge the filesystem gap),
but what it carries depends on how much reap moves in-pod.

---

## 2. Types

```ts
// Opaque handle — the only run reference that crosses the seam. Providers map
// runId → native ids internally; the domain treats sandboxId/providerRunId as opaque.
interface RunHandle {
  runId: string;          // warren domain id — the identity, generated pre-dispatch
  sandboxId: string;      // provider workspace/sandbox id (burrowId | pod name)
  providerRunId: string;  // provider run/dispatch id (burrowRunId | pod uid)
}

// Provider-neutral INTENT. No SandboxProfile, no host paths, no callback URL.
interface RunSpec {
  runId: string;

  // Workspace materialization INPUTS (never a pre-built result — the provider
  // materializes: burrow internally, K8s in an init container).
  originUrl: string;
  branch: string;
  baseBranch: string;          // PROMOTED to first-class — the domain resolves it
                               // (default_branch ?? "main") and BOTH providers forward it:
                               // LocalProvider → burrow's POST /burrows baseBranch (git
                               // worktree add -b <branch> <baseBranch>); K8s init container
                               // needs it explicit. The workspace branch is cut from it.
  hostClonePathHint?: string;  // optional burrow worktree optimization; K8s ignores it.

  // Agent.
  runtimeId: string;           // claude-code | pi | codex — selects image/toolchain
  prompt: string;              // system section already prepended by the domain
  metadata?: Record<string, unknown>;   // e.g. { frontmatter } — provider carries to runtime
  mode: "batch" | "conversation";

  // Isolation INTENT (provider maps to SandboxProfile | pod securityContext+resources).
  network: "none" | "restricted" | "open";
  resources?: { memoryMiB?: number; cpuMillicores?: number };
  timeoutMs?: number;

  // Context drops written into the workspace (.canopy/.mulch/.seeds/.pi).
  seedFiles: ReadonlyArray<{ path: string; contents: string; encoding?: string; mode?: number }>;

  // DOMAIN env only — coordination + secrets: PLOT_ID, PLOT_ACTOR,
  // WARREN_QUALITY_GATE, WARREN_API_TOKEN. The provider ADDS its own plumbing
  // (WARREN_API_URL callback, BUN_INSTALL_CACHE_DIR, …); the domain must NOT set those.
  env: Record<string, string>;
}

interface NormalizedEvent {
  seq: number;   // monotonic per run — burrow server-assigns, K8s provider synthesizes
  ts: string;    // ISO-8601
  kind: string;  // OPEN string. Terminal envelopes ride kind="state_change",
                 // discriminated by payload.type ("result"|"agent_end") — do NOT
                 // lift them into a typed terminal event or detectRuntimeTerminal breaks.
  stream: "stdout" | "stderr" | "system" | null;   // unknown coerces to null
  payload: unknown;   // LOSSLESS — providers MUST NOT summarize; the budget/cost
                      // extractor reads total_cost_usd/usage out of these payloads.
}

interface StreamOpts { sinceSeq?: number; }   // resume cursor (dedup: domain skips seq <= sinceSeq)

type RunPhase = "queued" | "running" | "succeeded" | "failed" | "cancelled";
type TerminalReason = "completed" | "error" | "oom_killed" | "cancelled" | "lost";

interface RunStatus {
  phase: RunPhase;
  exitCode: number | null;
  terminalReason?: TerminalReason;   // NEW VALUE — promotes OOM + lost to first-class.
                                     // Burrow ALREADY has the signal (oomKilled() probe +
                                     // oom_killed event) that warren currently discards; K8s
                                     // gives it via terminated.reason=="OOMKilled". Unify here.
  lastEventSeq: number;              // collapses the separate maxSeqForRun query
  lastEventTs: string | null;        // heartbeat anchor (domain still owns the watchdog decision)
  exists: boolean;                   // false ⇒ run_lost (burrow 404 / pod GC'd) — a value, not a throw
}

type MessagePriority = "low" | "normal" | "high" | "urgent";
interface OutboundMessage { body: string; priority?: MessagePriority; fromActor?: string; }
interface Message {          // the persisted row returned to the domain
  id: string; runId: string | null; body: string; priority: MessagePriority;
  fromActor: string; state: "unread" | "delivered" | "failed";
  createdAt: string; deliveredAt: string | null;
}

interface RuntimeCapabilities {
  previewPorts: boolean;                                  // inbound port exposure supported
  networkPolicy: "none" | "coarse" | "domain-allowlist"; // burrow: domain-allowlist; K8s v1: coarse
  longLived: boolean;                                     // conversation / holdStdin streaming
  midRunSteering: boolean;                                // deliver mid-turn vs next-spawn only
  enforcedResourceLimits: boolean;                        // cgroup memory/cpu + oomKilled
  workspaceArchive: boolean;                              // terminate returns an archive handle
}

interface TeardownResult {
  archived: boolean; deletedEvents: number; deletedMessages: number; deletedRuns: number;
}
```

---

## 3. What stays in the DOMAIN — the anti-leak guardrail

These are NOT provider methods. They are computed off warren's own persisted state
and must not migrate into the contract, or the abstraction leaks:

- **Heartbeat / watchdog / the `mode==="conversation"` exclusion.** Idle is derived
  from the stored events table; neither backend knows about `mode`. The provider
  supplies `lastEventTs`; the *decision to force-fail* stays in the domain.
- **Fine-grained `failure_reason`** (`never_started`, `no_model_response`, `crashed`,
  `dropped_commit`, …). Derived by reap from the persisted event log, not the stream.
  Only the coarse `terminalReason` (§2) is a provider concern.
- **Budget/cost cap enforcement.** Pure domain — reads a warren-frozen column, caps on
  cumulative cost extracted from event payloads. The provider's only obligation is
  lossless payloads.
- **Pause/resume.** No runtime pause primitive exists. `"paused"` is domain state over
  the event stream + inbox; the process keeps running. `holdStdin` is an internal
  spawn detail, abstracted behind `capabilities.longLived`.
- **Placement / worker routing.** Deleted entirely (plan §5.C), not abstracted.

---

## 4. The load-bearing decision: reap under pod-per-run

**The problem the design doc missed.** Today's reap pipeline
(`src/runs/reap/pipeline.ts`) does its workspace-dependent work — `mergeMulch`,
`mirrorSeeds`, `mirrorPlans`, `mergePlot`, `stageSeedsForCommit`, `closeRunSeedId`,
`git push origin HEAD:<branch>`, commits-ahead count, PR open — by reading
`.seeds`/`.plot`/`plans.jsonl` off the worktree and running git against it **directly
on the host filesystem**. This works only because co-tenancy means warren and the
workspace share a disk.

Under pod-per-run, the control-plane pod and the run pod's `emptyDir` **share
nothing**. Warren cannot `fs.read` the workspace or `git push` from it. The reap
model must move to where the workspace is.

**Rejected: `exec(handle, argv)` on the contract.** The obvious patch — expose a
remote-exec/file-read surface — was flagged by the ground-truth audit as a leak. For
LocalProvider it's a trivial host shell; for K8s it forces a stateful
`kubectl exec`-style session into a live pod, which breaks on pod/warren restart
(the exact fragility the design doc rejected for steering). It also drags host-path
and git-exec semantics back across the seam. Do not add it.

**DECIDED (2026-07-09): `finalize(handle, intent)` — reap-where-the-workspace-is.**
The provider runs the workspace-dependent half of reap *in place* and returns
structured artifacts the domain applies to the project clone on its own side:

```ts
interface FinalizeIntent {
  branch: string;
  push: boolean;                    // push HEAD:branch from inside the workspace
  mirror: ("mulch" | "seeds" | "plans" | "plot")[];   // which artifact sets to extract
}
interface FinalizeResult {
  pushed: boolean;
  commitsAhead: number | null;      // null = not measured (warren-f3bb)
  commitsAheadBase?: string;        // ref the count ran against; a repair run pins the
                                    // pre-push origin/<base> SHA (warren-ba08)
  emptyPush: boolean;               // dropped-commit detection
  mirror: {                         // artifact diffs the domain applies to the project clone
    mulch?: MulchDelta; seeds?: SeedsDelta; plans?: PlansDelta; plot?: PlotDelta;
  };
  prBranch: string | null;
}
```

- **LocalProvider:** executes host-side against the worktree exactly as reap does
  today — a thin wrapper over the existing pipeline. Zero behavior change.
- **K8sProvider:** runs finalize as a **post-agent step inside the pod** (the agent
  container's exit hook, or a short-lived reap step in the same pod before teardown),
  which pushes the branch and emits the mirror deltas back over the event stream /
  API. Warren applies the returned deltas to its project clone. Stateless, restart-safe,
  and 12-factor (the pod owns its workspace; the control plane never reaches in).

This keeps the domain orchestration (*when* to reap, whether to open a PR, plan-run
chaining) intact and out of the provider — only the *workspace-touching execution*
crosses the seam. The ordering contract is explicit: **domain calls `finalize`, then
`terminate`.** `finalize` is skipped under the same conditions reap is skipped today
(conversation mode, preview still live).

### 4.1 Salvage-before-destroy (warren-cd3b, 2026-07-30)

A failed `finalize` used to erase the run's committed work. The branch push
never landed, and then the workspace went away. LocalProvider destroyed it.
Under K8s the preserve skip was a no-op, because the pod's `emptyDir` died
with the container.

Salvage closes that hole. **Before warren destroys a workspace after a
failed finalize, the side that can still reach it captures the work** in two
forms:

1. **Rescue ref** — push `HEAD` to `warren/rescue/<runId>` on origin. Recovery is one `git fetch`. Push protection can refuse this push too.
2. **Git bundle** — `git bundle create <base>..HEAD` at `<dataDir>/salvage/<runId>.bundle`. The bundle never touches origin, so push protection cannot block it.

Under K8s, salvage first folds a dirty tree into a warren bookkeeping commit
with `git add -A` and the canonical bot identity (warren-6016). A run that
died with uncommitted work is exactly the case salvage exists for. A range
bundle over a dirty tree refuses as empty.

The in-pod rescue push authenticates with the intent-carried `gitToken` when
one parked, else with the pod-carried `WARREN_GIT_TOKEN` from the same
`warren-git-token` Secret the init container clones with.
The harness alone holds that credential.
The entrypoint spawns the agent child with the token scrubbed, so the agent
itself never holds a push token.

The runtime split mirrors `finalize` itself.

- **LocalProvider:** the salvage step (`src/runs/reap/salvage.ts`) runs inside reap before `runWorkspaceDestroy`. A captured work product lifts the old preserve-the-workspace skip. A total failure keeps the skip and emits `reap.workspace_salvage_failed`.
- **K8sProvider:** the pod salvages itself (`src/runtime/k8s/salvage.ts`). On a failed push it posts BEFORE the finalize result that releases warren to destroy the pod. With no intent at all it retries the bundle POST through the rollout window (`WARREN_SALVAGE_MAX_WAIT_MS`).

The intake route `POST /runs/:id/salvage` stores the bundle, stamps
`salvage_ref`/`salvage_path` on the run row, and emits
`reap.workspace_salvaged`. In-flight runs survive a control-plane rollout
with their work recoverable. Warren does not drain dispatch during a
rollout. The lost finalize message names the pod phase and terminalReason,
so root causes no longer collapse into one string.

**Open sub-questions for the finalize spike** (do not block the core contract):
- Exact `MulchDelta`/`SeedsDelta`/`PlansDelta`/`PlotDelta` shapes — how much of the
  current in-process merge logic serializes cleanly across the seam.
- Whether K8s finalize is an in-container exit hook vs. a distinct reap container in
  the pod (init-container-style, but terminal).
- How the mirror deltas travel — piggyback on the NDJSON event stream, or a dedicated
  `POST /internal/runs/:id/finalize` callback.

---

## 5. Capability degradations the domain must handle

Grounded divergences where K8s v1 can't match LocalProvider — the domain branches on
`capabilities`, it does not assume:

| Capability | Local | K8s v1 | Domain behavior when absent |
|---|---|---|---|
| `midRunSteering` | true (pi stdin-RPC) | maybe false | Fall back to next-spawn fold-in (the codex path already exists) — steering lands on the next turn, not mid-turn. Visible latency change, not a break. |
| `networkPolicy` | `domain-allowlist` (per-run proxy + `allowedDomains`) | `coarse` | `restricted` degrades to `open`-or-`none`; surface the downgrade. No per-domain allowlist at v1. |
| `previewPorts` | loopback `hostPort` + reverse proxy | Service/Ingress URL | Preview endpoint must be an **opaque URL** the provider returns, not an assumed `127.0.0.1:port`. Keeps `src/preview/proxy` from hard-coding loopback. Deferred past initial migration (plan §5.F). |
| `longLived` | true | pod stays up, stdin transport differs | Conversation runs need the separate long-lived pod template (design doc Q3). |

---

## 6. Corrections this contract bakes in (from ground truth)

1. **Two-call create → one `create()`** (burrow's `burrows.up` + `runs.create` collapse).
2. **`baseBranch` promoted** to a RunSpec field, forwarded verbatim by LocalProvider to
   burrow's `POST /burrows` (previously resolved burrow-internally; K8s needs it explicit).
3. **Callback URL is provider-owned**, not domain env — `http://localhost:PORT` is a
   co-tenancy assumption; K8s uses Service DNS. Domain `env` excludes `WARREN_API_URL`.
4. **`seq` is a provider guarantee** — free in burrow, synthesized by K8s over pod logs.
   Single biggest K8s implementation burden.
5. **OOM + lost become first-class `terminalReason`s** — burrow already emits the OOM
   signal warren currently throws away; this is net value the migration unlocks.
6. **Payloads are lossless across the seam** — non-negotiable, the cost extractor depends on it.
7. **Missing-run is a status value (`exists:false`), not a thrown `NotFoundError`.**
8. **Reap-then-terminate ordering** is an explicit contract obligation (§4).

---

## 7. Next step

The eight-method interface is now settled, including the §4 `finalize` seam (decided:
in-pod reap, not `exec`). It is ready to implement `LocalProvider` against — wrap the
existing burrow-client so today's behavior flows through the seam unchanged. That's
the plan's §6 checkpoint 2 and it proves the contract before any K8s exists.

The remaining work is scoped, not open:
- **finalize delta shapes** (`MulchDelta`/`SeedsDelta`/`PlansDelta`/`PlotDelta`) — worked
  out empirically during the LocalProvider checkpoint by serializing the current
  in-process merge logic across the seam.
- **finalize delta transport** (piggyback the NDJSON stream vs. a dedicated callback)
  and **K8s finalize form** (container exit hook vs. terminal reap container) — K8sProvider
  concerns, deferred to that build; they do not change the domain-facing contract.
