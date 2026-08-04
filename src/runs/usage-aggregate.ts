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
 * The per-runtime shape knowledge (which envelope type carries usage,
 * how to read it, sum-vs-assign accumulation) lives in the typed
 * readers of `src/core/usage-shape.ts` (warren-db2e), declared per
 * runtime id off `KNOWN_RUNTIME_IDS`. This module owns only the
 * cross-envelope aggregation: the accumulators, the `seen` tracking,
 * and the pi-wins tiebreak.
 */

import { extractAgentEventEnvelope } from "../core/event-envelope.ts";
import { type UsageReading, type UsageShape, usageShapeFor } from "../core/usage-shape.ts";
import type { RuntimeId } from "../core/wire.ts";
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
	/**
	 * Parse-boundary provenance (warren-6646). Optional — the persisted
	 * events table predates the tag; absent reads as warren-authored.
	 * Fed into the shared envelope extractor's provenance gate
	 * (warren-27b5).
	 */
	readonly origin?: string;
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

/**
 * Fold one shape reading into the accumulator per the shape's declared
 * mode. `sum` (pi) adds only the non-null fields — a partial turn_end
 * still contributes what it carried. `assign` (claude-code) overwrites
 * with a zero fallback, because claude's terminal `result` envelope is
 * cumulative and complete.
 */
function applyReading(
	acc: SessionStatsAccumulator,
	reading: UsageReading,
	mode: UsageShape["mode"],
): void {
	acc.seen = true;
	if (mode === "assign") {
		acc.costUsd = reading.costUsd ?? 0;
		acc.tokensInput = reading.tokensInput ?? 0;
		acc.tokensOutput = reading.tokensOutput ?? 0;
		acc.tokensCacheRead = reading.tokensCacheRead ?? 0;
		acc.tokensCacheWrite = reading.tokensCacheWrite ?? 0;
		return;
	}
	if (reading.costUsd !== null) acc.costUsd += reading.costUsd;
	if (reading.tokensInput !== null) acc.tokensInput += reading.tokensInput;
	if (reading.tokensOutput !== null) acc.tokensOutput += reading.tokensOutput;
	if (reading.tokensCacheRead !== null) acc.tokensCacheRead += reading.tokensCacheRead;
	if (reading.tokensCacheWrite !== null) acc.tokensCacheWrite += reading.tokensCacheWrite;
}

/**
 * Shared accumulate path: extract the trusted envelope, look up the
 * runtime's declared usage shape, and fold the reading in per the
 * shape's mode. Unknown shapes leave the accumulator untouched — a
 * future runtime version that grows new envelope fields can't crash
 * the bridge; the worst case is "we miss this run's cost", same as
 * no-event.
 */
function accumulateWithShape(
	acc: SessionStatsAccumulator,
	event: UsageEventInput,
	runtime: RuntimeId,
): void {
	const envelope = extractAgentEventEnvelope(event);
	if (envelope === null) return;
	const shape = usageShapeFor(runtime);
	if (shape === null || envelope.type !== shape.envelopeType) return;
	const reading = shape.read(envelope.payload);
	if (reading === null) return;
	applyReading(acc, reading, shape.mode);
}

/**
 * Extract pi's per-turn usage from a `turn_end` envelope and add it to
 * the accumulator, via the pi {@link UsageShape}. Pi's per-message
 * usage (in `message_end`) double-counts across the turn because each
 * assistant message duplicates the conversation totals, so only
 * `turn_end`'s `message.usage.cost` is read (see burrow
 * `src/runtime/parsers/__golden__/pi-v0.74.0-anthropic-*.jsonl`).
 */
export function accumulatePiUsage(acc: SessionStatsAccumulator, event: UsageEventInput): void {
	accumulateWithShape(acc, event, "pi");
}

/**
 * Extract claude-code's run-level usage from its single terminal
 * `result` envelope (warren-87f9), via the claude-code
 * {@link UsageShape}. Single-shot: claude-code emits cumulative totals
 * once at end, so the shape assigns (not adds). Pi's `turn_end` shape
 * is disjoint (different `type` + nested `message.usage.cost.total`),
 * so shape resolution here can't collide with `accumulatePiUsage`.
 */
export function extractClaudeUsage(acc: SessionStatsAccumulator, event: UsageEventInput): void {
	accumulateWithShape(acc, event, "claude-code");
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
