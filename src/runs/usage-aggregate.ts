/**
 * Pure usage/cost aggregation from persisted event rows (warren-ab18).
 *
 * The bridge (`stream.ts`) extracts session-cumulative cost+tokens
 * in-stream and checkpoints them onto the run row via `attachStats`. If
 * the bridge dies before its next checkpoint (machine reboot, ghost
 * run, etc.) the columns stay null even though the underlying usage
 * envelopes already landed in the `events` table.
 *
 * This module pulls those totals back out at read-time so the UI/API
 * still shows a best-effort cost for any run with streamed events. It
 * is the same shape sniffing the bridge does at write-time — kept here
 * as the canonical pure version so both call sites stay in sync.
 *
 * Two runtime shapes are recognised, both riding the same
 * `kind=state_change`, `stream=system` carrier:
 *
 *   - pi: per-turn totals in `payload.type === "turn_end"` →
 *     `message.usage.{cost.total,input,output,cacheRead,cacheWrite}`.
 *     Sum across turns.
 *   - claude-code: single terminal `payload.type === "result"` →
 *     `total_cost_usd` + `usage.{input,output,cache_read_input,
 *     cache_creation_input}_tokens`. Cumulative; assign (not add).
 *
 * Both shapes are guarded so malformed envelopes never crash the
 * aggregator — worst case is "we miss this run's cost".
 */

import type { SessionStats } from "./stream/index.ts";

/**
 * Structural subset of `RunEvent` (burrow stream) and `EventRow`
 * (warren events table) shared by every usage shape we sniff. Both
 * sources only carry `kind`, `stream`, `payload` for the purposes of
 * usage extraction; the rest of the row (`seq`, `ts`, `id`, …) is
 * irrelevant. Structural typing lets the bridge feed `RunEvent` and
 * the read-time hydrator feed `EventRow` (mapped through
 * `eventRowToUsageInput`) into the same accumulator without an
 * adapter.
 */
export interface UsageEventInput {
	readonly kind: string;
	readonly stream: string | null;
	readonly payload: unknown;
}

/**
 * Mutable accumulator for usage observed across an event stream.
 *
 * `seen` distinguishes "no usage envelope observed yet" from "observed
 * zero cost" — callers skip persisting / returning when `seen === false`
 * so non-cost-emitting runs keep parity with the bridge (columns stay
 * null instead of being written as zeros).
 */
export interface SessionStatsAccumulator {
	seen: boolean;
	costUsd: number;
	tokensInput: number;
	tokensOutput: number;
	tokensCacheRead: number;
	tokensCacheWrite: number;
}

export function newSessionStatsAccumulator(): SessionStatsAccumulator {
	return {
		seen: false,
		costUsd: 0,
		tokensInput: 0,
		tokensOutput: 0,
		tokensCacheRead: 0,
		tokensCacheWrite: 0,
	};
}

function toNumber(value: unknown): number | null {
	return typeof value === "number" && Number.isFinite(value) ? value : null;
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
export function accumulatePiUsage(acc: SessionStatsAccumulator, event: UsageEventInput): void {
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
export function extractClaudeUsage(acc: SessionStatsAccumulator, event: UsageEventInput): void {
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

/**
 * Aggregate `pi` and `claude-code` usage envelopes across a run's
 * persisted event stream and return the cumulative session totals, or
 * `null` if nothing usage-shaped was observed.
 *
 * Pi-wins parity (mirrors the bridge's terminal write at stream.ts:297):
 * when a stream carries both shapes, pi's accumulator is the answer.
 * That's mostly defensive — in practice a single run is one runtime —
 * but it keeps the contract aligned with what the bridge would have
 * checkpointed had it lived long enough.
 */
export function aggregateUsageFromEvents(events: Iterable<UsageEventInput>): SessionStats | null {
	const piAcc = newSessionStatsAccumulator();
	const claudeAcc = newSessionStatsAccumulator();
	for (const event of events) {
		accumulatePiUsage(piAcc, event);
		extractClaudeUsage(claudeAcc, event);
	}
	if (piAcc.seen) return accumulatorToStats(piAcc);
	if (claudeAcc.seen) return accumulatorToStats(claudeAcc);
	return null;
}

function accumulatorToStats(acc: SessionStatsAccumulator): SessionStats {
	return {
		costUsd: acc.costUsd,
		tokensInput: acc.tokensInput,
		tokensOutput: acc.tokensOutput,
		tokensCacheRead: acc.tokensCacheRead,
		tokensCacheWrite: acc.tokensCacheWrite,
	};
}

/**
 * Adapt an `EventRow` to the structural shape the accumulators consume.
 * The events table stores `payloadJson` (parsed by drizzle's JSON mode);
 * the burrow `RunEvent` keeps it as `payload`. The accumulators only
 * read the parsed value, so the rename is the only adapter needed.
 */
export function eventRowToUsageInput(row: {
	readonly kind: string;
	readonly stream: string | null;
	readonly payloadJson: unknown;
}): UsageEventInput {
	return { kind: row.kind, stream: row.stream, payload: row.payloadJson };
}
