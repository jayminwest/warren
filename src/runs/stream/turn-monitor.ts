/**
 * `TurnMonitor` — in-turn inspection at the bridge's per-delta drop site
 * (warren-1f85 / warren-74a7, GitHub #1242).
 *
 * Between a `turn_start` and a `turn_end`, warren was blind: the bridge drops
 * every per-delta envelope before persisting (./delta-noise.ts), the watchdog
 * anchors on the newest persisted event with a 45-minute budget, and the
 * spend cap reads usage only at `turn_end` — so a provider stream that hung
 * mid-turn (warren-1f85: 45 idle minutes, $2.38) or degenerated into
 * whitespace-only reasoning deltas until the provider's length cap
 * (warren-74a7: five paid runs in a row) burned money with nothing to stop it.
 *
 * The monitor observes EVERY envelope the bridge sees (before the noise
 * drop) and tracks three things per turn: stall (wall time since the last
 * observed event while a turn is open — past the `WARREN_TURN_STALL_MS`
 * budget, default 10 minutes, it trips a `turn.stalled` cancel),
 * degeneration (consecutive whitespace-only `thinking` / `text` deltas —
 * non-empty, since empty deltas are legitimate wire noise — past a
 * count-or-byte `WARREN_TURN_DEGENERATE_*` threshold, a
 * `turn.degenerate` cancel), and in-turn spend (the cumulative
 * `partial.usage.cost.total` riding every delta, so the spend cap can trip
 * mid-turn rather than at `turn_end`).
 *
 * On a trip the bridge follows the `enforceBudgetCap` shape (./budget.ts):
 * evaluate, persist the known cost, emit the trip event, cancel through the
 * same `cancelBurrowRun` seam, and break the loop `cancelled` so reap
 * finalizes. The monitor NEVER persists deltas (bridge.test.ts pins that);
 * the injected clock keeps the bridge loop inside its size / complexity
 * budgets, and both runtimes feed the same bridge (./provider-source.ts).
 */

import type { RuntimeId } from "../../core/wire.ts";
import type { Repos } from "../../db/repos/index.ts";
import { isOverBudget } from "../cost-cap.ts";
import type { RunEventBroker } from "../events.ts";
import type { SessionStatsAccumulator } from "../usage-aggregate.ts";
import { newSessionStatsAccumulator } from "../usage-aggregate.ts";
import type { CancelBurrowRunFn } from "./budget.ts";
import { persistInStreamUsage } from "./stats.ts";
import type { BridgeLogger, StreamEventView } from "./types.ts";

/* --- Config --- */

/**
 * Default in-turn stall budget: 10 minutes — well below the watchdog's
 * 45-minute heartbeat, yet above any legitimate silent stretch inside one
 * model turn. `WARREN_TURN_STALL_MS`; `0` disables stall detection.
 */
export const DEFAULT_TURN_STALL_MS = 600_000;

/**
 * Default degeneration thresholds (warren-74a7): 200 consecutive
 * whitespace-only deltas (or 8 KiB of them) is far past anything a healthy
 * stream produces before the provider's length cap ends the turn.
 * `WARREN_TURN_DEGENERATE_MIN_DELTAS` / `..._MIN_BYTES`; `0` disables.
 */
export const DEFAULT_TURN_DEGENERATE_MIN_DELTAS = 200;
export const DEFAULT_TURN_DEGENERATE_MIN_BYTES = 8_192;

/** Stall-timer cadence: an integer compare per tick, so 15s is free. */
export const DEFAULT_TURN_STALL_CHECK_INTERVAL_MS = 15_000;

interface TurnEnvLike {
	readonly [key: string]: string | undefined;
}

export interface TurnMonitorOptions {
	/** Stall budget in ms. */
	readonly stallMs: number | null;
	/** Whitespace-delta count threshold. */
	readonly degenerateMinDeltas: number | null;
	/** Whitespace-byte threshold. */
	readonly degenerateMinBytes: number | null;
	/** Effective run spend cap. */
	readonly costCapUsd: number | null;
	/** Stall-timer cadence in ms. */
	readonly stallCheckIntervalMs: number;
	/** Injected clock (tests). */
	readonly clock: TurnClock;
}

/**
 * Resolve monitor config from env (mirrors `loadWatchdogConfigFromEnv`):
 * unset → defaults, `0` disables the arm, malformed throws loud. The spend cap
 * is threaded in by the bridge.
 */
export function turnMonitorOptionsFromEnv(
	env: TurnEnvLike,
	costCapUsd: number | null,
	clock: TurnClock = wallClock,
): TurnMonitorOptions {
	return {
		stallMs: parseNonNegativeInt(
			env.WARREN_TURN_STALL_MS,
			"WARREN_TURN_STALL_MS",
			DEFAULT_TURN_STALL_MS,
		),
		degenerateMinDeltas: parseNonNegativeInt(
			env.WARREN_TURN_DEGENERATE_MIN_DELTAS,
			"WARREN_TURN_DEGENERATE_MIN_DELTAS",
			DEFAULT_TURN_DEGENERATE_MIN_DELTAS,
		),
		degenerateMinBytes: parseNonNegativeInt(
			env.WARREN_TURN_DEGENERATE_MIN_BYTES,
			"WARREN_TURN_DEGENERATE_MIN_BYTES",
			DEFAULT_TURN_DEGENERATE_MIN_BYTES,
		),
		costCapUsd,
		stallCheckIntervalMs: DEFAULT_TURN_STALL_CHECK_INTERVAL_MS,
		clock,
	};
}

function parseNonNegativeInt(
	raw: string | undefined,
	name: string,
	fallback: number,
): number | null {
	if (raw === undefined || raw.trim() === "") return fallback;
	const parsed = Number.parseInt(raw, 10);
	if (!Number.isInteger(parsed) || parsed < 0 || String(parsed) !== raw.trim()) {
		throw new Error(`${name} must be a non-negative integer (got ${JSON.stringify(raw)})`);
	}
	return parsed === 0 ? null : parsed;
}

/** Wall clock — the production `TurnClock`. */
export const wallClock: TurnClock = { now: () => Date.now() };

export interface TurnClock {
	now(): number;
}

/* --- The monitor --- */

/** What tripped: drives the emitted event kind, payload, and cancel reason. */
export type TurnTrip =
	| { readonly kind: "stalled"; readonly idleMs: number; readonly stallMs: number }
	| {
			readonly kind: "degenerate";
			readonly deltaCount: number;
			readonly byteCount: number;
	  }
	| { readonly kind: "spend"; readonly costUsd: number; readonly capUsd: number };

/**
 * Per-turn inactivity / degeneration / spend state, fed from the bridge's
 * event loop. `observe` is side-effect-free: it reads the envelope and
 * returns the trip for the caller to act on. The stall timer
 * (`start`/`stop`) is owned here so a stream that stops delivering
 * entirely — where `observe` can never run again — still trips.
 */
export class TurnMonitor {
	readonly #options: TurnMonitorOptions;
	#timer: ReturnType<typeof setInterval> | null = null;
	#lastEventAtMs: number | null = null;
	#turnActive = false;
	#whitespaceDeltas = 0;
	#whitespaceBytes = 0;
	#currentTurnCostUsd: number | null = null;
	#completedCostUsd = 0;
	#seenUsage = false;

	constructor(options: TurnMonitorOptions) {
		this.#options = options;
	}

	/**
	 * Observe one stream event (the bridge feeds every envelope it sees,
	 * before the per-delta noise drop) and return the trip when a threshold
	 * crossed. Any observed event re-anchors the stall clock.
	 */
	observe(event: StreamEventView): TurnTrip | null {
		const now = this.#options.clock.now();
		this.#lastEventAtMs = now;
		const env = asRecord(event.payload);
		if (env === null) return null;
		const type = env.type;
		if (typeof type !== "string") return null;
		if (type === "turn_start") {
			this.#turnActive = true;
			this.#resetTurnCounters();
		} else if (type === "turn_end") {
			this.#turnActive = false;
			this.#foldTurnEndCost(env);
			this.#resetTurnCounters();
		} else if (type === "agent_end") {
			this.#turnActive = false;
			this.#resetTurnCounters();
		} else if (type === "message_update") {
			const trip = this.#observeMessageUpdate(env);
			if (trip !== null) return trip;
		}
		return null;
	}

	/**
	 * Cumulative spend so far: completed `turn_end` totals plus the newest
	 * in-flight `partial.usage.cost.total`; `null` when nothing usage-shaped
	 * was observed. Used by the trip handler to persist what is known.
	 */
	cumulativeCostUsd(): number | null {
		if (!this.#seenUsage) return null;
		return this.#completedCostUsd + (this.#currentTurnCostUsd ?? 0);
	}

	/**
	 * Arm the periodic stall check. `onStall` fires at most once (the timer
	 * disarms itself before invoking). No-op when stall detection is disabled;
	 * the bridge MUST call `stop()` when its loop ends.
	 */
	start(onStall: (trip: TurnTrip) => void): void {
		this.stop();
		if (this.#options.stallMs === null) return;
		this.#timer = setInterval(() => {
			const trip = this.#checkStall();
			if (trip !== null) {
				this.stop();
				onStall(trip);
			}
		}, this.#options.stallCheckIntervalMs);
	}

	stop(): void {
		if (this.#timer !== null) {
			clearInterval(this.#timer);
			this.#timer = null;
		}
	}

	#checkStall(): TurnTrip | null {
		const stallMs = this.#options.stallMs;
		if (stallMs === null || !this.#turnActive || this.#lastEventAtMs === null) return null;
		const idleMs = this.#options.clock.now() - this.#lastEventAtMs;
		if (idleMs <= stallMs) return null;
		return { kind: "stalled", idleMs, stallMs };
	}

	#resetTurnCounters(): void {
		this.#whitespaceDeltas = 0;
		this.#whitespaceBytes = 0;
	}

	/**
	 * Inspect a `message_update` envelope. Empty deltas are legitimate wire
	 * noise (pi's parser drops only empty TEXT; the whitespace-only spiral is
	 * what slips through), so only non-empty whitespace counts against the
	 * degeneration thresholds; any content-bearing delta resets the streak.
	 */
	#observeMessageUpdate(env: Record<string, unknown>): TurnTrip | null {
		this.#observePartialCost(env);
		const spendTrip = this.#spendTrip();
		if (spendTrip !== null) return spendTrip;
		const ame = asRecord(env.assistantMessageEvent);
		if (ame === null) return null;
		const deltaType = ame.type;
		if (deltaType !== "thinking_delta" && deltaType !== "text_delta") return null;
		const delta = ame.delta;
		if (typeof delta !== "string") return null;
		if (delta.length === 0 || delta.trim() !== "") {
			this.#resetTurnCounters();
			return null;
		}
		this.#whitespaceDeltas += 1;
		this.#whitespaceBytes += delta.length;
		if (this.#degenerate()) {
			return {
				kind: "degenerate",
				deltaCount: this.#whitespaceDeltas,
				byteCount: this.#whitespaceBytes,
			};
		}
		return null;
	}

	#degenerate(): boolean {
		const { degenerateMinDeltas, degenerateMinBytes } = this.#options;
		if (degenerateMinDeltas !== null && this.#whitespaceDeltas >= degenerateMinDeltas) return true;
		return degenerateMinBytes !== null && this.#whitespaceBytes >= degenerateMinBytes;
	}

	/** Read the in-flight turn's cumulative cost off `partial.usage.cost.total`. */
	#observePartialCost(env: Record<string, unknown>): void {
		const partial = asRecord(env.partial);
		const usage = partial !== null ? asRecord(partial.usage) : null;
		const cost = usage !== null ? asRecord(usage.cost) : null;
		const total = cost !== null ? cost.total : undefined;
		if (typeof total === "number" && Number.isFinite(total) && total >= 0) {
			this.#currentTurnCostUsd = total;
			this.#seenUsage = true;
		}
	}

	/**
	 * Fold a completed turn's authoritative cost: the `turn_end` total
	 * replaces the in-flight partial (they measure the same turn; keeping
	 * both would double-count). A turn_end with no usage banks the last
	 * partial so a malformed envelope still persists what is known.
	 */
	#foldTurnEndCost(env: Record<string, unknown>): void {
		const message = asRecord(env.message);
		const usage = message !== null ? asRecord(message.usage) : null;
		const cost = usage !== null ? asRecord(usage.cost) : null;
		const total = cost !== null ? cost.total : undefined;
		if (typeof total === "number" && Number.isFinite(total) && total >= 0) {
			this.#completedCostUsd += total;
			this.#seenUsage = true;
		} else {
			this.#completedCostUsd += this.#currentTurnCostUsd ?? 0;
		}
		this.#currentTurnCostUsd = null;
	}

	#spendTrip(): TurnTrip | null {
		if (this.#options.costCapUsd === null || !this.#seenUsage) return null;
		const cumulative = this.cumulativeCostUsd();
		if (cumulative === null || !isOverBudget(cumulative, this.#options.costCapUsd)) return null;
		return { kind: "spend", costUsd: cumulative, capUsd: this.#options.costCapUsd };
	}
}

function asRecord(value: unknown): Record<string, unknown> | null {
	if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
	return value as Record<string, unknown>;
}

/* --- Trip action --- */

export interface TurnTripActionInput {
	readonly runId: string;
	readonly sandboxRunId: string;
	readonly trip: TurnTrip;
	/** Best-known cumulative cost at trip time; `null` when nothing was observed. */
	readonly costUsd: number | null;
	/**
	 * Runtime tag for the cost persist, threaded from the bridge's resolved
	 * runtime (the monitor itself is runtime-neutral — it only reads shapes).
	 * `null` skips the stats persist.
	 */
	readonly runtime: RuntimeId | null;
	readonly repos: Repos;
	readonly broker: RunEventBroker;
	readonly cancelBurrowRun: CancelBurrowRunFn;
	readonly logger?: BridgeLogger;
}

/**
 * Act on a monitor trip, following the `enforceBudgetCap` shape (./budget.ts):
 * persist the known cost, emit the trip event onto the run's log so the
 * operator sees WHY the run was cut, and cancel through the same seam. All
 * steps best-effort — a failure is logged and swallowed so a trip never
 * throws out of the bridge.
 */
export async function tripTurnMonitor(input: TurnTripActionInput): Promise<void> {
	input.logger?.warn?.(
		{ runId: input.runId, sandboxRunId: input.sandboxRunId, trip: input.trip },
		"turn monitor tripped; cancelling run",
	);
	await persistKnownCost(input);
	await emitTripEvent(input);
	try {
		await input.cancelBurrowRun(tripReason(input.trip));
	} catch (err) {
		input.logger?.error?.(
			{
				runId: input.runId,
				sandboxRunId: input.sandboxRunId,
				err: err instanceof Error ? err.message : String(err),
			},
			"turn-monitor burrow cancel failed; reap will finalize from terminal-detect",
		);
	}
}

async function persistKnownCost(input: TurnTripActionInput): Promise<void> {
	if (input.runtime === null || input.costUsd === null || input.costUsd <= 0) return;
	const usage: SessionStatsAccumulator = {
		...newSessionStatsAccumulator(),
		seen: true,
		costUsd: input.costUsd,
	};
	await persistInStreamUsage({
		usage,
		runtime: input.runtime,
		runId: input.runId,
		sandboxRunId: input.sandboxRunId,
		repos: input.repos,
		...(input.logger !== undefined ? { logger: input.logger } : {}),
	});
}

async function emitTripEvent(input: TurnTripActionInput): Promise<void> {
	try {
		const seq = ((await input.repos.events.maxSeqForRun(input.runId)) ?? 0) + 1;
		const row = await input.repos.events.append({
			runId: input.runId,
			sandboxEventSeq: seq,
			ts: new Date().toISOString(),
			kind: tripEventKind(input.trip),
			stream: "system",
			payload: tripEventPayload(input.trip),
		});
		input.broker.publish(input.runId, row);
	} catch (err) {
		input.logger?.error?.(
			{ runId: input.runId, err: err instanceof Error ? err.message : String(err) },
			"failed to emit turn-monitor trip event",
		);
	}
}

function tripEventKind(trip: TurnTrip): string {
	if (trip.kind === "stalled") return "turn.stalled";
	if (trip.kind === "degenerate") return "turn.degenerate";
	return "budget.exceeded";
}

function tripEventPayload(trip: TurnTrip): Record<string, unknown> {
	if (trip.kind === "stalled") {
		return { idleMs: trip.idleMs, stallMs: trip.stallMs };
	}
	if (trip.kind === "degenerate") {
		return { deltaCount: trip.deltaCount, byteCount: trip.byteCount };
	}
	return { costUsd: trip.costUsd, capUsd: trip.capUsd };
}

function tripReason(trip: TurnTrip): string {
	if (trip.kind === "stalled") {
		return `turn stalled: no events for ${trip.idleMs}ms (budget ${trip.stallMs}ms)`;
	}
	if (trip.kind === "degenerate") {
		return `degenerate turn: ${trip.deltaCount} whitespace-only deltas (${trip.byteCount} bytes)`;
	}
	return `spend cap exceeded: $${trip.costUsd} > $${trip.capUsd}`;
}

/* --- Bridge wiring --- */

export interface BridgeTurnMonitorInput {
	readonly monitor: TurnMonitor;
	readonly runId: string;
	readonly sandboxRunId: string;
	/** Runtime tag for the trip cost persist (from the bridge's resolved runtime). */
	readonly runtime: RuntimeId | null;
	readonly repos: Repos;
	readonly broker: RunEventBroker;
	readonly cancelBurrowRun: CancelBurrowRunFn;
	/** The bridge's abort controller — the trip aborts the parked source iterator. */
	readonly ctrl: AbortController;
	/** Marks the bridge's terminal outcome (`cancelled`) on a trip. */
	onTerminalCancelled: () => void;
	readonly logger?: BridgeLogger;
}

export interface BridgeTurnMonitor {
	/** Feed one event; returns the trip when a threshold crossed, else `null`. */
	readonly observe: (event: StreamEventView) => TurnTrip | null;
	/** Act on a trip: persist + emit + cancel, then abort the source. */
	readonly trip: (trip: TurnTrip) => Promise<void>;
	/** True once a trip acted (the bridge's catch treats abort as terminal). */
	readonly tripped: { readonly value: boolean };
	readonly stop: () => void;
}

/**
 * Wire a monitor into one bridge run (#1242): arms the stall timer and returns
 * the observe/trip/stop surface the bridge loop uses. Lives here — not in
 * `bridge.ts` — so the bridge stays inside its file-size ratchet.
 */
export function bridgeTurnMonitor(input: BridgeTurnMonitorInput): BridgeTurnMonitor {
	const tripped = { value: false };
	const trip = async (turnTrip: TurnTrip): Promise<void> => {
		tripped.value = true;
		input.onTerminalCancelled();
		await tripTurnMonitor({
			runId: input.runId,
			sandboxRunId: input.sandboxRunId,
			trip: turnTrip,
			costUsd: input.monitor.cumulativeCostUsd(),
			runtime: input.runtime,
			repos: input.repos,
			broker: input.broker,
			cancelBurrowRun: input.cancelBurrowRun,
			...(input.logger !== undefined ? { logger: input.logger } : {}),
		});
		input.ctrl.abort();
	};
	input.monitor.start((turnTrip) => {
		if (input.ctrl.signal.aborted) return;
		void trip(turnTrip);
	});
	return {
		observe: (event) => input.monitor.observe(event),
		trip,
		tripped,
		stop: () => input.monitor.stop(),
	};
}
