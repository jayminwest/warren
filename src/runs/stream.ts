/**
 * Bridge burrow's per-run event stream into warren's events table and
 * fan-out broker (SPEC §4.3 step 5, §9 "event durability rationale").
 *
 * The bridge is the only writer to `events` (rows always land via
 * `bridgeRunStream` → `EventsRepo.append`); the broker is published
 * to immediately after each row commits so live tailers see fresh
 * events without waiting on a polling interval.
 *
 * Resume semantics. Burrow's `runs.stream` always tails from the start
 * of the burrow's event history (the route doesn't accept `?since=`
 * for the run-scoped variant), so warren dedupes on the consumer side:
 * `EventsRepo.maxSeqForRun(runId)` gives the last seq we persisted, and
 * any incoming event whose `seq <= maxSeq` is dropped. This is the
 * "MAX(events.burrow_event_seq) + 1" recovery point in SPEC §4.3 — we
 * implement it client-side because the wire route doesn't.
 *
 * The bridge swallows transport-layer errors (BurrowUnreachableError
 * et al.) and just returns; it logs the failure if a logger was
 * supplied. The supervising layer (Phase 9 HTTP server, Phase 12
 * supervisor) is responsible for restart policy.
 *
 * State mirroring is intentionally limited to the queued → running
 * edge: as soon as the bridge sees its first event from burrow, it
 * atomically claims the warren row via `RunsRepo.claimById` so HTTP
 * clients polling `/runs/:id` stop seeing 'queued' while the agent is
 * actively working. Terminal transitions still belong to Phase 7
 * (reap); the bridge never finalizes a run.
 *
 * Terminal detection (warren-a69a). Burrow's run-stream is an infinite
 * poll on the events table — it never auto-closes when the burrow run
 * reaches a terminal state. Without an in-stream signal, the bridge
 * would keep polling forever and warren's run would stay 'running' even
 * after the agent exited. So the bridge inspects each persisted event
 * for a runtime-terminal shape (claude-code: `kind=state_change`,
 * `stream=system`, `payload.type=result`); on a match, it sets
 * `terminalDetected` on the result and breaks. The registry layer
 * (server/bridges.ts) reads `terminalDetected` and calls `reapRun` —
 * the bridge does not transition warren state itself (mx-fadaa2).
 *
 * Run-state fallback (warren-6596). In-stream terminal detection only
 * fires for runtimes that emit a recognised terminal envelope
 * (claude-code, pi). Declarative agents with `outputFormat=raw-text`
 * (the acceptance stub-shell, many user-authored shell agents) emit
 * only `text` events, so the bridge has no in-stream signal to break on.
 * To cover that gap, the bridge runs a parallel low-frequency poller
 * that calls burrow's `runs.get(burrowRunId)`. When burrow reports a
 * terminal state, the poller waits a short drain window (so the next
 * tail poll picks up final events), then aborts the stream. The bridge
 * synthesises a `terminalDetected` from the burrow state so reap runs
 * exactly as it would have via in-stream detection. Disabled in tests
 * that override `source` without supplying `runStateProbe`.
 *
 * Restart recovery. `recoverActiveRunStreams` walks the runs table for
 * rows in {queued, running} that already have a `burrow_run_id`, and
 * starts a bridge for each. It returns the in-flight bridges so the
 * caller can stop them on shutdown.
 */

import { NotFoundError as BurrowNotFoundError, type RunEvent } from "@os-eco/burrow-cli";
import type { BurrowClient } from "../burrow-client/client.ts";
import { withTransportMapping } from "../burrow-client/client.ts";
import type { BurrowClientPool } from "../burrow-client/pool.ts";
import type { Repos } from "../db/repos/index.ts";
import type { EventStream, RunTerminalState } from "../db/schema.ts";
import { EVENT_STREAMS } from "../db/schema.ts";
import type { RunEventBroker } from "./events.ts";
import {
	accumulatePiUsage,
	extractClaudeUsage,
	newSessionStatsAccumulator,
	type SessionStatsAccumulator,
} from "./usage-aggregate.ts";

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

/**
 * Pump events from burrow's `/runs/:id/stream` into the warren events
 * table and fan-out broker. Returns when the source iterator ends, the
 * signal aborts, or the source throws — whichever comes first.
 *
 * The function is async-iteration shaped (one pass, no resume after
 * return) — call it again from the supervisor if the bridge needs to
 * resume against a still-live burrow run.
 */
export async function bridgeRunStream(input: BridgeRunStreamInput): Promise<BridgeRunStreamResult> {
	const { runId, burrowRunId, repos, broker } = input;
	const ctrl = new AbortController();
	const onAbort = (): void => ctrl.abort();
	if (input.signal !== undefined) {
		if (input.signal.aborted) ctrl.abort();
		else input.signal.addEventListener("abort", onAbort, { once: true });
	}

	const resumeSeq = (await repos.events.maxSeqForRun(runId)) ?? 0;
	// warren-c0c9: route the stream poll through the worker that owns this
	// burrow. The source override (tests) bypasses the pool entirely.
	const sourceClient =
		input.source !== undefined
			? null
			: (await input.burrowClientPool.clientFor({ burrowId: input.burrowId })).client;
	const source = input.source ?? defaultSource(sourceClient as BurrowClient, burrowRunId);

	// warren-6596: run-state poller. Covers runtimes that don't emit a
	// recognised in-stream terminal envelope (raw-text declarative agents).
	// Skipped when neither a probe override nor a real burrow client exists
	// (tests that pass `source` but no `runStateProbe`).
	const runStateProbe: RunStateProbe | null =
		input.runStateProbe ??
		(sourceClient !== null ? defaultRunStateProbe(sourceClient as BurrowClient) : null);
	const probedTerminal: { value: BurrowTerminalSnapshot | null } = { value: null };
	const pollerTask =
		runStateProbe !== null
			? runStatePoller({
					probe: runStateProbe,
					burrowRunId,
					ctrl,
					pollIntervalMs: input.runStatePollMs ?? DEFAULT_RUN_STATE_POLL_MS,
					drainMs: input.runStateDrainMs ?? DEFAULT_RUN_STATE_DRAIN_MS,
					observed: probedTerminal,
					runId,
					...(input.logger !== undefined ? { logger: input.logger } : {}),
				})
			: null;

	let written = 0;
	let skipped = 0;
	let errored = false;
	let claimed = false;
	let terminalDetected: { outcome: RunTerminalState } | undefined;
	let burrowRunMissing = false;
	// pi cost tracking (warren-a7dc, warren-17a4). Two paths:
	//   1. In-stream extraction (default): accumulate `turn_end` usage as
	//      events flow through the bridge. Persisted on terminal.
	//   2. Out-of-band PiStatsClient (override): fetched at baseline +
	//      terminal, delta persisted. Used when the wire format doesn't
	//      carry usage (declarative stubs, custom dispatchers).
	// Both paths are best-effort; failures leave the columns null.
	let statsBaseline: Promise<SessionStats | null> | undefined;
	let statsPersisted = false;
	const piUsage: SessionStatsAccumulator = newSessionStatsAccumulator();
	// claude-code cost tracking (warren-87f9). Single-shot: claude-code
	// emits one `result` envelope at run end carrying `total_cost_usd` +
	// `usage.{input,output,cache_read_input,cache_creation_input}_tokens`.
	// Shape-sniffed in `extractClaudeUsage`; persisted on terminal only
	// when no pi usage was observed (pi path wins for parity).
	const claudeUsage: SessionStatsAccumulator = newSessionStatsAccumulator();

	try {
		for await (const event of source(ctrl.signal)) {
			if (ctrl.signal.aborted) break;
			if (!claimed) {
				const claimedRun = await repos.runs.claimById(runId);
				if (claimedRun !== null) {
					input.logger?.info?.({ runId, burrowRunId }, "bridge transitioned run queued → running");
				}
				claimed = true;
				if (input.piStats !== undefined) {
					statsBaseline = snapshotStats(
						input.piStats,
						burrowRunId,
						ctrl.signal,
						"baseline",
						runId,
						input.logger,
					);
				}
			}
			if (event.seq <= resumeSeq) {
				skipped += 1;
				continue;
			}
			const row = await repos.events.append({
				runId,
				burrowEventSeq: event.seq,
				ts: toIsoString(event.ts),
				kind: event.kind,
				stream: normalizeStream(event.stream),
				payload: event.payload,
			});
			written += 1;
			broker.publish(runId, row);

			accumulatePiUsage(piUsage, event);
			extractClaudeUsage(claudeUsage, event);

			if (!statsPersisted && isPiAgentEnd(event)) {
				statsPersisted = true;
				if (input.piStats !== undefined) {
					await persistPiStatsDelta({
						piStats: input.piStats,
						burrowRunId,
						runId,
						repos,
						baseline: statsBaseline,
						signal: ctrl.signal,
						logger: input.logger,
					});
				} else {
					await persistInStreamUsage({
						usage: piUsage,
						runtime: "pi",
						runId,
						burrowRunId,
						repos,
						logger: input.logger,
					});
				}
			}

			const outcome = detectRuntimeTerminal(event);
			if (outcome !== null) {
				terminalDetected = { outcome };
				input.logger?.info?.(
					{ runId, burrowRunId, outcome, seq: event.seq },
					"bridge observed runtime-terminal event; reap will finalize",
				);
				if (!statsPersisted) {
					statsPersisted = true;
					if (input.piStats !== undefined) {
						await persistPiStatsDelta({
							piStats: input.piStats,
							burrowRunId,
							runId,
							repos,
							baseline: statsBaseline,
							signal: ctrl.signal,
							logger: input.logger,
						});
					} else if (piUsage.seen) {
						// Prefer pi if observed (mixed-shape stream); claude-code
						// usage is the fallback when no pi `turn_end` ever fired.
						persistInStreamUsage({
							usage: piUsage,
							runtime: "pi",
							runId,
							burrowRunId,
							repos,
							logger: input.logger,
						});
					} else {
						persistInStreamUsage({
							usage: claudeUsage,
							runtime: "claude",
							runId,
							burrowRunId,
							repos,
							logger: input.logger,
						});
					}
				}
				break;
			}
		}
	} catch (err) {
		if (err instanceof BurrowNotFoundError) {
			// warren-b1a9: burrow no longer has this run (machine restart wiped
			// its in-memory store, deliberate cleanup, etc.). Surface as a
			// distinct terminal signal so the registry stops reconnecting and
			// reconciles the warren row to `failed` instead of spinning on
			// backoff. Don't set `errored` — errored=true triggers the reconnect
			// loop; the missing-run signal is exactly the case where reconnect
			// is hopeless.
			burrowRunMissing = true;
			input.logger?.warn?.(
				{ runId, burrowRunId, written, skipped, err: err.message },
				"run stream bridge: burrow returned 404 for burrow_run_id (ghost run)",
			);
		} else if (probedTerminal.value !== null) {
			// warren-6596: the run-state poller observed burrow terminal and
			// aborted the source. An AbortError surfacing here is intentional —
			// don't flag `errored` (which would trip the registry's reconnect
			// loop). The synthesized `terminalDetected` is set below.
			input.logger?.info?.(
				{
					runId,
					burrowRunId,
					burrowState: probedTerminal.value.state,
					err: err instanceof Error ? err.message : String(err),
				},
				"run stream bridge: stream aborted by run-state poller after terminal observation",
			);
		} else {
			errored = true;
			input.logger?.error?.(
				{
					runId,
					burrowRunId,
					written,
					skipped,
					err: err instanceof Error ? err.message : String(err),
				},
				"run stream bridge errored",
			);
		}
	} finally {
		if (input.signal !== undefined) input.signal.removeEventListener("abort", onAbort);
		ctrl.abort();
		if (pollerTask !== null) await pollerTask;
		broker.close(runId);
	}

	// warren-6596: if the in-stream terminal-detect path didn't fire but the
	// run-state poller saw burrow terminal, synthesise `terminalDetected` so
	// the registry's inline reap still runs. Outcome maps 1:1 from burrow
	// state (succeeded/failed/cancelled). Skipped when terminal was already
	// detected in-stream — the in-stream path is authoritative because it
	// carries exit_code semantics from the runtime parser.
	if (terminalDetected === undefined && !burrowRunMissing && probedTerminal.value !== null) {
		terminalDetected = { outcome: probedTerminal.value.state };
		input.logger?.info?.(
			{ runId, burrowRunId, outcome: probedTerminal.value.state },
			"bridge synthesized terminalDetected from burrow run-state probe",
		);
	}

	input.logger?.info?.(
		{ runId, burrowRunId, written, skipped, errored, burrowRunMissing },
		"run stream bridge ended",
	);
	if (burrowRunMissing) {
		return { written, skipped, errored, burrowRunMissing: true };
	}
	return terminalDetected !== undefined
		? { written, skipped, errored, terminalDetected }
		: { written, skipped, errored };
}

/**
 * Inspect a burrow event for a runtime-terminal shape (warren-a69a,
 * warren-2687).
 * Returns the warren-side outcome to reap with, or `null` if the event
 * doesn't carry a terminal signal.
 *
 * Two runtime terminal shapes ride the same `kind=state_change`,
 * `stream=system` carrier:
 *
 *   - claude-code: burrow's jsonl-claude parser emits `payload.type ===
 *     "result"`. The `is_error` field distinguishes a clean exit from a
 *     crash; `is_error: true` → `failed`, anything else → `succeeded`.
 *   - pi: burrow's pi parser emits `payload.type === "agent_end"` as the
 *     final lifecycle envelope. `stopReason === "error"` or a non-empty
 *     `errorMessage` → `failed` (warren-1ac2 / pl-5516); absent both,
 *     → `succeeded`. Zero-token / empty-content alone is NOT a failure
 *     signal — a legitimate noop run shares that shape.
 *
 * burrow's own cancel path emits a different terminal shape; that case
 * is handled by `cancelRun`. Future runtimes extend this dispatch by
 * adding their runtime-specific terminal shape.
 */
function detectRuntimeTerminal(event: RunEvent): RunTerminalState | null {
	if (event.kind !== "state_change") return null;
	if (event.stream !== "system") return null;
	const payload = event.payload;
	if (payload === null || typeof payload !== "object") return null;
	const env = payload as Record<string, unknown>;
	if (env.type === "result") return env.is_error === true ? "failed" : "succeeded";
	if (env.type === "agent_end") {
		const err = env.errorMessage;
		const failed = env.stopReason === "error" || (typeof err === "string" && err.length > 0);
		return failed ? "failed" : "succeeded";
	}
	return null;
}

/**
 * Match pi's `agent_end` terminal envelope (warren-36c0). Burrow's pi parser
 * (burrow `src/runtime/parsers/pi.ts`) maps every pi lifecycle line to a
 * RunEvent with `kind="state_change"`, `stream="system"`, and the original
 * envelope shoved into `payload` — so `event.kind === "agent_end"` never
 * matches on real pi runs. The piStats snapshot branch (bridgeRunStream)
 * checks this predicate to fire the terminal `get_session_stats` fetch
 * before the bridge breaks on terminal detection. Distinct from
 * `detectRuntimeTerminal`, which also accepts claude-code's `result`
 * envelope — piStats is a pi-only concern.
 */
function isPiAgentEnd(event: RunEvent): boolean {
	if (event.kind !== "state_change") return false;
	if (event.stream !== "system") return false;
	const payload = event.payload;
	if (payload === null || typeof payload !== "object") return false;
	const env = payload as Record<string, unknown>;
	return env.type === "agent_end";
}

/**
 * Default source factory: shells through the HttpClient. Wrapping in
 * `withTransportMapping` is moot here because the iterator yields
 * after the initial fetch returns — but the initial fetch can still
 * fail with a transport error, and we want that to surface as
 * `BurrowUnreachableError` for consistency with the spawn flow.
 */
function defaultSource(
	client: BurrowClient,
	burrowRunId: string,
): (signal: AbortSignal) => AsyncIterable<RunEvent> {
	return (signal) => {
		return {
			[Symbol.asyncIterator](): AsyncIterator<RunEvent> {
				const inner = client.http.runs.stream(burrowRunId, { signal });
				return {
					next: () =>
						withTransportMapping(client.config, () => inner.next()) as Promise<
							IteratorResult<RunEvent>
						>,
					return: () => inner.return(undefined) as Promise<IteratorResult<RunEvent>>,
				};
			},
		};
	};
}

interface BurrowTerminalSnapshot {
	readonly state: RunTerminalState;
	readonly exitCode: number | null;
}

interface RunStatePollerInput {
	readonly probe: RunStateProbe;
	readonly burrowRunId: string;
	readonly ctrl: AbortController;
	readonly pollIntervalMs: number;
	readonly drainMs: number;
	readonly observed: { value: BurrowTerminalSnapshot | null };
	readonly runId: string;
	readonly logger?: BridgeLogger;
}

const BURROW_TERMINAL_STATES = new Set<RunTerminalState>(["succeeded", "failed", "cancelled"]);

/**
 * Default run-state probe: project burrow's `runs.get` to the
 * {state, exitCode} pair the poller needs. `BurrowNotFoundError` bubbles
 * up so the bridge's main catch block records `burrowRunMissing` exactly
 * once instead of fighting with the stream's own 404. Other transport
 * errors return null and the poller retries on the next tick.
 */
function defaultRunStateProbe(client: BurrowClient): RunStateProbe {
	return async (burrowRunId, _signal) => {
		const run = await withTransportMapping(client.config, () => client.http.runs.get(burrowRunId));
		return { state: run.state, exitCode: run.exitCode };
	};
}

/**
 * Poll burrow's run state in parallel with the event stream. On first
 * terminal observation: record the snapshot, sleep the drain window so
 * tailBurrow's next 200ms cycle picks up final events, then abort the
 * stream. Errors are swallowed — the stream's own error handling is
 * authoritative for transport failures.
 */
async function runStatePoller(input: RunStatePollerInput): Promise<void> {
	const { probe, burrowRunId, ctrl, pollIntervalMs, drainMs, observed, runId, logger } = input;
	while (!ctrl.signal.aborted) {
		try {
			const row = await probe(burrowRunId, ctrl.signal);
			if (row !== null && isBurrowTerminal(row.state)) {
				observed.value = { state: row.state, exitCode: row.exitCode };
				logger?.info?.(
					{ runId, burrowRunId, burrowState: row.state, exitCode: row.exitCode },
					"run-state poller observed burrow terminal; draining stream before abort",
				);
				await sleepMs(drainMs, ctrl.signal);
				ctrl.abort();
				return;
			}
		} catch (err) {
			// BurrowNotFoundError or transport failure — let the main stream
			// loop classify (404 → burrowRunMissing, others → errored). The
			// poller doesn't make those calls itself; it just keeps trying
			// until the stream aborts.
			logger?.warn?.(
				{
					runId,
					burrowRunId,
					err: err instanceof Error ? err.message : String(err),
				},
				"run-state poller probe failed; retrying",
			);
		}
		if (await sleepMs(pollIntervalMs, ctrl.signal)) return;
	}
}

function isBurrowTerminal(state: string): state is RunTerminalState {
	return BURROW_TERMINAL_STATES.has(state as RunTerminalState);
}

/** Resolve after `ms` or return true when the signal fires first. */
function sleepMs(ms: number, signal: AbortSignal): Promise<boolean> {
	if (ms <= 0) return Promise.resolve(signal.aborted);
	return new Promise<boolean>((resolve) => {
		const timer = setTimeout(() => {
			signal.removeEventListener("abort", onAbort);
			resolve(false);
		}, ms);
		const onAbort = (): void => {
			clearTimeout(timer);
			resolve(true);
		};
		if (signal.aborted) {
			clearTimeout(timer);
			resolve(true);
			return;
		}
		signal.addEventListener("abort", onAbort, { once: true });
	});
}

/**
 * Burrow's wire `stream` is `'stdout' | 'stderr' | 'system'`; warren's
 * column accepts the same enum but is nullable. Coerce unknown values
 * to null so a forward-compatible burrow can ship new stream tags
 * without crashing the bridge — the event still lands, just without a
 * stream tag.
 */
function normalizeStream(value: unknown): EventStream | null {
	if (typeof value !== "string") return null;
	return (EVENT_STREAMS as readonly string[]).includes(value) ? (value as EventStream) : null;
}

function toIsoString(ts: Date | string): string {
	return ts instanceof Date ? ts.toISOString() : ts;
}

/**
 * Snapshot pi's get_session_stats RPC, swallowing failures (transport
 * error, channel closed, agent isn't pi). The `phase` tag lands in the
 * log message so operators can tell baseline-failed from terminal-failed.
 */
async function snapshotStats(
	client: PiStatsClient,
	burrowRunId: string,
	signal: AbortSignal,
	phase: "baseline" | "terminal",
	runId: string,
	logger: BridgeLogger | undefined,
): Promise<SessionStats | null> {
	try {
		return await client.fetch(burrowRunId, signal);
	} catch (err) {
		logger?.warn?.(
			{
				runId,
				burrowRunId,
				phase,
				err: err instanceof Error ? err.message : String(err),
			},
			"pi get_session_stats failed; cost columns will stay null",
		);
		return null;
	}
}

interface PersistPiStatsInput {
	readonly piStats: PiStatsClient;
	readonly burrowRunId: string;
	readonly runId: string;
	readonly repos: Repos;
	readonly baseline: Promise<SessionStats | null> | undefined;
	readonly signal: AbortSignal;
	readonly logger?: BridgeLogger;
}

/**
 * Compute (terminal − baseline) and persist via `RunsRepo.attachStats`.
 * Resolved pi sessions reuse prior turns via `--continue`/`--session`, so
 * `get_session_stats` always returns the session-cumulative number. The
 * delta is the only safe per-run accounting (plan risk #3). If the
 * baseline was missing (RPC failed at start), the delta defaults to the
 * terminal value verbatim — better to over-attribute than under-report.
 * Terminal failure leaves the row untouched.
 */
async function persistPiStatsDelta(input: PersistPiStatsInput): Promise<void> {
	const terminal = await snapshotStats(
		input.piStats,
		input.burrowRunId,
		input.signal,
		"terminal",
		input.runId,
		input.logger,
	);
	if (terminal === null) return;
	const baseline = input.baseline !== undefined ? await input.baseline : null;
	const base: SessionStats = baseline ?? {
		costUsd: 0,
		tokensInput: 0,
		tokensOutput: 0,
		tokensCacheRead: 0,
		tokensCacheWrite: 0,
	};
	const delta = {
		costUsd: terminal.costUsd - base.costUsd,
		tokensInput: terminal.tokensInput - base.tokensInput,
		tokensOutput: terminal.tokensOutput - base.tokensOutput,
		tokensCacheRead: terminal.tokensCacheRead - base.tokensCacheRead,
		tokensCacheWrite: terminal.tokensCacheWrite - base.tokensCacheWrite,
	};
	try {
		await input.repos.runs.attachStats(input.runId, delta);
		input.logger?.info?.(
			{
				runId: input.runId,
				burrowRunId: input.burrowRunId,
				costUsd: delta.costUsd,
				tokensInput: delta.tokensInput,
				tokensOutput: delta.tokensOutput,
			},
			"persisted pi session-stats delta",
		);
	} catch (err) {
		input.logger?.warn?.(
			{
				runId: input.runId,
				burrowRunId: input.burrowRunId,
				err: err instanceof Error ? err.message : String(err),
			},
			"attachStats threw; cost columns may be inconsistent",
		);
	}
}

interface PersistInStreamUsageInput {
	readonly usage: SessionStatsAccumulator;
	readonly runtime: "pi" | "claude";
	readonly runId: string;
	readonly burrowRunId: string;
	readonly repos: Repos;
	readonly logger?: BridgeLogger;
}

/**
 * Persist in-stream-accumulated runtime usage via `RunsRepo.attachStats`.
 * Skips when nothing was observed (non-cost-emitting run) so columns
 * stay null. attachStats throws on storage errors; we log + swallow to
 * match the PiStatsClient path's best-effort posture. The `runtime`
 * tag distinguishes pi (`turn_end` accumulator, warren-17a4) from
 * claude-code (`result` single-shot, warren-87f9) in the log line.
 */
async function persistInStreamUsage(input: PersistInStreamUsageInput): Promise<void> {
	if (!input.usage.seen) return;
	try {
		await input.repos.runs.attachStats(input.runId, {
			costUsd: input.usage.costUsd,
			tokensInput: input.usage.tokensInput,
			tokensOutput: input.usage.tokensOutput,
			tokensCacheRead: input.usage.tokensCacheRead,
			tokensCacheWrite: input.usage.tokensCacheWrite,
		});
		input.logger?.info?.(
			{
				runId: input.runId,
				burrowRunId: input.burrowRunId,
				runtime: input.runtime,
				costUsd: input.usage.costUsd,
				tokensInput: input.usage.tokensInput,
				tokensOutput: input.usage.tokensOutput,
			},
			"persisted in-stream usage totals",
		);
	} catch (err) {
		input.logger?.warn?.(
			{
				runId: input.runId,
				burrowRunId: input.burrowRunId,
				runtime: input.runtime,
				err: err instanceof Error ? err.message : String(err),
			},
			"attachStats threw on in-stream usage; cost columns may stay null",
		);
	}
}

export interface RecoverActiveRunStreamsInput {
	readonly repos: Repos;
	readonly broker: RunEventBroker;
	readonly burrowClientPool: BurrowClientPool;
	readonly logger?: BridgeLogger;
	/** Override the bridge factory (tests). Defaults to `bridgeRunStream`. */
	readonly bridge?: (input: BridgeRunStreamInput) => Promise<BridgeRunStreamResult>;
}

export interface ActiveBridge {
	readonly runId: string;
	readonly burrowRunId: string;
	readonly abort: AbortController;
	readonly done: Promise<BridgeRunStreamResult>;
}

export interface RecoverActiveRunStreamsResult {
	readonly bridges: readonly ActiveBridge[];
	readonly skipped: readonly {
		runId: string;
		reason: "no_burrow_run_id" | "no_burrow_id";
	}[];
}

/**
 * Walk the runs table for rows in {queued, running} that have a
 * `burrow_run_id` attached and start a bridge for each. Idempotent
 * across restarts; the resume seq filter means re-subscribing to a
 * run we already have full history for is harmless. Returns
 * controllers so the caller can `abort()` on shutdown.
 *
 * Runs in active states without a `burrow_run_id` are skipped — those
 * are partial spawns (a burrow was provisioned but `POST /runs`
 * never landed) which the spawn flow's rollback should already have
 * cancelled. Surfaced in `skipped` so the operator sees them.
 */
export async function recoverActiveRunStreams(
	input: RecoverActiveRunStreamsInput,
): Promise<RecoverActiveRunStreamsResult> {
	const { repos, broker, burrowClientPool, logger } = input;
	const bridge = input.bridge ?? bridgeRunStream;
	const candidates = await repos.runs.listByState(["queued", "running"]);

	const bridges: ActiveBridge[] = [];
	const skipped: { runId: string; reason: "no_burrow_run_id" | "no_burrow_id" }[] = [];

	for (const run of candidates) {
		if (run.burrowRunId === null) {
			skipped.push({ runId: run.id, reason: "no_burrow_run_id" });
			logger?.warn?.(
				{ runId: run.id, state: run.state },
				"skipping recovery: run has no burrow_run_id",
			);
			continue;
		}
		if (run.burrowId === null) {
			// Active row with a burrow_run_id but no burrow_id is malformed
			// (spawn writes burrow_id first). Skip rather than crash; warren
			// doctor surfaces orphaned rows.
			skipped.push({ runId: run.id, reason: "no_burrow_id" });
			logger?.warn?.(
				{ runId: run.id, state: run.state, burrowRunId: run.burrowRunId },
				"skipping recovery: run has burrow_run_id but no burrow_id",
			);
			continue;
		}
		const abort = new AbortController();
		const bridgeInput: BridgeRunStreamInput = {
			runId: run.id,
			burrowRunId: run.burrowRunId,
			burrowId: run.burrowId,
			repos,
			broker,
			burrowClientPool,
			signal: abort.signal,
			...(logger !== undefined ? { logger } : {}),
		};
		const done = bridge(bridgeInput);
		bridges.push({
			runId: run.id,
			burrowRunId: run.burrowRunId,
			abort,
			done,
		});
		logger?.info?.(
			{ runId: run.id, burrowRunId: run.burrowRunId, state: run.state },
			"resumed run stream bridge",
		);
	}

	return { bridges, skipped };
}
