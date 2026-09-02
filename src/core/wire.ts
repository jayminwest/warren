/**
 * Canonical wire vocabulary (warren-b229 / pl-b82d step 26).
 *
 * THIS FILE IS THE SINGLE SOURCE OF TRUTH for every enum-shaped value that
 * crosses warren's HTTP wire (lifecycle states, failure-cause discriminators,
 * run mode, clone kind, event stream, inbox classes, salvage triggers, and
 * the HTTP response envelopes — warren-42f1). Every other layer — the
 * drizzle column metadata (`src/db/schema/columns.ts`), the SDK
 * (`src/client/types*.ts`), and the browser UI (`src/ui/src/api/types.ts`) —
 * RE-EXPORTS these names. None of them may redeclare one.
 * `bun run check:wire-types` (warren-d371) enforces that mechanically.
 *
 * Why `src/core/` and why this direction:
 *
 *   - `src/core/` is warren's dependency-free kernel (errors + ids). It
 *     imports nothing, so every layer — including the Vite-bundled UI, which
 *     must never reach `src/db/schema/` — can import it without inheriting a
 *     dependency.
 *   - The three surfaces drifted for as long as they were hand-kept copies
 *     (`RunFailureReason` lost values in the SDK and the UI;
 *     `RefreshAgentsResponse.removed` read as `{name}[]` against a server
 *     truth of `string[]`).
 *
 * Container-shape convention: every set is a frozen `as const` tuple
 * narrowed by `satisfies readonly <Union>[]`, so the tuple and the union it
 * derives can never disagree. Membership is tested with the exported type
 * guards, never by rebuilding a `Set` at a call site.
 *
 * The physical-schema constants (table names, index names, row-id helpers)
 * are NOT wire vocabulary and stay in `src/db/schema/columns.ts`.
 */

export const RUN_STATES = ["queued", "running", "succeeded", "failed", "cancelled"] as const;
export type RunState = (typeof RUN_STATES)[number];

export const RUN_TERMINAL_STATES = [
	"succeeded",
	"failed",
	"cancelled",
] as const satisfies readonly RunState[];
export type RunTerminalState = (typeof RUN_TERMINAL_STATES)[number];

/** True once a run can no longer change state. */
export function isTerminalRunState(state: RunState): state is RunTerminalState {
	return (RUN_TERMINAL_STATES as readonly RunState[]).includes(state);
}

/**
 * Run mode discriminator (pl-0344 step 1 / warren-67b6). `batch` is the
 * historical single-shot run: warren spawns burrow, agent runs to completion,
 * reap pushes the branch. Mode is fixed at run-create time; defaults to
 * `batch` so legacy rows match the historical shape (retired values dropped).
 */
export const RUN_MODES = ["batch"] as const;
export type RunMode = (typeof RUN_MODES)[number];

// The actor vocabulary of GET /whoami (warren-3754) lives in
// ./wire-actor.ts (file-size budget); re-exported for one canonical home.
export * from "./wire-actor.ts";
// Cost-basis vocabulary (warren-f3c3) lives in ./wire-cost.ts (file-size budget).
export * from "./wire-cost.ts";
// The steering-inbox vocabulary (warren-3d0b) lives in ./wire-inbox.ts;
// re-exported so the canonical import path stays `src/core/wire.ts`.
export * from "./wire-inbox.ts";
// The analytics-insight vocabulary (warren-be04) lives in
// ./wire-insight.ts (file-size budget); re-exported for one canonical home.
export * from "./wire-insight.ts";
// The runtime-id vocabulary (warren-c4be) lives in ./wire-runtime.ts
// (file-size budget); re-exported for one canonical home.
export * from "./wire-runtime.ts";
// The IssueTracker seam vocabulary (warren-6c29) lives in ./wire-tracker.ts.
export * from "./wire-tracker.ts";

/**
 * Chain-kind discriminator for a run that carries a `parent_run_id`
 * (warren-e96f). `continue` (warren-4b11) seeds the new run's workspace from
 * the parent's pushed branch; `replicate` (warren-e96f) is a fresh re-dispatch
 * of the parent's exact agent / model / project / prompt against the default
 * base. Nullable on the row (root runs leave it null); TS-only narrowing
 * (mx-2ab984); no SQL CHECK. Set at run-create time and never mutated.
 */
export const CLONE_KINDS = ["replicate", "continue"] as const;
export type CloneKind = (typeof CLONE_KINDS)[number];

/**
 * Failure-cause discriminator for a `failed` run (warren-3c40, warren-5165).
 * `state:failed` alone can't tell several different failure shapes apart.
 * Reap infers from the warren state on entry plus event content:
 *
 *   - still `queued` on entry ⇒ no events ever flowed from burrow ⇒
 *     `never_started` (config/runtime issue, e.g. under-specified prompt).
 *   - `running` on entry but events table holds no model-turn output
 *     (`text` / `thinking` / `tool_use` on stdout) ⇒ `no_model_response`
 *     (typically a credential/auth failure — the warren-5165 symptom was
 *     claude-code exiting with "Not logged in" before any assistant turn;
 *     also covers rate-limit and provider-network failures).
 *   - `running` on entry with model output ⇒ `crashed` (agent ran and
 *     hit an unrecoverable error mid-conversation).
 *   - `timed_out` (warren-285d) is set by the heartbeat watchdog
 *     (src/runs/watchdog.ts) when a `running` run goes silent-but-busy past
 *     `WARREN_RUN_HEARTBEAT_TIMEOUT_MS` — e.g. a runaway gate command behind
 *     a stuck bash tool. The watchdog cancels the burrow run and reaps it
 *     `failed` so the sandbox tree is torn down instead of pinning CPU
 *     forever; burrow reports no timeout state, so warren owns the deadline.
 *   - `sandbox_run_lost` (warren-b1a9; renamed from `burrow_run_lost` in
 *     warren-d15c for the runtime-neutral warren-36cb taxonomy) means the
 *     runtime backend has no record of the run — a burrow 404 (local) or a
 *     pod vanished from the API with no cancel intent (K8s). A pod warren
 *     deleted itself is NOT lost: cancel intent wins → `cancelled` (warren-fe9b).
 *   - `sandbox_unreachable` (warren-af76) means burrow stayed up but
 *     unresponsive — the socket probe timed out, so the bridge errored
 *     with `sandboxRunMissing:false` and reconnected with no forward
 *     progress past `BRIDGE_STALL_CEILING` consecutive attempts. The
 *     reconnect loop gives up and finalizes the warren row `failed` with
 *     this reason instead of spinning forever (the run otherwise wedges
 *     in `running`). Distinct from `sandbox_run_lost`, which is a clean
 *     404; here burrow never answered at all.
 *   - `dropped_commit` (warren-72b9) means reap's `git push` landed zero
 *     commits ahead of the base (`reap.empty_push`) AND the workspace was
 *     still dirty with non-bookkeeping paths — agent edited/staged work
 *     but never `git commit`ed. A clean tree, or dirt only under warren
 *     bookkeeping (`.mulch/`, `.seeds/`; warren-89b0), is a deliberate
 *     no-op: fresh-branch dispatches stay `succeeded` with `noChanges` on
 *     `reap.empty_push` / `reap.completed`; ref-dispatch (`ref` /
 *     `targetBranch`) reaps `failed`/`no_changes` instead (warren-ba08).
 *   - `no_changes` (warren-ba08): ref-dispatch zero-commit over a clean or
 *     bookkeeping-only tree — repair produced no new work. Distinct from
 *     `dropped_commit` (dirty non-bookkeeping tree). Fresh-branch no-ops
 *     keep the warren-89b0 succeeded+`noChanges`-flag shape.
 *   - `finalize_failed` (warren-495d) means reap's finalize did NOT
 *     complete its branch push before it timed out or failed — under K8s
 *     the in-pod finalize round-trip (git push → mirror deltas → POST the
 *     result) can time out (`WARREN_K8S_FINALIZE_TIMEOUT_MS`, default
 *     120s) or the pod can vanish / reach a terminal phase before it
 *     posts a result, yielding a structured FAILED `FinalizeResult` with
 *     `pushed:false`. Marking the run `failed` (instead of letting it
 *     masquerade as `succeeded`) keeps a run whose commits never reached
 *     origin from reporting success — and pairs with reap PRESERVING the
 *     workspace (skipping `terminate`) so the agent's commits stay
 *     recoverable instead of being silently destroyed. Distinct from
 *     `dropped_commit` (push succeeded but landed zero commits over a
 *     still-dirty tree): here the push itself never completed.
 *   - `push_rejected_policy` (warren-b68d) narrows `finalize_failed` to a push
 *     the REMOTE refused on policy grounds; see `../runtime/push-rejection.ts`.
 *   - `finalize_unposted` (warren-5ea1) means the K8s in-pod finalize
 *     never POSTed a result at all — the pod reached a terminal phase (or
 *     vanished, or the round-trip timed out) while warren was still waiting,
 *     so reap's `FinalizeResult` is the provider's synthesized degradation,
 *     not a pod-computed collection. The canonical trigger: the agent exited
 *     WITHOUT its terminal envelope reaching warren, so no reap intent was
 *     ever parked while the pod was alive to serve it. Distinct from
 *     `finalize_failed` (the pod DID post a result whose branch-push stage
 *     failed): here the workspace died with the pod, so the only recovery path
 *     is the salvage bundle/rescue ref the pod POSTed before exiting.
 *   - `provider_error` (warren-edc3) means the agent's terminal model turn
 *     ended with `stopReason === "error"` and a non-empty provider
 *     `errorMessage` (e.g. Anthropic `400` "Your credit balance is too low to
 *     access the Anthropic API"). Burrow sees the agent process exit 0 and
 *     marks the run `succeeded`, so the in-stream terminal detect (warren-e281
 *     / pl-5516, which keys off the `agent_end` envelope) misses it when the
 *     error signal rides the per-turn `turn_end` envelope instead. Reap's
 *     safety net scans the event log for the terminal error turn and flips an
 *     otherwise-`succeeded` run to `failed`, blocking the bookkeeping-only PR /
 *     seed close / plan-run advance. The message surfaces on the
 *     `reap.provider_error` event; `failure_reason` carries only the
 *     discriminator (the column is enum-narrowed, not free text).
 *   - `oom_killed` (warren-9cce) means the agent container was cgroup
 *     OOM-killed — burrow's `oomKilled()` probe or the K8s
 *     `terminated.reason=="OOMKilled"` signal, carried through the run-state
 *     probe's `terminalReason` onto the finalized row.
 *   - `agent_died` (warren-7f0b) means the in-pod agent-entrypoint's idle
 *     watchdog killed the harness — the `stdin_hold_timeout` system witness —
 *     while the pod (and its finalize poller) may still be live, the zombie
 *     shape the watchdog-reconcile net reaps so the in-pod salvage fires
 *     before the emptyDir disappears. Distinct from `crashed`/`timed_out`.
 *   - `sandbox_failed` (warren-daef) means the sandbox PRIMITIVE itself
 *     broke before the agent ever ran — bwrap could not create the
 *     namespace (user namespaces disabled, missing setuid bit, AppArmor
 *     policy) or sandbox-exec refused the profile, so the run died with
 *     the sandbox's own error on stderr and zero model turns. Reap
 *     infers it from a bwrap/sandbox-exec error line on `stream=stderr`
 *     when no model-turn output exists, so a broken host stops masquerading as
 *     `no_model_response` (which reads as a credential/provider fault and sends
 *     the operator down the wrong debugging path). Distinct from
 *     `no_model_response` (the agent started but produced nothing) and `never_started` (the bridge
 *     never claimed the row).
 *   - `spawn_failed` (warren-4e2a, warren-950d): the agent PROCESS was never exec'd — a missing
 *     docker CLI, or the K8s uid-drop preflight refusal; reap skips the seeds commit + push.
 *   - `evicted` (warren-c0cd) means the kubelet evicted the run pod under node
 *     resource pressure (K8s `status.reason=="Evicted"`) — most often
 *     ephemeral-storage exhaustion (the emptyDir workspace outgrowing its
 *     budget). K8s-only; distinct from `oom_killed` (a container cgroup kill)
 *     and `crashed` (an agent fault) because an eviction is an infra-capacity
 *     signal, surfaced via the run-state probe's `terminalReason`.
 *   - `preempted` (warren-ea4b): the pod's GKE Spot node was reclaimed
 *     (K8s-only, retryable — the substrate lost the run, not the agent).
 *
 * Null on succeeded/cancelled rows.
 */
export const RUN_FAILURE_REASONS = [
	"never_started",
	"no_model_response",
	"sandbox_failed",
	"spawn_failed",
	"crashed",
	"agent_died",
	"timed_out",
	"sandbox_run_lost",
	"sandbox_unreachable",
	"dropped_commit",
	"no_changes",
	"finalize_failed",
	"push_rejected_policy",
	"finalize_unposted",
	"provider_error",
	"oom_killed",
	"evicted",
	"preempted",
] as const;
export type RunFailureReason = (typeof RUN_FAILURE_REASONS)[number];

/**
 * Why an in-pod salvage capture ran (warren-cd3b, warren-985e). Rides
 * `SalvageEnvelope.trigger` on `POST /runs/:id/salvage` and the
 * `reap.workspace_salvaged` payload: `push_failed` (rejected primary push),
 * `no_intent` (severed finalize loop), `empty_push_dirty` (zero-commit push
 * with a dirty tree — the run died mid-work before its first commit, so the
 * uncommitted diff is the only work to save).
 */
export const SALVAGE_TRIGGERS = ["push_failed", "no_intent", "empty_push_dirty"] as const;
export type SalvageTrigger = (typeof SALVAGE_TRIGGERS)[number];

/** Membership predicate for {@link SALVAGE_TRIGGERS}. */
export function isSalvageTrigger(value: unknown): value is SalvageTrigger {
	return typeof value === "string" && (SALVAGE_TRIGGERS as readonly string[]).includes(value);
}

/**
 * Pull-request lifecycle as a forge reports it (warren-0993 /
 * docs/design/forge-contract.md §2). The forge seam reports this closed
 * vocabulary; the DOMAIN decides what a merged PR means — the state machines
 * stay domain-side (§3). `open` (mergeable-or-pending; the merge gate keeps
 * polling), `merged` (`mergedAt` carries the epoch-ms stamp the analytics
 * merge-watcher blocks on), `closed_unmerged` (fatal for a plan-run merge
 * gate — the child flips to `failed`). Canonical here because the UI and
 * the SDK both render these values (AGENTS.md, "The wire vocabulary").
 */
export const PULL_REQUEST_LIFECYCLES = ["open", "merged", "closed_unmerged"] as const;
export type PullRequestLifecycle = (typeof PULL_REQUEST_LIFECYCLES)[number];

/** Membership predicate for {@link PULL_REQUEST_LIFECYCLES}. */
export function isPullRequestLifecycle(value: unknown): value is PullRequestLifecycle {
	return (
		typeof value === "string" && (PULL_REQUEST_LIFECYCLES as readonly string[]).includes(value)
	);
}

/**
 * Forge-seam error taxonomy (warren-0993 / docs/design/forge-contract.md
 * §2). The ONE taxonomy the domain switches on across the forge seam — it
 * replaces the three drifted failure conventions the GitHub surface had
 * (`OpenPullRequestResult`, `CheckPrMergedResult`,
 * `FetchCheckRunsResult`; §6.4). Seam methods return `ForgeResult<T>` and
 * never throw; every arm below has a live call site:
 *
 *   - `no_credential`  — nothing is configured at all: no token env, no
 *     App credentials. Detection site is the provider constructor or the
 *     credential mint, BEFORE any HTTP happens. Distinct from
 *     `unauthorized` (a credential existed and was rejected): here the
 *     domain skips the step rather than reporting an auth failure.
 *   - `unauthorized`   — HTTP 401: an expired or wrong credential.
 *     Detected by the transport error classifier off the response status.
 *     Under App mode this is the hourly-installation-token-expiry signal
 *     and triggers a re-mint; distinct from `forbidden` (403 — the
 *     credential authenticated but lacks the grant).
 *   - `forbidden`      — HTTP 403 that is NOT a rate limit. Detected by
 *     the classifier once the `x-ratelimit-remaining: 0` /
 *     `Retry-After` rate-limit shape has been ruled out. Distinct from
 *     `unauthorized` (the credential itself was refused) and from
 *     `rate_limited` (same status, different semantics and a retryAfter
 *     hint).
 *   - `not_found`      — HTTP 404/410. Detected by the classifier off the
 *     status. Fatal for a merge gate (`merge-gate.ts`): a vanished PR
 *     means `closed_unmerged`-class handling, never a keep-waiting retry.
 *   - `conflict`       — HTTP 409/422 the provider could not resolve.
 *     Detected after the provider's own duplicate-resolution dance
 *     (`openPullRequest` is idempotent by contract — GitHub's
 *     422-then-search stays INSIDE the provider), so this arm means a
 *     genuine unresolvable conflict, e.g. a head-branch state GitHub
 *     refuses.
 *   - `rate_limited`   — HTTP 403/429 WITH rate-limit semantics
 *     (`x-ratelimit-remaining: 0` or a `Retry-After` header). Detected by
 *     the transport classifier; `ForgeError.retryAfterMs` carries the
 *     hint when the forge knows it. Transport retry absorbs it inside the
 *     provider (§3: semantic retry stays in the domain, transport retry
 *     moves to the forge). Distinct from bare `forbidden`.
 *   - `push_protected` — GitHub secret-scanning push protection rejected
 *     the push. Detected at the git-push boundary from the push output;
 *     `detail` carries the unblock URL GitHub returns so an operator can
 *     allow-list the secret. Distinct from `forbidden`, which is an HTTP
 *     API grant failure, not a push-time scan verdict.
 *   - `unsupported`    — this forge/credential mode cannot do the
 *     operation at all (§5 capability degradation: e.g. a fine-grained
 *     PAT calling `listChecks` when `capabilities.checkRuns` is false).
 *     Detected BEFORE transport by reading the provider's declared
 *     `ForgeCapabilities` — no HTTP is ever attempted. Distinct from
 *     `forbidden`, which is discovered at transport time.
 *   - `network`        — no HTTP response at all: DNS failure, refused
 *     connection, TLS error, fetch abort. Detected at the fetch boundary
 *     (a thrown transport error rather than a response). Distinct from
 *     every status-carrying arm — there is no `status` to log.
 *   - `http_error`     — everything else with a response: any status the
 *     classifier did not map onto a narrower arm (5xx, unexpected 4xx
 *     shapes). The catch-all; `status` carries the transport status for
 *     logs.
 */
export const FORGE_ERROR_KINDS = [
	"no_credential",
	"unauthorized",
	"forbidden",
	"not_found",
	"conflict",
	"rate_limited",
	"push_protected",
	"unsupported",
	"network",
	"http_error",
] as const;
export type ForgeErrorKind = (typeof FORGE_ERROR_KINDS)[number];

/** Membership predicate for {@link FORGE_ERROR_KINDS}. */
export function isForgeErrorKind(value: unknown): value is ForgeErrorKind {
	return typeof value === "string" && (FORGE_ERROR_KINDS as readonly string[]).includes(value);
}

export const EVENT_STREAMS = ["stdout", "stderr", "system"] as const;
export type EventStream = (typeof EVENT_STREAMS)[number];

/**
 * Provenance of a stream event, classified at the PARSE boundary (warren-6646).
 * Describes which channel authored the envelope, not what the payload says about
 * itself — an event never gets to declare its own trust level.
 *
 *   - `"warren"` — warren's own event pipeline authored the envelope: the
 *     host-side burrow stream (LocalProvider), the in-pod agent entrypoint's
 *     NDJSON emitter (which classifies each transcript line through the
 *     runtime's structured parser), or a warren-synthesized lifecycle event.
 *     Only this origin carries `stream: "system"` authority, which is what
 *     terminal detection (`src/runs/stream/terminal-detect.ts`) reaps on.
 *   - `"agent"` — an unattributed raw line warren re-parsed off a transport the
 *     agent can also write to (the pod log). Kept in the stream so nothing is
 *     lost, but stripped of system-stream authority so a crafted
 *     `{"kind":"state_change","stream":"system",...}` line cannot terminalize
 *     the run it was printed from.
 *
 * Not persisted: the parse boundary already downgrades an `"agent"` envelope's
 * stream, so every consumer that keys on `state_change` + `system` (usage
 * aggregation, provider-error inference, reap) inherits the guarantee off the
 * stored row.
 */
export const EVENT_ORIGINS = ["warren", "agent"] as const;
export type EventOrigin = (typeof EVENT_ORIGINS)[number];

/**
 * How a run was kicked off (warren-c486). The closed vocabulary every
 * dispatcher stamps onto `runs.trigger` and, via the seed-extension writer
 * (`src/runs/spawn/seed-extensions.ts`), onto the seed for provenance.
 *
 * Canonical here because two surfaces need the same list: that writer and
 * the seeds-CLI extension schema (`src/seeds-cli/warren-extensions.ts`,
 * which derives its zod enum from this tuple). The hand-copied enum it
 * replaced held six of the ten values live dispatchers pass, so `plan-run`,
 * `ci-fixer`, `healer`, `auto_plan_run` and the legacy `manual-trigger` all
 * failed the parse and lost the `trigger` key. Spelling matches what
 * dispatchers already persisted in the column, so the mix stays as-is.
 */
export const RUN_TRIGGER_KINDS = [
	"manual",
	"cron",
	"scheduled",
	"webhook",
	"comment",
	"cli",
	"plan-run",
	"auto_plan_run",
	"ci-fixer",
	"healer",
] as const;
export type RunTriggerKind = (typeof RUN_TRIGGER_KINDS)[number];

/**
 * Legacy raw `runs.trigger` strings mapped onto a canonical kind
 * (warren-c486). `manual-trigger` is what
 * `POST /projects/:id/triggers/:triggerId/run` has always written; Run Now
 * on a cron trigger is a manual dispatch, so it normalizes to `manual` at
 * the read boundary. The column keeps its historical value.
 */
export const LEGACY_RUN_TRIGGER_ALIASES = {
	"manual-trigger": "manual",
} as const satisfies Record<string, RunTriggerKind>;

/** Membership predicate for {@link RUN_TRIGGER_KINDS}. */
export function isRunTriggerKind(value: unknown): value is RunTriggerKind {
	return typeof value === "string" && (RUN_TRIGGER_KINDS as readonly string[]).includes(value);
}

/**
 * Resolve a raw trigger string to a canonical kind via
 * {@link LEGACY_RUN_TRIGGER_ALIASES}. `undefined` means outside the
 * vocabulary — callers must surface that, never drop it silently.
 */
export function normalizeRunTriggerKind(value: string | undefined): RunTriggerKind | undefined {
	if (value === undefined) return undefined;
	if (isRunTriggerKind(value)) return value;
	const aliases: Record<string, RunTriggerKind> = LEGACY_RUN_TRIGGER_ALIASES;
	return aliases[value];
}

/**
 * Registry provenance stamped onto an agent row by the server
 * (warren-f6ad / readAgentSource). Two tiers: built-in agents shipped
 * inline (`"builtin"`) and same-named library overrides (`"library"`).
 * The per-project `.canopy/` tier was removed in warren-f787.
 */
export const AGENT_SOURCES = ["builtin", "library"] as const;
export type AgentSource = (typeof AGENT_SOURCES)[number];

/**
 * The `GET /agents` row shape as every consumer sees it (warren-4253 /
 * pl-b82d). Not enum-shaped like the rest of this file, but it crosses the
 * same wire and drifted the same way: the UI typed the hoisted
 * `description` / `provider` / `model` trio while the SDK's hand-copy
 * lacked all three. Declared once here; `src/client/types.ts` and
 * `src/ui/src/api/types.ts` re-export it.
 *
 * Field notes (server truth: `DecoratedAgent` in
 * `src/server/handlers/agents.ts`):
 *
 *   - `renderedJson` is OPTIONAL: the public projection drops the whole
 *     rendered envelope for a `readPublic`-only spectator (warren-4f6c),
 *     so operator surfaces must test presence.
 *   - `description` / `provider` / `model` are the frontmatter facts
 *     hoisted out of `renderedJson` onto the row (warren-4f6c) so both
 *     audiences get them; null when the frontmatter declares none.
 *   - `source` is decorated by the server (warren-f6ad /
 *     `readAgentSource`).
 *
 * The drizzle `agents` table row is a DIFFERENT shape (physical schema,
 * not wire vocabulary) and lives in `src/db/schema/` as `AgentDbRow`.
 */
export interface AgentRow {
	name: string;
	renderedJson?: unknown;
	registeredAt: string;
	lastRefreshed: string;
	description: string | null;
	provider: string | null;
	model: string | null;
	source?: AgentSource;
}

/**
 * Preview environment lifecycle (R-19 / docs/design/preview-environments.md).
 *
 *   - `starting`    — `preview_launch` sub-step has spawned the sidecar
 *                     command in burrow; readiness probe hasn't returned
 *                     2xx yet.
 *   - `live`        — readiness probe succeeded; the host reverse proxy
 *                     can route requests to `preview_port`.
 *   - `failed`      — sidecar exited or readiness probe timed out;
 *                     `preview_failure_message` holds the stderr tail.
 *   - `torn-down`   — eviction worker or manual teardown stopped the
 *                     sidecar and released the port. Workspace stays.
 *
 * TS-only narrowing — no SQL CHECK constraint (mx-2ab984). Null on rows
 * for projects that haven't opted into previews.
 */
export const PREVIEW_STATES = ["starting", "live", "failed", "torn-down"] as const;
export type PreviewState = (typeof PREVIEW_STATES)[number];

/** Preview states whose sidecar is still holding a port (UI polls these). */
export const PREVIEW_ACTIVE_STATES = [
	"starting",
	"live",
] as const satisfies readonly PreviewState[];
export type PreviewActiveState = (typeof PREVIEW_ACTIVE_STATES)[number];

/** True while a preview environment still owns a sidecar + port. */
export function isActivePreviewState(state: PreviewState): state is PreviewActiveState {
	return (PREVIEW_ACTIVE_STATES as readonly PreviewState[]).includes(state);
}

/**
 * Plan-run lifecycle (pl-a258 step 2 / warren-4d7c). One row per dispatched
 * `sd plan` walk; the coordinator (warren-2623) advances the row through
 * these states as it executes each child seed sequentially:
 *   - `queued`     — inserted by POST /plan-runs; first tick flips to
 *                    `running` and dispatches the lowest-seq child.
 *   - `running`    — a child has been dispatched; stays until every child
 *                    is `merged`/`skipped` OR one terminal-fails.
 *   - `succeeded`  — every child reached `merged` or `skipped`.
 *   - `failed`     — a child terminal-failed or its PR closed unmerged
 *                    (`failure_reason` carries the discriminator).
 *   - `cancelled`  — operator hit POST /plan-runs/:id/cancel. No SQL CHECK (mx-2ab984).
 */
export const PLAN_RUN_STATES = ["queued", "running", "succeeded", "failed", "cancelled"] as const;
export type PlanRunState = (typeof PLAN_RUN_STATES)[number];

export const PLAN_RUN_TERMINAL_STATES = [
	"succeeded",
	"failed",
	"cancelled",
] as const satisfies readonly PlanRunState[];
export type PlanRunTerminalState = (typeof PLAN_RUN_TERMINAL_STATES)[number];

/** Plan-run states the coordinator still ticks (UI polls these). */
export const PLAN_RUN_ACTIVE_STATES = [
	"queued",
	"running",
] as const satisfies readonly PlanRunState[];
export type PlanRunActiveState = (typeof PLAN_RUN_ACTIVE_STATES)[number];

/** True once a plan-run walk can no longer advance. */
export function isTerminalPlanRunState(state: PlanRunState): state is PlanRunTerminalState {
	return (PLAN_RUN_TERMINAL_STATES as readonly PlanRunState[]).includes(state);
}

// warren-de42: `plan` = tracker plan id via getPlan; `issues` = explicit ordered issue-id list.
export const PLAN_RUN_SOURCES = ["plan", "issues"] as const;
export type PlanRunSource = (typeof PLAN_RUN_SOURCES)[number];

/**
 * Values `GET /plan-runs?state=` accepts (warren-302a). `active` is the union
 * of `PLAN_RUN_ACTIVE_STATES` rather than a state a row can hold, so asking
 * for the live view is explicit. Omitting the parameter means every state.
 */
export const PLAN_RUN_STATE_FILTERS = ["active", ...PLAN_RUN_STATES] as const;
export type PlanRunStateFilter = (typeof PLAN_RUN_STATE_FILTERS)[number];

/**
 * Per-child lifecycle within a plan-run (pl-a258 step 2 / warren-4d7c).
 *
 *   - `pending`    — child seed not yet dispatched; waiting for its turn.
 *   - `dispatched` — coordinator called spawnRun and stamped `run_id`; the
 *                    warren run row may still be `queued` at this instant.
 *   - `running`    — the linked run reached `running`.
 *   - `pr_open`    — the linked run succeeded and reap opened a PR (or
 *                    landed a zero-commit "trivially merged" push).
 *   - `merged`     — PR merged (poll-confirmed via GitHub) OR the
 *                    trivial-merge path advanced directly.
 *   - `failed`     — the linked run terminal-failed, the PR closed
 *                    unmerged, or the dispatch itself errored.
 *   - `skipped`    — resume semantics (warren-fcc9): the child's seed was
 *                    already `closed` at dispatch time, so the coordinator
 *                    advanced without spawning a run.
 *
 * TS-only narrowing — no SQL CHECK constraint (mx-2ab984).
 */
export const PLAN_RUN_CHILD_STATES = [
	"pending",
	"dispatched",
	"running",
	"pr_open",
	"merged",
	"failed",
	"skipped",
] as const;
export type PlanRunChildState = (typeof PLAN_RUN_CHILD_STATES)[number];

export const PLAN_RUN_CHILD_TERMINAL_STATES = [
	"merged",
	"failed",
	"skipped",
] as const satisfies readonly PlanRunChildState[];
export type PlanRunChildTerminalState = (typeof PLAN_RUN_CHILD_TERMINAL_STATES)[number];

/** True once a plan-run child can no longer advance. */
export function isTerminalPlanRunChildState(
	state: PlanRunChildState,
): state is PlanRunChildTerminalState {
	return (PLAN_RUN_CHILD_TERMINAL_STATES as readonly PlanRunChildState[]).includes(state);
}

/* ----------------------------------------------------------------------- */
/* HTTP response envelopes (warren-42f1 / pl-882c step 3).                  */
/* ----------------------------------------------------------------------- */

/**
 * Error envelope rendered for every non-2xx response. Mirrors burrow's
 * `ErrorEnvelope` so an HTTP consumer hitting both surfaces uses one
 * decoder. `code` is the stable machine identifier; `message` is human;
 * `hint` is the optional recovery cue from `WarrenError.recoveryHint`.
 *
 * Defined ONCE here — the server (`src/server/types.ts`), the SDK
 * (`src/client/types.ts`) and the UI (`src/ui/src/api/types.ts`) re-export
 * it. warren-5334 tracked the three hand-mirrored copies this replaces.
 * Type-only, so the dependency-free-kernel rule is unaffected.
 */
export interface ErrorEnvelope {
	error: {
		code: string;
		message: string;
		hint?: string;
	};
}
