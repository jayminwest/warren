/**
 * Shared types and constants for the run-stream bridge (warren-041e split).
 *
 * Kept type-only so it can be imported from any sibling module without
 * pulling runtime code. `SessionStats` also lives here (not in the
 * stats persistence module) because `usage-aggregate.ts` re-exports it
 * for shared accumulators — putting it in `bridge.ts` would create a
 * runtime cycle.
 */

import type { RunEvent } from "@os-eco/burrow-cli";
import type { BurrowClientPool } from "../../burrow-client/pool.ts";
import type { Repos } from "../../db/repos/index.ts";
import type { RunMode, RunTerminalState } from "../../db/schema.ts";
import type { RunEventBroker } from "../events.ts";
import type { ConversationTurnHandler } from "./conversation-turn.ts";

/**
 * Optional logger interface — pino-compatible subset, but typed loosely
 * so callers can pass any structured logger. We never construct one here.
 */
export interface BridgeLogger {
	info?(obj: object, msg?: string): void;
	warn?(obj: object, msg?: string): void;
	error?(obj: object, msg?: string): void;
}

/**
 * Session-cumulative cost + token snapshot (warren-a7dc, SPEC §pi). Pi
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
	fetch(burrowRunId: string, signal: AbortSignal): Promise<SessionStats | null>;
}

/**
 * Run-state probe shape (warren-6596). The bridge calls this on a low
 * cadence in parallel with the event stream so raw-text / declarative
 * agents (no in-stream terminal envelope) still reach terminal in warren.
 * Returns the current burrow run state, or `null` if the row was lost
 * (handled by the BurrowNotFoundError path).
 *
 * Production default: `client.http.runs.get(burrowRunId)` projected to
 * `{state, exitCode}`. Tests override with a synthetic probe.
 */
export type RunStateProbe = (
	burrowRunId: string,
	signal: AbortSignal,
) => Promise<{
	state: "queued" | "running" | "succeeded" | "failed" | "cancelled";
	exitCode: number | null;
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
	/** Burrow's run id (column `runs.burrow_run_id`). */
	readonly burrowRunId: string;
	/**
	 * Burrow's burrow id (column `runs.burrow_id`). The bridge uses this to
	 * resolve the owning worker via `burrowClientPool.clientFor({burrowId})`
	 * so the stream poll lands on the same worker that hosts the burrow.
	 */
	readonly burrowId: string;
	readonly repos: Repos;
	readonly broker: RunEventBroker;
	/**
	 * Multi-worker burrow pool (warren-c0c9 / pl-9ba1 step 5). bridge resolves
	 * the owning worker via `pool.clientFor({burrowId})` for the
	 * `http.runs.stream` poll. Propagates `StickyWorkerUnreachableError`
	 * (503 via src/server/errors.ts) when the pinned worker is `unreachable`.
	 */
	readonly burrowClientPool: BurrowClientPool;
	readonly signal?: AbortSignal;
	/**
	 * Run mode (warren-df71). When `'conversation'`, the bridge treats a pi
	 * `agent_end` as a TURN boundary rather than a run terminal: it persists
	 * the turn's usage + assistant text and applies any `propose_intent`
	 * patch, then KEEPS the run `running` (no break, no inline reap). Omitted
	 * / any other value behaves exactly as before — non-conversation run
	 * lifecycles are unchanged.
	 */
	readonly mode?: RunMode;
	/**
	 * Conversation-turn side-effect seam (warren-df71). Consulted only when
	 * `mode === 'conversation'` to persist assistant turns and apply
	 * `propose_intent` patches. Omit for non-conversation runs.
	 */
	readonly conversationTurn?: ConversationTurnHandler;
	/** Override the stream source (tests). Default: `client.http.runs.stream`. */
	readonly source?: (signal: AbortSignal) => AsyncIterable<RunEvent>;
	readonly logger?: BridgeLogger;
	/**
	 * Pi cost-stats consumer (warren-a7dc). Set when the bridged run uses
	 * the pi runtime; the bridge then snapshots `get_session_stats` at
	 * run-start + run-end and persists the delta via `RunsRepo.attachStats`.
	 * Omit for non-pi runs — the stats columns stay null, identical to the
	 * pre-warren-a7dc behaviour for claude-code/sapling runs.
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
	readonly terminalDetected?: { readonly outcome: RunTerminalState };
	/**
	 * Set when burrow returned 404 / NotFoundError for the run's
	 * `burrow_run_id` while polling the stream (warren-b1a9). Indicates a
	 * "ghost run" — typically a warren-machine restart wiped burrow's
	 * in-memory run state for an in-flight run. The registry treats this
	 * as terminal: it stops the reconnect loop and reconciles the warren
	 * row to `failed` with `failure_reason='burrow_run_lost'` rather than
	 * spinning forever on backoff. Mutually exclusive with
	 * `terminalDetected`.
	 */
	readonly burrowRunMissing?: true;
}

export interface BurrowTerminalSnapshot {
	readonly state: RunTerminalState;
	readonly exitCode: number | null;
}
