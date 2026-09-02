/**
 * Typed per-runtime usage readers over the canonical event-envelope
 * extractor (warren-db2e / pl-882c step 6; AgentRuntimeAdapter phase-1
 * item 2, the `usageShape` direction).
 *
 * Before this module, the shape sniffing for "what does this runtime's
 * usage envelope look like" lived inline in
 * `src/runs/usage-aggregate.ts` — the second envelope-parsing site the
 * wave-1 consolidation set out to delete. Now shape knowledge lives
 * here, once, declared per runtime id keyed off
 * {@link KNOWN_RUNTIME_IDS}: which envelope `type` carries usage, how
 * to read its fields, and whether successive envelopes accumulate by
 * summing (pi's per-turn `turn_end`) or by assignment (claude-code's
 * single cumulative terminal `result`).
 *
 * Consumers:
 *
 *   - `readUsage(envelope)` — the generic reader: try each declared
 *     shape (pi first, preserving the pi-wins priority) and return the
 *     first reading, or `null` when no shape matches.
 *   - `usageShapeFor(runtime)` — the per-runtime reader the
 *     accumulators in `src/runs/usage-aggregate.ts` drive, so the
 *     write-time bridge (`stream/stats.ts`) and the read-time hydrator
 *     (`usage-hydrate.ts`) share exactly this shape knowledge.
 *
 * The pi-wins tiebreak itself is NOT here — it is a cross-envelope
 * aggregation decision and stays at its two decision sites
 * (`aggregateUsageFromEvents` and `enforceBudgetCap`). This module only
 * declares how one envelope reads.
 *
 * `src/core/` imports nothing outside itself (check:layers), so the
 * readers are dependency-free and structural.
 */

import type { AgentEventEnvelope } from "./event-envelope.ts";
import type { RuntimeId } from "./wire.ts";

/**
 * One envelope's usage reading. Fields are `null` when the envelope
 * carries no value for them — the accumulator decides how to fold
 * partial readings (pi sums the non-null fields; claude-code assigns
 * with a zero fallback), mirroring the pre-consolidation semantics
 * exactly.
 */
export interface UsageReading {
	readonly costUsd: number | null;
	readonly tokensInput: number | null;
	readonly tokensOutput: number | null;
	readonly tokensCacheRead: number | null;
	readonly tokensCacheWrite: number | null;
}

/**
 * How successive envelopes of one runtime fold into a running total:
 * pi emits per-turn deltas (`sum`), claude-code emits one cumulative
 * terminal snapshot (`assign`).
 */
export type UsageAccumulationMode = "sum" | "assign";

/**
 * The declared usage knowledge for one runtime: which envelope type
 * carries usage, how to read it, and how readings accumulate.
 */
export interface UsageShape {
	readonly runtime: RuntimeId;
	/** `payload.type` this runtime's usage rides (e.g. `"turn_end"`). */
	readonly envelopeType: string;
	readonly mode: UsageAccumulationMode;
	/**
	 * Read the usage fields out of a carrier-matched envelope payload,
	 * or return `null` when the payload is not real usage. The guard
	 * matters: a structurally-present but empty usage block must not
	 * mark a run as usage-shaped, or the accumulators would persist
	 * all-zeros over a null (unknown) cost.
	 */
	read(payload: Record<string, unknown>): UsageReading | null;
}

function toNumber(value: unknown): number | null {
	return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
	return value !== null && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

/**
 * Pi's per-turn totals ride `turn_end` at
 * `message.usage.{cost.total,input,output,cacheRead,cacheWrite}`.
 * Pi's per-message usage (`message_end`) double-counts across the turn
 * because each assistant message duplicates the conversation totals, so
 * only `turn_end` is read (see burrow
 * `src/runtime/parsers/__golden__/pi-v0.74.0-anthropic-*.jsonl`).
 * Per-turn deltas accumulate by summing.
 */
const PI_USAGE_SHAPE: UsageShape = {
	runtime: "pi",
	envelopeType: "turn_end",
	mode: "sum",
	read(payload) {
		const usage = asRecord(asRecord(payload.message)?.usage);
		if (usage === null) return null;
		const costTotal = toNumber(asRecord(usage.cost)?.total);
		const tokensInput = toNumber(usage.input);
		const tokensOutput = toNumber(usage.output);
		const tokensCacheRead = toNumber(usage.cacheRead);
		const tokensCacheWrite = toNumber(usage.cacheWrite);
		// Require at least the cost total OR an input/output token count
		// before counting the envelope as real usage — otherwise a
		// malformed turn_end with a structurally-present but empty usage
		// block would mark the run as pi-shaped and persist all-zeros.
		if (costTotal === null && tokensInput === null && tokensOutput === null) return null;
		return { costUsd: costTotal, tokensInput, tokensOutput, tokensCacheRead, tokensCacheWrite };
	},
};

/**
 * Claude-code's run-level usage rides its single terminal `result`
 * envelope (warren-87f9). Shape (see burrow
 * `src/runtime/parsers/jsonl-claude.ts`):
 *   {"type":"result", "total_cost_usd": N,
 *    "usage":{"input_tokens":N, "output_tokens":N,
 *             "cache_read_input_tokens":N, "cache_creation_input_tokens":N}}
 * The totals are cumulative and emitted once, so readings accumulate by
 * assignment, not addition.
 */
const CLAUDE_CODE_USAGE_SHAPE: UsageShape = {
	runtime: "claude-code",
	envelopeType: "result",
	mode: "assign",
	read(payload) {
		const usage = asRecord(payload.usage);
		const costTotal = toNumber(payload.total_cost_usd);
		const tokensInput = toNumber(usage?.input_tokens);
		const tokensOutput = toNumber(usage?.output_tokens);
		const tokensCacheRead = toNumber(usage?.cache_read_input_tokens);
		const tokensCacheWrite = toNumber(usage?.cache_creation_input_tokens);
		// Same real-usage guard as the pi shape: cost OR input/output
		// tokens must be present.
		if (costTotal === null && tokensInput === null && tokensOutput === null) return null;
		return { costUsd: costTotal, tokensInput, tokensOutput, tokensCacheRead, tokensCacheWrite };
	},
};

/**
 * The usage shapes, declared per runtime id. Keyed off
 * {@link KNOWN_RUNTIME_IDS} via `Record<RuntimeId, …>` — a runtime
 * without a usage envelope is simply absent.
 */
export const USAGE_SHAPES: Readonly<Partial<Record<RuntimeId, UsageShape>>> = {
	pi: PI_USAGE_SHAPE,
	"claude-code": CLAUDE_CODE_USAGE_SHAPE,
};

/**
 * Resolution order for {@link readUsage}. Pi is tried first so the
 * generic reader's priority matches the pi-wins tiebreak the
 * accumulators apply across a stream.
 */
const USAGE_SHAPE_PRIORITY: readonly UsageShape[] = [PI_USAGE_SHAPE, CLAUDE_CODE_USAGE_SHAPE];

/**
 * The `payload.type` values that carry usage, derived once from the
 * declared shapes so SQL predicates (e.g. `EventsRepo.listUsageEvents`)
 * and the in-process readers cannot drift. Derived, not hand-listed.
 */
export const USAGE_ENVELOPE_TYPES: readonly string[] = [
	...new Set(USAGE_SHAPE_PRIORITY.map((shape) => shape.envelopeType)),
];

/**
 * Look up the declared usage shape for a runtime id, or `null` when
 * the runtime emits no usage envelope.
 */
export function usageShapeFor(runtime: RuntimeId): UsageShape | null {
	return USAGE_SHAPES[runtime] ?? null;
}

/**
 * Read usage out of a trusted, carrier-matched agent envelope, trying
 * each declared shape in priority order (pi first). Returns the
 * envelope's usage fields, or `null` when no shape claims the envelope
 * (wrong `payload.type`, or a shape matched but its guard rejected the
 * payload as not-real-usage).
 */
export function readUsage(envelope: AgentEventEnvelope): UsageReading | null {
	for (const shape of USAGE_SHAPE_PRIORITY) {
		if (envelope.type !== shape.envelopeType) continue;
		const reading = shape.read(envelope.payload);
		if (reading !== null) return reading;
	}
	return null;
}
