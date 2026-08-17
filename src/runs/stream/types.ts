/**
 * Shared types and constants for the run-stream bridge (warren-041e split).
 *
 * Kept type-only so it can be imported from any sibling module without
 * pulling runtime code. `SessionStats` also lives here (not in the
 * stats persistence module) because `usage-aggregate.ts` re-exports it
 * for shared accumulators — putting it in `bridge.ts` would create a
 * runtime cycle.
 */

import type { Repos } from "../../db/repos/index.ts";
import type { RunFailureReason, RunMode, RunTerminalState } from "../../db/schema.ts";
import type { RuntimeProvider, TerminalReason } from "../../runtime/contract.ts";
import type { RunEventBroker } from "../events.ts";

/**
 * Structural view of a stream event — the fields the bridge and its pure
 * classifiers (`terminal-detect.ts`) read off each
 * event. Deliberately provider-neutral (warren-1f56): satisfied by BOTH the
 * seam's `NormalizedEvent` (the production source, off `provider.streamEvents`)
 * and burrow's `RunEvent` (the test `source` override still feeds those), so the
 * bridge consumes one type without importing `@os-eco/burrow-cli`. `ts` is
 * `Date | string` because burrow's `RunEvent` carries a `Date` while
 * `NormalizedEvent` already carries an ISO string; `toIsoString` normalizes both.
 */
export interface StreamEventView {
	readonly seq: number;
	readonly ts: Date | string;
	readonly kind: string;
	readonly stream: string | null;
	/**
	 * Parse-boundary provenance (warren-6646). `"agent"` marks an unattributed
	 * line warren re-parsed off a transport the agent can write to; those never
	 * carry terminal authority. Optional because burrow's `RunEvent` (still fed by
	 * test `source` overrides) predates the tag — absent reads as warren-authored.
	 */
	readonly origin?: string;
	readonly payload: unknown;
}

/**
 * Optional logger interface — pino-compatible subset, but typed loosely
 * so callers can pass any structured logger. We never construct one here.
 */
export interface BridgeLogger {
	info?(obj: object, msg?: string): void;
	warn?(obj: object, msg?: string): void;
	error?(obj: object, msg?: string): void;
	/**
	 * pino's `.child(bindings)` — present on real loggers, optional here so
	 * tests can pass a partial logger. `bindBridgeLogger` (./logger.ts) uses
	 * it to bind `run_id` / `sandbox_run_id` / `worker` once per run.
	 */
	child?(bindings: object): BridgeLogger;
}

/**
 * Session-cumulative cost + token snapshot (warren-a7dc, docs/design/agent-composition.md). Pi
 * v0.74 reports cost in USD computed against the same models.json it
 * dispatched against; warren persists the raw number rather than
 * re-pricing tokens itself (plan alternative #5).
 *
 * Pi emits this shape inline on every `turn_end` envelope (and the
 * matching assistant `message_end`) — see burrow's
 * `src/runtime/parsers/__golden__/pi-v0.74.0-anthropic-*.jsonl`. The
 * bridge's preferred path is to extract these from the event stream it
 * already consumes (warren-17a4); the PiStatsClient out-of-band RPC
 * surface below remains as an override for runtimes that surface stats
 * only via an external fetch.
 */
export interface SessionStats {
	readonly costUsd: number;
	readonly tokensInput: number;
	readonly tokensOutput: number;
	readonly tokensCacheRead: number;
	readonly tokensCacheWrite: number;
}

/**
 * Transport-agnostic hook for an out-of-band stats fetch. The bridge
 * calls `fetch` at run-start (baseline) and run-end (terminal), then
 * persists the delta via `RunsRepo.attachStats`. Returning `null` signals
 * "stats unavailable" (e.g. RPC channel closed, agent isn't pi) and is
 * treated as best-effort — the column stays null, the bridge keeps going.
 * Throws are caught + logged; same outcome.
 *
 * Most pi runs do NOT need this — the bridge extracts cost from pi's
 * inline `turn_end` envelopes (warren-17a4) without any extra wiring.
 * `PiStatsClient` is the override for sources warren can't observe
 * in-stream (custom dispatchers, harnessed test fixtures, future
 * runtimes). When both paths produce data, the explicit client wins.
 */
export interface PiStatsClient {
	fetch(sandboxRunId: string, signal: AbortSignal): Promise<SessionStats | null>;
}

/**
 * Run-state probe shape (warren-6596). The bridge calls this on a low
 * cadence in parallel with the event stream so raw-text / declarative
 * agents (no in-stream terminal envelope) still reach terminal in warren.
 * Returns the current burrow run state, or `null` if the row was lost
 * (handled by the BurrowNotFoundError path).
 *
 * Production default: `client.http.runs.get(sandboxRunId)` projected to
 * `{state, exitCode}`. Tests override with a synthetic probe.
 */
export type RunStateProbe = (
	sandboxRunId: string,
	signal: AbortSignal,
) => Promise<{
	state: "queued" | "running" | "succeeded" | "failed" | "cancelled";
	exitCode: number | null;
	/**
	 * Coarse terminal classification the seam surfaces (warren-1f56 / warren-9cce).
	 * The production probe fills it from `provider.status().terminalReason`; its
	 * only load-bearing value today is `"oom_killed"` — burrow stamps an OOM kill
	 * onto the run row's `errorMessage`, which `status()` recovers and the poller
	 * carries through to `failure_reason` (a signal warren previously dropped).
	 * Absent on non-terminal / test probes; other reasons are covered by `state`.
	 */
	terminalReason?: TerminalReason;
} | null>;

/** Burrow run-state poll cadence (ms) — light load: 1 RPC/run/2s. */
export const DEFAULT_RUN_STATE_POLL_MS = 2_000;
/**
 * After observing terminal, wait this long before aborting the stream so
 * tailBurrow's next 200ms poll picks up the final events. Tunable for tests.
 */
export const DEFAULT_RUN_STATE_DRAIN_MS = 1_000;

export interface BridgeRunStreamInput {
	readonly runId: string;
	/** Burrow's run id (column `runs.sandbox_run_id`). */
	readonly sandboxRunId: string;
	/**
	 * The run's sandbox id (column `runs.sandbox_id`). Carried opaquely into the
	 * `RunHandle` the bridge hands the provider so `streamEvents` / `status` /
	 * `cancel` land on the backend that hosts this run.
	 */
	readonly sandboxId: string;
	readonly repos: Repos;
	readonly broker: RunEventBroker;
	/**
	 * Runtime-provider seam (K8s migration pl-829f step 13 / warren-1f56,
	 * warren-1fce). The bridge's backend touchpoints route through it: the event
	 * stream is `provider.streamEvents(handle, { sinceSeq })` (resume cursor), the
	 * run-state poller reads `provider.status(handle)`, and the budget-cap graceful
	 * stop is `provider.cancel(handle)`. Event persistence + warren seq
	 * bookkeeping, poller cadence, and terminal-reconciliation decisions stay
	 * DOMAIN (they run over the seam's output). Ignored when a test `source`
	 * overrides the stream.
	 */
	readonly runtimeProvider: RuntimeProvider;
	readonly signal?: AbortSignal;
	/** Run mode. */
	readonly mode?: RunMode;
	/**
	 * Override the stream source (tests). Default: the run's
	 * `provider.streamEvents(handle)` adapted to the abort signal. Typed against
	 * the provider-neutral `StreamEventView` so both the seam's `NormalizedEvent`
	 * (production) and burrow's `RunEvent` (existing test fixtures) satisfy it.
	 */
	readonly source?: (signal: AbortSignal) => AsyncIterable<StreamEventView>;
	readonly logger?: BridgeLogger;
	/**
	 * Pi cost-stats consumer (warren-a7dc). Set when the bridged run uses
	 * the pi runtime; the bridge then snapshots `get_session_stats` at
	 * run-start + run-end and persists the delta via `RunsRepo.attachStats`.
	 * Omit for non-pi runs — the stats columns stay null, identical to the
	 * pre-warren-a7dc behaviour for claude-code runs.
	 */
	readonly piStats?: PiStatsClient;
	/**
	 * Run-state probe override (warren-6596). When unset, the bridge
	 * defaults to `client.http.runs.get` via the resolved sourceClient. Tests
	 * that pass `source` (no real client) can pass an explicit probe to
	 * exercise the run-state fallback; tests that don't pass either leave
	 * the poller dormant.
	 */
	readonly runStateProbe?: RunStateProbe;
	/** Override the run-state poll cadence (ms). Default 2000. */
	readonly runStatePollMs?: number;
	/** Override the post-terminal drain window (ms). Default 1000. */
	readonly runStateDrainMs?: number;
	/**
	 * Override the bounded provider-stream teardown ceiling (ms) applied after the
	 * poller aborts (warren-c433). Default `DEFAULT_STREAM_TEARDOWN_MS`. Only takes
	 * effect on the default provider-stream wiring (a test `source` override owns
	 * its own teardown); tests pin it small to prove a hung K8s log pump can't wedge
	 * the bridge's path to terminal/reap.
	 */
	readonly streamTeardownMs?: number;
	/**
	 * Effective per-run spend cap in USD (warren-a63d). When set, the
	 * bridge cancels the run once cumulative cost crosses it. Normally
	 * resolved by the bridge itself from `runs.rendered_agent_json`
	 * (`resolveCostCapUsd`); tests inject it directly to exercise
	 * enforcement without seeding a run row.
	 */
	readonly costCapUsd?: number;
	/**
	 * Override the graceful-cancel seam used when the spend cap trips
	 * (warren-a63d, tests). Production defaults to a closure over the
	 * resolved burrow client's `runs.cancel`; tests pass a stub to assert
	 * the cancel fired without a live burrow.
	 */
	readonly cancelBurrowRun?: (reason: string) => Promise<void>;
}

export interface BridgeRunStreamResult {
	/** Number of events written to the events table during the bridge run. */
	readonly written: number;
	/** Number of events skipped because their seq was at-or-below MAX(seq). */
	readonly skipped: number;
	/** True when the bridge ended because of an error (logged but not thrown). */
	readonly errored: boolean;
	/**
	 * Set when the bridge broke out of the poll loop because it observed a
	 * runtime-terminal event (warren-a69a). The registry layer uses this
	 * as the signal to call `reapRun` with the inferred outcome. Absent
	 * for bridges that ended via abort, error, or natural source close.
	 */
	readonly terminalDetected?: {
		readonly outcome: RunTerminalState;
		/**
		 * Explicit `failure_reason` the domain should finalize with, overriding
		 * reap's `inferFailureReason` (warren-9cce). Set only for the plan-mandated
		 * OOM surfacing: when the run-state poller reconciles a burrow-terminal run
		 * whose `provider.status().terminalReason === "oom_killed"`, it carries
		 * `"oom_killed"` here so the registry's inline reap records it instead of
		 * collapsing an OOM kill into an anonymous `crashed`/`no_model_response`.
		 * Absent otherwise (the in-stream terminal path carries no coarse reason).
		 */
		readonly failureReason?: RunFailureReason;
	};
	/**
	 * Set when burrow returned 404 / NotFoundError for the run's
	 * `sandbox_run_id` while polling the stream (warren-b1a9). Indicates a
	 * "ghost run" — typically a warren-machine restart wiped burrow's
	 * in-memory run state for an in-flight run. The registry treats this
	 * as terminal: it stops the reconnect loop and reconciles the warren
	 * row to `failed` with `failure_reason='sandbox_run_lost'` rather than
	 * spinning forever on backoff. Mutually exclusive with
	 * `terminalDetected`.
	 */
	readonly sandboxRunMissing?: true;
}

export interface BurrowTerminalSnapshot {
	readonly state: RunTerminalState;
	readonly exitCode: number | null;
	/**
	 * Domain `failure_reason` distilled from the probe's coarse `terminalReason`
	 * (warren-9cce). Populated only for `"oom_killed"` today; the bridge forwards
	 * it onto the synthesized `terminalDetected.failureReason`. Absent otherwise.
	 */
	readonly failureReason?: RunFailureReason;
}

/**
 * The bridge registry. Per-run bridges are created when `POST /runs`
 * lands and on warren startup via `recoverActiveRunStreams`; the
 * registry tracks them so server shutdown can abort everyone in one
 * pass. Concrete impl lives in `src/server/bridges.ts`.
 *
 * The interface lives here, with the bridge it registers, rather than in
 * `src/server/types.ts` (warren-89a6). The plan-run dispatcher needs the
 * type and is domain code, so declaring it on the HTTP surface made a
 * domain module import the server. `src/server/types.ts` re-exports it,
 * so the ~20 server-side consumers are unchanged.
 */
export interface BridgeRegistry {
	/**
	 * Start a bridge for the given run; idempotent against a running bridge.
	 * `sandboxId` is required so the bridge can resolve the owning worker via
	 * `BurrowClient.clientFor` (warren-c0c9). `mode` (warren-df71) makes a
	 * `'conversation'` run keep-alive across pi `agent_end` turn boundaries;
	 * omit / `'batch'` retains the prior one-shot terminal behaviour.
	 */
	start(runId: string, sandboxRunId: string, sandboxId: string, mode?: RunMode): void;
	/** Abort all in-flight bridges and await their drain. */
	stopAll(): Promise<void>;
	/** Test/diagnostic surface — number of currently-attached bridges. */
	size(): number;
}
