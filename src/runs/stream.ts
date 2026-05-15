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
 * Restart recovery. `recoverActiveRunStreams` walks the runs table for
 * rows in {queued, running} that already have a `burrow_run_id`, and
 * starts a bridge for each. It returns the in-flight bridges so the
 * caller can stop them on shutdown.
 */

import type { RunEvent } from "@os-eco/burrow-cli";
import type { BurrowClient } from "../burrow-client/client.ts";
import { withTransportMapping } from "../burrow-client/client.ts";
import type { BurrowClientPool } from "../burrow-client/pool.ts";
import type { Repos } from "../db/repos/index.ts";
import type { EventStream, RunTerminalState } from "../db/schema.ts";
import { EVENT_STREAMS } from "../db/schema.ts";
import type { RunEventBroker } from "./events.ts";

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

	let written = 0;
	let skipped = 0;
	let errored = false;
	let claimed = false;
	let terminalDetected: { outcome: RunTerminalState } | undefined;
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
	} finally {
		if (input.signal !== undefined) input.signal.removeEventListener("abort", onAbort);
		ctrl.abort();
		broker.close(runId);
	}

	input.logger?.info?.(
		{ runId, burrowRunId, written, skipped, errored },
		"run stream bridge ended",
	);
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
 *     final lifecycle envelope (burrow `src/runtime/parsers/pi.ts`).
 *     The envelope carries no error flag, so the bridge treats it as
 *     "the agent reached its natural end" → `succeeded`; reap then
 *     reconciles against burrow's authoritative `exit_code` /
 *     `state` if the process crashed afterwards.
 *
 * burrow's own cancel path emits a different terminal shape; that case
 * is handled by `cancelRun` which already has the burrow run state in
 * hand, so the bridge doesn't need to detect it here.
 *
 * Future runtimes extend this dispatch by adding their runtime-specific
 * terminal shape.
 */
function detectRuntimeTerminal(event: RunEvent): RunTerminalState | null {
	if (event.kind !== "state_change") return null;
	if (event.stream !== "system") return null;
	const payload = event.payload;
	if (payload === null || typeof payload !== "object") return null;
	const env = payload as Record<string, unknown>;
	if (env.type === "result") return env.is_error === true ? "failed" : "succeeded";
	if (env.type === "agent_end") return "succeeded";
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

/**
 * Mutable accumulator for pi `turn_end` usage observed in-stream. Pi
 * emits per-turn totals (not session-cumulative within a single run with
 * `--no-session`), so the bridge sums turns to land at the run total.
 * `seen` distinguishes "no pi usage observed yet" from "observed zero
 * cost" — the persist step skips the write entirely when seen=false so
 * non-pi runs keep parity with claude-code (columns stay null).
 */
interface SessionStatsAccumulator {
	seen: boolean;
	costUsd: number;
	tokensInput: number;
	tokensOutput: number;
	tokensCacheRead: number;
	tokensCacheWrite: number;
}

function newSessionStatsAccumulator(): SessionStatsAccumulator {
	return {
		seen: false,
		costUsd: 0,
		tokensInput: 0,
		tokensOutput: 0,
		tokensCacheRead: 0,
		tokensCacheWrite: 0,
	};
}

/**
 * Extract pi's per-turn usage from a `turn_end` envelope and add it to
 * the accumulator. Pi's per-message usage (in `message_end`) double-counts
 * across the turn because each assistant message duplicates the
 * conversation totals, so we read only `turn_end`'s `message.usage.cost`
 * (see burrow `src/runtime/parsers/__golden__/pi-v0.74.0-anthropic-*.jsonl`).
 *
 * Defensive: unknown shapes leave the accumulator untouched. A future
 * pi version that grows new envelope fields can't crash the bridge —
 * the worst case is "we miss this run's cost", same as no-event.
 */
function accumulatePiUsage(acc: SessionStatsAccumulator, event: RunEvent): void {
	if (event.kind !== "state_change") return;
	if (event.stream !== "system") return;
	const payload = event.payload;
	if (payload === null || typeof payload !== "object") return;
	const env = payload as Record<string, unknown>;
	if (env.type !== "turn_end") return;
	const message = env.message;
	if (message === null || typeof message !== "object") return;
	const usage = (message as Record<string, unknown>).usage;
	if (usage === null || typeof usage !== "object") return;
	const u = usage as Record<string, unknown>;
	const cost = u.cost;
	const costTotal =
		cost !== null && typeof cost === "object"
			? toNumber((cost as Record<string, unknown>).total)
			: null;
	const tokensInput = toNumber(u.input);
	const tokensOutput = toNumber(u.output);
	const tokensCacheRead = toNumber(u.cacheRead);
	const tokensCacheWrite = toNumber(u.cacheWrite);
	// Require at least the cost total OR an input/output token count
	// before we count the envelope as "real" usage — otherwise a malformed
	// turn_end with a structurally-present but empty usage block would
	// mark the run as pi-shaped and persist all-zeros.
	if (costTotal === null && tokensInput === null && tokensOutput === null) return;
	acc.seen = true;
	if (costTotal !== null) acc.costUsd += costTotal;
	if (tokensInput !== null) acc.tokensInput += tokensInput;
	if (tokensOutput !== null) acc.tokensOutput += tokensOutput;
	if (tokensCacheRead !== null) acc.tokensCacheRead += tokensCacheRead;
	if (tokensCacheWrite !== null) acc.tokensCacheWrite += tokensCacheWrite;
}

function toNumber(value: unknown): number | null {
	return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/**
 * Extract claude-code's run-level usage from its single terminal `result`
 * envelope (warren-87f9). Shape (see burrow `src/runtime/parsers/jsonl-claude.ts`):
 *   {"type":"result", "subtype":"success", "total_cost_usd": N,
 *    "usage":{ "input_tokens":N, "output_tokens":N,
 *              "cache_read_input_tokens":N, "cache_creation_input_tokens":N }}
 * Single-shot: claude-code emits cumulative totals once at end, so we
 * assign (not add) to the accumulator. Pi's `turn_end` shape is
 * disjoint (different `type` + nested `message.usage.cost.total`), so
 * shape-sniffing here can't collide with `accumulatePiUsage`.
 *
 * Defensive: unknown shapes leave the accumulator untouched. A future
 * claude-code that adds fields can't crash the bridge — worst case we
 * miss this run's cost.
 */
function extractClaudeUsage(acc: SessionStatsAccumulator, event: RunEvent): void {
	if (event.kind !== "state_change") return;
	if (event.stream !== "system") return;
	const payload = event.payload;
	if (payload === null || typeof payload !== "object") return;
	const env = payload as Record<string, unknown>;
	if (env.type !== "result") return;
	const costTotal = toNumber(env.total_cost_usd);
	const usage = env.usage;
	const u = usage !== null && typeof usage === "object" ? (usage as Record<string, unknown>) : null;
	const tokensInput = u !== null ? toNumber(u.input_tokens) : null;
	const tokensOutput = u !== null ? toNumber(u.output_tokens) : null;
	const tokensCacheRead = u !== null ? toNumber(u.cache_read_input_tokens) : null;
	const tokensCacheWrite = u !== null ? toNumber(u.cache_creation_input_tokens) : null;
	// Require cost OR input/output tokens before flagging the envelope as
	// real claude-code usage — mirrors accumulatePiUsage's guard.
	if (costTotal === null && tokensInput === null && tokensOutput === null) return;
	acc.seen = true;
	acc.costUsd = costTotal ?? 0;
	acc.tokensInput = tokensInput ?? 0;
	acc.tokensOutput = tokensOutput ?? 0;
	acc.tokensCacheRead = tokensCacheRead ?? 0;
	acc.tokensCacheWrite = tokensCacheWrite ?? 0;
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
